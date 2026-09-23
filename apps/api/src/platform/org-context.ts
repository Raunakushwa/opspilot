import { type Database, withTenant } from '@opspilot/database';
import { memberships } from '@opspilot/database/schema';
import { and, eq } from 'drizzle-orm';
import { type FastifyInstance, type FastifyRequest } from 'fastify';

import { type Permission, type Role, can } from './authorization.js';
import { AppError } from './errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set on routes under /api/orgs/:orgId once membership has been verified. */
    organization?: { id: string; role: Role };
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Resolves the organization from the URL and the caller's role in it.
 *
 * A non-member gets 404, not 403: "you may not touch this" confirms the
 * organization exists, which is itself a leak across tenants.
 */
export function registerOrgContext(app: FastifyInstance, db: Database): void {
  app.decorateRequest('organization', undefined);

  app.addHook('preHandler', async (request) => {
    const params = request.params as { orgId?: string } | undefined;
    const orgId = params?.orgId;
    if (!orgId) return;

    if (!request.user) {
      throw new AppError(401, 'unauthenticated', 'Authentication required');
    }
    if (!UUID.test(orgId)) {
      throw new AppError(404, 'not_found', 'Organization not found');
    }

    // Membership is read inside the organization's own tenant context, so the
    // lookup is subject to the same row-level security as everything else.
    const [membership] = await withTenant(db, orgId, (tx) =>
      tx
        .select({ role: memberships.role })
        .from(memberships)
        .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, request.user?.id ?? '')))
        .limit(1),
    );

    if (!membership) {
      throw new AppError(404, 'not_found', 'Organization not found');
    }

    request.organization = { id: orgId, role: membership.role };
  });
}

/** Throws unless the caller holds the permission in the current organization. */
export function requirePermission(request: FastifyRequest, permission: Permission): void {
  const organization = request.organization;
  if (!organization) {
    throw new AppError(401, 'unauthenticated', 'Authentication required');
  }
  if (!can(organization.role, permission)) {
    throw new AppError(403, 'forbidden', `Your role (${organization.role}) cannot ${permission}`);
  }
}

/** The organization context, or a 401/404 if the route was reached without one. */
export function orgContext(request: FastifyRequest): { id: string; role: Role } {
  if (!request.organization) {
    throw new AppError(401, 'unauthenticated', 'Authentication required');
  }
  return request.organization;
}
