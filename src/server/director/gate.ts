import type { ReactionKind } from './templates.js';

export interface BotRef {
  id: string;
  name: string;
  aliases: string[];
}

export interface GateConfig {
  /** Maks giliran bot-ke-bot berturut-turut (tanpa pesan pengguna di antaranya). */
  maxBotStreak: number;
  maxLinesPerRound: number;
  rateLimitPerMin: number;
  idleStopMs: number;
  topicIdleMs: number;
  topicMinIntervalMs: number;
  maxTopicsPerIdle: number;
  reactProbability: number;
}

export interface GateState {
  lastUserAt: number;
  lastActivityAt: number;
  /** Giliran bot yang bukan balasan langsung ke pengguna sejak pesan pengguna terakhir. */
  botStreak: number;
  /** Timestamp pesan bot yang terkirim (untuk rate limit bergulir 60 detik). */
  sentAt: number[];
  lastTopicAt: number;
  topicsSinceUser: number;
  stopped: boolean;
  /** Ada pesan sejak berhenti/mulai terakhir? Menentukan perlu penutupan atau diam saja. */
  activitySinceStop: boolean;
}

export type GateTrigger =
  | { kind: 'user'; text: string; roll: number }
  | { kind: 'continue' }
  | { kind: 'idle' };

export type RoundMode = 'reply' | 'continue' | 'topic';

export type GateResult =
  | { action: 'skip'; reason: string }
  | { action: 'run'; mode: RoundMode; maxLines: number; forced: string[] }
  | { action: 'react'; kind: ReactionKind }
  | { action: 'close'; reason: string }
  | { action: 'stop'; reason: string };

export function newGateState(now: number): GateState {
  return {
    lastUserAt: now,
    lastActivityAt: now,
    botStreak: 0,
    sentAt: [],
    lastTopicAt: 0,
    topicsSinceUser: 0,
    stopped: false,
    activitySinceStop: false,
  };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Deteksi nama/alias bot disebut di teks (batas kata, tanpa peduli kapital, "@" opsional). */
export function detectMentions(text: string, bots: BotRef[]): string[] {
  const found: string[] = [];
  for (const b of bots) {
    const hit = [b.name, ...b.aliases].some((n) =>
      new RegExp(`(?<![\\p{L}\\p{N}])@?${escapeRe(n)}(?![\\p{L}\\p{N}])`, 'iu').test(text),
    );
    if (hit) found.push(b.id);
  }
  return found;
}

const LAUGH = /^(?:\s|[wk]{3,}|(?:ha){2,}h?|(?:he){2,}h?|lol|lmao|rofl|[😂🤣😆])+$/iu;
const ACK =
  /^(?:ok|oke|okey|okay|sip|siap|yoi|yoa|iya|ya|yap|yes|hm+|oh|ooh|owh|nah|mantap|mantul|noted|thanks|makasih|thx|tq|nice|keren)[\s.!]*$/i;
const QUESTION = /\?|^\s*(?:apa|siapa|kenapa|gimana|bagaimana|kapan|dimana|di mana|berapa|mengapa)\b/i;
const FAREWELL =
  /(?:^|[^\p{L}])(?:bye+|dadah|dah+ ya|gtg|g2g|pamit|udahan|tidur (?:dulu|ya|duluan)|cabut (?:dulu|ya)|off dulu|sampai (?:jumpa|besok|nanti)|bobo|good ?night|met malam|selamat malam|mlm ya)(?![\p{L}])/iu;

export type UserTextClass = 'laugh' | 'ack' | 'question' | 'plain';

export function classifyUserText(text: string): UserTextClass {
  const t = text.trim();
  if (LAUGH.test(t)) return 'laugh';
  if (ACK.test(t)) return 'ack';
  if (QUESTION.test(t)) return 'question';
  return 'plain';
}

export const isFarewell = (text: string) => FAREWELL.test(text);

/** Pesan "ringan": tertawa, anggukan, atau sangat pendek tanpa pertanyaan. */
export function isLightMessage(text: string): boolean {
  const c = classifyUserText(text);
  if (c === 'laugh' || c === 'ack') return true;
  return c !== 'question' && text.trim().length <= 12;
}

/**
 * Gate berbasis kode, tanpa LLM. Murni: semua waktu dan angka acak disuplai pemanggil.
 * Batas keras (rate limit, streak, idle) hanya ditegakkan di sini; LLM cuma memberi rekomendasi.
 */
export function evaluateGate(
  trigger: GateTrigger,
  state: GateState,
  cfg: GateConfig,
  now: number,
  bots: BotRef[],
): GateResult {
  const sent = state.sentAt.filter((t) => now - t < 60_000).length;
  const rateLeft = Math.max(0, cfg.rateLimitPerMin - sent);
  const streakLeft = Math.max(0, cfg.maxBotStreak - state.botStreak);
  const skip = (reason: string): GateResult => ({ action: 'skip', reason });

  switch (trigger.kind) {
    case 'user': {
      // Pamitan pengguna dijawab penutup (tidak kena rate limit; maks 2 pesan).
      if (isFarewell(trigger.text)) return { action: 'close', reason: 'user_farewell' };
      if (rateLeft <= 0) return skip('rate_limited');
      const forced = detectMentions(trigger.text, bots);
      if (forced.length) {
        return { action: 'run', mode: 'reply', maxLines: Math.min(cfg.maxLinesPerRound, rateLeft), forced };
      }
      if (isLightMessage(trigger.text)) {
        if (trigger.roll >= cfg.reactProbability) return skip('light_message_ignored');
        const cls = classifyUserText(trigger.text);
        const r2 = trigger.roll / Math.max(cfg.reactProbability, 1e-9); // ulang-skala ke [0,1)
        const kind: ReactionKind =
          cls === 'laugh' ? 'laugh' : cls === 'ack' ? (r2 < 0.5 ? 'agree' : 'emoji') : r2 < 0.5 ? 'surprise' : 'emoji';
        return { action: 'react', kind };
      }
      return { action: 'run', mode: 'reply', maxLines: Math.min(cfg.maxLinesPerRound, rateLeft), forced: [] };
    }

    case 'continue': {
      if (state.stopped) return skip('stopped');
      if (streakLeft <= 0) return skip('streak_cap');
      if (rateLeft <= 0) return skip('rate_limited');
      return {
        action: 'run',
        mode: 'continue',
        maxLines: Math.min(cfg.maxLinesPerRound, rateLeft, streakLeft),
        forced: [],
      };
    }

    case 'idle': {
      if (state.stopped) return skip('stopped');
      const userIdle = now - state.lastUserAt;
      if (userIdle >= cfg.idleStopMs) {
        return state.activitySinceStop
          ? { action: 'close', reason: 'idle_stop' }
          : { action: 'stop', reason: 'idle_stop_quiet' };
      }
      const quietFor = now - state.lastActivityAt;
      if (
        userIdle >= cfg.topicIdleMs &&
        quietFor >= cfg.topicIdleMs &&
        now - state.lastTopicAt >= cfg.topicMinIntervalMs &&
        state.topicsSinceUser < cfg.maxTopicsPerIdle
      ) {
        if (rateLeft <= 0) return skip('rate_limited');
        return {
          action: 'run',
          mode: 'topic',
          maxLines: Math.min(cfg.maxLinesPerRound, rateLeft, cfg.maxBotStreak),
          forced: [],
        };
      }
      return skip('not_idle_enough');
    }
  }
}
