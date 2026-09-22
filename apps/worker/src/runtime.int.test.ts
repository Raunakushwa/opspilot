import { setTimeout as sleep } from 'node:timers/promises';

import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { type JobHandler } from './processors/index.js';
import { QueueName, defineJob } from './queues/definitions.js';
import { createEnqueuer } from './queues/enqueue.js';
import { createRuntime, type Runtime } from './runtime.js';
import { z } from 'zod';

const logger = pino({ level: 'silent' });

const testJob = defineJob({
  name: 'system.test',
  queue: QueueName.System,
  schema: z.object({ value: z.string() }),
});

let container: StartedRedisContainer;
let connection: Redis;
let runtime: Runtime | undefined;

function start(handler: JobHandler): Runtime {
  runtime = createRuntime({
    connection,
    logger,
    concurrency: 2,
    handlers: { [testJob.name]: handler },
    definitions: [testJob],
  });
  return runtime;
}

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await probe();
    if (result !== undefined) return result;
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await sleep(50);
  }
}

async function deadLetters(): Promise<DeadLetterJob[]> {
  const queue = new Queue(QueueName.DeadLetter, { connection });
  try {
    const jobs = await queue.getJobs(['waiting', 'completed', 'active', 'delayed']);
    return jobs.map((job) => job.data as DeadLetterJob);
  } finally {
    await queue.close();
  }
}

interface DeadLetterJob {
  queue: string;
  jobName: string;
  payload: unknown;
  attemptsMade: number;
  failedReason: string;
}

beforeAll(async () => {
  container = await new RedisContainer('redis:7-alpine').start();
  connection = new Redis(container.getConnectionUrl(), { maxRetriesPerRequest: null });
});

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
  await connection.flushall();
});

afterAll(async () => {
  connection.disconnect();
  await container.stop();
});

describe('worker runtime', () => {
  it('processes a valid job', async () => {
    const seen: string[] = [];
    const current = start((payload: never) => {
      seen.push((payload as { value: string }).value);
      return Promise.resolve();
    });
    const enqueue = createEnqueuer(current.queues);

    await enqueue(testJob, { value: 'hello' });

    await waitFor(() => Promise.resolve(seen.length > 0 ? seen : undefined));
    expect(seen).toEqual(['hello']);
  });

  it('retries with exponential backoff until the job succeeds', async () => {
    const attemptsAt: number[] = [];
    const current = start(() => {
      attemptsAt.push(Date.now());
      if (attemptsAt.length < 3) return Promise.reject(new Error('transient failure'));
      return Promise.resolve();
    });
    const enqueue = createEnqueuer(current.queues);

    await enqueue(
      testJob,
      { value: 'retry me' },
      { attempts: 3, backoff: { type: 'exponential', delay: 200 } },
    );

    await waitFor(() => Promise.resolve(attemptsAt.length === 3 ? attemptsAt : undefined));
    const [first, second, third] = attemptsAt as [number, number, number];
    expect(second - first).toBeGreaterThanOrEqual(150);
    expect(third - second).toBeGreaterThan(second - first);
    expect(await deadLetters()).toHaveLength(0);
  });

  it('dead-letters a job whose attempts are exhausted', async () => {
    const current = start(() => Promise.reject(new Error('still broken')));
    const enqueue = createEnqueuer(current.queues);

    await enqueue(
      testJob,
      { value: 'doomed' },
      { attempts: 2, backoff: { type: 'fixed', delay: 50 } },
    );

    const records = await waitFor(async () => {
      const found = await deadLetters();
      return found.length > 0 ? found : undefined;
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      queue: QueueName.System,
      jobName: testJob.name,
      payload: { value: 'doomed' },
      attemptsMade: 2,
      failedReason: 'still broken',
    });
  });

  it('dead-letters an invalid payload immediately instead of retrying', async () => {
    let handlerCalls = 0;
    const current = start(() => {
      handlerCalls += 1;
      return Promise.resolve();
    });

    // Bypasses the producer-side validation in createEnqueuer, as a stale
    // producer in another deployment would.
    await current.queues[QueueName.System].add(testJob.name, { value: 42 }, { attempts: 5 });

    const records = await waitFor(async () => {
      const found = await deadLetters();
      return found.length > 0 ? found : undefined;
    });
    expect(handlerCalls).toBe(0);
    expect(records[0]?.attemptsMade).toBe(1);
    expect(records[0]?.failedReason).toContain('Invalid payload');
  });

  it('dead-letters a job with no registered handler', async () => {
    const current = start(() => Promise.resolve());

    await current.queues[QueueName.System].add('system.unknown', { value: 'x' }, { attempts: 5 });

    const records = await waitFor(async () => {
      const found = await deadLetters();
      return found.length > 0 ? found : undefined;
    });
    expect(records[0]?.failedReason).toContain('No handler registered');
  });

  it('treats a repeated job id as the same job', async () => {
    let calls = 0;
    const current = start(() => {
      calls += 1;
      return Promise.resolve();
    });
    const enqueue = createEnqueuer(current.queues);

    await enqueue(testJob, { value: 'once' }, { jobId: 'stable-id' });
    await enqueue(testJob, { value: 'once' }, { jobId: 'stable-id' });

    await waitFor(() => Promise.resolve(calls > 0 ? calls : undefined));
    await sleep(300);
    expect(calls).toBe(1);
  });

  it('lets an in-flight job finish during shutdown', async () => {
    let finished = false;
    const current = start(async () => {
      await sleep(400);
      finished = true;
    });
    const enqueue = createEnqueuer(current.queues);

    await enqueue(testJob, { value: 'slow' });
    await waitFor(async () => {
      const active = await current.queues[QueueName.System].getActiveCount();
      return active > 0 ? active : undefined;
    });

    await current.close();
    runtime = undefined;

    expect(finished).toBe(true);
  });

  it('validates payloads in the producer before anything is queued', async () => {
    const current = start(() => Promise.resolve());
    const enqueue = createEnqueuer(current.queues);

    await expect(enqueue(testJob, { value: 123 as unknown as string })).rejects.toThrow();
    expect(await current.queues[QueueName.System].getWaitingCount()).toBe(0);
  });
});
