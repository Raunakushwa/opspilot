import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import type pg from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, createPool, type Database } from './client.js';
import { runMigrations } from './migrate.js';
import { provisionAppUser } from './provision.js';
import {
  memberships,
  organizations,
  services,
  teams,
  TENANT_TABLES,
  users,
} from './schema/index.js';
import { InvalidTenantError, withTenant, withoutTenant, withUser } from './tenant.js';

/**
 * Drizzle wraps driver errors, so the PostgreSQL message and code live on
 * `cause`. Asserting on the SQLSTATE is stricter than matching text: 42501 is
 * exactly "row-level security policy violated", not any permission error.
 */
async function expectDbError(promise: Promise<unknown>, sqlState: string): Promise<void> {
  await expect(promise).rejects.toThrow();
  try {
    await promise;
  } catch (err) {
    const cause = (err as { cause?: unknown }).cause;
    expect((cause as { code?: string } | undefined)?.code).toBe(sqlState);
  }
}

/** insufficient_privilege — raised when a row-level security policy rejects a write. */
const RLS_VIOLATION = '42501';
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

const APP_USER = 'opspilot_app';
const APP_PASSWORD = 'integration-test-password';

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: Database;

const acme = { id: uuidv7(), name: 'Acme Engineering', slug: 'acme' };
const globex = { id: uuidv7(), name: 'Globex', slug: 'globex' };

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  const ownerUrl = container.getConnectionUri();
  await runMigrations({ connectionString: ownerUrl });
  await provisionAppUser({
    connectionString: ownerUrl,
    username: APP_USER,
    password: APP_PASSWORD,
  });

  // Seed as the owner, which is subject to FORCE ROW LEVEL SECURITY too, so
  // each organization's rows are written inside its own tenant context.
  const appUrl = `postgres://${APP_USER}:${APP_PASSWORD}@${container.getHost()}:${String(container.getPort())}/${container.getDatabase()}`;
  pool = createPool({ connectionString: appUrl });
  db = createDatabase(pool);

  await withoutTenant(db, async (tx) => {
    await tx.insert(organizations).values([acme, globex]);
  });

  for (const org of [acme, globex]) {
    await withTenant(db, org.id, async (tx) => {
      await tx
        .insert(teams)
        .values({ orgId: org.id, name: `${org.name} Platform`, slug: 'platform' });
      await tx
        .insert(services)
        .values({ orgId: org.id, name: 'payment-service', slug: 'payment-service' });
    });
  }
}, 120_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

describe('withTenant', () => {
  it('returns only the current organization rows', async () => {
    const acmeServices = await withTenant(db, acme.id, (tx) => tx.select().from(services));
    const globexServices = await withTenant(db, globex.id, (tx) => tx.select().from(services));

    expect(acmeServices).toHaveLength(1);
    expect(acmeServices[0]?.orgId).toBe(acme.id);
    expect(globexServices).toHaveLength(1);
    expect(globexServices[0]?.orgId).toBe(globex.id);
  });

  it('hides another organization row even when queried by its exact id', async () => {
    const [target] = await withTenant(db, globex.id, (tx) => tx.select().from(services));

    const found = await withTenant(db, acme.id, (tx) =>
      tx
        .select()
        .from(services)
        .where(eq(services.id, target?.id ?? '')),
    );

    expect(found).toEqual([]);
  });

  it('returns nothing when tenant context was never established', async () => {
    // The failure mode this defends against: a repository call that forgot to
    // scope by organization. It must return no rows, not every organization's.
    const leaked = await withoutTenant(db, (tx) => tx.select().from(services));

    expect(leaked).toEqual([]);
  });

  it('refuses to write a row belonging to another organization', async () => {
    await expectDbError(
      withTenant(db, acme.id, (tx) =>
        tx.insert(services).values({ orgId: globex.id, name: 'smuggled', slug: 'smuggled' }),
      ),
      RLS_VIOLATION,
    );
  });

  it('cannot update another organization row into view', async () => {
    const result = await withTenant(db, acme.id, (tx) =>
      tx.update(services).set({ name: 'renamed' }).where(eq(services.slug, 'payment-service')),
    );

    const globexService = await withTenant(db, globex.id, (tx) => tx.select().from(services));
    expect(result.rowCount).toBe(1);
    expect(globexService[0]?.name).toBe('payment-service');
  });

  it('clears the setting after the transaction, so a pooled connection cannot leak it', async () => {
    await withTenant(db, acme.id, (tx) => tx.select().from(services));

    const leaked = await withoutTenant(db, (tx) => tx.select().from(services));
    expect(leaked).toEqual([]);
  });

  it('rejects an organization id that is not a UUID', async () => {
    await expect(
      withTenant(db, "' or true --", (tx) => tx.select().from(services)),
    ).rejects.toThrow(InvalidTenantError);
  });

  it('rolls back the whole transaction on failure', async () => {
    await expect(
      withTenant(db, acme.id, async (tx) => {
        await tx.insert(teams).values({ orgId: acme.id, name: 'Temporary', slug: 'temporary' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const found = await withTenant(db, acme.id, (tx) =>
      tx.select().from(teams).where(eq(teams.slug, 'temporary')),
    );
    expect(found).toEqual([]);
  });
});

describe('schema constraints', () => {
  it('treats email as case-insensitive for uniqueness', async () => {
    await withoutTenant(db, (tx) =>
      tx.insert(users).values({ email: 'Ada@Acme.test', passwordHash: 'x', displayName: 'Ada' }),
    );

    await expectDbError(
      withoutTenant(db, (tx) =>
        tx
          .insert(users)
          .values({ email: 'ada@acme.TEST', passwordHash: 'y', displayName: 'Ada 2' }),
      ),
      UNIQUE_VIOLATION,
    );
  });

  it('allows the same team slug in different organizations', async () => {
    const slugs = await Promise.all(
      [acme, globex].map((org) =>
        withTenant(db, org.id, (tx) => tx.select().from(teams).where(eq(teams.slug, 'platform'))),
      ),
    );

    expect(slugs.map((rows) => rows.length)).toEqual([1, 1]);
  });

  it('rejects a duplicate team slug within one organization', async () => {
    await expectDbError(
      withTenant(db, acme.id, (tx) =>
        tx.insert(teams).values({ orgId: acme.id, name: 'Platform again', slug: 'platform' }),
      ),
      UNIQUE_VIOLATION,
    );
  });

  it('makes a cross-tenant reference unstorable via the composite foreign key', async () => {
    const [globexTeam] = await withTenant(db, globex.id, (tx) => tx.select().from(teams));

    // The row-level security policy would already hide the team; the composite
    // key is the layer that makes the reference impossible even if it did not.
    await expectDbError(
      withTenant(db, acme.id, (tx) =>
        tx.insert(services).values({
          orgId: acme.id,
          name: 'cross-tenant',
          slug: 'cross-tenant',
          ownerTeamId: globexTeam?.id,
        }),
      ),
      FOREIGN_KEY_VIOLATION,
    );
  });

  it('gives every user a membership role that defaults to ENGINEER', async () => {
    const [user] = await withoutTenant(db, (tx) =>
      tx
        .insert(users)
        .values({ email: 'grace@acme.test', passwordHash: 'x', displayName: 'Grace' })
        .returning(),
    );

    const [membership] = await withTenant(db, acme.id, (tx) =>
      tx
        .insert(memberships)
        .values({ orgId: acme.id, userId: user?.id ?? '' })
        .returning(),
    );

    expect(membership?.role).toBe('ENGINEER');
  });
});

describe('policy coverage', () => {
  it('has row-level security enabled with a policy on every tenant table', async () => {
    // Guards the failure mode of adding a tenant table and forgetting its
    // policy: the table would silently be readable across organizations.
    const rows = await withoutTenant(db, (tx) =>
      tx.execute<{ table: string; enabled: boolean; policies: number }>(sql`
        SELECT c.relname AS table,
               c.relrowsecurity AS enabled,
               count(p.polname)::int AS policies
        FROM pg_class c
        LEFT JOIN pg_policy p ON p.polrelid = c.oid
        WHERE c.relname = ANY(string_to_array(${TENANT_TABLES.join(',')}, ','))
        GROUP BY c.relname, c.relrowsecurity
      `),
    );

    expect(rows.rows).toHaveLength(TENANT_TABLES.length);
    for (const row of rows.rows) {
      expect({ table: row.table, enabled: row.enabled, hasPolicy: row.policies > 0 }).toEqual({
        table: row.table,
        enabled: true,
        hasPolicy: true,
      });
    }
  });
});

describe('membership self-read policy', () => {
  it('lets a user see their own memberships without organization context', async () => {
    // This is the query that must work at login, before any organization is
    // chosen; the tenant policy alone could never satisfy it.
    const [member] = await withoutTenant(db, (tx) =>
      tx
        .insert(users)
        .values({ email: 'self@acme.test', passwordHash: 'x', displayName: 'Self' })
        .returning(),
    );
    const memberId = member?.id ?? '';
    for (const org of [acme, globex]) {
      await withTenant(db, org.id, (tx) =>
        tx.insert(memberships).values({ orgId: org.id, userId: memberId, role: 'ADMIN' }),
      );
    }

    const own = await withUser(db, memberId, (tx) => tx.select().from(memberships));

    expect(own.map((row) => row.orgId).sort()).toEqual([acme.id, globex.id].sort());
  });

  it('does not expose anyone else memberships', async () => {
    const [other] = await withoutTenant(db, (tx) =>
      tx
        .insert(users)
        .values({ email: 'other@acme.test', passwordHash: 'x', displayName: 'Other' })
        .returning(),
    );
    const otherId = other?.id ?? '';
    await withTenant(db, acme.id, (tx) =>
      tx.insert(memberships).values({ orgId: acme.id, userId: otherId }),
    );

    const [stranger] = await withoutTenant(db, (tx) =>
      tx
        .insert(users)
        .values({ email: 'stranger@acme.test', passwordHash: 'x', displayName: 'Stranger' })
        .returning(),
    );

    const visible = await withUser(db, stranger?.id ?? '', (tx) => tx.select().from(memberships));

    expect(visible).toEqual([]);
  });

  it('does not allow writing a membership with only user context', async () => {
    const [user] = await withoutTenant(db, (tx) =>
      tx
        .insert(users)
        .values({ email: 'writer@acme.test', passwordHash: 'x', displayName: 'Writer' })
        .returning(),
    );

    // Self-read is SELECT-only: a user cannot add themselves to an organization.
    await expectDbError(
      withUser(db, user?.id ?? '', (tx) =>
        tx.insert(memberships).values({ orgId: acme.id, userId: user?.id ?? '', role: 'OWNER' }),
      ),
      RLS_VIOLATION,
    );
  });
});
