import { Redis } from 'ioredis';
import pg from 'pg';

import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { postgresCheck, redisCheck } from './platform/dependencies.js';

const SHUTDOWN_GRACE_MS = 10_000;

async function main(): Promise<void> {
  const config = loadConfig();

  const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });
  // Without enableOfflineQueue=false, commands issued while Redis is down would
  // queue indefinitely and the readiness probe would time out instead of failing fast.
  const redis = new Redis(config.REDIS_URL, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });

  const app = await buildApp({ config, checks: [postgresCheck(pool), redisCheck(redis)] });

  // An idle client losing its connection must not crash the process; the pool
  // replaces it and readiness reports the outage.
  pool.on('error', (err) => {
    app.log.error({ err }, 'postgres pool error');
  });
  redis.on('error', (err) => {
    app.log.warn({ err }, 'redis connection error');
  });
  // Start without Redis if it is down: liveness stays green, readiness goes red,
  // and ioredis keeps reconnecting in the background.
  redis.connect().catch((err: unknown) => {
    app.log.warn({ err }, 'initial redis connection failed');
  });

  app.addHook('onClose', async () => {
    redis.disconnect();
    await pool.end();
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    setTimeout(() => {
      app.log.error('graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS).unref();
    app.close().then(
      () => process.exit(0),
      (err: unknown) => {
        app.log.error({ err }, 'error during shutdown');
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await app.listen({ host: config.API_HOST, port: config.API_PORT });
}

main().catch((err: unknown) => {
  // The logger may not exist yet (e.g. invalid config), so write directly to stderr.
  const message = err instanceof ConfigError ? err.message : err;
  // eslint-disable-next-line no-console
  console.error(message);
  process.exit(1);
});
