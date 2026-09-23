import { type Job } from 'bullmq';
import { describe, expect, it } from 'vitest';

import { toDeadLetterRecord } from './dead-letter.js';

function fakeJob(overrides: Partial<Job> = {}): Job {
  return {
    queueName: 'notifications',
    name: 'notification.send',
    id: '42',
    data: { userId: 'u1' },
    attemptsMade: 5,
    ...overrides,
  } as Job;
}

describe('toDeadLetterRecord', () => {
  it('captures what an operator needs to diagnose and replay a job', () => {
    const now = new Date('2026-09-23T10:00:00.000Z');

    const record = toDeadLetterRecord(fakeJob(), new Error('SMTP timeout'), now);

    expect(record).toEqual({
      queue: 'notifications',
      jobName: 'notification.send',
      jobId: '42',
      payload: { userId: 'u1' },
      attemptsMade: 5,
      failedReason: 'SMTP timeout',
      failedAt: '2026-09-23T10:00:00.000Z',
    });
  });

  it('truncates huge failure messages so one job cannot bloat Redis', () => {
    const record = toDeadLetterRecord(fakeJob(), new Error('x'.repeat(10_000)));

    expect(record.failedReason).toHaveLength(2000);
  });
});

describe('dead-letter job ids', () => {
  it('avoids the colon, which BullMQ rejects in custom job ids', () => {
    const record = toDeadLetterRecord(fakeJob(), new Error('boom'));

    const jobId = `${record.queue}-${record.jobId}-${String(record.attemptsMade)}`;
    expect(jobId).not.toContain(':');
  });
});
