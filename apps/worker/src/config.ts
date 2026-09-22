import { z } from 'zod';

// Mirrors apps/api/src/config.ts deliberately: the two services validate
// different variables. A shared loader lands in packages/shared once a third
// consumer exists.
const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  WORKER_HOST: z.string().min(1).default('0.0.0.0'),
  WORKER_PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().max(100).default(5),
  READINESS_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
});

export type Config = z.infer<typeof configSchema>;

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return result.data;
}
