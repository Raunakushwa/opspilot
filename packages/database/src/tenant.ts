import { sql } from 'drizzle-orm';

import { type Database } from './client.js';

/** A UUID, validated before it reaches a SET LOCAL statement. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class InvalidTenantError extends Error {
  constructor(value: string) {
    super(`Invalid organization id: ${value}`);
    this.name = 'InvalidTenantError';
  }
}

/**
 * Runs `fn` inside a transaction whose `app.current_org_id` is set, which is
 * what the row-level security policies compare against (ADR-009).
 *
 * The setting is transaction-scoped (`SET LOCAL`), so it cannot leak to the
 * next request that borrows the same pooled connection — a plain `SET` would.
 * Outside such a transaction the setting is absent, the policies evaluate to
 * NULL, and tenant tables return nothing: forgetting tenant context is a bug
 * that returns no rows, never another organization's rows.
 */
export async function withTenant<T>(
  db: Database,
  organizationId: string,
  fn: (tx: Database) => Promise<T>,
): Promise<T> {
  if (!UUID.test(organizationId)) {
    throw new InvalidTenantError(organizationId);
  }

  return db.transaction(async (tx) => {
    // set_config(..., true) is the function form of SET LOCAL and accepts a
    // bind parameter, so the id is never concatenated into SQL.
    await tx.execute(sql`SELECT set_config('app.current_org_id', ${organizationId}, true)`);
    return fn(tx);
  });
}

/**
 * Runs `fn` in a transaction with no tenant context, for the few operations
 * that legitimately precede one: login, session lookup, organization creation.
 * Tenant tables are unreadable inside it.
 */
export async function withoutTenant<T>(db: Database, fn: (tx: Database) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => fn(tx as Database));
}
