import { hash, verify } from '@node-rs/argon2';

/**
 * argon2id parameters. OWASP's current floor is 19 MiB memory, 2 iterations,
 * 1 degree of parallelism; we use 19 MiB / 3 iterations. Memory cost is what
 * makes GPU cracking expensive, so it is raised before iterations.
 */
const OPTIONS = {
  memoryCost: 19456,
  timeCost: 3,
  parallelism: 1,
} as const;

export async function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, OPTIONS);
}

/**
 * Verifies a password. Returns false rather than throwing on a malformed hash,
 * so a corrupt row cannot turn into a 500 that distinguishes it from a wrong
 * password.
 */
export async function verifyPassword(digest: string, plaintext: string): Promise<boolean> {
  try {
    return await verify(digest, plaintext, OPTIONS);
  } catch {
    return false;
  }
}
