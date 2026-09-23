import { type Database, withTenant, withoutTenant } from '@opspilot/database';
import { documentVersions, organizations } from '@opspilot/database/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { type Logger } from 'pino';

import { ingestDocument } from '../queues/definitions.js';
import { type Enqueue } from '../queues/enqueue.js';

/**
 * Re-queues document versions that are not indexed.
 *
 * Runs at startup because ingestion is at-least-once and best-effort: a job
 * can be lost to a crash, a dead letter, or a database seeded outside the
 * normal flow. Reconciling from the source of truth is cheaper and more
 * reliable than trying to make the queue perfectly durable.
 *
 * Safe to run repeatedly: the job id is derived from the version, so a version
 * already queued or running is not queued twice.
 */
export async function reconcilePendingIngestion(
  db: Database,
  enqueue: Enqueue,
  logger: Logger,
): Promise<number> {
  const orgs = await withoutTenant(db, (tx) =>
    tx.select({ id: organizations.id }).from(organizations),
  );

  let queued = 0;
  for (const org of orgs) {
    const pending = await withTenant(db, org.id, (tx) =>
      tx
        .select({ id: documentVersions.id })
        .from(documentVersions)
        .where(
          and(
            eq(documentVersions.orgId, org.id),
            inArray(documentVersions.ingestionStatus, ['PENDING', 'FAILED']),
          ),
        ),
    );

    for (const version of pending) {
      await enqueue(
        ingestDocument,
        { organizationId: org.id, documentVersionId: version.id },
        // ':' is BullMQ's key separator and is rejected in custom job ids.
        { jobId: `ingest-${version.id}` },
      );
      queued += 1;
    }
  }

  if (queued > 0) {
    logger.info({ queued }, 'queued unindexed document versions');
  }
  return queued;
}
