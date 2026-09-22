import { runMigrations } from '../migrate.js';

// Migrations run as the schema owner, never as the application user.
const connectionString = process.env.MIGRATION_DATABASE_URL;
if (!connectionString) {
  // eslint-disable-next-line no-console
  console.error('MIGRATION_DATABASE_URL is required');
  process.exit(1);
}

const startedAt = performance.now();
runMigrations({ connectionString }).then(
  () => {
    // eslint-disable-next-line no-console
    console.log(`migrations applied in ${Math.round(performance.now() - startedAt)}ms`);
  },
  (err: unknown) => {
    // eslint-disable-next-line no-console
    console.error('migration failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
