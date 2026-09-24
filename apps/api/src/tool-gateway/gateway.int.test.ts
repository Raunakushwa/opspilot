import {
  createDatabase,
  createPool,
  provisionAppUser,
  runMigrations,
  seed,
  withTenant,
  type Database,
  type DatabasePool,
} from '@opspilot/database';
import { memberships } from '@opspilot/database/schema';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq } from 'drizzle-orm';
import { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { mintDelegationToken } from './delegation.js';
import { buildToolGateway } from './server.js';

const APP_USER = 'opspilot_app';
const APP_PASSWORD = 'gateway-integration-password';
const SECRET = 'a-test-secret-that-is-long-enough-32';

let postgres: StartedPostgreSqlContainer;
let pool: DatabasePool;
let db: Database;
let gateway: FastifyInstance;

let organizationId: string;
let demoIncidentId: string;
let engineerId: string;
let viewerId: string;

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- T is supplied by the caller
function body<T>(response: { json: () => unknown }): T {
  const parsed: unknown = response.json();
  return parsed as T;
}

interface ToolResponse {
  toolCallId: string;
  tool: string;
  ok: boolean;
  result?: unknown;
  latencyMs: number;
}

async function callTool(
  tool: string,
  args: Record<string, unknown>,
  options: { userId?: string; organizationId?: string; token?: string } = {},
) {
  const token =
    options.token ??
    (await mintDelegationToken(
      {
        userId: options.userId ?? engineerId,
        organizationId: options.organizationId ?? organizationId,
        runId: '01a0c000-0000-7000-8000-0000000000bb',
      },
      SECRET,
      900,
    ));

  return gateway.inject({
    method: 'POST',
    url: `/internal/tools/${tool}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { args },
  });
}

beforeAll(async () => {
  postgres = await new PostgreSqlContainer('postgres:17-alpine').start();
  const ownerUrl = postgres.getConnectionUri();
  await runMigrations({ connectionString: ownerUrl });
  await provisionAppUser({
    connectionString: ownerUrl,
    username: APP_USER,
    password: APP_PASSWORD,
  });

  pool = createPool({
    connectionString: `postgres://${APP_USER}:${APP_PASSWORD}@${postgres.getHost()}:${String(postgres.getPort())}/${postgres.getDatabase()}`,
  });
  db = createDatabase(pool);

  const result = await seed(db);
  organizationId = result.organizationId;
  demoIncidentId = result.demoIncidentId;

  const rows = await withTenant(db, organizationId, (tx) =>
    tx
      .select({ userId: memberships.userId, role: memberships.role })
      .from(memberships)
      .where(eq(memberships.orgId, organizationId)),
  );
  engineerId = rows.find((row) => row.role === 'ENGINEER')?.userId ?? '';
  viewerId = rows.find((row) => row.role === 'VIEWER')?.userId ?? '';

  gateway = buildToolGateway({ db, secret: SECRET });
}, 240_000);

afterAll(async () => {
  await gateway.close();
  await pool.end();
  await postgres.stop();
});

describe('authentication', () => {
  it('refuses a call with no token', async () => {
    const response = await gateway.inject({
      method: 'POST',
      url: '/internal/tools/get_incident',
      payload: { args: { incident_id: demoIncidentId } },
    });

    expect(response.statusCode).toBe(401);
  });

  it('refuses a token signed with the wrong secret', async () => {
    const forged = await mintDelegationToken(
      { userId: engineerId, organizationId, runId: 'run' },
      'a-completely-different-secret-value-32',
      900,
    );

    const response = await callTool(
      'get_incident',
      { incident_id: demoIncidentId },
      { token: forged },
    );

    expect(response.statusCode).toBe(401);
  });

  it('refuses an unknown tool name', async () => {
    const response = await callTool('drop_database', {});

    expect(response.statusCode).toBe(404);
    expect(body<{ code: string }>(response).code).toBe('unknown_tool');
  });
});

describe('authorization', () => {
  it('lets an engineer read incidents', async () => {
    const response = await callTool('get_incident', { incident_id: demoIncidentId });

    expect(response.statusCode).toBe(200);
    expect(body<ToolResponse>(response).ok).toBe(true);
  });

  it('re-checks the role on every call, so a revoked member loses access mid-run', async () => {
    // The token stays valid; membership is the authority, not the claim.
    const token = await mintDelegationToken(
      { userId: viewerId, organizationId, runId: 'run' },
      SECRET,
      900,
    );
    const before = await callTool('get_incident', { incident_id: demoIncidentId }, { token });
    expect(before.statusCode).toBe(200);

    await withTenant(db, organizationId, (tx) =>
      tx
        .delete(memberships)
        .where(and(eq(memberships.orgId, organizationId), eq(memberships.userId, viewerId))),
    );

    const after = await callTool('get_incident', { incident_id: demoIncidentId }, { token });

    expect(after.statusCode).toBe(403);
    expect(body<{ code: string }>(after).code).toBe('forbidden');
  });
});

describe('tenant isolation', () => {
  it('returns nothing for an organization the data does not belong to', async () => {
    // A token for another organization is valid but reads an empty world.
    const response = await callTool(
      'get_incident',
      { incident_id: demoIncidentId },
      { organizationId: '01a0c000-0000-7000-8000-00000000dead' },
    );

    expect(response.statusCode).toBe(403);
  });
});

describe('argument validation', () => {
  it('rejects arguments that do not match the schema', async () => {
    // Arguments arrive from a language model; they are validated, never coerced.
    const response = await callTool('get_incident', { incident_id: 'not-a-uuid' });

    expect(response.statusCode).toBe(400);
    expect(body<{ code: string }>(response).code).toBe('invalid_tool_arguments');
  });

  it('applies defaults for omitted optional arguments', async () => {
    const response = await callTool('get_deployments', { service: 'payment-service' });

    expect(response.statusCode).toBe(200);
  });

  it('refuses a window beyond the allowed maximum', async () => {
    const response = await callTool('get_logs', {
      service: 'payment-service',
      window_minutes: 999_999,
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('the tools answer the demo scenario', () => {
  // Wide enough to include the oldest seeded deployment (18 days back).
  const window = { window_minutes: 60 * 24 * 30 };

  it('finds the deployment that preceded the incident', async () => {
    const response = await callTool('get_deployments', { service: 'payment-service', ...window });

    const deployments = body<ToolResponse>(response).result as { version: string }[];
    expect(deployments[0]?.version).toBe('v2026.9.20-1');
  });

  it('groups the error logs into the pattern that explains the failure', async () => {
    const response = await callTool('get_log_patterns', { service: 'payment-service', ...window });

    const patterns = body<ToolResponse>(response).result as {
      message: string;
      occurrences: number;
    }[];
    expect(patterns[0]?.message).toContain('timeout acquiring connection from pool');
    expect(patterns[0]?.occurrences).toBeGreaterThan(5);
  });

  it('returns the error-rate series that rises after the deploy', async () => {
    const response = await callTool('get_metrics', {
      service: 'payment-service',
      metric: 'error_rate',
      ...window,
    });

    const points = body<ToolResponse>(response).result as { value: number }[];
    expect(points.length).toBeGreaterThan(10);
    expect(Math.max(...points.map((p) => p.value))).toBeGreaterThan(0.05);
  });

  it('finds the matching historical incident', async () => {
    const response = await callTool('search_incidents', { query: 'connection pool' });

    const incidents = body<ToolResponse>(response).result as { title: string }[];
    expect(incidents.some((incident) => incident.title.includes('pool size change'))).toBe(true);
  });

  it('finds previous postmortems', async () => {
    const response = await callTool('get_previous_postmortems', { query: 'connection pool' });

    const postmortems = body<ToolResponse>(response).result as { title: string }[];
    expect(postmortems).toHaveLength(1);
  });

  it('returns a tool call id, so the answer can cite what it actually read', async () => {
    const response = await callTool('get_service', { service: 'payment-service' });

    const payload = body<ToolResponse>(response);
    expect(payload.toolCallId).toMatch(/^[0-9a-f-]{36}$/);
    expect(payload.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns null rather than failing for a service that does not exist', async () => {
    const response = await callTool('get_service', { service: 'no-such-service' });

    expect(body<ToolResponse>(response).result).toBeNull();
  });
});
