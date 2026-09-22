import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import journal from '../migrations/meta/_journal.json' with { type: 'json' };
import { runMigrations } from './migrate.js';
import { provisionAppUser } from './provision.js';

const APP_USER = 'opspilot_app';
const APP_PASSWORD = 'app-test-password';

let container: StartedPostgreSqlContainer;
let ownerUrl: string;

function urlFor(
  database: string,
  user = container.getUsername(),
  password = container.getPassword(),
) {
  return `postgres://${user}:${password}@${container.getHost()}:${container.getPort()}/${database}`;
}

async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function appliedMigrationCount(url: string): Promise<number> {
  return withClient(url, async (client) => {
    const result = await client.query<{ count: string }>(
      'SELECT count(*) FROM drizzle.__drizzle_migrations',
    );
    return Number(result.rows[0]?.count);
  });
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  ownerUrl = urlFor(container.getDatabase());

  await runMigrations({ connectionString: ownerUrl });
  // What infrastructure does in each environment: a LOGIN user that inherits app_rw.
  await withClient(ownerUrl, (client) =>
    client.query(`CREATE ROLE ${APP_USER} LOGIN PASSWORD '${APP_PASSWORD}' IN ROLE app_rw`),
  );
});

afterAll(async () => {
  await container.stop();
});

describe('runMigrations', () => {
  it('applies every migration in the journal', async () => {
    expect(await appliedMigrationCount(ownerUrl)).toBe(journal.entries.length);

    const extensions = await withClient(ownerUrl, (client) =>
      client.query<{ extname: string }>(
        "SELECT extname FROM pg_extension WHERE extname = 'citext'",
      ),
    );
    expect(extensions.rows).toHaveLength(1);
  });

  it('is idempotent when re-run', async () => {
    await runMigrations({ connectionString: ownerUrl });

    expect(await appliedMigrationCount(ownerUrl)).toBe(journal.entries.length);
  });

  it('serialises concurrent runners against a fresh database', async () => {
    await withClient(ownerUrl, (client) => client.query('CREATE DATABASE concurrent_runs'));
    const url = urlFor('concurrent_runs');

    await Promise.all([1, 2, 3, 4].map(() => runMigrations({ connectionString: url })));

    expect(await appliedMigrationCount(url)).toBe(journal.entries.length);
  });
});

describe('application role', () => {
  const appUrl = () => urlFor(container.getDatabase(), APP_USER, APP_PASSWORD);

  it('cannot bypass row-level security or escalate privileges', async () => {
    const role = await withClient(ownerUrl, (client) =>
      client.query<{ rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean }>(
        'SELECT rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = $1',
        [APP_USER],
      ),
    );

    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, rolcreaterole: false });
  });

  it('cannot create tables', async () => {
    await expect(
      withClient(appUrl(), (client) => client.query('CREATE TABLE sneaky (id int)')),
    ).rejects.toThrow(/permission denied for schema public/);
  });

  it('gets data privileges, but not ownership, on tables created by later migrations', async () => {
    await withClient(ownerUrl, (client) =>
      client.query('CREATE TABLE widgets (id bigserial PRIMARY KEY, name text NOT NULL)'),
    );

    await withClient(appUrl(), async (client) => {
      await client.query("INSERT INTO widgets (name) VALUES ('gear')");
      const rows = await client.query<{ name: string }>('SELECT name FROM widgets');
      expect(rows.rows).toEqual([{ name: 'gear' }]);

      await expect(client.query('DROP TABLE widgets')).rejects.toThrow(/must be owner/);
      await expect(client.query('ALTER TABLE widgets ADD COLUMN x int')).rejects.toThrow(
        /must be owner/,
      );
    });
  });

  it('cannot read or tamper with migration history', async () => {
    await expect(
      withClient(appUrl(), (client) => client.query('SELECT * FROM drizzle.__drizzle_migrations')),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('provisionAppUser', () => {
  const username = 'app_provisioned';
  const password = 'a-long-enough-password';

  it('creates a login role that inherits app_rw and can use the data', async () => {
    await provisionAppUser({ connectionString: ownerUrl, username, password });

    const role = await withClient(ownerUrl, (client) =>
      client.query<{ rolcanlogin: boolean; rolsuper: boolean }>(
        'SELECT rolcanlogin, rolsuper FROM pg_roles WHERE rolname = $1',
        [username],
      ),
    );
    expect(role.rows[0]).toEqual({ rolcanlogin: true, rolsuper: false });

    await withClient(ownerUrl, (client) =>
      client.query('CREATE TABLE IF NOT EXISTS provisioned_widgets (id int)'),
    );
    await withClient(urlFor(container.getDatabase(), username, password), async (client) => {
      await client.query('INSERT INTO provisioned_widgets VALUES (1)');
      await expect(client.query('CREATE TABLE nope (id int)')).rejects.toThrow(/permission denied/);
    });
  });

  it('is idempotent and rotates the password on re-run', async () => {
    const rotated = 'another-long-password';

    await provisionAppUser({ connectionString: ownerUrl, username, password });
    await provisionAppUser({ connectionString: ownerUrl, username, password: rotated });

    await withClient(urlFor(container.getDatabase(), username, rotated), (client) =>
      client.query('SELECT 1'),
    );
  });

  it('rejects role names that are not plain identifiers', async () => {
    await expect(
      provisionAppUser({
        connectionString: ownerUrl,
        username: 'evil"; DROP TABLE widgets; --',
        password,
      }),
    ).rejects.toThrow(/Invalid role name/);
  });

  it('rejects a weak password before touching the database', async () => {
    await expect(
      provisionAppUser({ connectionString: ownerUrl, username: 'app_weak', password: 'short' }),
    ).rejects.toThrow(/at least 12 characters/);
  });
});
