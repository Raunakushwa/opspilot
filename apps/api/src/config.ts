import { z } from 'zod';

// `z.coerce.boolean()` treats any non-empty string (including "false") as true,
// so environment booleans are parsed explicitly.
const envBoolean = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const commaSeparatedList = z.string().transform((value) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0),
);

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Log *format* is independent of the environment: containers always emit JSON
  // (pino-pretty is a dev dependency and absent from the runtime image), while
  // `pnpm dev` opts into human-readable output.
  LOG_PRETTY: envBoolean.default(false),
  API_HOST: z.string().min(1).default('0.0.0.0'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  CORS_ORIGINS: commaSeparatedList.pipe(z.array(z.url())).default(['http://localhost:3000']),
  TRUST_PROXY: envBoolean.default(false),
  READINESS_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  COOKIE_SECURE: envBoolean.default(false),
  SESSION_TTL_HOURS: z.coerce
    .number()
    .int()
    .positive()
    .max(24 * 30)
    .default(24 * 7),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
  /** Credential endpoints get a much tighter budget than ordinary routes. */
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
  /** Signs the short-lived delegation tokens the agent uses to read data. */
  INTERNAL_JWT_SECRET: z.string().min(32).optional(),
  INTERNAL_PORT: z.coerce.number().int().min(1).max(65535).default(4001),
  /** Delegation tokens outlive a single tool call but not an investigation. */
  DELEGATION_TTL_SECONDS: z.coerce.number().int().positive().max(3600).default(900),
});

export type Config = z.infer<typeof configSchema>;

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Validates the environment once at startup so misconfiguration fails fast.
 * Error messages name the offending variable but never echo its value, because
 * values such as DATABASE_URL contain credentials.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return result.data;
}
