import { describe, expect, it } from 'vitest';

import { hashPassword, verifyPassword } from './password.js';

describe('password hashing', () => {
  it('produces an argon2id digest, never the plaintext', async () => {
    const digest = await hashPassword('correct horse battery staple');

    expect(digest).toMatch(/^\$argon2id\$/);
    expect(digest).not.toContain('correct horse');
  });

  it('salts each digest, so identical passwords hash differently', async () => {
    const [a, b] = await Promise.all([
      hashPassword('same-password'),
      hashPassword('same-password'),
    ]);

    expect(a).not.toBe(b);
    await expect(verifyPassword(a, 'same-password')).resolves.toBe(true);
    await expect(verifyPassword(b, 'same-password')).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const digest = await hashPassword('the-right-one');

    await expect(verifyPassword(digest, 'the-wrong-one')).resolves.toBe(false);
  });

  it('returns false for a malformed digest instead of throwing', async () => {
    // A corrupt row must look like a failed login, not a 500 that reveals it.
    await expect(verifyPassword('not-a-hash', 'anything')).resolves.toBe(false);
  });
});
