import {
  createDatabase,
  createPool,
  provisionAppUser,
  runMigrations,
  withTenant,
  type Database,
  type DatabasePool,
} from '@opspilot/database';
import { services } from '@opspilot/database/schema';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { sql } from 'drizzle-orm';
import { type FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';
import { createAuthRepository } from '../auth/repository.js';
import { createAuthService } from '../auth/service.js';
import { SESSION_COOKIE } from '../auth/session-cookie.js';
import { createOrganizationRepository } from '../organizations/repository.js';
import { createOrganizationService } from '../organizations/service.js';
import { createIncidentRepository } from './repository.js';
import { createIncidentService } from './service.js';

const APP_USER = 'opspilot_app';
const APP_PASSWORD = 'incident-integration-password';

let postgres: StartedPostgreSqlContainer;
let redisContainer: StartedRedisContainer;
let pool: DatabasePool;
let db: Database;
let redis: Redis;
let app: FastifyInstance;

let orgId: string;
let ownerCookie: string;
let engineerCookie: string;
let engineerId: string;
let viewerCookie: string;
let serviceId: string;

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- T is supplied by the caller
function body<T>(response: { json: () => unknown }): T {
  const parsed: unknown = response.json();
  return parsed as T;
}

function as(cookie: string) {
  return { [SESSION_COOKIE]: cookie };
}

async function signUp(email: string): Promise<{ cookie: string; userId: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'a-long-enough-password', displayName: email.split('@')[0] },
  });
  return {
    cookie: response.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? '',
    userId: body<{ user: { id: string } }>(response).user.id,
  };
}

interface IncidentBody {
  id: string;
  number: number;
  title: string;
  status: string;
  severity: string;
  version: number;
  assignedTo: string | null;
}

async function createIncident(payload: Record<string, unknown>, cookie = engineerCookie) {
  return app.inject({
    method: 'POST',
    url: `/api/orgs/${orgId}/incidents`,
    cookies: as(cookie),
    payload,
  });
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
    incidents: createIncidentService(createIncidentRepository(db)),
    rateLimitRedis: redis,
  });

  const owner = await signUp('owner@incidents.test');
  ownerCookie = owner.cookie;
  const created = await app.inject({
    method: 'POST',
    url: '/api/orgs',
    cookies: as(ownerCookie),
    payload: { name: 'Acme Engineering', slug: 'acme-inc' },
  });
  orgId = body<{ id: string }>(created).id;

  const engineer = await signUp('eng@incidents.test');
  const viewer = await signUp('viewer@incidents.test');
  engineerCookie = engineer.cookie;
  engineerId = engineer.userId;
  viewerCookie = viewer.cookie;
  for (const [email, role] of [
    ['eng@incidents.test', 'ENGINEER'],
    ['viewer@incidents.test', 'VIEWER'],
  ] as const) {
    await app.inject({
      method: 'POST',
      url: `/api/orgs/${orgId}/members`,
      cookies: as(ownerCookie),
      payload: { email, role },
    });
  }

  // Services have no API yet (they arrive with the seed); insert directly.
  const [service] = await withTenant(db, orgId, (tx) =>
    tx
      .insert(services)
      .values({ orgId, name: 'payment-service', slug: 'payment-service' })
      .returning(),
  );
  serviceId = service?.id ?? '';
}, 240_000);

afterAll(async () => {
  await app.close();
  await pool.end();
  redis.disconnect();
  await Promise.all([postgres.stop(), redisContainer.stop()]);
});

describe('creating incidents', () => {
  it('numbers incidents per organization and starts them investigating', async () => {
    const first = await createIncident({ title: 'Checkout latency spike', severity: 'SEV2' });
    const second = await createIncident({ title: 'Second incident', severity: 'SEV3' });

    expect(first.statusCode).toBe(201);
    expect(body<IncidentBody>(first)).toMatchObject({ number: 1, status: 'INVESTIGATING' });
    expect(body<IncidentBody>(second).number).toBe(2);
    expect(first.headers.etag).toBe('"1"');
  });

  it('records the creation on the timeline and in the audit log', async () => {
    const created = await createIncident({ title: 'Timeline check', severity: 'SEV3' });
    const incidentId = body<IncidentBody>(created).id;

    const timeline = await app.inject({
      method: 'GET',
      url: `/api/orgs/${orgId}/incidents/${incidentId}/events`,
      cookies: as(engineerCookie),
    });
    const audit = await app.inject({
      method: 'GET',
      url: `/api/orgs/${orgId}/audit-logs`,
      cookies: as(ownerCookie),
    });

    expect(body<{ data: { type: string }[] }>(timeline).data.map((e) => e.type)).toEqual([
      'incident.created',
    ]);
    expect(
      body<{ data: { action: string; resourceId: string }[] }>(audit).data.some(
        (entry) => entry.action === 'INCIDENT_CREATED' && entry.resourceId === incidentId,
      ),
    ).toBe(true);
  });

  it('attaches affected services', async () => {
    const created = await createIncident({
      title: 'Payments failing',
      severity: 'SEV1',
      serviceIds: [serviceId],
    });

    const incident = await app.inject({
      method: 'GET',
      url: `/api/orgs/${orgId}/incidents/${body<IncidentBody>(created).id}`,
      cookies: as(engineerCookie),
    });
    expect(body<{ services: { slug: string }[] }>(incident).services).toEqual([
      expect.objectContaining({ slug: 'payment-service' }) as unknown,
    ]);
  });

  it('rejects a service from another organization', async () => {
    const response = await createIncident({
      title: 'Bad service reference',
      serviceIds: ['01a0c000-0000-7000-8000-0000000000ff'],
    });

    expect(response.statusCode).toBe(400);
    expect(body<{ code: string }>(response).code).toBe('unknown_service');
  });

  it('rejects an assignee who is not a member', async () => {
    const outsider = await signUp('outsider@incidents.test');

    const response = await createIncident({ title: 'Bad assignee', assignedTo: outsider.userId });

    expect(response.statusCode).toBe(400);
    expect(body<{ code: string }>(response).code).toBe('not_a_member');
  });

  it('forbids a viewer from creating incidents', async () => {
    const response = await createIncident({ title: 'Viewer attempt' }, viewerCookie);

    expect(response.statusCode).toBe(403);
  });
});

describe('updating incidents', () => {
  it('requires If-Match, so a blind write cannot clobber a colleague', async () => {
    const created = await createIncident({ title: 'Needs if-match' });
    const incidentId = body<IncidentBody>(created).id;

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/orgs/${orgId}/incidents/${incidentId}`,
      cookies: as(engineerCookie),
      payload: { status: 'MITIGATING' },
    });

    expect(response.statusCode).toBe(428);
    expect(body<{ code: string }>(response).code).toBe('precondition_required');
  });

  it('rejects a stale version with 412', async () => {
    const created = await createIncident({ title: 'Concurrent edit' });
    const incidentId = body<IncidentBody>(created).id;

    const first = await app.inject({
      method: 'PATCH',
      url: `/api/orgs/${orgId}/incidents/${incidentId}`,
      cookies: as(engineerCookie),
      headers: { 'if-match': '"1"' },
      payload: { status: 'IDENTIFIED' },
    });
    const second = await app.inject({
      method: 'PATCH',
      url: `/api/orgs/${orgId}/incidents/${incidentId}`,
      cookies: as(ownerCookie),
      headers: { 'if-match': '"1"' },
      payload: { status: 'MITIGATING' },
    });

    expect(first.statusCode).toBe(200);
    expect(first.headers.etag).toBe('"2"');
    expect(second.statusCode).toBe(412);
    expect(body<{ code: string }>(second).code).toBe('stale_version');
  });

  it('writes one timeline entry per meaningful change', async () => {
    const created = await createIncident({ title: 'Multi change', severity: 'SEV3' });
    const incidentId = body<IncidentBody>(created).id;

    await app.inject({
      method: 'PATCH',
      url: `/api/orgs/${orgId}/incidents/${incidentId}`,
      cookies: as(engineerCookie),
      headers: { 'if-match': '"1"' },
      payload: { status: 'MITIGATING', severity: 'SEV1', assignedTo: engineerId },
    });

    const timeline = await app.inject({
      method: 'GET',
      url: `/api/orgs/${orgId}/incidents/${incidentId}/events`,
      cookies: as(engineerCookie),
    });
    const types = body<{ data: { type: string }[] }>(timeline).data.map((e) => e.type);
    expect(types).toEqual([
      'incident.created',
      'incident.status.changed',
      'incident.severity.changed',
      'incident.assignee.changed',
    ]);
  });

  it('does not write an event when a field is set to its current value', async () => {
    const created = await createIncident({ title: 'No-op change', severity: 'SEV3' });
    const incidentId = body<IncidentBody>(created).id;

    await app.inject({
      method: 'PATCH',
      url: `/api/orgs/${orgId}/incidents/${incidentId}`,
      cookies: as(engineerCookie),
      headers: { 'if-match': '"1"' },
      payload: { severity: 'SEV3' },
    });

    const timeline = await app.inject({
      method: 'GET',
      url: `/api/orgs/${orgId}/incidents/${incidentId}/events`,
      cookies: as(engineerCookie),
    });
    expect(body<{ data: unknown[] }>(timeline).data).toHaveLength(1);
  });

  it('stamps resolvedAt when an incident is resolved', async () => {
    const created = await createIncident({ title: 'Will resolve' });
    const incidentId = body<IncidentBody>(created).id;

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/orgs/${orgId}/incidents/${incidentId}`,
      cookies: as(engineerCookie),
      headers: { 'if-match': '"1"' },
      payload: { status: 'RESOLVED' },
    });

    expect(body<{ resolvedAt: string | null }>(response).resolvedAt).not.toBeNull();
  });

  it('refuses to change the status of a closed incident', async () => {
    const created = await createIncident({ title: 'Will close' });
    const incidentId = body<IncidentBody>(created).id;
    await app.inject({
      method: 'PATCH',
      url: `/api/orgs/${orgId}/incidents/${incidentId}`,
      cookies: as(engineerCookie),
      headers: { 'if-match': '"1"' },
      payload: { status: 'CLOSED' },
    });

    const reopen = await app.inject({
      method: 'PATCH',
      url: `/api/orgs/${orgId}/incidents/${incidentId}`,
      cookies: as(engineerCookie),
      headers: { 'if-match': '"2"' },
      payload: { status: 'INVESTIGATING' },
    });

    expect(reopen.statusCode).toBe(409);
    expect(body<{ code: string }>(reopen).code).toBe('incident_closed');
  });
});

describe('listing and filtering', () => {
  it('filters by status and by assignee', async () => {
    const created = await createIncident({ title: 'Assigned to engineer' });
    await app.inject({
      method: 'PATCH',
      url: `/api/orgs/${orgId}/incidents/${body<IncidentBody>(created).id}`,
      cookies: as(engineerCookie),
      headers: { 'if-match': '"1"' },
      payload: { assignedTo: engineerId, status: 'IDENTIFIED' },
    });

    const filtered = await app.inject({
      method: 'GET',
      url: `/api/orgs/${orgId}/incidents?status=IDENTIFIED&assignedTo=${engineerId}`,
      cookies: as(engineerCookie),
    });

    const data = body<{ data: IncidentBody[] }>(filtered).data;
    expect(data.length).toBeGreaterThan(0);
    expect(data.every((i) => i.status === 'IDENTIFIED' && i.assignedTo === engineerId)).toBe(true);
  });

  it('paginates with a stable cursor', async () => {
    const firstPage = await app.inject({
      method: 'GET',
      url: `/api/orgs/${orgId}/incidents?limit=2`,
      cookies: as(engineerCookie),
    });
    const page = body<{ data: IncidentBody[]; nextCursor: string | null }>(firstPage);

    const secondPage = await app.inject({
      method: 'GET',
      url: `/api/orgs/${orgId}/incidents?limit=2&cursor=${page.nextCursor ?? ''}`,
      cookies: as(engineerCookie),
    });
    const next = body<{ data: IncidentBody[] }>(secondPage).data;

    expect(page.data).toHaveLength(2);
    expect(next.some((i) => page.data.some((p) => p.id === i.id))).toBe(false);
  });

  it('lets a viewer read but not write', async () => {
    const list = await app.inject({
      method: 'GET',
      url: `/api/orgs/${orgId}/incidents`,
      cookies: as(viewerCookie),
    });

    expect(list.statusCode).toBe(200);
  });
});

describe('tenant isolation', () => {
  it('hides incidents from another organization', async () => {
    const stranger = await signUp('stranger@other.test');
    const otherOrg = await app.inject({
      method: 'POST',
      url: '/api/orgs',
      cookies: as(stranger.cookie),
      payload: { name: 'Globex', slug: 'globex-inc' },
    });
    const otherOrgId = body<{ id: string }>(otherOrg).id;

    const created = await createIncident({ title: 'Acme only' });
    const incidentId = body<IncidentBody>(created).id;

    // Same incident id, wrong organization in the path.
    const crossTenant = await app.inject({
      method: 'GET',
      url: `/api/orgs/${otherOrgId}/incidents/${incidentId}`,
      cookies: as(stranger.cookie),
    });
    // Right organization, but not a member.
    const nonMember = await app.inject({
      method: 'GET',
      url: `/api/orgs/${orgId}/incidents/${incidentId}`,
      cookies: as(stranger.cookie),
    });

    expect(crossTenant.statusCode).toBe(404);
    expect(nonMember.statusCode).toBe(404);
  });
});

describe('audit log', () => {
  it('is visible to admins and hidden from engineers', async () => {
    const asOwner = await app.inject({
      method: 'GET',
      url: `/api/orgs/${orgId}/audit-logs`,
      cookies: as(ownerCookie),
    });
    const asEngineer = await app.inject({
      method: 'GET',
      url: `/api/orgs/${orgId}/audit-logs`,
      cookies: as(engineerCookie),
    });

    expect(asOwner.statusCode).toBe(200);
    expect(asEngineer.statusCode).toBe(403);
  });

  it('cannot be altered, even by the application role', async () => {
    // Privileges are revoked and a trigger refuses the operation outright, so
    // history cannot be rewritten by a bug or a compromised session.
    await expect(
      withTenant(db, orgId, (tx) => tx.execute(sql`UPDATE audit_logs SET action = 'TAMPERED'`)),
    ).rejects.toThrow();

    await expect(
      withTenant(db, orgId, (tx) => tx.execute(sql`DELETE FROM audit_logs`)),
    ).rejects.toThrow();
  });

  it('records the acting user and request id for traceability', async () => {
    const audit = await app.inject({
      method: 'GET',
      url: `/api/orgs/${orgId}/audit-logs`,
      cookies: as(ownerCookie),
    });

    const entry = body<{ data: { actorId: string; requestId: string | null }[] }>(audit).data[0];
    expect(entry?.actorId).toBeTruthy();
    expect(entry?.requestId).toBeTruthy();
  });
});

describe('transactional outbox', () => {
  it('writes an outbox event in the same transaction as the change', async () => {
    const created = await createIncident({ title: 'Outbox check' });
    const incidentId = body<IncidentBody>(created).id;

    const rows = await withTenant(db, orgId, (tx) =>
      tx.execute<{ topic: string }>(
        sql`SELECT topic FROM outbox_events WHERE payload->>'incidentId' = ${incidentId}`,
      ),
    );

    expect(rows.rows.map((row) => row.topic)).toContain('incident.created');
  });

  it('leaves no outbox event behind when the write fails', async () => {
    const before = await withTenant(db, orgId, (tx) =>
      tx.execute<{ total: string }>(sql`SELECT count(*) AS total FROM outbox_events`),
    );

    // An unknown service fails validation before any row is written.
    await createIncident({ title: 'Doomed', serviceIds: ['01a0c000-0000-7000-8000-0000000000ee'] });

    const after = await withTenant(db, orgId, (tx) =>
      tx.execute<{ total: string }>(sql`SELECT count(*) AS total FROM outbox_events`),
    );
    expect(after.rows[0]?.total).toBe(before.rows[0]?.total);
  });
});

describe('incident numbering', () => {
  it('assigns unique numbers under concurrent creation', async () => {
    // max(number) + 1 would collide here; the counter row lock prevents it.
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        createIncident({ title: `Concurrent ${String(index)}` }),
      ),
    );

    const numbers = responses.map((response) => body<IncidentBody>(response).number);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(responses.every((response) => response.statusCode === 201)).toBe(true);
  });
});
