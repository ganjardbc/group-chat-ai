import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { ClientEvent, ServerEvent } from '../../shared/protocol.js';
import { Director } from '../director/director.js';
import type { LlmChat } from '../llm-client/client.js';
import { nullLogger } from '../logger.js';
import { Memory } from '../memory/memory.js';
import { Store } from '../memory/store.js';
import { loadPersonas } from '../persona/persona.js';
import { MessageQueue } from '../queue/queue.js';
import { Gateway, sanitizeName } from './gateway.js';

const bots = loadPersonas('./personas');
let gw: Gateway | null = null;

async function boot(llmText: string) {
  const store = new Store(':memory:');
  const llm: LlmChat = { chat: async () => ({ text: llmText, model: 'mock', latencyMs: 1, callId: 'c' }) };
  const memory = new Memory(store, llm, { contextMessages: 18, summaryBatch: 8 }, nullLogger);
  const g: Gateway = new Gateway({
    group: { id: 'main', name: 'Tes' }, bots, memory, webDir: './nonexistent', log: nullLogger,
    onUserMessage: (m) => void director.onUserMessage(m),
    onUserJoin: () => director.onUserJoin(),
  });
  const director: Director = new Director({
    groupId: 'main', bots, llm, memory, queue: new MessageQueue({ speed: 0 }),
    gate: {
      maxBotStreak: 3, maxLinesPerRound: 3, rateLimitPerMin: 50, idleStopMs: 3e5, topicIdleMs: 6e4,
      topicMinIntervalMs: 18e4, maxTopicsPerIdle: 2, reactProbability: 1,
    },
    log: nullLogger,
    events: {
      message: (m) => g.broadcastMessage(m),
      typing: (id, n, on) => g.broadcastTyping(id, n, on),
    },
  });
  gw = g;
  const port = await g.listen(0);
  return { port, director };
}

function client(port: number) {
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  const events: ServerEvent[] = [];
  ws.on('message', (d) => events.push(JSON.parse(d.toString())));
  const open = new Promise<void>((r) => ws.on('open', () => r()));
  const send = (e: ClientEvent) => ws.send(JSON.stringify(e));
  const waitFor = async (pred: (e: ServerEvent[]) => boolean, ms = 2000) => {
    const end = Date.now() + ms;
    while (!pred(events)) {
      if (Date.now() > end) throw new Error('timeout; events=' + JSON.stringify(events.map((e) => e.type)));
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return { ws, events, open, send, waitFor };
}

afterEach(async () => {
  await gw?.close();
  gw = null;
});

describe('Gateway', () => {
  it('join -> welcome; kirim pesan -> siaran pesan pengguna + balasan bot + indikator mengetik', async () => {
    const { port, director } = await boot('Rina: halo juga budi\nBayu: yo\nLANJUT: tidak\nALASAN: x');
    const c = client(port);
    await c.open;
    c.send({ type: 'join', name: 'Budi' });
    await c.waitFor((e) => e.some((x) => x.type === 'welcome'));
    const welcome = c.events.find((e) => e.type === 'welcome');
    expect(welcome).toMatchObject({ you: 'Budi', group: { name: 'Tes' } });
    expect((welcome as Extract<ServerEvent, { type: 'welcome' }>).bots).toHaveLength(4);

    c.send({ type: 'message', text: 'halo semuanya, lagi pada ngapain?' });
    await c.waitFor((e) => e.filter((x) => x.type === 'message').length >= 3);
    await director.idle();

    const msgs = c.events.flatMap((e) => (e.type === 'message' ? [e.message] : []));
    expect(msgs.map((m) => `${m.senderName}:${m.text}`)).toEqual([
      'Budi:halo semuanya, lagi pada ngapain?',
      'Rina:halo juga budi',
      'Bayu:yo',
    ]);
    expect(c.events.filter((e) => e.type === 'typing').map((e) => e.type === 'typing' && e.on)).toEqual([true, false, true, false]);
    c.ws.close();
  });

  it('klien baru menerima riwayat; pesan dari klien belum join diabaikan', async () => {
    const { port, director } = await boot('Sari: iya\nLANJUT: tidak\nALASAN: x');
    const a = client(port);
    await a.open;
    a.send({ type: 'message', text: 'tanpa join' });
    a.send({ type: 'join', name: 'Ani' });
    await a.waitFor((e) => e.some((x) => x.type === 'welcome'));
    a.send({ type: 'message', text: 'Sari, kamu di mana?' });
    await a.waitFor((e) => e.filter((x) => x.type === 'message').length >= 2);
    await director.idle();

    const b = client(port);
    await b.open;
    b.send({ type: 'join', name: 'Bima' });
    await b.waitFor((e) => e.some((x) => x.type === 'welcome'));
    const w = b.events.find((e) => e.type === 'welcome') as Extract<ServerEvent, { type: 'welcome' }>;
    expect(w.history.map((m) => m.text)).toEqual(['Sari, kamu di mana?', 'iya']);
    expect(w.users.sort()).toEqual(['Ani', 'Bima']);
    a.ws.close();
    b.ws.close();
  });

  it('JSON rusak dan pesan kosong tidak membuat server jatuh', async () => {
    const { port } = await boot('Rina: x\nLANJUT: tidak\nALASAN: x');
    const c = client(port);
    await c.open;
    c.ws.send('{bukan json');
    c.send({ type: 'join', name: '   ' }); // nama kosong ditolak
    c.send({ type: 'join', name: 'Ok' });
    await c.waitFor((e) => e.some((x) => x.type === 'welcome'));
    c.send({ type: 'message', text: '   ' });
    const res = await fetch(`http://localhost:${port}/health`);
    expect(await res.json()).toMatchObject({ ok: true });
    c.ws.close();
  });
});

describe('sanitizeName', () => {
  it('bersihkan, batasi panjang, dan cegah menyamar jadi bot', () => {
    expect(sanitizeName('  Budi\n  Santoso ', bots)).toBe('Budi Santoso');
    expect(sanitizeName('x'.repeat(100), bots)).toHaveLength(24);
    expect(sanitizeName('rina', bots)).toBe('rina (manusia)');
    expect(sanitizeName('', bots)).toBeNull();
    expect(sanitizeName(42, bots)).toBeNull();
  });
});
