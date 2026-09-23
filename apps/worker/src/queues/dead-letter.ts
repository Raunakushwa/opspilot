import { type Job, type Queue } from 'bullmq';

import { QueueName } from './definitions.js';

export interface DeadLetterRecord {
  queue: string;
  jobName: string;
  jobId: string;
  payload: unknown;
  attemptsMade: number;
  failedReason: string;
  failedAt: string;
}

const MAX_REASON_LENGTH = 2000;

export function toDeadLetterRecord(job: Job, error: Error, now = new Date()): DeadLetterRecord {
  return {
    queue: job.queueName,
    jobName: job.name,
    jobId: job.id ?? '',
    payload: job.data,
    attemptsMade: job.attemptsMade,
    failedReason: error.message.slice(0, MAX_REASON_LENGTH),
    failedAt: now.toISOString(),
  };
}

/**
 * Terminal failures are copied to a queue nothing consumes, so they survive the
 * original job's retention window and can be listed, replayed or alerted on. A future
 * admin endpoint reads this queue; Phase 4 also persists a `job_failures` row.
 */
export async function recordDeadLetter(
  deadLetterQueue: Queue,
  record: DeadLetterRecord,
): Promise<void> {
  await deadLetterQueue.add(record.jobName, record, {
    attempts: 1,
    // Dead letters are the audit trail of automation failure: keep them all.
    removeOnComplete: false,
    removeOnFail: false,
    // BullMQ rejects ':' in custom job ids (it is its key separator).
    jobId: `${record.queue}-${record.jobId}-${String(record.attemptsMade)}`,
  });
}

export const DEAD_LETTER_QUEUE = QueueName.DeadLetter;
