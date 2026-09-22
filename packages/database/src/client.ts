import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import * as schema from './schema/index.js';

export type Database = NodePgDatabase<typeof schema>;

export interface PoolOptions {
  connectionString: string;
  max?: number;
  applicationName?: string;
}

export function createPool({ connectionString, max = 10, applicationName }: PoolOptions): pg.Pool {
  return new pg.Pool({
    connectionString,
    max,
    ...(applicationName === undefined ? {} : { application_name: applicationName }),
  });
}

export function createDatabase(pool: pg.Pool): Database {
  return drizzle(pool, { schema, casing: 'snake_case' });
}
