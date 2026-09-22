import { provisionAppUser } from '../provision.js';

const connectionString = process.env.MIGRATION_DATABASE_URL;
const username = process.env.APP_DB_USER;
const password = process.env.APP_DB_PASSWORD;

if (!connectionString || !username || !password) {
  // eslint-disable-next-line no-console
  console.error('MIGRATION_DATABASE_URL, APP_DB_USER and APP_DB_PASSWORD are required');
  process.exit(1);
}

provisionAppUser({ connectionString, username, password }).then(
  () => {
    // eslint-disable-next-line no-console
    console.log(`provisioned application role "${username}"`);
  },
  (err: unknown) => {
    // eslint-disable-next-line no-console
    console.error('provisioning failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
