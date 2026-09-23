import {
  createDatabase,
  createPool,
  provisionAppUser,
  runMigrations,
  type Database,
  type DatabasePool,
} from '@opspilot/database';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { type FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';
import { createAuthRepository } from '../auth/repository.js';
import { createAuthService } from '../auth/service.js';
import { SESSION_COOKIE } from '../auth/session-cookie.js';
import { createOrganizationRepository } from './repository.js';
import { createOrganizationService } from './service.js';

const APP_USER = 'opspilot_app';
const APP_PASSWORD = 'org-integration-password';

let postgres: StartedPostgreSqlContainer;
let redisContainer: StartedRedisContainer;
let pool: DatabasePool;
let redis: Redis;
let db: Database;
let app: FastifyInstance;

/**
 * Typed access to an injected response body. Fastify's `json()` is `any`, and
 * the call site is the only place that knows the shape.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- T is supplied by the caller
function body<T>(response: { json: () => unknown }): T {
  const parsed: unknown = response.json();
  return parsed as T;
}

/** Registers a user and returns the cookie header value for their session. */
async function signUp(email: string): Promise<{ cookie: string; userId: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'a-long-enough-password', displayName: email.split('@')[0] },
  });
  const cookie = response.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? '';
  return { cookie, userId: body<{ user: { id: string } }>(response).user.id };
}

function as(cookie: string) {
  return { [SESSION_COOKIE]: cookie };
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
  db = createDatabase(pool);
  redis = new Redis(redisContainer.getConnectionUrl());

  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: appUrl,
    REDIS_URL: redisContainer.getConnectionUrl(),
    AUTH_RATE_LIMIT_MAX: '500',
  });

  app = await buildApp({
    config,
    checks: [],
    db,
    auth: createAuthService({
      repository: createAuthRepository(db),
      sessionTtlMs: 60 * 60 * 1000,
    }),
    organizations: createOrganizationService({ repository: createOrganizationRepository(db) }),
    rateLimitRedis: redis,
  });
}, 180_000);

afterAll(async () => {
  await app.close();
  await pool.end();
  redis.disconnect();
  await Promise.all([postgres.stop(), redisContainer.stop()]);
});

describe('creating an organization', () => {
  it('makes the creator its owner and lists it under /api/orgs', async () => {
    const { cookie } = await signUp('founder@acme.test');

    const created = await app.inject({
      method: 'POST',
      url: '/api/orgs',
      cookies: as(cookie),
      payload: { name: 'Acme Engineering', slug: 'acme' },
    });
    expect(created.statusCode).toBe(201);

    const list = await app.inject({ method: 'GET', url: '/api/orgs', cookies: as(cookie) });
    expect(list.json()).toMatchObject({ data: [{ slug: 'acme', role: 'OWNER' }] });
  });

  it('requires authentication', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/orgs',
      payload: { name: 'Anon', slug: 'anon' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects a malformed slug with a field-level error', async () => {
    const { cookie } = await signUp('slug@acme.test');

    const response = await app.inject({
      method: 'POST',
      url: '/api/orgs',
      cookies: as(cookie),
      payload: { name: 'Bad', slug: 'Not A Slug' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: 'validation_failed',
      errors: [{ path: '/slug' }],
    });
  });
});

describe('tenant boundaries', () => {
  it('answers 404 — not 403 — for a non-member, so the organization is not revealed', async () => {
    const owner = await signUp('owner-a@acme.test');
    const created = await app.inject({
      method: 'POST',
      url: '/api/orgs',
      cookies: as(owner.cookie),
      payload: { name: 'Private Co', slug: 'private-co' },
    });
    const orgId = body<{ id: string }>(created).id;

    const outsider = await signUp('outsider@globex.test');
    const response = await app.inject({
      method: 'GET',
      url: `/api/orgs/${orgId}`,
      cookies: as(outsider.cookie),
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found' });
  });

  it('answers 404 for an organization id that does not exist', async () => {
    const { cookie } = await signUp('probe@acme.test');

    const response = await app.inject({
      method: 'GET',
      url: '/api/orgs/01a0c000-0000-7000-8000-00000000dead',
      cookies: as(cookie),
    });

    expect(response.statusCode).toBe(404);
  });

  it('answers 404 for a malformed organization id without touching the database', async () => {
    const { cookie } = await signUp('malformed@acme.test');

    const response = await app.inject({
      method: 'GET',
      url: '/api/orgs/not-a-uuid',
      cookies: as(cookie),
    });

    expect(response.statusCode).toBe(404);
  });

  it('only lists organizations the caller belongs to', async () => {
    const a = await signUp('multi-a@acme.test');
    const b = await signUp('multi-b@globex.test');
    await app.inject({
      method: 'POST',
      url: '/api/orgs',
      cookies: as(a.cookie),
      payload: { name: 'A Co', slug: 'a-co' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/orgs',
      cookies: as(b.cookie),
      payload: { name: 'B Co', slug: 'b-co' },
    });

    const list = await app.inject({ method: 'GET', url: '/api/orgs', cookies: as(a.cookie) });

    const slugs = body<{ data: { slug: string }[] }>(list).data.map((org) => org.slug);
    expect(slugs).toEqual(['a-co']);
  });
});

describe('membership management', () => {
  let orgId: string;
  let ownerCookie: string;

  beforeAll(async () => {
    const owner = await signUp('boss@acme.test');
    ownerCookie = owner.cookie;
    const created = await app.inject({
      method: 'POST',
      url: '/api/orgs',
      cookies: as(ownerCookie),
      payload: { name: 'Members Co', slug: 'members-co' },
    });
    orgId = body<{ id: string }>(created).id;
    await signUp('engineer@acme.test');
    await signUp('viewer@acme.test');
    await signUp('admin@acme.test');
  });

  it('adds an existing user with the requested role', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/orgs/${orgId}/members`,
      cookies: as(ownerCookie),
      payload: { email: 'engineer@acme.test', role: 'ENGINEER' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ email: 'engineer@acme.test', role: 'ENGINEER' });
  });

  it('rejects an unknown email rather than silently inviting nobody', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/orgs/${orgId}/members`,
      cookies: as(ownerCookie),
      payload: { email: 'nobody@acme.test', role: 'VIEWER' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'user_not_found' });
  });

  it('rejects adding the same member twice', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/orgs/${orgId}/members`,
      cookies: as(ownerCookie),
      payload: { email: 'engineer@acme.test', role: 'VIEWER' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'already_member' });
  });

  it('refuses to remove the last owner, which would orphan the organization', async () => {
    const owner = body<{ data: { userId: string; role: string }[] }>(
      await app.inject({
        method: 'GET',
        url: `/api/orgs/${orgId}/members`,
        cookies: as(ownerCookie),
      }),
    );
    const ownerId = owner.data.find((member) => member.role === 'OWNER')?.userId ?? '';

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/orgs/${orgId}/members/${ownerId}`,
      cookies: as(ownerCookie),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'last_owner' });
  });
});

describe('role enforcement', () => {
  let orgId: string;
  let ownerCookie: string;
  let engineerCookie: string;
  let viewerCookie: string;
  let adminCookie: string;
  let engineerId: string;

  beforeAll(async () => {
    const owner = await signUp('owner@roles.test');
    ownerCookie = owner.cookie;
    const created = await app.inject({
      method: 'POST',
      url: '/api/orgs',
      cookies: as(ownerCookie),
      payload: { name: 'Roles Co', slug: 'roles-co' },
    });
    orgId = body<{ id: string }>(created).id;

    const engineer = await signUp('eng@roles.test');
    const viewer = await signUp('view@roles.test');
    const admin = await signUp('adm@roles.test');
    engineerCookie = engineer.cookie;
    viewerCookie = viewer.cookie;
    adminCookie = admin.cookie;
    engineerId = engineer.userId;

    for (const [email, role] of [
      ['eng@roles.test', 'ENGINEER'],
      ['view@roles.test', 'VIEWER'],
      ['adm@roles.test', 'ADMIN'],
    ] as const) {
      await app.inject({
        method: 'POST',
        url: `/api/orgs/${orgId}/members`,
        cookies: as(ownerCookie),
        payload: { email, role },
      });
    }
  });

  it('lets every member read the organization', async () => {
    for (const cookie of [ownerCookie, adminCookie, engineerCookie, viewerCookie]) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/orgs/${orgId}`,
        cookies: as(cookie),
      });
      expect(response.statusCode).toBe(200);
    }
  });

  it('returns the caller role and permissions so the UI can match the server', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/orgs/${orgId}`,
      cookies: as(viewerCookie),
    });

    const payload = body<{ role: string; permissions: string[] }>(response);
    expect(payload.role).toBe('VIEWER');
    expect(payload.permissions).not.toContain('member:manage');
  });

  it.each([
    ['viewer', () => viewerCookie],
    ['engineer', () => engineerCookie],
  ])('forbids %s from managing members', async (_name, cookie) => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/orgs/${orgId}/members`,
      cookies: as(cookie()),
      payload: { email: 'adm@roles.test', role: 'VIEWER' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'forbidden' });
  });

  it('forbids an engineer from renaming the organization', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/orgs/${orgId}`,
      cookies: as(engineerCookie),
      payload: { name: 'Renamed by engineer' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('allows an admin to rename the organization', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/orgs/${orgId}`,
      cookies: as(adminCookie),
      payload: { name: 'Renamed by admin' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ name: 'Renamed by admin' });
  });

  it('stops an admin from promoting anyone to their own rank or above', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/orgs/${orgId}/members/${engineerId}`,
      cookies: as(adminCookie),
      payload: { role: 'OWNER' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('lets an owner promote an engineer to admin', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/orgs/${orgId}/members/${engineerId}`,
      cookies: as(ownerCookie),
      payload: { role: 'ADMIN' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ role: 'ADMIN' });
  });

  it('lets a member remove themselves without member:manage', async () => {
    const leaver = await signUp('leaver@roles.test');
    await app.inject({
      method: 'POST',
      url: `/api/orgs/${orgId}/members`,
      cookies: as(ownerCookie),
      payload: { email: 'leaver@roles.test', role: 'VIEWER' },
    });

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/orgs/${orgId}/members/${leaver.userId}`,
      cookies: as(leaver.cookie),
    });

    expect(response.statusCode).toBe(204);
    const after = await app.inject({
      method: 'GET',
      url: `/api/orgs/${orgId}`,
      cookies: as(leaver.cookie),
    });
    // Having left, the organization is invisible again.
    expect(after.statusCode).toBe(404);
  });
});
