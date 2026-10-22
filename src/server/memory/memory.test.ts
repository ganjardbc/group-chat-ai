import { beforeEach, describe, expect, it } from 'vitest';
import type { LlmChat, LlmRequest } from '../llm-client/client.js';
import { LlmUnavailableError } from '../llm-client/client.js';
import { nullLogger } from '../logger.js';
import { Memory, parseSummaryOutput } from './memory.js';
import { Store } from './store.js';

const G = 'g';
let store: Store;

function add(n: number, from = 1) {
  for (let i = 0; i < n; i++) {
    store.addMessage({ groupId: G, senderId: 'u', senderName: 'Budi', kind: 'user', text: `pesan ${from + i}`, ts: from + i });
  }
}

function mockLlm(reply: string | Error) {
  const calls: LlmRequest[] = [];
  const llm: LlmChat = {
    async chat(req) {
      calls.push(req);
      if (reply instanceof Error) throw reply;
      return { text: reply, model: 'm', latencyMs: 1, callId: 'c' };
    },
  };
  return { llm, calls };
}

beforeEach(() => {
  store = new Store(':memory:');
});

describe('Store', () => {
  it('menyimpan dan mengambil pesan terakhir berurutan', () => {
    add(5);
    expect(store.recent(G, 3).map((m) => m.text)).toEqual(['pesan 3', 'pesan 4', 'pesan 5']);
    expect(store.latestId(G)).toBe(5);
    expect(store.range(G, 1, 3).map((m) => m.id)).toEqual([2, 3]);
  });
  it('fakta: duplikat diabaikan dan dibatasi cap', () => {
    store.addFacts(G, ['a', 'b', 'a'], 1, 2);
    store.addFacts(G, ['c'], 2, 2);
    expect(store.listFacts(G, 10)).toEqual(['c', 'b']);
  });
  it('ringkasan upsert', () => {
    store.setSummary(G, 'satu', 3, 1);
    store.setSummary(G, 'dua', 9, 2);
    expect(store.getSummary(G)).toEqual({ text: 'dua', uptoId: 9 });
  });
});

describe('parseSummaryOutput', () => {
  it('memisahkan ringkasan dan fakta', () => {
    const r = parseSummaryOutput('Ringkasan: mereka bahas makan.\nFAKTA: Budi suka sate\n- **FAKTA:** Rina alergi udang');
    expect(r.summary).toBe('mereka bahas makan.');
    expect(r.facts).toEqual(['Budi suka sate', 'Rina alergi udang']);
  });
});

describe('Memory', () => {
  const opts = { contextMessages: 5, summaryBatch: 4 };

  it('context: ringkasan + fakta + pesan terakhir', () => {
    add(8);
    store.setSummary(G, 'ringkas', 2, 1);
    store.addFacts(G, ['f1', 'f2'], 1);
    const m = new Memory(store, mockLlm('x').llm, opts, nullLogger);
    const c = m.context(G);
    expect(c.summary).toBe('ringkas');
    expect(c.facts).toEqual(['f1', 'f2']);
    expect(c.recent.map((x) => x.id)).toEqual([4, 5, 6, 7, 8]);
  });

  it('merangkum hanya pesan di luar jendela konteks setelah batch cukup', async () => {
    const { llm, calls } = mockLlm('Mereka ngobrol.\nFAKTA: Budi suka sate');
    const m = new Memory(store, llm, opts, nullLogger);
    add(8); // jendela = id 4..8, di luar jendela = 1..3 (< batch 4)
    expect(await m.maybeSummarize(G)).toBe(false);
    expect(calls).toHaveLength(0);

    add(2, 9); // jendela = 6..10, di luar = 1..5 (5 >= 4)
    expect(await m.maybeSummarize(G)).toBe(true);
    expect(calls[0]?.tier).toBe('light');
    expect(calls[0]?.messages[1]?.content).toContain('pesan 5');
    expect(calls[0]?.messages[1]?.content).not.toContain('pesan 6');
    expect(store.getSummary(G)).toEqual({ text: 'Mereka ngobrol.', uptoId: 5 });
    expect(store.listFacts(G, 5)).toEqual(['Budi suka sate']);

    // langsung dipanggil lagi: tidak ada pesan baru di luar jendela
    expect(await m.maybeSummarize(G)).toBe(false);
  });

  it('LLM gagal: tidak melempar error dan ringkasan tidak berubah', async () => {
    const m = new Memory(store, mockLlm(new LlmUnavailableError('habis')).llm, opts, nullLogger);
    add(12);
    expect(await m.maybeSummarize(G)).toBe(false);
    expect(store.getSummary(G).uptoId).toBe(0);
  });
});
