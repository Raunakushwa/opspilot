import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type AppError } from '../../platform/errors.js';
import { hashPassword } from './password.js';
import { type AuthRepository } from './repository.js';
import { createAuthService } from './service.js';
import { hashSessionToken } from './tokens.js';

const user = {
  id: '01a0c000-0000-7000-8000-000000000001',
  email: 'ada@acme.test',
  displayName: 'Ada',
};

function createRepository(overrides: Partial<AuthRepository> = {}): AuthRepository {
  return {
    findUserByEmail: vi.fn().mockResolvedValue(undefined),
    createUser: vi.fn().mockResolvedValue(user),
    createSession: vi.fn().mockResolvedValue({ id: 's1', userId: user.id, expiresAt: new Date() }),
    findLiveSession: vi.fn().mockResolvedValue(undefined),
    revokeSession: vi.fn().mockResolvedValue(undefined),
    touchSession: vi.fn().mockResolvedValue(undefined),
    recordLogin: vi.fn().mockResolvedValue(undefined),
    listMemberships: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

const ttl = 60 * 60 * 1000;
let now: Date;

beforeEach(() => {
  now = new Date('2026-09-23T12:00:00.000Z');
});

describe('register', () => {
  it('stores a hashed password and issues a session', async () => {
    const repository = createRepository();
    const service = createAuthService({ repository, sessionTtlMs: ttl, now: () => now });

    const result = await service.register(
      { email: 'ada@acme.test', password: 'a-long-enough-password', displayName: 'Ada' },
      {},
    );

    const created = vi.mocked(repository.createUser).mock.calls[0]?.[0];
    expect(created?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(created?.passwordHash).not.toContain('a-long-enough-password');
    expect(result.token).toMatch(/^[\w-]{43}$/);
    expect(result.expiresAt).toEqual(new Date('2026-09-23T13:00:00.000Z'));
  });

  it('stores only the token hash, never the token', async () => {
    const repository = createRepository();
    const service = createAuthService({ repository, sessionTtlMs: ttl, now: () => now });

    const result = await service.register(
      { email: 'ada@acme.test', password: 'a-long-enough-password', displayName: 'Ada' },
      {},
    );

    const stored = vi.mocked(repository.createSession).mock.calls[0]?.[0];
    expect(stored?.tokenHash).toBe(hashSessionToken(result.token));
    expect(stored?.tokenHash).not.toBe(result.token);
  });

  it('refuses an email that is already registered', async () => {
    const repository = createRepository({
      findUserByEmail: vi.fn().mockResolvedValue({ ...user, passwordHash: 'x' }),
    });
    const service = createAuthService({ repository, sessionTtlMs: ttl });

    await expect(
      service.register({ email: user.email, password: 'a-long-password', displayName: 'A' }, {}),
    ).rejects.toMatchObject({ status: 409, code: 'email_taken' });
  });
});

describe('login', () => {
  it('issues a session for correct credentials and records the login', async () => {
    const passwordHash = await hashPassword('a-long-enough-password');
    const repository = createRepository({
      findUserByEmail: vi.fn().mockResolvedValue({ ...user, passwordHash }),
    });
    const service = createAuthService({ repository, sessionTtlMs: ttl, now: () => now });

    const result = await service.login(
      { email: user.email, password: 'a-long-enough-password' },
      { ip: '10.0.0.1' },
    );

    expect(result.user.id).toBe(user.id);
    expect(repository.recordLogin).toHaveBeenCalledWith(user.id);
  });

  it('gives the same error for an unknown email and a wrong password', async () => {
    const passwordHash = await hashPassword('the-real-password');
    const unknown = createAuthService({ repository: createRepository(), sessionTtlMs: ttl });
    const wrongPassword = createAuthService({
      repository: createRepository({
        findUserByEmail: vi.fn().mockResolvedValue({ ...user, passwordHash }),
      }),
      sessionTtlMs: ttl,
    });

    const errors = await Promise.all(
      [
        unknown.login({ email: 'nobody@acme.test', password: 'whatever-long' }, {}),
        wrongPassword.login({ email: user.email, password: 'not-the-password' }, {}),
      ].map(async (promise): Promise<AppError> => {
        try {
          await promise;
          throw new Error('expected login to fail');
        } catch (err) {
          return err as AppError;
        }
      }),
    );

    expect(errors.map((e) => [e.status, e.code, e.message])).toEqual([
      [401, 'invalid_credentials', 'Email or password is incorrect'],
      [401, 'invalid_credentials', 'Email or password is incorrect'],
    ]);
  });

  it('verifies a password even when no user exists, so timing does not leak enumeration', async () => {
    // Without the decoy digest this path would return in microseconds while a
    // real account costs ~50ms of argon2 work.
    const service = createAuthService({ repository: createRepository(), sessionTtlMs: ttl });

    const started = performance.now();
    await service
      .login({ email: 'nobody@acme.test', password: 'whatever-long' }, {})
      .catch(() => undefined);

    expect(performance.now() - started).toBeGreaterThan(5);
  });

  it('does not create a session for a failed login', async () => {
    const repository = createRepository();
    const service = createAuthService({ repository, sessionTtlMs: ttl });

    await service
      .login({ email: 'nobody@acme.test', password: 'whatever-long' }, {})
      .catch(() => undefined);

    expect(repository.createSession).not.toHaveBeenCalled();
  });
});

describe('authenticate', () => {
  it('resolves a live session to its user', async () => {
    const findLiveSession = vi.fn().mockResolvedValue({ sessionId: 's1', user });
    const service = createAuthService({
      repository: createRepository({ findLiveSession }),
      sessionTtlMs: ttl,
    });

    await expect(service.authenticate('some-token')).resolves.toEqual(user);
    // Lookup is by hash: a database leak does not hand over live sessions.
    expect(findLiveSession).toHaveBeenCalledWith(hashSessionToken('some-token'));
  });

  it('returns undefined when the session is unknown, revoked or expired', async () => {
    const service = createAuthService({ repository: createRepository(), sessionTtlMs: ttl });

    await expect(service.authenticate('stale-token')).resolves.toBeUndefined();
  });
});

describe('logout', () => {
  it('revokes by token hash', async () => {
    const revokeSession = vi.fn().mockResolvedValue(undefined);
    const service = createAuthService({
      repository: createRepository({ revokeSession }),
      sessionTtlMs: ttl,
    });

    await service.logout('a-token');

    expect(revokeSession).toHaveBeenCalledWith(hashSessionToken('a-token'));
  });
});
