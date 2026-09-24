import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import * as schema from './schema/index.js';

export type Database = NodePgDatabase<typeof schema>;
/** Re-exported so consumers do not need a direct `pg` dependency. */
export type DatabasePool = pg.Pool;

export interface PoolOptions {
  connectionString: string;
  max?: number;
  applicationName?: string;
  /**
   * Called when an *idle* client fails — typically because the server went
   * away. Without a listener, node-postgres re-emits it as an uncaught
   * exception and takes the process down, which is never the right response to
   * one dead connection: the pool simply replaces it.
   */
  onError?: (error: Error) => void;
}

export function createPool({
  connectionString,
  max = 10,
  applicationName,
  onError,
}: PoolOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max,
    ...(applicationName === undefined ? {} : { application_name: applicationName }),
  });
  pool.on('error', (error) => {
    onError?.(error);
  });
  return pool;
}

export function createDatabase(pool: pg.Pool): Database {
  return drizzle(pool, { schema, casing: 'snake_case' });
}
