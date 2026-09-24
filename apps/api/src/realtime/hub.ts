import { type Redis } from 'ioredis';
import { type FastifyReply } from 'fastify';

/**
 * Organization-wide event stream (ADR-003).
 *
 * One Redis subscription per API instance, fanned out to that instance's
 * connected clients. Subscribing per client would open a connection per
 * browser tab; subscribing per organization per instance keeps it bounded.
 */

export const CHANNEL_PREFIX = 'opspilot:org:';

interface Client {
  reply: FastifyReply;
  organizationId: string;
}

export interface RealtimeHub {
  subscribe: (organizationId: string, reply: FastifyReply) => Promise<() => void>;
  close: () => Promise<void>;
  clientCount: () => number;
}

export function createRealtimeHub(redis: Redis): RealtimeHub {
  // The API's main client is configured to fail fast while Redis is down
  // (enableOfflineQueue: false), which is right for request-path commands but
  // wrong for a long-lived subscriber: it must connect and keep retrying.
  const subscriber = redis.duplicate({ lazyConnect: false, enableOfflineQueue: true });
  const clients = new Set<Client>();
  const subscribedChannels = new Set<string>();

  subscriber.on('error', () => {
    // Reconnection is ioredis's job; a transient error must not crash the API.
  });

  subscriber.on('message', (channel, message) => {
    const organizationId = channel.slice(CHANNEL_PREFIX.length);
    for (const client of clients) {
      if (client.organizationId !== organizationId) continue;
      // A slow or dead socket must not stall the others.
      try {
        client.reply.raw.write(`event: domain\ndata: ${message}\n\n`);
      } catch {
        clients.delete(client);
      }
    }
  });

  return {
    subscribe: async (organizationId, reply) => {
      const channel = `${CHANNEL_PREFIX}${organizationId}`;
      if (!subscribedChannels.has(channel)) {
        await subscriber.subscribe(channel);
        subscribedChannels.add(channel);
      }

      const client: Client = { reply, organizationId };
      clients.add(client);

      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      reply.raw.write(': connected\n\n');

      const heartbeat = setInterval(() => {
        try {
          reply.raw.write(': keep-alive\n\n');
        } catch {
          clients.delete(client);
        }
      }, 15_000);

      const cleanup = () => {
        clearInterval(heartbeat);
        clients.delete(client);
      };
      reply.raw.on('close', cleanup);
      return cleanup;
    },

    close: async () => {
      for (const client of clients) {
        client.reply.raw.end();
      }
      clients.clear();
      await subscriber.quit();
    },

    clientCount: () => clients.size,
  };
}
