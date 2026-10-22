import { describe, expect, it, vi } from 'vitest';
import { MessageQueue, splitMessage, typingDelayMs, type QueueItem } from './queue.js';

const item = (text: string, botId = 'rina'): QueueItem => ({ botId, botName: botId, text });

describe('typingDelayMs', () => {
  it('lebih panjang untuk pesan lebih panjang, dengan batas bawah dan atas', () => {
    const rng = () => 0.5;
    expect(typingDelayMs('ok', rng)).toBe(700);
    expect(typingDelayMs('a'.repeat(30), rng)).toBeGreaterThan(typingDelayMs('a'.repeat(10), rng));
    expect(typingDelayMs('a'.repeat(5000), rng)).toBe(6500);
  });
  it('acak: rng berbeda memberi jeda berbeda', () => {
    const t = 'a'.repeat(30);
    expect(typingDelayMs(t, () => 0)).not.toBe(typingDelayMs(t, () => 1));
  });
});

describe('splitMessage', () => {
  it('pesan pendek tidak dipecah', () => {
    expect(splitMessage('wkwk iya sih')).toEqual(['wkwk iya sih']);
  });
  it('memecah di batas kalimat, tiap bagian pendek', () => {
    const parts = splitMessage(
      'Eh tadi gue ketemu mantan di mall, awkward banget sumpah. Terus dia nyapa gue duluan! Ya gue pura-pura gak liat aja.',
      60,
    );
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.length).toBeLessThanOrEqual(3);
    expect(parts.join(' ')).toContain('mantan');
  });
  it('maksimal maxParts dan tidak ada teks yang hilang', () => {
    const text = 'satu dua tiga. empat lima enam. tujuh delapan sembilan. sepuluh sebelas duabelas. tigabelas.';
    const parts = splitMessage(text, 20, 3);
    expect(parts).toHaveLength(3);
    expect(parts.join(' ')).toBe(text);
  });
});

describe('MessageQueue', () => {
  it('mengirim berurutan dengan indikator mengetik on/off sebelum tiap pesan', async () => {
    const q = new MessageQueue({ speed: 0 });
    const log: string[] = [];
    const res = await q.enqueue('g', [item('a'), item('b', 'bayu')], {
      typing: (i, on) => log.push(`${on ? 'start' : 'stop'}:${i.text}`),
      deliver: (i) => void log.push(`msg:${i.text}`),
    });
    expect(res).toEqual({ delivered: 2, cancelled: false });
    expect(log).toEqual(['start:a', 'stop:a', 'msg:a', 'start:b', 'stop:b', 'msg:b']);
  });

  it('cancel menghentikan sisa antrean, mematikan indikator, dan membangunkan sleep', async () => {
    vi.useFakeTimers();
    try {
      const q = new MessageQueue({ speed: 1, rng: () => 0.5 });
      const delivered: string[] = [];
      const typing: string[] = [];
      const p = q.enqueue('g', [item('pertama'), item('kedua')], {
        typing: (i, on) => typing.push(`${on ? '+' : '-'}${i.text}`),
        deliver: (i) => void delivered.push(i.text),
      });
      expect(q.busy('g')).toBe(true);
      await vi.advanceTimersByTimeAsync(500); // masih fase "membaca"/mengetik
      q.cancel('g');
      const res = await p;
      expect(res.cancelled).toBe(true);
      expect(delivered).toEqual([]);
      expect(typing.filter((t) => t.startsWith('+')).length).toBe(typing.filter((t) => t.startsWith('-')).length);
      expect(q.busy('g')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('jeda nyata dipakai saat speed > 0', async () => {
    vi.useFakeTimers();
    try {
      const q = new MessageQueue({ speed: 1, rng: () => 0.5 });
      const got: string[] = [];
      const p = q.enqueue('g', [item('halo')], { typing: () => {}, deliver: (i) => void got.push(i.text) });
      await vi.advanceTimersByTimeAsync(100);
      expect(got).toEqual([]);
      await vi.advanceTimersByTimeAsync(5000);
      await p;
      expect(got).toEqual(['halo']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('batch pada grup yang sama diproses bergantian, bukan bersamaan', async () => {
    const q = new MessageQueue({ speed: 0 });
    const order: string[] = [];
    const hooks = (tag: string) => ({ typing: () => {}, deliver: (i: QueueItem) => void order.push(`${tag}${i.text}`) });
    await Promise.all([q.enqueue('g', [item('1'), item('2')], hooks('A')), q.enqueue('g', [item('3')], hooks('B'))]);
    expect(order).toEqual(['A1', 'A2', 'B3']);
  });
});
