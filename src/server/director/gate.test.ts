import { describe, expect, it } from 'vitest';
import {
  classifyUserText,
  detectMentions,
  evaluateGate,
  isFarewell,
  isLightMessage,
  newGateState,
  type BotRef,
  type GateConfig,
  type GateState,
} from './gate.js';

const bots: BotRef[] = [
  { id: 'rina', name: 'Rina', aliases: ['rin'] },
  { id: 'bayu', name: 'Bayu', aliases: [] },
  { id: 'sari', name: 'Sari', aliases: ['mbak sari'] },
];

const cfg: GateConfig = {
  maxBotStreak: 3,
  maxLinesPerRound: 4,
  rateLimitPerMin: 6,
  idleStopMs: 5 * 60_000,
  topicIdleMs: 60_000,
  topicMinIntervalMs: 3 * 60_000,
  maxTopicsPerIdle: 2,
  reactProbability: 0.5,
};

const T0 = 10_000_000;
const state = (patch: Partial<GateState> = {}): GateState => ({ ...newGateState(T0), ...patch });
const user = (text: string, roll = 0.9) => ({ kind: 'user' as const, text, roll });

describe('detectMentions', () => {
  it('mendeteksi nama, alias, dan @ tanpa peduli kapital', () => {
    expect(detectMentions('eh rina, besok jadi?', bots)).toEqual(['rina']);
    expect(detectMentions('@Bayu sama RIN ikut gak', bots)).toEqual(['rina', 'bayu']);
    expect(detectMentions('mbak sari tolong dong', bots)).toEqual(['sari']);
  });
  it('tidak cocok di tengah kata', () => {
    expect(detectMentions('Rinaldi lagi di mana', bots)).toEqual([]);
    expect(detectMentions('kebayu-bayu banget', bots)).toEqual(['bayu']); // tanda hubung = batas kata
    expect(detectMentions('merinding', bots)).toEqual([]);
  });
});

describe('klasifikasi teks', () => {
  it('mengenali tawa, anggukan, pertanyaan', () => {
    expect(classifyUserText('wkwkwk')).toBe('laugh');
    expect(classifyUserText('😂😂')).toBe('laugh');
    expect(classifyUserText('oke')).toBe('ack');
    expect(classifyUserText('kenapa sih')).toBe('question');
    expect(classifyUserText('tadi gue ketemu mantan di mall')).toBe('plain');
  });
  it('pesan ringan: pendek tanpa tanya', () => {
    expect(isLightMessage('hehe')).toBe(true);
    expect(isLightMessage('gimana?')).toBe(false);
    expect(isLightMessage('tadi gue ketemu mantan di mall')).toBe(false);
  });
  it('mendeteksi pamitan', () => {
    expect(isFarewell('gue tidur dulu ya')).toBe(true);
    expect(isFarewell('dadah semua')).toBe(true);
    expect(isFarewell('GTG bro')).toBe(true);
    expect(isFarewell('tidurnya nyenyak')).toBe(false);
    expect(isFarewell('kita bahas bye-bye blue')).toBe(true); // false positive yang diterima
  });
});

describe('gate: pesan pengguna', () => {
  it('mention memaksa bot yang disebut berbicara', () => {
    const r = evaluateGate(user('Bayu, menurut lo gimana?'), state(), cfg, T0, bots);
    expect(r).toEqual({ action: 'run', mode: 'reply', maxLines: 4, forced: ['bayu'] });
  });
  it('mention menang atas pesan ringan', () => {
    const r = evaluateGate(user('rina?'), state(), cfg, T0, bots);
    expect(r.action).toBe('run');
  });
  it('pesan biasa menjalankan babak balasan', () => {
    const r = evaluateGate(user('tadi gue ketemu mantan di mall'), state(), cfg, T0, bots);
    expect(r).toMatchObject({ action: 'run', mode: 'reply', forced: [] });
  });
  it('pesan ringan: bereaksi template atau diam, tergantung roll', () => {
    expect(evaluateGate(user('wkwk', 0.2), state(), cfg, T0, bots)).toEqual({ action: 'react', kind: 'laugh' });
    expect(evaluateGate(user('wkwk', 0.8), state(), cfg, T0, bots)).toEqual({
      action: 'skip',
      reason: 'light_message_ignored',
    });
  });
  it('rate limit menahan balasan', () => {
    const sentAt = Array.from({ length: 6 }, (_, i) => T0 - 1000 * i);
    expect(evaluateGate(user('bahas apa nih'), state({ sentAt }), cfg, T0, bots)).toEqual({
      action: 'skip',
      reason: 'rate_limited',
    });
  });
  it('rate limit bergulir: pesan lebih dari 60 detik lalu tidak dihitung, sisa jatah membatasi maxLines', () => {
    const sentAt = [T0 - 61_000, T0 - 61_000, T0 - 5_000, T0 - 4_000, T0 - 3_000, T0 - 2_000];
    const r = evaluateGate(user('bahas apa nih'), state({ sentAt }), cfg, T0, bots);
    expect(r).toMatchObject({ action: 'run', maxLines: 2 });
  });
  it('pamitan memicu penutupan, bahkan saat rate limit', () => {
    const sentAt = Array.from({ length: 6 }, () => T0 - 1000);
    expect(evaluateGate(user('gue tidur dulu ya'), state({ sentAt }), cfg, T0, bots)).toEqual({
      action: 'close',
      reason: 'user_farewell',
    });
  });
});

describe('gate: lanjut antar-bot', () => {
  it('berjalan selama streak di bawah batas, dan maxLines mengikuti sisa streak', () => {
    const r = evaluateGate({ kind: 'continue' }, state({ botStreak: 1 }), cfg, T0, bots);
    expect(r).toEqual({ action: 'run', mode: 'continue', maxLines: 2, forced: [] });
  });
  it('berhenti keras saat streak mencapai batas', () => {
    expect(evaluateGate({ kind: 'continue' }, state({ botStreak: 3 }), cfg, T0, bots)).toEqual({
      action: 'skip',
      reason: 'streak_cap',
    });
  });
  it('tidak lanjut kalau sudah stopped atau kena rate limit', () => {
    expect(evaluateGate({ kind: 'continue' }, state({ stopped: true }), cfg, T0, bots)).toMatchObject({
      reason: 'stopped',
    });
    const sentAt = Array.from({ length: 6 }, () => T0 - 1000);
    expect(evaluateGate({ kind: 'continue' }, state({ sentAt }), cfg, T0, bots)).toMatchObject({
      reason: 'rate_limited',
    });
  });
});

describe('gate: idle', () => {
  it('belum cukup sepi: diam', () => {
    expect(evaluateGate({ kind: 'idle' }, state(), cfg, T0 + 30_000, bots)).toMatchObject({
      reason: 'not_idle_enough',
    });
  });
  it('sepi cukup lama: memancing topik', () => {
    const r = evaluateGate({ kind: 'idle' }, state(), cfg, T0 + 61_000, bots);
    expect(r).toMatchObject({ action: 'run', mode: 'topic', maxLines: 3 });
  });
  it('frekuensi topik dibatasi: interval minimum', () => {
    const s = state({ lastTopicAt: T0 + 30_000, lastActivityAt: T0 });
    expect(evaluateGate({ kind: 'idle' }, s, cfg, T0 + 90_000, bots)).toMatchObject({ reason: 'not_idle_enough' });
    expect(evaluateGate({ kind: 'idle' }, s, cfg, T0 + 30_000 + 3 * 60_000, bots)).toMatchObject({ mode: 'topic' });
  });
  it('frekuensi topik dibatasi: maksimum per periode sepi', () => {
    const s = state({ topicsSinceUser: 2, lastTopicAt: 1 });
    expect(evaluateGate({ kind: 'idle' }, s, cfg, T0 + 4 * 60_000, bots)).toMatchObject({ reason: 'not_idle_enough' });
  });
  it('tidak memancing topik kalau bot baru saja bicara', () => {
    const s = state({ lastActivityAt: T0 + 70_000 });
    expect(evaluateGate({ kind: 'idle' }, s, cfg, T0 + 80_000, bots)).toMatchObject({ reason: 'not_idle_enough' });
  });
  it('pengguna idle > N menit: penutupan bila ada aktivitas, stop diam bila tidak', () => {
    const t = T0 + 5 * 60_000;
    expect(evaluateGate({ kind: 'idle' }, state({ activitySinceStop: true }), cfg, t, bots)).toEqual({
      action: 'close',
      reason: 'idle_stop',
    });
    expect(evaluateGate({ kind: 'idle' }, state(), cfg, t, bots)).toEqual({
      action: 'stop',
      reason: 'idle_stop_quiet',
    });
  });
  it('setelah stopped, tidak ada lagi aktivitas', () => {
    expect(evaluateGate({ kind: 'idle' }, state({ stopped: true }), cfg, T0 + 99 * 60_000, bots)).toMatchObject({
      reason: 'stopped',
    });
  });
});
