import { Redis } from 'ioredis';
import { pino } from 'pino';

import { ConfigError, loadConfig } from './config.js';
import { createHealthServer } from './health.js';
import { handlers } from './processors/index.js';
import { systemPing } from './queues/definitions.js';
import { createRuntime } from './runtime.js';

const SHUTDOWN_GRACE_MS = 30_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({
    level: config.LOG_LEVEL,
    ...(config.NODE_ENV === 'development'
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss.l' } } }
      : {}),
  });

  // BullMQ blocks on Redis commands, so it requires maxRetriesPerRequest: null.
  const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  connection.on('error', (err) => {
    logger.warn({ err }, 'redis connection error');
  });

  const runtime = createRuntime({
    connection,
    logger,
    concurrency: config.WORKER_CONCURRENCY,
    handlers,
    definitions: [systemPing],
  });

  let running = true;
  const health = createHealthServer({
    redis: connection,
    logger,
    timeoutMs: config.READINESS_TIMEOUT_MS,
    isRunning: () => running,
  });
  await health.listen({ host: config.WORKER_HOST, port: config.WORKER_PORT });
  logger.info({ queues: Object.keys(runtime.queues) }, 'worker started');

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    running = false;
    logger.info({ signal }, 'shutting down');
    // Long grace period on purpose: in-flight jobs (embeddings, AI runs) are
    // expensive to redo, so we let them finish rather than killing them.
    setTimeout(() => {
      logger.error('graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS).unref();

    void (async () => {
      try {
        await runtime.close();
        await health.close();
        connection.disconnect();
        process.exit(0);
      } catch (err) {
        logger.error({ err }, 'error during shutdown');
        process.exit(1);
      }
    })();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
});
