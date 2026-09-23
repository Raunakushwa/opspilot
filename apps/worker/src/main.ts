import { createDatabase, createPool } from '@opspilot/database';
import { Redis } from 'ioredis';
import { pino } from 'pino';

import { createAiServiceClient } from './clients/ai-service.js';
import { ConfigError, loadConfig } from './config.js';
import { createHealthServer } from './health.js';
import { createIngestionProcessor } from './processors/ingestion.js';
import { handlers } from './processors/index.js';
import { reconcilePendingIngestion } from './processors/reconcile.js';
import { ingestDocument, systemPing } from './queues/definitions.js';
import { createEnqueuer } from './queues/enqueue.js';
import { createRuntime } from './runtime.js';

const SHUTDOWN_GRACE_MS = 30_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({
    level: config.LOG_LEVEL,
    ...(config.LOG_PRETTY
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss.l' } } }
      : {}),
  });

  // BullMQ blocks on Redis commands, so it requires maxRetriesPerRequest: null.
  const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  connection.on('error', (err) => {
    logger.warn({ err }, 'redis connection error');
  });

  const pool = createPool({
    connectionString: config.DATABASE_URL,
    applicationName: 'opspilot-worker',
  });
  const db = createDatabase(pool);
  const ai = createAiServiceClient({
    baseUrl: config.AI_SERVICE_URL,
    token: config.INTERNAL_API_TOKEN,
  });

  const runtime = createRuntime({
    connection,
    logger,
    concurrency: config.WORKER_CONCURRENCY,
    handlers: {
      ...handlers,
      [ingestDocument.name]: createIngestionProcessor({ db, ai }) as (typeof handlers)[string],
    },
    definitions: [systemPing, ingestDocument],
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

  // Startup reconciliation, not a startup requirement: a failure here must not
  // stop the worker from processing everything else.
  void reconcilePendingIngestion(db, createEnqueuer(runtime.queues), logger).catch(
    (err: unknown) => {
      logger.error({ err }, 'ingestion reconciliation failed');
    },
  );

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
        await pool.end();
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
