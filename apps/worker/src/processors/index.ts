import { type Job } from 'bullmq';
import { type Logger } from 'pino';

import { systemPing, type SystemPingPayload } from '../queues/definitions.js';

export interface JobContext {
  logger: Logger;
}

export type JobHandler = (payload: never, job: Job, context: JobContext) => Promise<unknown>;

/**
 * Maps job name to handler. Registering a handler here is the only way a job
 * becomes processable; unknown job names fail without retrying.
 */
export const handlers: Record<string, JobHandler> = {
  [systemPing.name]: (payload: SystemPingPayload) => Promise.resolve({ echo: payload.echo }),
} as Record<string, JobHandler>;
