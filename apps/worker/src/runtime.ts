import { type Job, UnrecoverableError, Worker } from 'bullmq';
import { type Redis } from 'ioredis';
import { type Logger } from 'pino';
import { type z } from 'zod';

import { type JobHandler } from './processors/index.js';
import { recordDeadLetter, toDeadLetterRecord } from './queues/dead-letter.js';
import { type JobDefinition, PROCESSED_QUEUES, QueueName } from './queues/definitions.js';
import { createQueues, type QueueRegistry } from './queues/enqueue.js';

export interface RuntimeOptions {
  connection: Redis;
  logger: Logger;
  concurrency: number;
  handlers: Record<string, JobHandler>;
  definitions: JobDefinition<z.ZodType>[];
}

export interface Runtime {
  queues: QueueRegistry;
  workers: Worker[];
  close: () => Promise<void>;
}

export function createRuntime({
  connection,
  logger,
  concurrency,
  handlers,
  definitions,
}: RuntimeOptions): Runtime {
  const queues = createQueues(connection);
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));

  const process = async (job: Job): Promise<unknown> => {
    const definition = byName.get(job.name);
    const handler = handlers[job.name];
    if (!definition || !handler) {
      // Retrying cannot help: the deployment simply has no code for this job.
      throw new UnrecoverableError(`No handler registered for job "${job.name}"`);
    }

    const parsed = definition.schema.safeParse(job.data);
    if (!parsed.success) {
      // A malformed payload will still be malformed on the next attempt.
      throw new UnrecoverableError(
        `Invalid payload for "${job.name}": ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
      );
    }

    const jobLogger = logger.child({ queue: job.queueName, job: job.name, jobId: job.id });
    return handler(parsed.data as never, job, { logger: jobLogger });
  };

  const workers = PROCESSED_QUEUES.map((queueName) => {
    const worker = new Worker(queueName, process, { connection, concurrency });

    worker.on('failed', (job, error) => {
      if (!job) {
        logger.error({ err: error, queue: queueName }, 'job failed before it could be loaded');
        return;
      }
      const attempts = job.opts.attempts ?? 1;
      logger.warn(
        { err: error, queue: queueName, job: job.name, jobId: job.id, attempt: job.attemptsMade },
        'job attempt failed',
      );

      // `isFailed()` is true only once BullMQ has stopped retrying — including
      // UnrecoverableError, which ends a job before its attempts are spent.
      void job
        .isFailed()
        .then(async (isTerminal) => {
          if (!isTerminal) return;
          await recordDeadLetter(queues[QueueName.DeadLetter], toDeadLetterRecord(job, error));
          logger.error(
            {
              queue: queueName,
              job: job.name,
              jobId: job.id,
              attempts: job.attemptsMade,
              of: attempts,
            },
            'job dead-lettered',
          );
        })
        .catch((err: unknown) => {
          logger.error({ err, jobId: job.id }, 'failed to record dead letter');
        });
    });

    worker.on('error', (err) => {
      logger.error({ err, queue: queueName }, 'worker error');
    });

    return worker;
  });

  return {
    queues,
    workers,
    close: async () => {
      // Workers first: each waits for its in-flight jobs to finish.
      await Promise.all(workers.map((worker) => worker.close()));
      await Promise.all(Object.values(queues).map((queue) => queue.close()));
    },
  };
}
