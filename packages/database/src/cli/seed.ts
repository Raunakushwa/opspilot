import { createDatabase, createPool } from '../client.js';
import { seed } from '../seed/index.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  // eslint-disable-next-line no-console
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const pool = createPool({ connectionString, applicationName: 'opspilot-seed' });

seed(createDatabase(pool)).then(
  async (result) => {
    // eslint-disable-next-line no-console
    console.log('seeded Acme Engineering:', JSON.stringify(result.counts));
    // eslint-disable-next-line no-console
    console.log('demo incident:', result.demoIncidentId);
    await pool.end();
  },
  async (err: unknown) => {
    // eslint-disable-next-line no-console
    console.error('seed failed:', err instanceof Error ? err.message : err);
    await pool.end();
    process.exit(1);
  },
);
