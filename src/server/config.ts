export interface Config {
  port: number;
  dbPath: string;
  personasDir: string;
  webDir: string;
  logFile: string;
  groupId: string;
  groupName: string;
  botIds: string[] | null;
  llm: {
    baseUrl: string;
    apiKey: string;
    mainModels: string[];
    lightModels: string[];
    maxTokensMain: number;
    maxTokensLight: number;
    timeoutMs: number;
  };
  director: {
    maxBotStreak: number;
    maxLinesPerRound: number;
    rateLimitPerMin: number;
    idleStopMs: number;
    topicIdleMs: number;
    topicMinIntervalMs: number;
    maxTopicsPerIdle: number;
    reactProbability: number;
    contextMessages: number;
    summaryBatch: number;
    tickMs: number;
  };
  typingSpeed: number;
}

type Env = Record<string, string | undefined>;

function num(env: Env, key: string, def: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

function str(env: Env, key: string, def = ''): string {
  const raw = env[key];
  return raw === undefined || raw.trim() === '' ? def : raw.trim();
}

function list(env: Env, key: string): string[] {
  return str(env, key)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(env: Env = process.env): Config {
  const botIds = list(env, 'BOT_IDS');
  return {
    port: num(env, 'PORT', 3000),
    dbPath: str(env, 'DB_PATH', './data/chat.db'),
    personasDir: str(env, 'PERSONAS_DIR', './personas'),
    webDir: str(env, 'WEB_DIR', './web/dist'),
    logFile: str(env, 'LLM_LOG_FILE', './data/llm.log.jsonl'),
    groupId: 'main',
    groupName: str(env, 'GROUP_NAME', 'Geng Receh'),
    botIds: botIds.length ? botIds : null,
    llm: {
      baseUrl: str(env, 'NINEROUTER_BASE_URL'),
      apiKey: str(env, 'NINEROUTER_API_KEY'),
      mainModels: list(env, 'MODEL_MAIN'),
      lightModels: list(env, 'MODEL_LIGHT'),
      maxTokensMain: num(env, 'MAX_TOKENS_MAIN', 280),
      maxTokensLight: num(env, 'MAX_TOKENS_LIGHT', 160),
      timeoutMs: num(env, 'LLM_TIMEOUT_MS', 20_000),
    },
    director: {
      maxBotStreak: num(env, 'MAX_BOT_STREAK', 4),
      maxLinesPerRound: num(env, 'MAX_LINES_PER_ROUND', 4),
      rateLimitPerMin: num(env, 'RATE_LIMIT_PER_MIN', 10),
      idleStopMs: num(env, 'IDLE_STOP_MIN', 5) * 60_000,
      topicIdleMs: num(env, 'TOPIC_IDLE_SEC', 75) * 1000,
      topicMinIntervalMs: num(env, 'TOPIC_MIN_INTERVAL_MIN', 3) * 60_000,
      maxTopicsPerIdle: num(env, 'MAX_TOPICS_PER_IDLE', 2),
      reactProbability: num(env, 'REACT_PROBABILITY', 0.5),
      contextMessages: num(env, 'CONTEXT_MESSAGES', 18),
      summaryBatch: num(env, 'SUMMARY_BATCH', 8),
      tickMs: num(env, 'TICK_SEC', 5) * 1000,
    },
    typingSpeed: num(env, 'TYPING_SPEED', 1),
  };
}
