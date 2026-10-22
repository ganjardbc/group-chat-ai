import { describe, expect, it } from 'vitest';
import { nullLogger } from '../logger.js';
import { LlmClient, LlmUnavailableError } from './client.js';

type Reply = { status?: number; body?: unknown; headers?: Record<string, string>; throws?: Error };

function fakeFetch(script: Record<string, Reply[]>) {
  const calls: string[] = [];
  const fn = (async (_url: string, init: { body: string }) => {
    const model = JSON.parse(init.body).model as string;
    calls.push(model);
    const r = script[model]?.shift() ?? { status: 500 };
    if (r.throws) throw r.throws;
    const status = r.status ?? 200;
    return new Response(JSON.stringify(r.body ?? {}), { status, headers: r.headers });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const ok = (text: string) => ({ body: { choices: [{ message: { content: text } }] } });

function make(script: Record<string, Reply[]>, t = { now: 0 }) {
  const f = fakeFetch(script);
  const client = new LlmClient({
    baseUrl: 'http://x/v1', apiKey: 'k',
    mainModels: ['main-a', 'main-b'], lightModels: ['light'],
    maxTokensMain: 100, maxTokensLight: 50, timeoutMs: 1000,
    log: nullLogger, fetchFn: f.fn, now: () => t.now,
  });
  return { client, calls: f.calls, t };
}

const req = { tier: 'main' as const, purpose: 't', messages: [{ role: 'user' as const, content: 'hi' }] };

describe('LlmClient', () => {
  it('sukses di model pertama', async () => {
    const { client, calls } = make({ 'main-a': [ok('halo')] });
    const r = await client.chat(req);
    expect(r.text).toBe('halo');
    expect(r.model).toBe('main-a');
    expect(calls).toEqual(['main-a']);
  });

  it('429 -> fallback ke model berikutnya, lalu model itu di-cooldown sesuai Retry-After', async () => {
    const t = { now: 0 };
    const { client, calls } = make(
      { 'main-a': [{ status: 429, headers: { 'retry-after': '30' } }, ok('a lagi')], 'main-b': [ok('dari b'), ok('b lagi')] },
      t,
    );
    expect((await client.chat(req)).model).toBe('main-b');
    expect((await client.chat(req)).model).toBe('main-b'); // main-a masih cooldown
    expect(calls).toEqual(['main-a', 'main-b', 'main-b']);
    t.now = 31_000;
    expect((await client.chat(req)).model).toBe('main-a'); // cooldown selesai
  });

  it('error jaringan dan respons kosong juga jatuh ke fallback; light dipakai terakhir', async () => {
    const { client } = make({
      'main-a': [{ throws: new Error('ECONNRESET') }],
      'main-b': [{ body: { choices: [{ message: { content: '  ' } }] } }],
      light: [ok('dari light')],
    });
    expect((await client.chat(req)).model).toBe('light');
  });

  it('tier light hanya memakai model ringan', async () => {
    const { client, calls } = make({ light: [{ status: 500 }] });
    await expect(client.chat({ ...req, tier: 'light' })).rejects.toBeInstanceOf(LlmUnavailableError);
    expect(calls).toEqual(['light']);
  });

  it('semua gagal -> LlmUnavailableError; panggilan berikutnya cepat gagal tanpa fetch (cooldown)', async () => {
    const { client, calls } = make({
      'main-a': [{ status: 500 }], 'main-b': [{ status: 429 }], light: [{ status: 401 }],
    });
    await expect(client.chat(req)).rejects.toBeInstanceOf(LlmUnavailableError);
    const before = calls.length;
    await expect(client.chat(req)).rejects.toThrow(/cooldown/);
    expect(calls.length).toBe(before);
  });

  it('tanpa konfigurasi -> LlmUnavailableError', async () => {
    const client = new LlmClient({
      baseUrl: '', apiKey: '', mainModels: [], lightModels: [],
      maxTokensMain: 1, maxTokensLight: 1, timeoutMs: 1, log: nullLogger,
    });
    expect(client.configured).toBe(false);
    await expect(client.chat(req)).rejects.toBeInstanceOf(LlmUnavailableError);
  });
});
