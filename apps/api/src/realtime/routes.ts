import { type FastifyInstance } from 'fastify';

import { orgContext, requirePermission } from '../platform/org-context.js';
import { type RealtimeHub } from './hub.js';

export function registerRealtimeRoutes(app: FastifyInstance, hub: RealtimeHub): void {
  app.get('/api/orgs/:orgId/stream', async (request, reply) => {
    // Membership is verified before the stream opens, by the same hook that
    // guards every other organization route.
    const { id } = orgContext(request);
    requirePermission(request, 'incident:read');

    await hub.subscribe(id, reply);
    // The connection stays open; Fastify must not try to send a body.
    return reply;
  });
}
