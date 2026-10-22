export interface QueueItem {
  botId: string;
  botName: string;
  text: string;
  /** Pengali kecepatan ketik persona (>1 = lebih cepat). */
  speed?: number;
}

export interface QueueHooks {
  typing(item: QueueItem, on: boolean): void;
  deliver(item: QueueItem): void | Promise<void>;
}

export interface QueueResult {
  delivered: number;
  cancelled: boolean;
}

export interface QueueOptions {
  /** Pengali global (TYPING_SPEED). 0 = tanpa jeda sama sekali (untuk tes). */
  speed: number;
  rng?: () => number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Jeda "mengetik" acak sesuai panjang pesan (ms), sebelum dibagi kecepatan. */
export function typingDelayMs(text: string, rng: () => number): number {
  const perChar = 45 + rng() * 40;
  const base = 250 + rng() * 450;
  return clamp(Math.round(text.length * perChar + base), 700, 6500);
}

/**
 * Pecah pesan panjang menjadi beberapa bubble pendek di batas kalimat/klausa.
 * Maksimal `maxParts`; sisa digabung ke bagian terakhir.
 */
export function splitMessage(text: string, maxLen = 90, maxParts = 3): string[] {
  const t = text.trim();
  if (t.length <= maxLen) return [t];
  const pieces = t.split(/(?<=[.!?…])\s+|(?<=,)\s+/).filter(Boolean);
  const parts: string[] = [];
  for (const p of pieces) {
    const cur = parts[parts.length - 1];
    if (cur !== undefined && cur.length + 1 + p.length <= maxLen) parts[parts.length - 1] = `${cur} ${p}`;
    else parts.push(p);
  }
  if (parts.length <= maxParts) return parts;
  const head = parts.slice(0, maxParts - 1);
  return [...head, parts.slice(maxParts - 1).join(' ')];
}

class Batch {
  cancelled = false;
  wake: (() => void) | null = null;
}

/**
 * Antrean pengiriman pesan bot per grup: jeda ketik acak, indikator mengetik,
 * dan bisa dibatalkan (mis. saat pengguna memotong dengan pesan baru).
 */
export class MessageQueue {
  private batches = new Map<string, Set<Batch>>();
  private tails = new Map<string, Promise<unknown>>();
  private readonly rng: () => number;

  constructor(private readonly opts: QueueOptions) {
    this.rng = opts.rng ?? Math.random;
  }

  /** Sedang ada pengiriman yang belum selesai di grup ini? */
  busy(groupId: string): boolean {
    return (this.batches.get(groupId)?.size ?? 0) > 0;
  }

  enqueue(groupId: string, items: QueueItem[], hooks: QueueHooks): Promise<QueueResult> {
    const batch = new Batch();
    let set = this.batches.get(groupId);
    if (!set) this.batches.set(groupId, (set = new Set()));
    set.add(batch);

    const prev = this.tails.get(groupId) ?? Promise.resolve();
    const run = prev.then(() => this.process(batch, items, hooks)).finally(() => set.delete(batch));
    this.tails.set(groupId, run.catch(() => undefined));
    return run;
  }

  /** Batalkan semua pesan yang belum terkirim (yang sedang "mengetik" ikut berhenti). */
  cancel(groupId: string): void {
    for (const b of this.batches.get(groupId) ?? []) {
      b.cancelled = true;
      b.wake?.();
    }
  }

  private sleep(batch: Batch, ms: number): Promise<void> {
    if (ms <= 0 || batch.cancelled) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        batch.wake = null;
        resolve();
      }
      batch.wake = done;
    });
  }

  private async process(batch: Batch, items: QueueItem[], hooks: QueueHooks): Promise<QueueResult> {
    const global = this.opts.speed;
    let delivered = 0;
    for (let i = 0; i < items.length; i++) {
      if (batch.cancelled) break;
      const item = items[i]!;
      const factor = global > 0 ? global * (item.speed ?? 1) : 0;

      // "membaca" dulu sebelum mulai mengetik (hanya untuk pesan pertama)
      if (i === 0 && factor > 0) await this.sleep(batch, (300 + this.rng() * 900) / factor);
      if (batch.cancelled) break;

      hooks.typing(item, true);
      if (factor > 0) await this.sleep(batch, typingDelayMs(item.text, this.rng) / factor);
      hooks.typing(item, false);
      if (batch.cancelled) break;

      await hooks.deliver(item);
      delivered++;

      if (i < items.length - 1 && factor > 0) await this.sleep(batch, (150 + this.rng() * 600) / factor);
    }
    return { delivered, cancelled: batch.cancelled };
  }
}
