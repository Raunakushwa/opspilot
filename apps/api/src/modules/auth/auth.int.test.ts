import {
  createDatabase,
  createPool,
  provisionAppUser,
  runMigrations,
  type DatabasePool,
} from '@opspilot/database';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { type FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';
import { createAuthRepository } from './repository.js';
import { createAuthService } from './service.js';
import { SESSION_COOKIE } from './session-cookie.js';

const APP_USER = 'opspilot_app';
const APP_PASSWORD = 'auth-integration-password';

let postgres: StartedPostgreSqlContainer;
let redisContainer: StartedRedisContainer;
let pool: DatabasePool;
let redis: Redis;
let app: FastifyInstance;

const credentials = { email: 'ada@acme.test', password: 'a-long-enough-password' };

function sessionCookie(response: {
  cookies: { name: string; value: string }[];
}): string | undefined {
  return response.cookies.find((cookie) => cookie.name === SESSION_COOKIE)?.value;
}

beforeAll(async () => {
  [postgres, redisContainer] = await Promise.all([
    new PostgreSqlContainer('postgres:17-alpine').start(),
    new RedisContainer('redis:7-alpine').start(),
  ]);

  const ownerUrl = postgres.getConnectionUri();
  await runMigrations({ connectionString: ownerUrl });
  await provisionAppUser({
    connectionString: ownerUrl,
    username: APP_USER,
    password: APP_PASSWORD,
  });

  const appUrl = `postgres://${APP_USER}:${APP_PASSWORD}@${postgres.getHost()}:${String(postgres.getPort())}/${postgres.getDatabase()}`;
  pool = createPool({ connectionString: appUrl });
  redis = new Redis(redisContainer.getConnectionUrl());

  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: appUrl,
    REDIS_URL: redisContainer.getConnectionUrl(),
    // Low enough to trigger within a test, high enough for the happy paths.
    AUTH_RATE_LIMIT_MAX: '4',
    RATE_LIMIT_WINDOW: '60 seconds',
  });

  app = await buildApp({
    config,
    checks: [],
    auth: createAuthService({
      repository: createAuthRepository(createDatabase(pool)),
      sessionTtlMs: 60 * 60 * 1000,
    }),
    rateLimitRedis: redis,
  });
}, 180_000);

afterAll(async () => {
  await app.close();
  await pool.end();
  redis.disconnect();
  await Promise.all([postgres.stop(), redisContainer.stop()]);
});

describe('registration', () => {
  it('creates an account and returns a session cookie', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { ...credentials, displayName: 'Ada Lovelace' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ user: { email: credentials.email } });

    const cookie = response.cookies.find((c) => c.name === SESSION_COOKIE);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('Lax');
    expect(cookie?.path).toBe('/');
  });

  it('never returns the password hash', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'grace@acme.test',
        password: 'another-long-password',
        displayName: 'Grace',
      },
    });

    expect(response.body).not.toContain('argon2');
    expect(response.json()).toEqual({
      user: { id: expect.any(String) as string, email: 'grace@acme.test', displayName: 'Grace' },
    });
  });

  it('rejects a duplicate email regardless of capitalisation', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'ADA@ACME.TEST', password: 'yet-another-password', displayName: 'Ada' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'email_taken' });
  });

  it('rejects a short password with a field-level error', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'short@acme.test', password: 'short', displayName: 'Short' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: 'validation_failed',
      errors: [{ path: '/password' }],
    });
  });
});

describe('login and session', () => {
  it('accepts correct credentials and identifies the user on /api/me', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: credentials,
    });
    expect(login.statusCode).toBe(200);

    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      cookies: { [SESSION_COOKIE]: sessionCookie(login) ?? '' },
    });

    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      user: { email: credentials.email },
      memberships: [],
    });
  });

  it('rejects a wrong password without saying which half was wrong', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: credentials.email, password: 'definitely-not-it' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      code: 'invalid_credentials',
      title: 'Email or password is incorrect',
    });
  });

  it('rejects an unknown email with exactly the same response', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'nobody@acme.test', password: 'definitely-not-it' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'invalid_credentials' });
  });

  it('refuses /api/me without a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/me' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'unauthenticated' });
  });

  it('ignores a forged session cookie', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/me',
      cookies: { [SESSION_COOKIE]: 'a'.repeat(43) },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('logout', () => {
  it('revokes the session so the cookie stops working', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: credentials,
    });
    const cookie = sessionCookie(login) ?? '';

    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      cookies: { [SESSION_COOKIE]: cookie },
    });
    expect(logout.statusCode).toBe(204);

    // The revoked token must fail even though the client still holds it.
    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      cookies: { [SESSION_COOKIE]: cookie },
    });
    expect(me.statusCode).toBe(401);
  });

  it('succeeds without a session, because logout is idempotent', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/auth/logout' });

    expect(response.statusCode).toBe(204);
  });
});

describe('rate limiting', () => {
  it('blocks repeated failed logins for one account', async () => {
    const attempt = () =>
      app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'target@acme.test', password: 'guess-guess-guess' },
        headers: { 'x-forwarded-for': '203.0.113.9' },
      });

    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push((await attempt()).statusCode);
    }

    // The configured budget is 4 per window; the rest are refused.
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
    expect(statuses.slice(0, 4).every((status) => status === 401)).toBe(true);
  });

  it('does not penalise a different account from the same address', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'other@acme.test', password: 'guess-guess-guess' },
      headers: { 'x-forwarded-for': '203.0.113.9' },
    });

    // Keying on address *and* email means one attacked account cannot lock out
    // everyone else behind the same NAT.
    expect(response.statusCode).toBe(401);
  });
});
