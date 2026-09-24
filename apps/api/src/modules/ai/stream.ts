import { type Redis } from 'ioredis';
import { type FastifyReply } from 'fastify';

/**
 * Server-Sent Events for investigation progress (ADR-003).
 *
 * Progress is read from a Redis *stream*, not pub/sub, so a client that
 * connects late or reloads mid-investigation replays what it missed using
 * Last-Event-ID. Pub/sub would silently drop everything before the subscribe.
 */

export function streamKey(runId: string): string {
  return `opspilot:run:${runId}:events`;
}

export interface StreamOptions {
  redis: Redis;
  runId: string;
  reply: FastifyReply;
  lastEventId?: string | undefined;
  /** Stops the stream if the run never finishes. */
  maxDurationMs?: number;
  heartbeatMs?: number;
}

const TERMINAL_EVENTS = new Set(['run.completed', 'run.failed']);

export async function streamRunEvents({
  redis,
  runId,
  reply,
  lastEventId,
  maxDurationMs = 10 * 60_000,
  heartbeatMs = 15_000,
}: StreamOptions): Promise<void> {
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Nginx and some proxies buffer by default, which would defeat streaming.
    'x-accel-buffering': 'no',
  });

  const key = streamKey(runId);
  let cursor = lastEventId ?? '0';
  const deadline = Date.now() + maxDurationMs;
  // Held in an object rather than a local: the only assignment happens inside
  // the close handler, and TypeScript would otherwise narrow a plain `let` to
  // the literal `false` for the rest of the function.
  const client = { closed: false };

  reply.raw.on('close', () => {
    client.closed = true;
  });

  // A comment line keeps intermediaries from closing an idle connection.
  const heartbeat = setInterval(() => {
    if (!client.closed) reply.raw.write(': keep-alive\n\n');
  }, heartbeatMs);

  try {
    while (!client.closed && Date.now() < deadline) {
      // BLOCK returns null on timeout, which is the idle case, not an error.
      const response = await redis.xread('BLOCK', 5000, 'STREAMS', key, cursor);
      if (response === null) continue;

      for (const [, entries] of response) {
        for (const [id, fields] of entries) {
          cursor = id;
          const event = fieldValue(fields, 'event') ?? 'message';
          const payload = fieldValue(fields, 'payload') ?? '{}';
          reply.raw.write(`id: ${id}\nevent: ${event}\ndata: ${payload}\n\n`);
          if (TERMINAL_EVENTS.has(event)) {
            return;
          }
        }
      }
    }
  } finally {
    clearInterval(heartbeat);
    if (!client.closed) reply.raw.end();
  }
}

function fieldValue(fields: string[], name: string): string | undefined {
  for (let index = 0; index < fields.length; index += 2) {
    if (fields[index] === name) return fields[index + 1];
  }
  return undefined;
}
