import type { ChatMessage } from '../../shared/protocol.js';
import type { LlmChat } from '../llm-client/client.js';
import type { Logger } from '../logger.js';
import type { Store } from './store.js';

export interface MemoryContext {
  summary: string;
  facts: string[];
  recent: ChatMessage[];
}

export interface MemoryOptions {
  contextMessages: number;
  /** Jumlah pesan lama yang belum terangkum sebelum ringkasan diperbarui. */
  summaryBatch: number;
  maxFactsInContext?: number;
}

const SUMMARY_SYSTEM = `Kamu merangkum obrolan grup berbahasa Indonesia untuk dijadikan memori singkat.
Tulis ringkasan gabungan (maks 80 kata, netral, tanpa basa-basi) dari RINGKASAN LAMA dan PESAN BARU.
Setelah ringkasan, boleh tulis 0-3 baris fakta stabil tentang anggota/grup (nama, hobi, rencana, hal yang disukai),
masing-masing diawali "FAKTA: " dan maksimal 15 kata. Jangan menulis fakta sepele atau yang sudah ada.`;

/** Pisahkan keluaran model menjadi ringkasan dan daftar fakta. */
export function parseSummaryOutput(raw: string): { summary: string; facts: string[] } {
  const facts: string[] = [];
  const body: string[] = [];
  for (const line of raw.replace(/<think>[\s\S]*?<\/think>/gi, '').split('\n')) {
    const m = /^\s*(?:[-*•]\s*)?(?:\*\*)?FAKTA(?:\*\*)?\s*:\s*(.+)$/i.exec(line);
    if (m) {
      const f = (m[1] ?? '').replace(/\*\*/g, '').trim();
      if (f && f.length <= 160) facts.push(f);
    } else if (line.trim()) {
      body.push(line.trim());
    }
  }
  const summary = body.join(' ').replace(/^ringkasan\s*:\s*/i, '').trim();
  return { summary, facts: facts.slice(0, 3) };
}

export class Memory {
  private summarizing = new Set<string>();

  constructor(
    readonly store: Store,
    private readonly llm: LlmChat,
    private readonly opts: MemoryOptions,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  context(groupId: string): MemoryContext {
    const { text } = this.store.getSummary(groupId);
    return {
      summary: text,
      facts: this.store.listFacts(groupId, this.opts.maxFactsInContext ?? 6).reverse(),
      recent: this.store.recent(groupId, this.opts.contextMessages),
    };
  }

  /**
   * Rangkum pesan yang sudah keluar dari jendela konteks tapi belum masuk ringkasan.
   * Dipanggil tanpa await; kegagalan hanya dicatat (ringkasan bukan fitur kritis).
   */
  async maybeSummarize(groupId: string): Promise<boolean> {
    if (this.summarizing.has(groupId)) return false;
    const latest = this.store.latestId(groupId);
    const window = this.store.recent(groupId, this.opts.contextMessages);
    const windowStart = window[0]?.id ?? latest + 1;
    const { text: oldSummary, uptoId } = this.store.getSummary(groupId);
    const pending = this.store.range(groupId, uptoId, windowStart - 1);
    if (pending.length < this.opts.summaryBatch) return false;

    this.summarizing.add(groupId);
    try {
      const transcript = pending.map((m) => `${m.senderName}: ${m.text}`).join('\n');
      const res = await this.llm.chat({
        tier: 'light',
        purpose: 'summary',
        temperature: 0.2,
        messages: [
          { role: 'system', content: SUMMARY_SYSTEM },
          { role: 'user', content: `RINGKASAN LAMA:\n${oldSummary || '(belum ada)'}\n\nPESAN BARU:\n${transcript}` },
        ],
      });
      const { summary, facts } = parseSummaryOutput(res.text);
      this.log.llm({ event: 'parse', callId: res.callId, purpose: 'summary', ok: Boolean(summary), facts: facts.length });
      if (!summary) return false;
      const lastId = pending[pending.length - 1]!.id;
      this.store.setSummary(groupId, summary, lastId, this.now());
      if (facts.length) this.store.addFacts(groupId, facts, this.now());
      return true;
    } catch (e) {
      this.log.warn('ringkasan gagal, dilewati', { error: (e as Error).message });
      return false;
    } finally {
      this.summarizing.delete(groupId);
    }
  }
}
