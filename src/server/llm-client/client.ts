import { randomUUID } from 'node:crypto';
import type { Logger } from '../logger.js';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type LlmTier = 'main' | 'light';

export interface LlmRequest {
  tier: LlmTier;
  messages: LlmMessage[];
  maxTokens?: number;
  temperature?: number;
  /** Label untuk log, mis. "script:reply" atau "summary". */
  purpose: string;
}

export interface LlmResponse {
  text: string;
  model: string;
  latencyMs: number;
  callId: string;
}

export interface LlmChat {
  chat(req: LlmRequest): Promise<LlmResponse>;
}

/** Semua model di rantai fallback gagal / sedang cooldown / tidak dikonfigurasi. */
export class LlmUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmUnavailableError';
  }
}

export interface LlmClientOptions {
  baseUrl: string;
  apiKey: string;
  mainModels: string[];
  lightModels: string[];
  maxTokensMain: number;
  maxTokensLight: number;
  timeoutMs: number;
  log: Logger;
  fetchFn?: typeof fetch;
  now?: () => number;
}

export class LlmClient implements LlmChat {
  private cooldown = new Map<string, number>();
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: LlmClientOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  get configured(): boolean {
    return Boolean(this.opts.baseUrl && (this.opts.mainModels.length || this.opts.lightModels.length));
  }

  /** Main: model utama lalu model ringan sebagai cadangan. Light: hanya model ringan. */
  private chain(tier: LlmTier): string[] {
    const { mainModels, lightModels } = this.opts;
    return tier === 'main' ? [...mainModels, ...lightModels] : [...lightModels];
  }

  private endpoint(): string {
    const base = this.opts.baseUrl.replace(/\/+$/, '');
    return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
  }

  async chat(req: LlmRequest): Promise<LlmResponse> {
    const callId = randomUUID().slice(0, 8);
    const models = [...new Set(this.chain(req.tier))];
    if (!this.opts.baseUrl || models.length === 0) {
      throw new LlmUnavailableError('LLM belum dikonfigurasi (NINEROUTER_BASE_URL / MODEL_*)');
    }

    const maxTokens = req.maxTokens ?? (req.tier === 'main' ? this.opts.maxTokensMain : this.opts.maxTokensLight);
    const attempts: string[] = [];

    for (const model of models) {
      const until = this.cooldown.get(model) ?? 0;
      if (this.now() < until) {
        attempts.push(`${model}: cooldown`);
        continue;
      }
      const started = this.now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs);
      try {
        const res = await this.fetchFn(this.endpoint(), {
          method: 'POST',
          signal: ctrl.signal,
          headers: {
            'content-type': 'application/json',
            ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model,
            messages: req.messages,
            max_tokens: maxTokens,
            temperature: req.temperature ?? (req.tier === 'main' ? 0.9 : 0.3),
            stream: false,
          }),
        });
        const latencyMs = this.now() - started;

        if (!res.ok) {
          const retryAfter = Number(res.headers.get('retry-after'));
          const wait =
            res.status === 429
              ? Number.isFinite(retryAfter) && retryAfter > 0
                ? retryAfter * 1000
                : 60_000
              : res.status === 401 || res.status === 403
                ? 300_000
                : res.status >= 500
                  ? 15_000
                  : 60_000;
          this.cooldown.set(model, this.now() + wait);
          attempts.push(`${model}: HTTP ${res.status}`);
          this.opts.log.llm({
            event: 'call', callId, purpose: req.purpose, tier: req.tier, model,
            ok: false, status: res.status, latencyMs, cooldownMs: wait,
          });
          continue;
        }

        const json = (await res.json()) as {
          choices?: { message?: { content?: unknown } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const content = json.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || !content.trim()) {
          this.cooldown.set(model, this.now() + 10_000);
          attempts.push(`${model}: respons kosong`);
          this.opts.log.llm({
            event: 'call', callId, purpose: req.purpose, tier: req.tier, model,
            ok: false, status: res.status, latencyMs, error: 'empty_content',
          });
          continue;
        }
        this.opts.log.llm({
          event: 'call', callId, purpose: req.purpose, tier: req.tier, model,
          ok: true, status: res.status, latencyMs, usage: json.usage,
        });
        return { text: content, model, latencyMs, callId };
      } catch (e) {
        const latencyMs = this.now() - started;
        const err = (e as Error).name === 'AbortError' ? 'timeout' : (e as Error).message;
        this.cooldown.set(model, this.now() + 15_000);
        attempts.push(`${model}: ${err}`);
        this.opts.log.llm({
          event: 'call', callId, purpose: req.purpose, tier: req.tier, model,
          ok: false, latencyMs, error: err,
        });
      } finally {
        clearTimeout(timer);
      }
    }
    throw new LlmUnavailableError(`semua model gagal (${attempts.join('; ')})`);
  }
}
