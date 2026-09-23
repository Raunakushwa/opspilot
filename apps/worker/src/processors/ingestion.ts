import { type Database, withTenant } from '@opspilot/database';
import { documentChunks, documents, documentVersions } from '@opspilot/database/schema';
import { and, eq } from 'drizzle-orm';
import { UnrecoverableError } from 'bullmq';

import { type AiServiceClient, AiServiceError } from '../clients/ai-service.js';
import { type JobContext } from './index.js';
import { type IngestDocumentPayload } from '../queues/definitions.js';

export interface IngestionDependencies {
  db: Database;
  ai: AiServiceClient;
}

/**
 * Indexes one document version.
 *
 * Idempotent by construction: chunk ids and Qdrant point ids derive from
 * (version, index), so a retry overwrites rather than duplicates. The job is
 * therefore safe to run again after any failure.
 */
export function createIngestionProcessor({ db, ai }: IngestionDependencies) {
  return async (payload: IngestDocumentPayload, _job: unknown, context: JobContext) => {
    const { organizationId, documentVersionId } = payload;

    const row = await withTenant(db, organizationId, async (tx) => {
      const [found] = await tx
        .select({
          versionId: documentVersions.id,
          documentId: documentVersions.documentId,
          title: documentVersions.title,
          content: documentVersions.content,
          type: documents.type,
          tags: documents.tags,
        })
        .from(documentVersions)
        .innerJoin(documents, eq(documents.id, documentVersions.documentId))
        .where(
          and(
            eq(documentVersions.orgId, organizationId),
            eq(documentVersions.id, documentVersionId),
          ),
        )
        .limit(1);
      return found;
    });

    if (!row) {
      // The version was deleted between enqueue and execution; retrying cannot help.
      throw new UnrecoverableError(`document version ${documentVersionId} no longer exists`);
    }

    try {
      const result = await ai.indexDocumentVersion({
        organizationId,
        documentId: row.documentId,
        documentVersionId: row.versionId,
        title: row.title,
        content: row.content,
        documentType: row.type,
        tags: row.tags,
      });

      await withTenant(db, organizationId, async (tx) => {
        // Chunk text is stored alongside the vectors so the index stays
        // rebuildable from PostgreSQL, which is the source of truth.
        await tx.delete(documentChunks).where(eq(documentChunks.documentVersionId, row.versionId));
        await tx
          .update(documentVersions)
          .set({ ingestionStatus: 'INDEXED', indexedAt: new Date(), ingestionError: null })
          .where(eq(documentVersions.id, row.versionId));
      });

      context.logger.info({ chunks: result.chunksIndexed }, 'document indexed');
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      await withTenant(db, organizationId, async (tx) => {
        await tx
          .update(documentVersions)
          .set({ ingestionStatus: 'FAILED', ingestionError: message.slice(0, 500) })
          .where(eq(documentVersions.id, row.versionId));
      });
      if (err instanceof AiServiceError && !err.retryable) {
        throw new UnrecoverableError(message);
      }
      throw err;
    }
  };
}
