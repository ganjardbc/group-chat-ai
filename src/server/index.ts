import { loadConfig } from './config.js';
import { Director } from './director/director.js';
import { Gateway } from './gateway/gateway.js';
import { LlmClient } from './llm-client/client.js';
import { createLogger } from './logger.js';
import { Memory } from './memory/memory.js';
import { Store } from './memory/store.js';
import { loadPersonas, validateRoster } from './persona/persona.js';
import { MessageQueue } from './queue/queue.js';

try {
  process.loadEnvFile('.env');
} catch {
  /* .env opsional; variabel bisa datang dari environment */
}

async function main() {
  const cfg = loadConfig();
  const log = createLogger({ llmLogFile: cfg.logFile, verbose: process.env.LOG_LEVEL === 'debug' });

  const bots = loadPersonas(cfg.personasDir, cfg.botIds);
  for (const w of validateRoster(bots)) log.warn(w);
  log.info(`persona: ${bots.map((b) => b.name).join(', ')}`);

  const llm = new LlmClient({ ...cfg.llm, log });
  if (!llm.configured) {
    log.warn('NINEROUTER_BASE_URL / MODEL_* belum diisi: bot hanya memakai reaksi template (mode degradasi).');
  }

  const store = new Store(cfg.dbPath);
  const memory = new Memory(
    store,
    llm,
    { contextMessages: cfg.director.contextMessages, summaryBatch: cfg.director.summaryBatch },
    log,
  );
  const queue = new MessageQueue({ speed: cfg.typingSpeed });

  // Gateway dan Director saling memanggil lewat closure; keduanya dibuat sebelum dipakai.
  const gateway: Gateway = new Gateway({
    group: { id: cfg.groupId, name: cfg.groupName },
    bots,
    memory,
    webDir: cfg.webDir,
    log,
    onUserMessage: (m) => void director.onUserMessage(m),
    onUserJoin: () => director.onUserJoin(),
  });

  const director: Director = new Director({
    groupId: cfg.groupId,
    bots,
    llm,
    memory,
    queue,
    gate: cfg.director,
    log,
    events: {
      message: (m) => gateway.broadcastMessage(m),
      typing: (id, name, on) => gateway.broadcastTyping(id, name, on),
    },
  });

  const timer = setInterval(() => {
    if (gateway.joinedCount > 0) void director.tick();
  }, cfg.director.tickMs);

  const port = await gateway.listen(cfg.port);
  log.info(`siap di http://localhost:${port}  (grup "${cfg.groupName}")`);

  const shutdown = async () => {
    clearInterval(timer);
    await gateway.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
