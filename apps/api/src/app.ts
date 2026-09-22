import { randomUUID } from 'node:crypto';

import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyInstance, type FastifyServerOptions, LogController } from 'fastify';

import { type Config } from './config.js';
import { registerErrorHandlers } from './platform/errors.js';
import { type DependencyCheck, registerHealthRoutes } from './platform/health.js';

export interface AppDependencies {
  config: Config;
  checks: DependencyCheck[];
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
export async function buildApp({ config, checks }: AppDependencies): Promise<FastifyInstance> {
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
  await app.register(cors, {
    origin: config.CORS_ORIGINS,
    credentials: true,
  });

  registerErrorHandlers(app);
  registerHealthRoutes(app, { checks, timeoutMs: config.READINESS_TIMEOUT_MS });

  return app;
}
