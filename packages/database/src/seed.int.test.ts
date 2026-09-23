import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool, type Database, type DatabasePool } from './client.js';
import { runMigrations } from './migrate.js';
import { provisionAppUser } from './provision.js';
import { DEMO_PASSWORD, seed } from './seed/index.js';
import { withTenant } from './tenant.js';

const APP_USER = 'opspilot_app';
const APP_PASSWORD = 'seed-integration-password';

let container: StartedPostgreSqlContainer;
let pool: DatabasePool;
let db: Database;
let organizationId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  const ownerUrl = container.getConnectionUri();
  await runMigrations({ connectionString: ownerUrl });
  await provisionAppUser({
    connectionString: ownerUrl,
    username: APP_USER,
    password: APP_PASSWORD,
  });

  pool = createPool({
    connectionString: `postgres://${APP_USER}:${APP_PASSWORD}@${container.getHost()}:${String(container.getPort())}/${container.getDatabase()}`,
  });
  db = createDatabase(pool);
  const result = await seed(db);
  organizationId = result.organizationId;
}, 180_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

describe('demo seed', () => {
  it('creates a demo organization with enough history to investigate', async () => {
    const counts = await withTenant(db, organizationId, (tx) =>
      tx.execute<{ table: string; total: number }>(sql`
        SELECT 'incidents' AS table, count(*)::int AS total FROM incidents
        UNION ALL SELECT 'documents', count(*)::int FROM documents
        UNION ALL SELECT 'deployments', count(*)::int FROM deployments
        UNION ALL SELECT 'services', count(*)::int FROM services
      `),
    );
    const byTable = Object.fromEntries(counts.rows.map((row) => [row.table, row.total]));

    expect(byTable.incidents).toBeGreaterThanOrEqual(21);
    expect(byTable.documents).toBeGreaterThanOrEqual(7);
    expect(byTable.deployments).toBeGreaterThanOrEqual(10);
    expect(byTable.services).toBe(4);
  });

  it('is idempotent: re-seeding converges instead of duplicating history', async () => {
    const before = await withTenant(db, organizationId, (tx) =>
      tx.execute<{ total: number }>(sql`SELECT count(*)::int AS total FROM incidents`),
    );

    await seed(db);

    const after = await withTenant(db, organizationId, (tx) =>
      tx.execute<{ total: number }>(sql`SELECT count(*)::int AS total FROM incidents`),
    );
    expect(after.rows[0]?.total).toBe(before.rows[0]?.total);
  });

  it('leaves the incident counter beyond the seeded numbers, so new incidents do not collide', async () => {
    const result = await withTenant(db, organizationId, (tx) =>
      tx.execute<{ next: number; max: number }>(sql`
        SELECT (SELECT next_number FROM incident_counters WHERE org_id = ${organizationId}) AS next,
               (SELECT max(number) FROM incidents) AS max
      `),
    );

    const row = result.rows[0];
    expect(row?.next).toBeGreaterThan(row?.max ?? 0);
  });

  it('places the causing deployment shortly before the open incident', async () => {
    // The whole demo depends on this ordering being real data, not a story.
    const result = await withTenant(db, organizationId, (tx) =>
      tx.execute<{ minutes_before: number; version: string }>(sql`
        SELECT EXTRACT(EPOCH FROM (i.created_at - d.started_at)) / 60 AS minutes_before, d.version
        FROM incidents i
        JOIN services s ON s.slug = 'payment-service' AND s.org_id = i.org_id
        JOIN deployments d ON d.service_id = s.id
        WHERE i.status = 'INVESTIGATING'
        ORDER BY d.started_at DESC
        LIMIT 1
      `),
    );

    const row = result.rows[0];
    expect(row?.version).toBe('v2026.9.20-1');
    expect(Number(row?.minutes_before)).toBeGreaterThan(0);
    expect(Number(row?.minutes_before)).toBeLessThan(30);
  });

  it('contains the error log pattern that explains the failure', async () => {
    const result = await withTenant(db, organizationId, (tx) =>
      tx.execute<{ total: number }>(sql`
        SELECT count(*)::int AS total FROM log_entries
        WHERE level = 'ERROR' AND message_tsv @@ plainto_tsquery('english', 'timeout acquiring connection pool')
      `),
    );

    expect(result.rows[0]?.total).toBeGreaterThan(0);
  });

  it('shows error rate rising only after the deployment', async () => {
    const result = await withTenant(db, organizationId, (tx) =>
      tx.execute<{ before_avg: number; after_avg: number }>(sql`
        WITH deploy AS (
          SELECT started_at FROM deployments WHERE version = 'v2026.9.20-1'
        )
        SELECT
          avg(value) FILTER (WHERE ts < (SELECT started_at FROM deploy)) AS before_avg,
          avg(value) FILTER (WHERE ts > (SELECT started_at FROM deploy)) AS after_avg
        FROM metric_points m
        JOIN services s ON s.id = m.service_id AND s.slug = 'payment-service'
        WHERE m.metric = 'error_rate'
      `),
    );

    const row = result.rows[0];
    expect(Number(row?.after_avg)).toBeGreaterThan(Number(row?.before_avg) * 5);
  });

  it('keeps a matching historical postmortem for the same failure mode', async () => {
    const result = await withTenant(db, organizationId, (tx) =>
      tx.execute<{ title: string }>(sql`
        SELECT title FROM documents WHERE type = 'POSTMORTEM' AND title ILIKE '%connection pool%'
      `),
    );

    expect(result.rows).toHaveLength(1);
  });
});

describe('demo accounts', () => {
  it('stores a password hash the API can verify', async () => {
    // A hardcoded digest would drift from the API's argon2 parameters; this is
    // the test that catches it, and it caught exactly that during development.
    const { verify } = await import('@node-rs/argon2');
    const result = await withTenant(db, organizationId, (tx) =>
      tx.execute<{ password_hash: string }>(
        sql`SELECT password_hash FROM users WHERE email = 'ada@acme.test'`,
      ),
    );

    const digest = result.rows[0]?.password_hash ?? '';
    expect(digest).toMatch(/^\$argon2id\$/);
    await expect(verify(digest, DEMO_PASSWORD)).resolves.toBe(true);
  });
});
