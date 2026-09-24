import { z } from 'zod';

// Mirrors apps/api/src/config.ts deliberately: the two services validate
// different variables. A shared loader lands in packages/shared once a third
// consumer exists.
const envBoolean = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // See apps/api/src/config.ts: format is explicit, not derived from NODE_ENV.
  LOG_PRETTY: envBoolean.default(false),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  WORKER_HOST: z.string().min(1).default('0.0.0.0'),
  WORKER_PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().max(100).default(5),
  READINESS_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  AI_SERVICE_URL: z.url().default('http://ai-service:8000'),
  INTERNAL_API_TOKEN: z.string().min(16).optional(),
  /** Same secret the API uses to verify delegation tokens. */
  INTERNAL_JWT_SECRET: z.string().min(32).optional(),
  TOOL_GATEWAY_URL: z.url().default('http://api:4001'),
  DELEGATION_TTL_SECONDS: z.coerce.number().int().positive().max(3600).default(900),
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
