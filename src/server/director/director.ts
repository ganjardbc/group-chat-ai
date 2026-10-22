import type { ChatMessage } from '../../shared/protocol.js';
import { LlmUnavailableError, type LlmChat } from '../llm-client/client.js';
import type { Logger } from '../logger.js';
import type { Memory } from '../memory/memory.js';
import type { Persona } from '../persona/persona.js';
import { MessageQueue, splitMessage, type QueueHooks, type QueueItem, type QueueResult } from '../queue/queue.js';
import {
  classifyUserText,
  evaluateGate,
  newGateState,
  type GateConfig,
  type GateResult,
  type GateState,
  type RoundMode,
} from './gate.js';
import { parseScript, type ParsedScript, type ScriptLine } from './parser.js';
import { buildScriptMessages, RETRY_NOTE } from './prompt.js';
import { pickCloser, pickReaction, type ReactionKind } from './templates.js';

export interface DirectorEvents {
  message(m: ChatMessage): void;
  typing(botId: string, botName: string, on: boolean): void;
}

export interface DirectorOptions {
  groupId: string;
  bots: Persona[];
  llm: LlmChat;
  memory: Memory;
  queue: MessageQueue;
  gate: GateConfig;
  events: DirectorEvents;
  log: Logger;
  now?: () => number;
  rng?: () => number;
}

type Request = { kind: 'user' } | { kind: 'continue' } | { kind: 'idle' };
type RunResult = Extract<GateResult, { action: 'run' }>;

export class Director {
  readonly state: GateState;
  private readonly now: () => number;
  private readonly rng: () => number;
  private readonly roster;
  private pending: Request | null = null;
  private running = false;
  private loop: Promise<void> = Promise.resolve();
  /** Naik setiap pesan pengguna; dipakai membuang hasil basi dan menghentikan rantai bot-ke-bot. */
  private epoch = 0;
  private lastUserText = '';
  private lastUserName = 'semuanya';

  constructor(private readonly o: DirectorOptions) {
    this.now = o.now ?? Date.now;
    this.rng = o.rng ?? Math.random;
    this.state = newGateState(this.now());
    this.roster = o.bots.map((b) => ({ id: b.id, name: b.name, aliases: b.aliases }));
  }

  // ───────────────────────── titik masuk ─────────────────────────

  /** Pesan pengguna sudah tersimpan; Director memutuskan siapa menjawab. */
  onUserMessage(msg: ChatMessage): Promise<void> {
    const t = this.now();
    const s = this.state;
    s.lastUserAt = t;
    s.lastActivityAt = t;
    s.botStreak = 0;
    s.topicsSinceUser = 0;
    s.stopped = false;
    s.activitySinceStop = true;
    this.lastUserText = msg.text;
    this.lastUserName = msg.senderName;

    this.epoch++;
    this.o.queue.cancel(this.o.groupId); // pengguna menyela: bot berhenti mengetik
    this.pending = { kind: 'user' };
    return this.start();
  }

  /** Pengguna masuk/terhubung kembali: bangunkan grup yang sudah "tidur" tanpa memicu balasan. */
  onUserJoin(): void {
    const s = this.state;
    const t = this.now();
    if (s.stopped || t - s.lastUserAt >= this.o.gate.idleStopMs) {
      s.stopped = false;
      s.lastUserAt = t;
      s.lastActivityAt = t;
      s.topicsSinceUser = 0;
      s.activitySinceStop = false;
    }
  }

  /** Dipanggil periodik oleh timer: pancing topik atau tutup obrolan saat pengguna idle. */
  tick(): Promise<void> {
    if (this.running || this.state.stopped || this.o.queue.busy(this.o.groupId)) return this.loop;
    this.pending = { kind: 'idle' };
    return this.start();
  }

  /** Menunggu pekerjaan Director yang sedang berjalan selesai (untuk tes/shutdown). */
  idle(): Promise<void> {
    return this.loop;
  }

  // ───────────────────────── loop ─────────────────────────

  private start(): Promise<void> {
    if (!this.running) {
      this.running = true;
      this.loop = this.drive();
    }
    return this.loop;
  }

  private async drive(): Promise<void> {
    try {
      while (this.pending) {
        const req = this.pending;
        this.pending = null;
        const epoch = this.epoch;
        let follow: Request | null = null;
        try {
          follow = await this.handle(req, epoch);
        } catch (e) {
          this.o.log.error('director error', { error: (e as Error).stack ?? String(e) });
        }
        // pesan baru dari pengguna menang atas lanjutan bot-ke-bot
        if (!this.pending && follow && epoch === this.epoch) this.pending = follow;
      }
    } finally {
      this.running = false;
    }
  }

  private async handle(req: Request, epoch: number): Promise<Request | null> {
    const gate = evaluateGate(
      req.kind === 'user' ? { kind: 'user', text: this.lastUserText, roll: this.rng() } : { kind: req.kind },
      this.state,
      this.o.gate,
      this.now(),
      this.roster,
    );
    const quiet = gate.action === 'skip' && (gate.reason === 'not_idle_enough' || gate.reason === 'stopped');
    (quiet ? this.o.log.debug : this.o.log.info)(`gate ${req.kind} -> ${gate.action}`, { ...gate });

    switch (gate.action) {
      case 'skip':
        return null;
      case 'react':
        await this.react(gate.kind, epoch);
        return null;
      case 'stop':
        this.state.stopped = true;
        this.state.activitySinceStop = false;
        return null;
      case 'close':
        await this.close(epoch);
        return null;
      case 'run':
        return this.scriptRound(gate, epoch);
    }
  }

  // ───────────────────────── babak skrip (LLM) ─────────────────────────

  private async scriptRound(run: RunResult, epoch: number): Promise<Request | null> {
    const { mode } = run;
    if (mode === 'topic') {
      this.state.lastTopicAt = this.now();
      this.state.topicsSinceUser++;
    }

    const ctx = this.o.memory.context(this.o.groupId);
    const humans = [...new Set(ctx.recent.filter((m) => m.kind === 'user').map((m) => m.senderName))];
    if (this.lastUserName !== 'semuanya' && !humans.includes(this.lastUserName)) humans.push(this.lastUserName);
    const messages = buildScriptMessages({
      bots: this.o.bots,
      mode,
      forced: run.forced,
      maxLines: run.maxLines,
      summary: ctx.summary,
      facts: ctx.facts,
      recent: ctx.recent,
      humans,
    });

    let parsed: ParsedScript;
    try {
      parsed = await this.generate(mode, messages);
    } catch (e) {
      if (!(e instanceof LlmUnavailableError)) throw e;
      this.o.log.warn('LLM tidak tersedia, degradasi ke template', { reason: e.message });
      if (epoch !== this.epoch) return null;
      await this.degraded(mode, run, epoch);
      return null;
    }
    if (epoch !== this.epoch) {
      this.o.log.info('skrip basi dibuang (pengguna bicara lagi)');
      return null;
    }
    if (!parsed.ok) {
      this.o.log.warn('skrip tidak terbaca setelah retry, degradasi ke template');
      await this.degraded(mode, run, epoch);
      return null;
    }

    const lines = this.shape(parsed.lines, run);
    this.o.log.info('skrip', {
      mode,
      lines: lines.length,
      lanjut: parsed.cont,
      alasan: parsed.reason,
    });
    if (mode !== 'reply') this.state.botStreak += lines.length;

    const result = await this.deliver(lines.map((l) => this.item(l.speakerId, l.text)).flat());
    void this.o.memory.maybeSummarize(this.o.groupId);

    if (result.cancelled || epoch !== this.epoch) return null;
    return parsed.cont === true ? { kind: 'continue' } : null;
  }

  /** Satu panggilan LLM, dengan satu kali retry bila format tidak terbaca. */
  private async generate(mode: RoundMode, messages: ReturnType<typeof buildScriptMessages>): Promise<ParsedScript> {
    const first = await this.o.llm.chat({ tier: 'main', purpose: `script:${mode}`, messages });
    let parsed = parseScript(first.text, this.roster);
    this.logParse(first.callId, first.model, mode, false, parsed);
    if (parsed.ok) return parsed;

    const second = await this.o.llm.chat({
      tier: 'main',
      purpose: `script:${mode}:retry`,
      messages: [
        ...messages,
        { role: 'assistant', content: first.text.slice(0, 600) },
        { role: 'user', content: RETRY_NOTE },
      ],
    });
    parsed = parseScript(second.text, this.roster);
    this.logParse(second.callId, second.model, mode, true, parsed);
    return parsed;
  }

  private logParse(callId: string, model: string, mode: RoundMode, retry: boolean, p: ParsedScript) {
    this.o.log.llm({
      event: 'parse', callId, model, mode, retry,
      ok: p.ok, lines: p.lines.length, lanjut: p.cont, alasan: p.reason, warnings: p.warnings,
    });
  }

  /** Terapkan batas keras pada skrip: dedupe, batasi jumlah, pastikan yang disebut ikut menjawab. */
  private shape(raw: ScriptLine[], run: RunResult): ScriptLine[] {
    const recent = this.o.memory.store
      .recent(this.o.groupId, 8)
      .map((m) => `${m.senderId}|${m.text.toLowerCase()}`);
    const seen = new Set(recent);
    const lines: ScriptLine[] = [];
    for (const l of raw) {
      const key = `${l.speakerId}|${l.text.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(l);
    }
    let out = lines.slice(0, run.maxLines);

    const missing = run.forced.filter((id) => !out.some((l) => l.speakerId === id));
    for (const id of missing.reverse()) {
      const p = this.bot(id);
      if (!p) continue;
      while (out.length >= run.maxLines && out.length > 0) out = out.slice(0, -1);
      out.unshift({ speakerId: id, speakerName: p.name, text: pickReaction('ack', p, this.rng) });
    }
    return out;
  }

  // ───────────────────────── template (tanpa LLM) ─────────────────────────

  private async react(kind: ReactionKind, epoch: number): Promise<void> {
    const p = this.pick(this.o.bots);
    if (!p || epoch !== this.epoch) return;
    await this.deliver([{ botId: p.id, botName: p.name, text: pickReaction(kind, p, this.rng), speed: p.typingSpeed }]);
  }

  /** LLM habis/rusak: balasan seperlunya dari template, tidak pernah menampilkan error ke pengguna. */
  private async degraded(mode: RoundMode, run: RunResult, epoch: number): Promise<void> {
    if (mode !== 'reply') return; // bot cukup diam; jangan paksa ngobrol sendiri
    const cls = classifyUserText(this.lastUserText);
    const speakers = run.forced.length
      ? run.forced.slice(0, 2).map((id) => this.bot(id)).filter((p): p is Persona => Boolean(p))
      : this.rng() < 0.6
        ? [this.pick(this.o.bots)!]
        : [];
    const items: QueueItem[] = speakers.map((p) => {
      const kind: ReactionKind =
        cls === 'laugh' ? 'laugh' : cls === 'question' ? 'think' : run.forced.length ? 'ack' : this.rng() < 0.5 ? 'agree' : 'emoji';
      return { botId: p.id, botName: p.name, text: pickReaction(kind, p, this.rng), speed: p.typingSpeed };
    });
    if (epoch === this.epoch && items.length) await this.deliver(items);
  }

  /** Penutupan natural: 1-2 bot pamit dengan template persona, lalu grup diam sampai ada pengguna. */
  private async close(epoch: number): Promise<void> {
    const n = this.state.activitySinceStop && this.rng() < 0.6 ? 2 : 1;
    const speakers = [...this.o.bots].sort(() => this.rng() - 0.5).slice(0, n);
    const items = speakers.map((p) => ({
      botId: p.id, botName: p.name, speed: p.typingSpeed,
      text: pickCloser(p, this.rng, this.lastUserName),
    }));
    await this.deliver(items);
    if (epoch === this.epoch) {
      this.state.stopped = true;
      this.state.activitySinceStop = false;
    }
  }

  // ───────────────────────── pengiriman ─────────────────────────

  private bot(id: string): Persona | undefined {
    return this.o.bots.find((b) => b.id === id);
  }

  private pick<T>(arr: T[]): T | undefined {
    return arr[Math.min(arr.length - 1, Math.floor(this.rng() * arr.length))];
  }

  /** Satu baris skrip -> satu atau beberapa bubble pendek. */
  private item(botId: string, text: string): QueueItem[] {
    const p = this.bot(botId);
    if (!p) return [];
    return splitMessage(text).map((t) => ({ botId: p.id, botName: p.name, text: t, speed: p.typingSpeed }));
  }

  private deliver(items: QueueItem[]): Promise<QueueResult> {
    const hooks: QueueHooks = {
      typing: (i, on) => this.o.events.typing(i.botId, i.botName, on),
      deliver: (i) => {
        const t = this.now();
        const msg = this.o.memory.store.addMessage({
          groupId: this.o.groupId, senderId: i.botId, senderName: i.botName, kind: 'bot', text: i.text, ts: t,
        });
        const s = this.state;
        s.sentAt = s.sentAt.filter((x) => t - x < 60_000);
        s.sentAt.push(t);
        s.lastActivityAt = t;
        s.activitySinceStop = true;
        this.o.events.message(msg);
      },
    };
    return this.o.queue.enqueue(this.o.groupId, items, hooks);
  }
}
