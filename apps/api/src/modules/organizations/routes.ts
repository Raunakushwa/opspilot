import { type FastifyInstance } from 'fastify';

import { permissionsFor } from '../../platform/authorization.js';
import { AppError } from '../../platform/errors.js';
import { orgContext, requirePermission } from '../../platform/org-context.js';
import {
  addMemberBody,
  changeRoleBody,
  createOrganizationBody,
  memberResponse,
  organizationResponse,
  updateOrganizationBody,
} from './schemas.js';
import { type OrganizationService } from './service.js';

function requireUser(request: { user?: { id: string } }) {
  if (!request.user) throw new AppError(401, 'unauthenticated', 'Authentication required');
  return request.user;
}

export function registerOrganizationRoutes(
  app: FastifyInstance,
  service: OrganizationService,
): void {
  app.post('/api/orgs', async (request, reply) => {
    const user = requireUser(request);
    const body = createOrganizationBody.parse(request.body);
    const organization = await service.create({ ...body, ownerId: user.id });
    return reply.status(201).send(organizationResponse.parse(organization));
  });

  app.get('/api/orgs', async (request, reply) => {
    const user = requireUser(request);
    return reply.send({ data: await service.listForUser(user.id) });
  });

  app.get('/api/orgs/:orgId', async (request, reply) => {
    const { id, role } = orgContext(request);
    requirePermission(request, 'organization:read');
    const organization = await service.get(id);
    // The caller's own permissions travel with the response so the UI can
    // hide what it must not offer — the server still enforces every one.
    return reply.send({
      ...organizationResponse.parse(organization),
      role,
      permissions: permissionsFor(role),
    });
  });

  app.patch('/api/orgs/:orgId', async (request, reply) => {
    const { id } = orgContext(request);
    requirePermission(request, 'organization:write');
    const body = updateOrganizationBody.parse(request.body);
    return reply.send(organizationResponse.parse(await service.update(id, body)));
  });

  app.get('/api/orgs/:orgId/members', async (request, reply) => {
    const { id } = orgContext(request);
    requirePermission(request, 'organization:read');
    const members = await service.listMembers(id);
    return reply.send({
      data: members.map((member) =>
        memberResponse.parse({
          userId: member.userId,
          email: member.email,
          displayName: member.displayName,
          role: member.role,
          joinedAt: member.createdAt.toISOString(),
        }),
      ),
    });
  });

  app.post('/api/orgs/:orgId/members', async (request, reply) => {
    const { id, role } = orgContext(request);
    requirePermission(request, 'member:manage');
    const body = addMemberBody.parse(request.body);
    const { membership, user } = await service.addMember({
      orgId: id,
      actorRole: role,
      email: body.email,
      role: body.role,
    });
    return reply.status(201).send(
      memberResponse.parse({
        userId: user.id,
        email: user.email,
        displayName: user.displayName,
        role: membership?.role ?? body.role,
        joinedAt: (membership?.createdAt ?? new Date()).toISOString(),
      }),
    );
  });

  app.patch('/api/orgs/:orgId/members/:userId', async (request, reply) => {
    const actor = requireUser(request);
    const { id, role } = orgContext(request);
    requirePermission(request, 'member:manage');
    const { userId } = request.params as { userId: string };
    const body = changeRoleBody.parse(request.body);

    const updated = await service.changeRole({
      orgId: id,
      actorId: actor.id,
      actorRole: role,
      targetUserId: userId,
      role: body.role,
    });
    return reply.send({ userId, role: updated.role });
  });

  app.delete('/api/orgs/:orgId/members/:userId', async (request, reply) => {
    const actor = requireUser(request);
    const { id, role } = orgContext(request);
    const { userId } = request.params as { userId: string };

    // Anyone may leave; removing someone else needs member:manage.
    if (actor.id !== userId) {
      requirePermission(request, 'member:manage');
    }

    await service.removeMember({
      orgId: id,
      actorId: actor.id,
      actorRole: role,
      targetUserId: userId,
    });
    return reply.status(204).send();
  });
}
