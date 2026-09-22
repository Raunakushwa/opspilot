import { type DatabasePool } from '@opspilot/database';
import { type Redis } from 'ioredis';

import { type DependencyCheck } from './health.js';

export function postgresCheck(pool: DatabasePool): DependencyCheck {
  return {
    name: 'postgres',
    check: async () => {
      await pool.query('SELECT 1');
    },
  };
}

export function redisCheck(redis: Redis): DependencyCheck {
  return {
    name: 'redis',
    check: async () => {
      await redis.ping();
    },
  };
}
