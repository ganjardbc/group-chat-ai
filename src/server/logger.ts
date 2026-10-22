import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Logger {
  debug(msg: string, extra?: object): void;
  info(msg: string, extra?: object): void;
  warn(msg: string, extra?: object): void;
  error(msg: string, extra?: object): void;
  /** Log panggilan LLM (event: call | parse), ditulis juga ke file JSONL. */
  llm(entry: Record<string, unknown>): void;
}

export const nullLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  llm() {},
};

export function createLogger(opts: { llmLogFile?: string; verbose?: boolean } = {}): Logger {
  const { llmLogFile, verbose = false } = opts;
  if (llmLogFile) mkdirSync(dirname(llmLogFile), { recursive: true });

  const out = (level: string, msg: string, extra?: object) => {
    const line = `${new Date().toISOString()} ${level.padEnd(5)} ${msg}`;
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    if (extra && Object.keys(extra).length) fn(line, JSON.stringify(extra));
    else fn(line);
  };

  return {
    debug: (m, e) => verbose && out('debug', m, e),
    info: (m, e) => out('info', m, e),
    warn: (m, e) => out('warn', m, e),
    error: (m, e) => out('error', m, e),
    llm(entry) {
      const record = { ts: new Date().toISOString(), ...entry };
      if (verbose) out('llm', String(entry.event ?? ''), entry);
      if (!llmLogFile) return;
      try {
        appendFileSync(llmLogFile, JSON.stringify(record) + '\n');
      } catch {
        /* logging tidak boleh menjatuhkan aplikasi */
      }
    },
  };
}
