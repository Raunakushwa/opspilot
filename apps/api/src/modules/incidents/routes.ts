import { type FastifyInstance } from 'fastify';

import { AppError } from '../../platform/errors.js';
import { orgContext, requirePermission } from '../../platform/org-context.js';
import { createIncidentBody, listQuery, updateIncidentBody } from './schemas.js';
import { type IncidentService } from './service.js';

interface IncidentParams {
  orgId: string;
  incidentId: string;
}

/** ETags carry the version, so If-Match gives optimistic concurrency for free. */
function etag(version: number): string {
  return `"${String(version)}"`;
}

function parseIfMatch(header: string | undefined): number | undefined {
  if (!header) return undefined;
  const match = /^(?:W\/)?"(\d+)"$/.exec(header.trim());
  return match ? Number(match[1]) : undefined;
}

export function registerIncidentRoutes(app: FastifyInstance, service: IncidentService): void {
  app.get('/api/orgs/:orgId/incidents', async (request, reply) => {
    const { id } = orgContext(request);
    requirePermission(request, 'incident:read');
    const query = listQuery.parse(request.query);

    const data = await service.list(id, query);
    // Cursor pagination: the next page starts after the last id we returned.
    const nextCursor = data.length === query.limit ? data.at(-1)?.id : undefined;
    return reply.send({ data, nextCursor: nextCursor ?? null });
  });

  app.post('/api/orgs/:orgId/incidents', async (request, reply) => {
    const { id } = orgContext(request);
    requirePermission(request, 'incident:write');
    const body = createIncidentBody.parse(request.body);

    const incident = await service.create(
      { orgId: id, ...body },
      { actorId: request.user?.id ?? '', requestId: request.id, ip: request.ip },
    );
    return reply
      .status(201)
      .header('etag', etag(incident.version))
      .header('location', `/api/orgs/${id}/incidents/${incident.id}`)
      .send(incident);
  });

  app.get('/api/orgs/:orgId/incidents/:incidentId', async (request, reply) => {
    const { id } = orgContext(request);
    requirePermission(request, 'incident:read');
    const { incidentId } = request.params as IncidentParams;

    const incident = await service.get(id, incidentId);
    return reply.header('etag', etag(incident.version)).send(incident);
  });

  app.patch('/api/orgs/:orgId/incidents/:incidentId', async (request, reply) => {
    const { id } = orgContext(request);
    requirePermission(request, 'incident:write');
    const { incidentId } = request.params as IncidentParams;
    const body = updateIncidentBody.parse(request.body);
    const expectedVersion = parseIfMatch(request.headers['if-match']);

    const incident = await service.update(id, incidentId, expectedVersion, body, {
      actorId: request.user?.id ?? '',
      requestId: request.id,
      ip: request.ip,
    });
    return reply.header('etag', etag(incident.version)).send(incident);
  });

  app.get('/api/orgs/:orgId/incidents/:incidentId/events', async (request, reply) => {
    const { id } = orgContext(request);
    requirePermission(request, 'incident:read');
    const { incidentId } = request.params as IncidentParams;

    return reply.send({ data: await service.timeline(id, incidentId) });
  });

  app.get('/api/orgs/:orgId/audit-logs', async (request, reply) => {
    const { id } = orgContext(request);
    // Audit is administrative: engineers see the incident timeline instead.
    requirePermission(request, 'audit:read');
    const limit = Number((request.query as { limit?: string }).limit ?? 100);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new AppError(400, 'validation_failed', 'limit must be between 1 and 500');
    }

    return reply.send({ data: await service.audit(id, limit) });
  });
}
