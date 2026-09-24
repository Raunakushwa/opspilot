import { createDatabase, createPool } from '@opspilot/database';
import { Redis } from 'ioredis';
import { pino } from 'pino';

import { createAiServiceClient } from './clients/ai-service.js';
import { ConfigError, loadConfig } from './config.js';
import { createHealthServer } from './health.js';
import { SignJWT } from 'jose';

import { createRunPersistence } from './ai/persistence.js';
import { estimateCostUsd } from './pricing.js';
import { createIngestionProcessor } from './processors/ingestion.js';
import { createInvestigationProcessor } from './processors/investigation.js';
import { createOutboxRelay } from './processors/outbox-relay.js';
import { handlers } from './processors/index.js';
import { reconcilePendingIngestion } from './processors/reconcile.js';
import { ingestDocument, runInvestigation, systemPing } from './queues/definitions.js';
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

  // Minting here, not in the API: the token must live exactly as long as the
  // run, and the worker is what knows when the run starts.
  const mintToken = async (claims: {
    userId: string;
    organizationId: string;
    runId: string;
  }): Promise<string> => {
    const secret = config.INTERNAL_JWT_SECRET;
    if (!secret) {
      throw new Error('INTERNAL_JWT_SECRET is required to run investigations');
    }
    return new SignJWT({ org: claims.organizationId, run: claims.runId, scope: 'tools:read' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.userId)
      .setIssuer('opspilot-api')
      .setAudience('opspilot-tool-gateway')
      .setIssuedAt()
      .setExpirationTime(`${String(config.DELEGATION_TTL_SECONDS)}s`)
      .sign(new TextEncoder().encode(secret));
  };

  const runtime = createRuntime({
    connection,
    logger,
    concurrency: config.WORKER_CONCURRENCY,
    handlers: {
      ...handlers,
      [ingestDocument.name]: createIngestionProcessor({ db, ai }) as (typeof handlers)[string],
      [runInvestigation.name]: createInvestigationProcessor({
        db,
        ai,
        mintToken,
        persist: createRunPersistence(db),
        estimateCost: estimateCostUsd,
      }) as (typeof handlers)[string],
    },
    definitions: [systemPing, ingestDocument, runInvestigation],
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

  // A separate connection: the relay publishes while BullMQ's connection is
  // busy blocking on queue reads.
  const publisher = connection.duplicate();
  const relay = createOutboxRelay({ db, redis: publisher, logger });
  relay.start();
  logger.info('outbox relay started');

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
        relay.stop();
        await runtime.close();
        await health.close();
        await pool.end();
        publisher.disconnect();
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
