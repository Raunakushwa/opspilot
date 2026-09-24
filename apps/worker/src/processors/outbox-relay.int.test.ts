import {
  createDatabase,
  createPool,
  provisionAppUser,
  runMigrations,
  seed,
  withTenant,
  type Database,
  type DatabasePool,
} from '@opspilot/database';
import { outboxEvents } from '@opspilot/database/schema';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { channelFor, createOutboxRelay } from './outbox-relay.js';

const APP_USER = 'opspilot_app';
const APP_PASSWORD = 'relay-integration-password';

let postgres: StartedPostgreSqlContainer;
let redisContainer: StartedRedisContainer;
let pool: DatabasePool;
let db: Database;
let redis: Redis;
let organizationId: string;
let relay: ReturnType<typeof createOutboxRelay>;

async function pendingCount(): Promise<number> {
  const result = await withTenant(db, organizationId, (tx) =>
    tx.execute<{ total: number }>(
      sql`SELECT count(*)::int AS total FROM outbox_events WHERE published_at IS NULL`,
    ),
  );
  return result.rows[0]?.total ?? 0;
}

async function writeEvent(topic: string, payload: Record<string, unknown>): Promise<void> {
  await withTenant(db, organizationId, (tx) =>
    tx.insert(outboxEvents).values({ orgId: organizationId, topic, payload }),
  );
}

beforeAll(async () => {
  [postgres, redisContainer] = await Promise.all([
    new PostgreSqlContainer('postgres:17-alpine').start(),
    new RedisContainer('redis:7-alpine').start(),
  ]);

  const ownerUrl = postgres.getConnectionUri();
  await runMigrations({ connectionString: ownerUrl });
  await provisionAppUser({
    connectionString: ownerUrl,
    username: APP_USER,
    password: APP_PASSWORD,
  });

  pool = createPool({
    connectionString: `postgres://${APP_USER}:${APP_PASSWORD}@${postgres.getHost()}:${String(postgres.getPort())}/${postgres.getDatabase()}`,
  });
  db = createDatabase(pool);
  organizationId = (await seed(db)).organizationId;

  redis = new Redis(redisContainer.getConnectionUrl());
  relay = createOutboxRelay({ db, redis, logger: pino({ level: 'silent' }) });
}, 240_000);

afterAll(async () => {
  relay.stop();
  redis.disconnect();
  await pool.end();
  await Promise.all([postgres.stop(), redisContainer.stop()]);
});

describe('outbox relay', () => {
  it('publishes a committed event to the organization channel', async () => {
    const subscriber = new Redis(redisContainer.getConnectionUrl());
    const received: string[] = [];
    await subscriber.subscribe(channelFor(organizationId));
    subscriber.on('message', (_channel, message) => received.push(message));

    await writeEvent('incident.status.changed', { incidentId: 'abc', to: 'MITIGATING' });
    await relay.drain();
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(received).toHaveLength(1);
    const event = JSON.parse(received[0] ?? '{}') as { topic: string; payload: { to: string } };
    expect(event.topic).toBe('incident.status.changed');
    expect(event.payload.to).toBe('MITIGATING');
    subscriber.disconnect();
  });

  it('marks events published so they are not sent twice', async () => {
    await writeEvent('incident.created', { incidentId: 'once' });

    const first = await relay.drain();
    const second = await relay.drain();

    expect(first).toBeGreaterThan(0);
    expect(second).toBe(0);
    expect(await pendingCount()).toBe(0);
  });

  it('publishes in the order the events were committed', async () => {
    const subscriber = new Redis(redisContainer.getConnectionUrl());
    const topics: string[] = [];
    await subscriber.subscribe(channelFor(organizationId));
    subscriber.on('message', (_channel, message) => {
      topics.push((JSON.parse(message) as { topic: string }).topic);
    });

    for (const topic of ['first.event', 'second.event', 'third.event']) {
      await writeEvent(topic, {});
    }
    await relay.drain();
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(topics).toEqual(['first.event', 'second.event', 'third.event']);
    subscriber.disconnect();
  });

  it('leaves an event unpublished if Redis is unreachable, so nothing is lost', async () => {
    // This is the property the outbox exists for: a failure to publish must
    // not consume the event.
    const brokenRedis = new Redis({
      host: '127.0.0.1',
      port: 1,
      lazyConnect: true,
      retryStrategy: () => null,
      maxRetriesPerRequest: 1,
    });
    const brokenRelay = createOutboxRelay({
      db,
      redis: brokenRedis,
      logger: pino({ level: 'silent' }),
    });

    await writeEvent('incident.updated', { incidentId: 'survives' });
    await expect(brokenRelay.drain()).rejects.toThrow();

    expect(await pendingCount()).toBeGreaterThan(0);
    brokenRedis.disconnect();

    // The working relay picks it up afterwards.
    await relay.drain();
    expect(await pendingCount()).toBe(0);
  });

  it('prunes published history without touching unpublished events', async () => {
    await writeEvent('old.event', {});
    await relay.drain();
    await withTenant(db, organizationId, (tx) =>
      tx
        .update(outboxEvents)
        .set({ publishedAt: new Date(Date.now() - 48 * 3600 * 1000) })
        .where(and(eq(outboxEvents.orgId, organizationId), sql`published_at IS NOT NULL`)),
    );
    await writeEvent('fresh.event', {});

    await relay.prune(24);

    const remaining = await withTenant(db, organizationId, (tx) =>
      tx
        .select({ topic: outboxEvents.topic })
        .from(outboxEvents)
        .where(and(eq(outboxEvents.orgId, organizationId), isNull(outboxEvents.publishedAt))),
    );
    expect(remaining.map((row) => row.topic)).toEqual(['fresh.event']);
  });
});
