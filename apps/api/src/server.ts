import { createDatabase, createPool } from '@opspilot/database';
import { Redis } from 'ioredis';

import { buildApp } from './app.js';
import { createAuthRepository } from './modules/auth/repository.js';
import { createAuthService } from './modules/auth/service.js';
import { createIncidentRepository } from './modules/incidents/repository.js';
import { createIncidentService } from './modules/incidents/service.js';
import { createOrganizationRepository } from './modules/organizations/repository.js';
import { buildToolGateway } from './tool-gateway/server.js';
import { createOrganizationService } from './modules/organizations/service.js';
import { ConfigError, loadConfig } from './config.js';
import { postgresCheck, redisCheck } from './platform/dependencies.js';

const SHUTDOWN_GRACE_MS = 10_000;

async function main(): Promise<void> {
  const config = loadConfig();

  const pool = createPool({
    connectionString: config.DATABASE_URL,
    applicationName: 'opspilot-api',
  });
  // Without enableOfflineQueue=false, commands issued while Redis is down would
  // queue indefinitely and the readiness probe would time out instead of failing fast.
  const redis = new Redis(config.REDIS_URL, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });

  const db = createDatabase(pool);
  const auth = createAuthService({
    repository: createAuthRepository(db),
    sessionTtlMs: config.SESSION_TTL_HOURS * 60 * 60 * 1000,
  });
  const organizations = createOrganizationService({
    repository: createOrganizationRepository(db),
  });
  const incidents = createIncidentService(createIncidentRepository(db));

  const app = await buildApp({
    config,
    checks: [postgresCheck(pool), redisCheck(redis)],
    auth,
    organizations,
    incidents,
    db,
    rateLimitRedis: redis,
  });

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

  // The gateway listens on its own port so it can be kept off the public
  // load balancer entirely, rather than relying on a path prefix.
  if (config.INTERNAL_JWT_SECRET) {
    const gateway = buildToolGateway({ db, secret: config.INTERNAL_JWT_SECRET });
    await gateway.listen({ host: config.API_HOST, port: config.INTERNAL_PORT });
    app.addHook('onClose', async () => {
      await gateway.close();
    });
    app.log.info({ port: config.INTERNAL_PORT }, 'tool gateway listening');
  } else if (config.NODE_ENV === 'production') {
    throw new Error('INTERNAL_JWT_SECRET is required in production');
  } else {
    app.log.warn('INTERNAL_JWT_SECRET not set: tool gateway disabled');
  }

  await app.listen({ host: config.API_HOST, port: config.API_PORT });
}

main().catch((err: unknown) => {
  // The logger may not exist yet (e.g. invalid config), so write directly to stderr.
  const message = err instanceof ConfigError ? err.message : err;
  // eslint-disable-next-line no-console
  console.error(message);
  process.exit(1);
});
