import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../shared/protocol.js';
import { LlmUnavailableError, type LlmChat, type LlmRequest } from '../llm-client/client.js';
import { nullLogger } from '../logger.js';
import { Memory } from '../memory/memory.js';
import { Store } from '../memory/store.js';
import { loadPersonas } from '../persona/persona.js';
import { MessageQueue } from '../queue/queue.js';
import { Director } from './director.js';
import type { GateConfig } from './gate.js';

const G = 'g';
const bots = loadPersonas('./personas');

const gateCfg: GateConfig = {
  maxBotStreak: 3,
  maxLinesPerRound: 2,
  rateLimitPerMin: 100,
  idleStopMs: 5 * 60_000,
  topicIdleMs: 60_000,
  topicMinIntervalMs: 3 * 60_000,
  maxTopicsPerIdle: 2,
  reactProbability: 1,
};

type Script = string | Error | ((req: LlmRequest, n: number) => string | Promise<string>);

class Harness {
  store = new Store(':memory:');
  t = 1_000_000;
  calls: LlmRequest[] = [];
  sent: ChatMessage[] = [];
  typing: string[] = [];
  llmScripts: Script[] = [];
  llmDefault: Script = 'Rina: default\nLANJUT: tidak\nALASAN: x';
  director: Director;

  constructor(cfg: Partial<GateConfig> = {}) {
    const self = this;
    const llm: LlmChat = {
      async chat(req) {
        const n = self.calls.length;
        self.calls.push(req);
        const s = self.llmScripts.shift() ?? self.llmDefault;
        if (s instanceof Error) throw s;
        const text = typeof s === 'function' ? await s(req, n) : s;
        return { text, model: 'mock', latencyMs: 1, callId: `c${n}` };
      },
    };
    const memory = new Memory(this.store, llm, { contextMessages: 18, summaryBatch: 8 }, nullLogger);
    this.director = new Director({
      groupId: G, bots, llm, memory,
      queue: new MessageQueue({ speed: 0 }),
      gate: { ...gateCfg, ...cfg },
      events: {
        message: (m) => this.sent.push(m),
        typing: (id, _n, on) => this.typing.push(`${on ? '+' : '-'}${id}`),
      },
      log: nullLogger,
      now: () => this.t,
      rng: () => 0.25,
    });
  }

  say(text: string, name = 'Budi') {
    const m = this.store.addMessage({ groupId: G, senderId: 'u:' + name, senderName: name, kind: 'user', text, ts: this.t });
    return this.director.onUserMessage(m);
  }
  get texts() {
    return this.sent.map((m) => `${m.senderName}: ${m.text}`);
  }
}

let h: Harness;
beforeEach(() => {
  h = new Harness();
});

describe('Director: balasan', () => {
  it('menulis skrip dari LLM, mengirim berurutan dengan indikator mengetik', async () => {
    h.llmScripts = ['Rina: eh serius?\nBayu: hmm masuk akal\nLANJUT: tidak\nALASAN: selesai'];
    await h.say('tadi gue ketemu mantan di mall');
    expect(h.texts).toEqual(['Rina: eh serius?', 'Bayu: hmm masuk akal']);
    expect(h.typing).toEqual(['+rina', '-rina', '+bayu', '-bayu']);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.tier).toBe('main');
    expect(h.calls[0]?.messages[1]?.content).toContain('Budi: tadi gue ketemu mantan di mall');
  });

  it('prompt memuat persona, hubungan antar-bot, few-shot, ringkasan, dan fakta', async () => {
    h.store.setSummary(G, 'mereka bahas kucing', 0, 1);
    h.store.addFacts(G, ['Budi punya kucing bernama Mochi'], 1);
    await h.say('halo semua, apa kabar kalian hari ini?');
    const [sys, usr] = h.calls[0]!.messages.map((m) => m.content);
    expect(sys).toContain('Suka meledek Bayu');
    expect(sys).toContain('[Contoh 4]');
    expect(sys).not.toContain('{A}');
    expect(usr).toContain('mereka bahas kucing');
    expect(usr).toContain('Mochi');
  });

  it('batas keras jumlah baris: LLM menulis 4 baris, hanya maxLines yang terkirim', async () => {
    h.llmScripts = ['Rina: a1\nBayu: b1\nSari: c1\nKevin: d1\nLANJUT: tidak\nALASAN: x'];
    await h.say('ada yang mau cerita sesuatu gak nih?');
    expect(h.sent).toHaveLength(2);
  });

  it('bot yang disebut tapi tak ada di skrip tetap menjawab (ack), nama bot tak dikenal dibuang', async () => {
    h.llmScripts = ['Rina: hmm\nBudi: aku nyela\nLANJUT: tidak\nALASAN: x'];
    await h.say('Kevin, lo dimana?');
    expect(h.sent.map((m) => m.senderId)).toEqual(['kevin', 'rina']);
  });

  it('pesan ringan: reaksi template tanpa panggilan LLM', async () => {
    await h.say('wkwkwk');
    expect(h.calls).toHaveLength(0);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.kind).toBe('bot');
  });

  it('rate limit tegak: tidak ada panggilan LLM maupun pesan', async () => {
    const h2 = new Harness({ rateLimitPerMin: 1 });
    h2.director.state.sentAt = [h2.t - 1000];
    await h2.say('ceritain dong sesuatu yang seru');
    expect(h2.calls).toHaveLength(0);
    expect(h2.sent).toHaveLength(0);
  });
});

describe('Director: format rusak dan retry', () => {
  it('retry sekali bila format tak terbaca, lalu memakai hasilnya', async () => {
    h.llmScripts = ['maaf saya tidak mengerti', 'Rina: nah gini dong\nLANJUT: tidak\nALASAN: x'];
    await h.say('ceritain sesuatu dong yang lucu');
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]?.purpose).toBe('script:reply:retry');
    expect(h.calls[1]?.messages.at(-1)?.content).toMatch(/Ulangi/);
    expect(h.texts).toEqual(['Rina: nah gini dong']);
  });

  it('dua kali rusak: berhenti di dua panggilan (maks 1 retry) dan degradasi tanpa error', async () => {
    h.llmScripts = ['ngawur', 'masih ngawur'];
    await h.say('Bayu, ceritain dong sesuatu');
    expect(h.calls).toHaveLength(2);
    expect(h.sent.map((m) => m.senderId)).toEqual(['bayu']); // ack template untuk yang disebut
  });
});

describe('Director: degradasi saat LLM habis', () => {
  it('semua model error: balas template untuk yang disebut, tanpa melempar dan tanpa teks error', async () => {
    h.llmDefault = new LlmUnavailableError('semua model gagal');
    await expect(h.say('Rina, menurut lo gimana?')).resolves.toBeUndefined();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.senderId).toBe('rina');
    expect(h.sent[0]?.text).not.toMatch(/error|gagal|limit/i);
  });

  it('tanpa mention: boleh diam atau reaksi singkat; babak lanjutan/topik diam', async () => {
    h.llmDefault = new LlmUnavailableError('x');
    await h.say('hari ini panas banget ya di sini');
    expect(h.sent.length).toBeLessThanOrEqual(1);
    const before = h.sent.length;
    h.t += 70_000;
    await h.director.tick();
    expect(h.sent.length).toBe(before);
  });

  it('exception tak terduga ditangkap, loop tetap hidup untuk pesan berikutnya', async () => {
    h.llmScripts = [new Error('boom')];
    await h.say('hei semua, lagi pada ngapain nih?');
    h.llmScripts = ['Rina: lagi rebahan\nLANJUT: tidak\nALASAN: x'];
    await h.say('wah enak banget kalian ya');
    expect(h.texts).toContain('Rina: lagi rebahan');
  });
});

describe('Director: lanjut antar-bot dan batas streak', () => {
  it('LANJUT: ya memicu babak lanjutan sampai streak mentok', async () => {
    h.llmDefault = (_r, n) => `Rina: kalimat ${n}a\nBayu: kalimat ${n}b\nLANJUT: ya\nALASAN: masih seru`;
    await h.say('kalian setuju gak kerja dari rumah itu enak?');
    // babak 1 (balasan, 2 baris) + lanjutan: streak 0->2, lalu sisa 1 -> 1 baris, lalu mentok
    expect(h.calls).toHaveLength(3);
    expect(h.sent).toHaveLength(2 + 2 + 1);
    expect(h.director.state.botStreak).toBe(3);
  });

  it('LANJUT: tidak -> berhenti, menunggu manusia', async () => {
    h.llmDefault = 'Rina: oke\nLANJUT: tidak\nALASAN: tunggu Budi';
    await h.say('kalian setuju gak kerja dari rumah itu enak?');
    expect(h.calls).toHaveLength(1);
  });

  it('pesan baru saat LLM masih berpikir: skrip basi dibuang, balasan dibuat untuk pesan baru', async () => {
    let release!: (s: string) => void;
    h.llmScripts = [() => new Promise<string>((r) => (release = r))];
    const first = h.say('pesan pertama yang agak panjang ya');
    await Promise.resolve();
    h.llmScripts.push('Sari: iya mbak\nLANJUT: tidak\nALASAN: x');
    const second = h.say('eh ralat, maksud gue pesan yang kedua');
    release('Rina: balasan basi\nLANJUT: ya\nALASAN: x');
    await Promise.all([first, second]);
    expect(h.texts).toEqual(['Sari: iya mbak']);
    expect(h.calls).toHaveLength(2);
  });
});

describe('Director: idle, topik, dan penutupan', () => {
  it('sepi: memancing topik via LLM, lalu dibatasi frekuensinya', async () => {
    h.llmDefault = 'Kevin: eh kalian udah nonton trailer baru belum\nLANJUT: tidak\nALASAN: x';
    h.t += 30_000;
    await h.director.tick();
    expect(h.calls).toHaveLength(0);

    h.t += 40_000; // 70 dtk sejak pengguna terakhir
    await h.director.tick();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.purpose).toBe('script:topic');
    expect(h.sent).toHaveLength(1);

    h.t += 70_000; // interval minimum 3 menit belum lewat
    await h.director.tick();
    expect(h.calls).toHaveLength(1);
  });

  it('pengguna idle > N menit: 1-2 bot menutup, lalu diam total', async () => {
    h.llmDefault = 'Rina: hai\nLANJUT: tidak\nALASAN: x';
    await h.say('halo semuanya, selamat sore ya');
    const before = h.sent.length;
    const callsBefore = h.calls.length;

    h.t += 5 * 60_000 + 1000;
    await h.director.tick();
    const closers = h.sent.slice(before);
    expect(closers.length).toBeGreaterThanOrEqual(1);
    expect(closers.length).toBeLessThanOrEqual(2);
    expect(h.calls).toHaveLength(callsBefore); // penutup dari template, tanpa LLM
    expect(h.director.state.stopped).toBe(true);

    h.t += 30 * 60_000;
    await h.director.tick();
    expect(h.sent.length).toBe(before + closers.length);
  });

  it('pamitan pengguna dijawab penutup; pesan berikutnya membangunkan grup lagi', async () => {
    await h.say('gue tidur dulu ya, bye semua');
    expect(h.calls).toHaveLength(0);
    expect(h.sent.length).toBeGreaterThanOrEqual(1);
    expect(h.sent.length).toBeLessThanOrEqual(2);
    expect(h.sent.every((m) => !m.text.includes('{user}'))).toBe(true);
    expect(h.director.state.stopped).toBe(true);

    h.llmDefault = 'Sari: eh udah balik lho\nLANJUT: tidak\nALASAN: x';
    await h.say('eh ternyata belum ngantuk, ada apa nih tadi?');
    expect(h.director.state.stopped).toBe(false);
    expect(h.texts.at(-1)).toBe('Sari: eh udah balik lho');
  });

  it('grup tanpa aktivitas sejak mulai: berhenti diam-diam tanpa penutup', async () => {
    h.t += 6 * 60_000;
    await h.director.tick();
    expect(h.sent).toHaveLength(0);
    expect(h.director.state.stopped).toBe(true);
  });
});
