import { type Database, withoutTenant, withUser } from '@opspilot/database';
import { memberships, organizations, sessions, users } from '@opspilot/database/schema';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';

export interface NewUser {
  email: string;
  passwordHash: string;
  displayName: string;
}

export interface SessionRecord {
  id: string;
  userId: string;
  expiresAt: Date;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string;
}

export interface MembershipSummary {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  role: string;
}

/**
 * Authentication runs outside tenant context: at login no organization is known
 * yet, and `users`/`sessions` are global tables (see docs/database.md).
 */
export function createAuthRepository(db: Database) {
  return {
    async findUserByEmail(email: string) {
      return withoutTenant(db, async (tx) => {
        const [user] = await tx.select().from(users).where(eq(users.email, email)).limit(1);
        return user;
      });
    },

    createUser: async (input: NewUser): Promise<AuthenticatedUser> => {
      return withoutTenant(db, async (tx) => {
        const [user] = await tx
          .insert(users)
          .values(input)
          .returning({ id: users.id, email: users.email, displayName: users.displayName });
        // The insert either returns a row or throws, so this is unreachable.
        if (!user) throw new Error('user insert returned no row');
        return user;
      });
    },

    createSession: async (input: {
      userId: string;
      tokenHash: string;
      expiresAt: Date;
      ip?: string | undefined;
      userAgent?: string | undefined;
    }): Promise<SessionRecord> => {
      return withoutTenant(db, async (tx) => {
        const [session] = await tx
          .insert(sessions)
          .values({
            userId: input.userId,
            tokenHash: input.tokenHash,
            expiresAt: input.expiresAt,
            ip: input.ip ?? null,
            userAgent: input.userAgent ?? null,
          })
          .returning({
            id: sessions.id,
            userId: sessions.userId,
            expiresAt: sessions.expiresAt,
          });
        if (!session) throw new Error('session insert returned no row');
        return session;
      });
    },

    /** Looks up a live session and its user in one query. */
    async findLiveSession(tokenHash: string) {
      return withoutTenant(db, async (tx) => {
        const [row] = await tx
          .select({
            sessionId: sessions.id,
            expiresAt: sessions.expiresAt,
            user: { id: users.id, email: users.email, displayName: users.displayName },
          })
          .from(sessions)
          .innerJoin(users, eq(users.id, sessions.userId))
          .where(
            and(
              eq(sessions.tokenHash, tokenHash),
              isNull(sessions.revokedAt),
              gt(sessions.expiresAt, new Date()),
            ),
          )
          .limit(1);
        return row;
      });
    },

    revokeSession: async (tokenHash: string): Promise<void> => {
      await withoutTenant(db, async (tx) => {
        await tx
          .update(sessions)
          .set({ revokedAt: new Date() })
          .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)));
      });
    },

    touchSession: async (sessionId: string): Promise<void> => {
      await withoutTenant(db, async (tx) => {
        await tx.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, sessionId));
      });
    },

    recordLogin: async (userId: string): Promise<void> => {
      await withoutTenant(db, async (tx) => {
        await tx.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
      });
    },

    /**
     * The organizations a user may act in. Runs with user context rather than
     * organization context: the `memberships_self_read` policy allows a user to
     * see their own membership rows, which is what makes this query possible
     * before any organization is chosen.
     */
    listMemberships: async (userId: string): Promise<MembershipSummary[]> => {
      return withUser(db, userId, async (tx) =>
        tx
          .select({
            organizationId: organizations.id,
            organizationName: organizations.name,
            organizationSlug: organizations.slug,
            role: sql<string>`${memberships.role}`,
          })
          .from(memberships)
          .innerJoin(organizations, eq(organizations.id, memberships.orgId))
          .where(eq(memberships.userId, userId)),
      );
    },
  };
}

export type AuthRepository = ReturnType<typeof createAuthRepository>;
