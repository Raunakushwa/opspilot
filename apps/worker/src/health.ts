import Fastify from 'fastify';
import { type Redis } from 'ioredis';
import { type Logger } from 'pino';

export interface HealthServerOptions {
  redis: Redis;
  logger: Logger;
  timeoutMs: number;
  isRunning: () => boolean;
}

/**
 * The worker serves no traffic, but orchestrators still need liveness and
 * readiness signals. Same split as the API: liveness never touches Redis.
 */
export function createHealthServer({ redis, logger, timeoutMs, isRunning }: HealthServerOptions) {
  const app = Fastify({ loggerInstance: logger });

  app.get('/healthz', () => ({ status: 'ok' }));

  app.get('/readyz', async (_request, reply) => {
    const timer = new Promise<never>((_, reject) =>
      setTimeout(() => {
        reject(new Error(`redis check exceeded ${String(timeoutMs)}ms`));
      }, timeoutMs).unref(),
    );

    let redisOk = true;
    try {
      await Promise.race([redis.ping(), timer]);
    } catch (err) {
      logger.warn({ err }, 'readiness check failed');
      redisOk = false;
    }

    const ok = redisOk && isRunning();
    return reply.status(ok ? 200 : 503).send({
      status: ok ? 'ok' : 'unavailable',
      checks: {
        redis: { status: redisOk ? 'ok' : 'unavailable' },
        workers: { status: isRunning() ? 'ok' : 'unavailable' },
      },
    });
  });

  return app;
}
