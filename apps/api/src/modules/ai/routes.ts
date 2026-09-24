import { type Redis } from 'ioredis';
import { type FastifyInstance } from 'fastify';

import { orgContext, requirePermission } from '../../platform/org-context.js';
import { AppError } from '../../platform/errors.js';
import { decideProposalBody, proposalQuery, startInvestigationBody } from './schemas.js';
import { type AiOrchestrationService } from './service.js';
import { streamRunEvents } from './stream.js';

export interface AiRoutesOptions {
  service: AiOrchestrationService;
  redis: Redis;
}

export function registerAiRoutes(app: FastifyInstance, options: AiRoutesOptions): void {
  app.post('/api/orgs/:orgId/ai/investigations', async (request, reply) => {
    const { id } = orgContext(request);
    requirePermission(request, 'ai:investigate');
    const body = startInvestigationBody.parse(request.body);

    const run = await options.service.startInvestigation({
      organizationId: id,
      incidentId: body.incidentId,
      userId: request.user?.id ?? '',
      question: body.question,
    });

    // 202: the investigation runs in the worker and streams its progress, so
    // it survives the client disconnecting and a second engineer can watch.
    return reply.status(202).send({
      runId: run.id,
      status: run.status,
      streamUrl: `/api/orgs/${id}/ai/runs/${run.id}/stream`,
    });
  });

  app.get('/api/orgs/:orgId/ai/runs/:runId', async (request, reply) => {
    const { id } = orgContext(request);
    requirePermission(request, 'incident:read');
    const { runId } = request.params as { runId: string };

    return reply.send(await options.service.getRun(id, runId));
  });

  app.get('/api/orgs/:orgId/ai/runs/:runId/stream', async (request, reply) => {
    const { id } = orgContext(request);
    requirePermission(request, 'incident:read');
    const { runId } = request.params as { runId: string };

    // Authorization happens before the stream opens: the run must belong to
    // this organization, which getRun enforces.
    await options.service.getRun(id, runId);

    await streamRunEvents({
      redis: options.redis,
      runId,
      reply,
      lastEventId: request.headers['last-event-id'] as string | undefined,
    });
    return reply;
  });

  app.get('/api/orgs/:orgId/incidents/:incidentId/ai/runs', async (request, reply) => {
    const { id } = orgContext(request);
    requirePermission(request, 'incident:read');
    const { incidentId } = request.params as { incidentId: string };

    return reply.send({ data: await options.service.listRuns(id, incidentId) });
  });

  app.get('/api/orgs/:orgId/ai/proposals', async (request, reply) => {
    const { id } = orgContext(request);
    requirePermission(request, 'incident:read');
    const query = proposalQuery.parse(request.query);

    return reply.send({ data: await options.service.listProposals(id, query) });
  });

  app.post('/api/orgs/:orgId/ai/proposals/:proposalId', async (request, reply) => {
    const { id, role } = orgContext(request);
    const { proposalId } = request.params as { proposalId: string };
    const body = decideProposalBody.parse(request.body);
    const user = request.user;
    if (!user) throw new AppError(401, 'unauthenticated', 'Authentication required');

    // The per-action permission is checked inside the service, because it
    // depends on which action is being approved.
    const result = await options.service.decideProposal({
      organizationId: id,
      proposalId,
      approverId: user.id,
      approverRole: role,
      decision: body.decision,
      requestId: request.id,
      ip: request.ip,
    });

    return reply.send(result);
  });
}
