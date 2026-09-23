import { type JobsOptions, Queue } from 'bullmq';
import { type Redis } from 'ioredis';
import { type z } from 'zod';

import { DEFAULT_JOB_OPTIONS, type JobDefinition, QueueName } from './definitions.js';

export type QueueRegistry = Record<QueueName, Queue>;

export function createQueues(connection: Redis): QueueRegistry {
  const entries = Object.values(QueueName).map((name) => [
    name,
    new Queue(name, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS }),
  ]);
  return Object.fromEntries(entries) as QueueRegistry;
}

export interface EnqueueOptions extends JobsOptions {
  /**
   * Stable ID for at-most-once semantics: re-enqueuing the same ID while the
   * job is queued or running is a no-op, which makes producers safe to retry.
   */
  jobId?: string;
}

/**
 * Validates the payload in the producer, so a malformed job is rejected at the
 * call site with a stack trace instead of failing later inside a worker.
 */
export type Enqueue = <TSchema extends z.ZodType>(
  definition: JobDefinition<TSchema>,
  payload: z.input<TSchema>,
  options?: EnqueueOptions,
) => Promise<string>;

export function createEnqueuer(queues: QueueRegistry): Enqueue {
  return async function enqueue<TSchema extends z.ZodType>(
    definition: JobDefinition<TSchema>,
    payload: z.input<TSchema>,
    options: EnqueueOptions = {},
  ): Promise<string> {
    const parsed = definition.schema.parse(payload) as unknown;
    const job = await queues[definition.queue].add(definition.name, parsed, {
      ...definition.options,
      ...options,
    });
    return job.id ?? '';
  };
}
