import { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

/** A downstream dependency the API needs in order to serve traffic. */
export interface DependencyCheck {
  name: string;
  check: () => Promise<void>;
}

type CheckStatus = 'ok' | 'unavailable';

interface CheckResult {
  status: CheckStatus;
  latencyMs: number;
}

export interface ReadinessReport {
  status: CheckStatus;
  checks: Record<string, CheckResult>;
}

class CheckTimeoutError extends Error {
  constructor(name: string, timeoutMs: number) {
    super(`${name} check exceeded ${timeoutMs}ms`);
    this.name = 'CheckTimeoutError';
  }
}

async function withTimeout<T>(promise: Promise<T>, name: string, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new CheckTimeoutError(name, timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface HealthRoutesOptions {
  checks: DependencyCheck[];
  timeoutMs: number;
}

/**
 * `/healthz` (liveness) answers "is the process alive?" and never touches
 * dependencies, so a database outage does not make the orchestrator restart
 * every API container. `/readyz` (readiness) answers "should this instance get
 * traffic?" and fails while any dependency is unreachable. During shutdown
 * Fastify itself answers 503 (`return503OnClosing`), which drains the instance
 * from the load balancer.
 */
export function registerHealthRoutes(app: FastifyInstance, options: HealthRoutesOptions): void {
  app.get('/healthz', () => ({ status: 'ok' }));

  // Same report, two audiences: /readyz is the orchestrator probe, /api/status
  // is part of the product surface (the browser only ever sees /api/*).
  app.get('/api/status', readiness);
  app.get('/readyz', readiness);

  async function readiness(request: FastifyRequest, reply: FastifyReply) {
    const entries = await Promise.all(
      options.checks.map(async ({ name, check }): Promise<[string, CheckResult]> => {
        const startedAt = performance.now();
        try {
          await withTimeout(check(), name, options.timeoutMs);
          return [name, { status: 'ok', latencyMs: Math.round(performance.now() - startedAt) }];
        } catch (err) {
          // Failure details go to the log, not the response: this endpoint is
          // reachable by anything that can reach the load balancer.
          request.log.warn({ err, dependency: name }, 'readiness check failed');
          return [
            name,
            { status: 'unavailable', latencyMs: Math.round(performance.now() - startedAt) },
          ];
        }
      }),
    );

    const allOk = entries.every(([, result]) => result.status === 'ok');
    const report: ReadinessReport = {
      status: allOk ? 'ok' : 'unavailable',
      checks: Object.fromEntries(entries),
    };
    return reply.status(allOk ? 200 : 503).send(report);
  }
}
