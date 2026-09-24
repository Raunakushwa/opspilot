import { type JobsOptions } from 'bullmq';
import { z } from 'zod';

/**
 * Queues are split by failure domain and latency budget, not by feature:
 * a slow embedding batch must never delay a notification, and AI jobs need
 * their own concurrency limit because each one costs money.
 */
export const QueueName = {
  System: 'system',
  Ingestion: 'ingestion',
  Notifications: 'notifications',
  Ai: 'ai',
  /** Terminal failures; inspected and replayed by operators, never auto-consumed. */
  DeadLetter: 'dead-letter',
} as const;
export type QueueName = (typeof QueueName)[keyof typeof QueueName];

/** Queues that have a worker attached. */
export const PROCESSED_QUEUES: QueueName[] = [
  QueueName.System,
  QueueName.Ingestion,
  QueueName.Notifications,
  QueueName.Ai,
];

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  // 1s, 2s, 4s, 8s (+ jitter) — long enough to ride out a dependency restart,
  // short enough that a notification is not hours late.
  backoff: { type: 'exponential', delay: 1000, jitter: 0.5 },
  removeOnComplete: { age: 3600, count: 1000 },
  // Failed jobs are copied to the dead-letter queue; the originals are kept
  // for a week so the failure can still be inspected in context.
  removeOnFail: { age: 7 * 24 * 3600 },
};

export interface JobDefinition<TSchema extends z.ZodType> {
  name: string;
  queue: QueueName;
  schema: TSchema;
  options?: JobsOptions;
}

export function defineJob<TSchema extends z.ZodType>(
  definition: JobDefinition<TSchema>,
): JobDefinition<TSchema> {
  return definition;
}

/** Minimal job used by tests and by the deployment smoke check. */
export const systemPing = defineJob({
  name: 'system.ping',
  queue: QueueName.System,
  schema: z.object({ echo: z.string().min(1) }),
});

export type SystemPingPayload = z.infer<typeof systemPing.schema>;

/** Index one document version into the vector store. */
export const ingestDocument = defineJob({
  name: 'document.ingest',
  queue: QueueName.Ingestion,
  schema: z.object({
    organizationId: z.uuid(),
    documentVersionId: z.uuid(),
  }),
  options: {
    // Embedding is expensive; fewer attempts, longer backoff than the default.
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  },
});

export type IngestDocumentPayload = z.infer<typeof ingestDocument.schema>;

/** Run one AI investigation. */
export const runInvestigation = defineJob({
  name: 'ai.investigate',
  queue: QueueName.Ai,
  schema: z.object({
    organizationId: z.uuid(),
    runId: z.uuid(),
    incidentId: z.uuid(),
    userId: z.uuid(),
    question: z.string().min(3).max(1000),
  }),
  options: {
    // Investigations cost money and are not idempotent from the user's point
    // of view: one retry for a transient failure, no more.
    attempts: 2,
    backoff: { type: 'fixed', delay: 3000 },
  },
});

export type RunInvestigationPayload = z.infer<typeof runInvestigation.schema>;
