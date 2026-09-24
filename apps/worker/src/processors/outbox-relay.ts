import { type Database, withTenant, withoutTenant } from '@opspilot/database';
import { organizations, outboxEvents } from '@opspilot/database/schema';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { type Redis } from 'ioredis';
import { type Logger } from 'pino';

/**
 * Publishes committed domain events to Redis (ADR-002).
 *
 * The event was written in the same transaction as the change, so it cannot be
 * lost between commit and publish. This relay is the at-least-once half: a
 * crash after publishing but before marking means the event is delivered
 * twice, which subscribers tolerate because each carries its own id.
 */

export const CHANNEL_PREFIX = 'opspilot:org:';

export function channelFor(organizationId: string): string {
  return `${CHANNEL_PREFIX}${organizationId}`;
}

export interface RelayOptions {
  db: Database;
  redis: Redis;
  logger: Logger;
  batchSize?: number;
  intervalMs?: number;
}

export function createOutboxRelay({
  db,
  redis,
  logger,
  batchSize = 100,
  intervalMs = 1000,
}: RelayOptions) {
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  /** One pass over the unpublished events of every organization. */
  const drain = async (): Promise<number> => {
    const orgs = await withoutTenant(db, (tx) =>
      tx.select({ id: organizations.id }).from(organizations),
    );

    let published = 0;
    for (const org of orgs) {
      const pending = await withTenant(db, org.id, (tx) =>
        tx
          .select()
          .from(outboxEvents)
          .where(and(eq(outboxEvents.orgId, org.id), isNull(outboxEvents.publishedAt)))
          .orderBy(asc(outboxEvents.createdAt))
          .limit(batchSize),
      );

      for (const event of pending) {
        await redis.publish(
          channelFor(org.id),
          JSON.stringify({ id: event.id, topic: event.topic, payload: event.payload }),
        );
        await withTenant(db, org.id, (tx) =>
          tx
            .update(outboxEvents)
            .set({ publishedAt: new Date() })
            .where(eq(outboxEvents.id, event.id)),
        );
        published += 1;
      }
    }
    return published;
  };

  return {
    drain,
    start: () => {
      timer = setInterval(() => {
        if (running) return; // never overlap passes
        running = true;
        drain()
          .then((count) => {
            if (count > 0) logger.debug({ count }, 'relayed outbox events');
          })
          .catch((err: unknown) => {
            logger.error({ err }, 'outbox relay failed');
          })
          .finally(() => {
            running = false;
          });
      }, intervalMs);
    },
    stop: () => {
      if (timer) clearInterval(timer);
    },
    /** Housekeeping: published rows are history, not a queue. */
    prune: async (olderThanHours = 24) => {
      const orgs = await withoutTenant(db, (tx) =>
        tx.select({ id: organizations.id }).from(organizations),
      );
      for (const org of orgs) {
        await withTenant(db, org.id, (tx) =>
          tx
            .delete(outboxEvents)
            .where(
              and(
                eq(outboxEvents.orgId, org.id),
                sql`${outboxEvents.publishedAt} < now() - make_interval(hours => ${olderThanHours})`,
              ),
            ),
        );
      }
    },
  };
}
