import { randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyServerOptions, LogController } from 'fastify';

import { type Config } from './config.js';
import { registerErrorHandlers } from './platform/errors.js';
import { type DependencyCheck, registerHealthRoutes } from './platform/health.js';
import { registerSessionAuth } from './modules/auth/plugin.js';
import { registerAuthRoutes } from './modules/auth/routes.js';
import { type AuthService } from './modules/auth/service.js';

export interface AppDependencies {
  config: Config;
  checks: DependencyCheck[];
  auth?: AuthService;
  /** Redis client backing the rate limiter; omitted in tests for an in-memory limiter. */
  rateLimitRedis?: unknown;
}

const REQUEST_ID_HEADER = 'x-request-id';
// Accept a caller-supplied request ID (e.g. from the load balancer) only if it
// is short and log-safe; otherwise generate one.
const SAFE_REQUEST_ID = /^[\w.-]{1,128}$/;

function loggerOptions(config: Config): NonNullable<FastifyServerOptions['logger']> {
  if (config.NODE_ENV === 'test') {
    return false;
  }
  return {
    level: config.LOG_LEVEL,
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
      censor: '[REDACTED]',
    },
    ...(config.LOG_PRETTY
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss.l' } } }
      : {}),
  };
}

/**
 * Builds the Fastify application without binding a port. Infrastructure is
 * injected so tests can run the full HTTP stack against fakes.
 */
export async function buildApp({
  config,
  checks,
  auth,
  rateLimitRedis,
}: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions(config),
    trustProxy: config.TRUST_PROXY,
    requestIdHeader: false,
    logController: new LogController({ requestIdLogLabel: 'requestId' }),
    genReqId: (req) => {
      const incoming = req.headers[REQUEST_ID_HEADER];
      return typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming)
        ? incoming
        : randomUUID();
    },
  });

  app.addHook('onRequest', (request, reply, done) => {
    // `reply.header()` returns the reply, which is thenable and only settles once
    // the response has been sent — awaiting it here would deadlock the request.
    void reply.header(REQUEST_ID_HEADER, request.id);
    done();
  });

  await app.register(helmet);
  await app.register(cookie);
  // Redis-backed so the limit is shared across API instances; without a store
  // each instance would allow the full quota on its own.
  await app.register(rateLimit, {
    global: false,
    // Default hook is onRequest, which runs before the body is parsed — the
    // per-account key would silently fall back to IP-only, so one attacked
    // account would lock out every user behind the same address.
    hook: 'preHandler',
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW,
    ...(rateLimitRedis ? { redis: rateLimitRedis } : {}),
  });
  await app.register(cors, {
    origin: config.CORS_ORIGINS,
    credentials: true,
  });

  registerErrorHandlers(app);
  registerHealthRoutes(app, { checks, timeoutMs: config.READINESS_TIMEOUT_MS });

  if (auth) {
    registerSessionAuth(app, auth);
    registerAuthRoutes(app, {
      service: auth,
      // Cookies are Secure everywhere except plain-HTTP local development.
      secureCookies: config.NODE_ENV === 'production' || config.COOKIE_SECURE,
      loginRateLimit: { max: config.AUTH_RATE_LIMIT_MAX, timeWindow: config.RATE_LIMIT_WINDOW },
    });
  }

  return app;
}
