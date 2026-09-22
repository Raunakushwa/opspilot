import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

// Resolves to <package>/migrations from both src/ (tsx) and dist/ (compiled).
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

// Arbitrary constant shared by every migrator process.
const MIGRATION_LOCK_ID = 7_346_220_001;

export interface MigrateOptions {
  connectionString: string;
  /** Abort if a DDL statement waits longer than this for a table lock. */
  lockTimeout?: string;
}

/**
 * Applies pending migrations as the schema owner.
 *
 * - A session-level advisory lock serialises concurrent runners (e.g. several
 *   containers starting at once); latecomers wait, then find nothing to do.
 * - `lock_timeout` makes a migration fail fast instead of queueing behind a
 *   long-running query while blocking all traffic to the table it wants.
 */
export async function runMigrations({
  connectionString,
  lockTimeout = '10s',
}: MigrateOptions): Promise<void> {
  const client = new pg.Client({
    connectionString,
    application_name: 'opspilot-migrator',
    options: `-c lock_timeout=${lockTimeout}`,
  });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    try {
      await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    }
  } finally {
    await client.end();
  }
}
