import { randomBytes } from 'node:crypto';

import { AppError } from '../../platform/errors.js';
import { hashPassword, verifyPassword } from './password.js';
import {
  type AuthenticatedUser,
  type AuthRepository,
  type MembershipSummary,
} from './repository.js';
import { createSessionToken, hashSessionToken } from './tokens.js';

export interface SessionContext {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export interface LoginResult {
  user: AuthenticatedUser;
  token: string;
  expiresAt: Date;
}

export interface AuthServiceOptions {
  repository: AuthRepository;
  sessionTtlMs: number;
  /** Clock injection keeps expiry tests deterministic. */
  now?: () => Date;
}

/**
 * A real argon2 digest of a random secret, computed once. When no user matches,
 * the password is verified against this instead of skipping the work, so the
 * failed-login path costs the same as the real one and response time does not
 * reveal whether an email address is registered.
 */
let decoyDigest: Promise<string> | undefined;
function getDecoyDigest(): Promise<string> {
  decoyDigest ??= hashPassword(randomBytes(32).toString('hex'));
  return decoyDigest;
}

export function createAuthService({
  repository,
  sessionTtlMs,
  now = () => new Date(),
}: AuthServiceOptions) {
  async function issueSession(
    user: AuthenticatedUser,
    context: SessionContext,
  ): Promise<LoginResult> {
    const token = createSessionToken();
    const expiresAt = new Date(now().getTime() + sessionTtlMs);
    await repository.createSession({
      userId: user.id,
      tokenHash: token.hash,
      expiresAt,
      ip: context.ip,
      userAgent: context.userAgent,
    });
    return { user, token: token.value, expiresAt };
  }

  return {
    async register(
      input: { email: string; password: string; displayName: string },
      context: SessionContext,
    ): Promise<LoginResult> {
      const existing = await repository.findUserByEmail(input.email);
      if (existing) {
        // Registration inevitably reveals that an address is taken; the
        // mitigation is rate limiting, not a misleading success response.
        throw new AppError(409, 'email_taken', 'That email address is already registered');
      }

      const user = await repository.createUser({
        email: input.email,
        passwordHash: await hashPassword(input.password),
        displayName: input.displayName,
      });
      return issueSession(user, context);
    },

    async login(
      input: { email: string; password: string },
      context: SessionContext,
    ): Promise<LoginResult> {
      const user = await repository.findUserByEmail(input.email);
      const valid = await verifyPassword(
        user?.passwordHash ?? (await getDecoyDigest()),
        input.password,
      );

      if (!user || !valid) {
        // One message for both cases: never confirm which half was wrong.
        throw new AppError(401, 'invalid_credentials', 'Email or password is incorrect');
      }

      await repository.recordLogin(user.id);
      return issueSession(
        { id: user.id, email: user.email, displayName: user.displayName },
        context,
      );
    },

    async logout(token: string): Promise<void> {
      await repository.revokeSession(hashSessionToken(token));
    },

    /** Resolves a cookie token to a user, or undefined if it is not usable. */
    async authenticate(token: string): Promise<AuthenticatedUser | undefined> {
      const row = await repository.findLiveSession(hashSessionToken(token));
      if (!row) return undefined;
      // Best-effort: a failed last-seen update must not fail the request.
      void repository.touchSession(row.sessionId).catch(() => undefined);
      return row.user;
    },

    async memberships(userId: string): Promise<MembershipSummary[]> {
      return repository.listMemberships(userId);
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
