import { AppError } from '../../platform/errors.js';
import { canAssignRole, outranks, type Role } from '../../platform/authorization.js';
import { type OrganizationRepository } from './repository.js';

export interface OrganizationServiceOptions {
  repository: OrganizationRepository;
}

export function createOrganizationService({ repository }: OrganizationServiceOptions) {
  return {
    create: async (input: { name: string; slug: string; ownerId: string }) =>
      repository.create(input),

    listForUser: async (userId: string) => repository.listForUser(userId),

    get: async (orgId: string) => {
      const organization = await repository.findById(orgId);
      if (!organization) throw new AppError(404, 'not_found', 'Organization not found');
      return organization;
    },

    update: async (orgId: string, changes: { name?: string }) => {
      const organization = await repository.update(orgId, changes);
      if (!organization) throw new AppError(404, 'not_found', 'Organization not found');
      return organization;
    },

    listMembers: async (orgId: string) => repository.listMembers(orgId),

    addMember: async (input: { orgId: string; actorRole: Role; email: string; role: Role }) => {
      if (!canAssignRole(input.actorRole, input.role)) {
        throw new AppError(
          403,
          'forbidden',
          `A ${input.actorRole} cannot grant the ${input.role} role`,
        );
      }

      const user = await repository.findUserByEmail(input.email);
      if (!user) {
        // Invitations for unregistered addresses come with the notification
        // system; until then only existing accounts can be added.
        throw new AppError(404, 'user_not_found', 'No account exists for that email address');
      }

      const existing = await repository.findMembership(input.orgId, user.id);
      if (existing) {
        throw new AppError(409, 'already_member', 'That user is already a member');
      }

      const membership = await repository.addMember({
        orgId: input.orgId,
        userId: user.id,
        role: input.role,
      });
      return { membership, user };
    },

    changeRole: async (input: {
      orgId: string;
      actorId: string;
      actorRole: Role;
      targetUserId: string;
      role: Role;
    }) => {
      const target = await repository.findMembership(input.orgId, input.targetUserId);
      if (!target) throw new AppError(404, 'not_found', 'Member not found');

      if (!canAssignRole(input.actorRole, input.role)) {
        throw new AppError(
          403,
          'forbidden',
          `A ${input.actorRole} cannot grant the ${input.role} role`,
        );
      }
      // Changing someone at or above your own rank is privilege escalation by
      // another name: an ADMIN must not be able to demote an OWNER.
      if (input.actorRole !== 'OWNER' && !outranks(input.actorRole, target.role)) {
        throw new AppError(403, 'forbidden', `A ${input.actorRole} cannot modify a ${target.role}`);
      }
      if (target.role === 'OWNER' && input.role !== 'OWNER') {
        await assertNotLastOwner(repository, input.orgId);
      }

      const updated = await repository.updateMemberRole(
        input.orgId,
        input.targetUserId,
        input.role,
      );
      if (!updated) throw new AppError(404, 'not_found', 'Member not found');
      return updated;
    },

    removeMember: async (input: {
      orgId: string;
      actorId: string;
      actorRole: Role;
      targetUserId: string;
    }) => {
      const target = await repository.findMembership(input.orgId, input.targetUserId);
      if (!target) throw new AppError(404, 'not_found', 'Member not found');

      const removingSelf = input.actorId === input.targetUserId;
      if (!removingSelf && input.actorRole !== 'OWNER' && !outranks(input.actorRole, target.role)) {
        throw new AppError(403, 'forbidden', `A ${input.actorRole} cannot remove a ${target.role}`);
      }
      if (target.role === 'OWNER') {
        await assertNotLastOwner(repository, input.orgId);
      }

      await repository.removeMember(input.orgId, input.targetUserId);
    },
  };
}

/**
 * An organization with no owner cannot be administered by anyone, and no API
 * call could restore it. Refuse rather than create that state.
 */
async function assertNotLastOwner(
  repository: OrganizationRepository,
  orgId: string,
): Promise<void> {
  const owners = await repository.countOwners(orgId);
  if (owners <= 1) {
    throw new AppError(409, 'last_owner', 'An organization must keep at least one owner');
  }
}

export type OrganizationService = ReturnType<typeof createOrganizationService>;
