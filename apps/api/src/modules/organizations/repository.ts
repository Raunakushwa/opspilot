import { type Database, withTenant, withoutTenant, withUser } from '@opspilot/database';
import { memberships, organizations, users } from '@opspilot/database/schema';
import { and, eq, sql } from 'drizzle-orm';

import { type Role } from '../../platform/authorization.js';

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  role: Role;
}

export interface MemberRow {
  membershipId: string;
  userId: string;
  email: string;
  displayName: string;
  role: Role;
  createdAt: Date;
}

export function createOrganizationRepository(db: Database) {
  return {
    /**
     * Creates the organization and its first membership in one transaction:
     * an organization without an owner would be unreachable by anyone.
     */
    create: async (input: { name: string; slug: string; ownerId: string }) => {
      return withoutTenant(db, async (tx) => {
        const [organization] = await tx
          .insert(organizations)
          .values({ name: input.name, slug: input.slug })
          .returning();
        if (!organization) throw new Error('organization insert returned no row');

        await tx.execute(sql`SELECT set_config('app.current_org_id', ${organization.id}, true)`);
        await tx
          .insert(memberships)
          .values({ orgId: organization.id, userId: input.ownerId, role: 'OWNER' });
        return organization;
      });
    },

    listForUser: async (userId: string): Promise<OrganizationSummary[]> =>
      withUser(db, userId, (tx) =>
        tx
          .select({
            id: organizations.id,
            name: organizations.name,
            slug: organizations.slug,
            role: memberships.role,
          })
          .from(memberships)
          .innerJoin(organizations, eq(organizations.id, memberships.orgId))
          .where(eq(memberships.userId, userId)),
      ),

    findById: async (orgId: string) =>
      withTenant(db, orgId, async (tx) => {
        const [organization] = await tx
          .select()
          .from(organizations)
          .where(eq(organizations.id, orgId))
          .limit(1);
        return organization;
      }),

    update: async (orgId: string, changes: { name?: string }) =>
      withTenant(db, orgId, async (tx) => {
        const [organization] = await tx
          .update(organizations)
          .set(changes)
          .where(eq(organizations.id, orgId))
          .returning();
        return organization;
      }),

    listMembers: async (orgId: string): Promise<MemberRow[]> =>
      withTenant(db, orgId, (tx) =>
        tx
          .select({
            membershipId: memberships.id,
            userId: users.id,
            email: users.email,
            displayName: users.displayName,
            role: memberships.role,
            createdAt: memberships.createdAt,
          })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(eq(memberships.orgId, orgId)),
      ),

    findUserByEmail: async (email: string) =>
      withoutTenant(db, async (tx) => {
        const [user] = await tx
          .select({ id: users.id, email: users.email, displayName: users.displayName })
          .from(users)
          .where(eq(users.email, email))
          .limit(1);
        return user;
      }),

    addMember: async (input: { orgId: string; userId: string; role: Role }) =>
      withTenant(db, input.orgId, async (tx) => {
        const [membership] = await tx
          .insert(memberships)
          .values({ orgId: input.orgId, userId: input.userId, role: input.role })
          .returning();
        return membership;
      }),

    findMembership: async (orgId: string, userId: string) =>
      withTenant(db, orgId, async (tx) => {
        const [membership] = await tx
          .select()
          .from(memberships)
          .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)))
          .limit(1);
        return membership;
      }),

    updateMemberRole: async (orgId: string, userId: string, role: Role) =>
      withTenant(db, orgId, async (tx) => {
        const [membership] = await tx
          .update(memberships)
          .set({ role })
          .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)))
          .returning();
        return membership;
      }),

    removeMember: async (orgId: string, userId: string) =>
      withTenant(db, orgId, async (tx) => {
        const removed = await tx
          .delete(memberships)
          .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)))
          .returning();
        return removed.length > 0;
      }),

    countOwners: async (orgId: string): Promise<number> =>
      withTenant(db, orgId, async (tx) => {
        const [row] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(memberships)
          .where(and(eq(memberships.orgId, orgId), eq(memberships.role, 'OWNER')));
        return row?.count ?? 0;
      }),
  };
}

export type OrganizationRepository = ReturnType<typeof createOrganizationRepository>;
