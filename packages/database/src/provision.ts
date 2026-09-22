import pg from 'pg';

export interface ProvisionAppUserOptions {
  /** Owner/migrator connection: creating roles needs CREATEROLE. */
  connectionString: string;
  username: string;
  password: string;
  /** Group role created by migration 0000. */
  memberOf?: string;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Creates (or updates) the application's LOGIN role and makes it a member of
 * the privilege-holding group role.
 *
 * Migrations cannot do this: they would have to contain a password. Locally
 * this runs from the migrate container; in AWS the equivalent step is Terraform
 * reading the password from Secrets Manager.
 */
export async function provisionAppUser({
  connectionString,
  username,
  password,
  memberOf = 'app_rw',
}: ProvisionAppUserOptions): Promise<void> {
  // Role names cannot be parameterised, so they are validated rather than escaped.
  for (const identifier of [username, memberOf]) {
    if (!IDENTIFIER.test(identifier)) {
      throw new Error(`Invalid role name: ${identifier}`);
    }
  }
  if (password.length < 12) {
    throw new Error('Application database password must be at least 12 characters');
  }

  const client = new pg.Client({ connectionString, application_name: 'opspilot-provision' });
  await client.connect();
  try {
    const existing = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [username]);

    // DDL cannot be parameterised, so PostgreSQL builds the statement itself:
    // format() quotes the identifier (%I) and the password literal (%L). The
    // password is only ever sent as a bind parameter from this process.
    const verb = existing.rowCount === 0 ? 'CREATE' : 'ALTER';
    const roleStatement = await client.query<{ sql: string }>(
      `SELECT format('${verb} ROLE %I LOGIN PASSWORD %L', $1::text, $2::text) AS sql`,
      [username, password],
    );
    await client.query(roleStatement.rows[0]?.sql ?? '');

    const grantStatement = await client.query<{ sql: string }>(
      "SELECT format('GRANT %I TO %I', $1::text, $2::text) AS sql",
      [memberOf, username],
    );
    await client.query(grantStatement.rows[0]?.sql ?? '');
  } finally {
    await client.end();
  }
}
