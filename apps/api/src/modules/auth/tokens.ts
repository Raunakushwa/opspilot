import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 256 bits of entropy: not guessable, and short enough for a cookie. */
const TOKEN_BYTES = 32;

export interface SessionToken {
  /** Sent to the client. Never stored. */
  value: string;
  /** Stored. A database leak therefore does not hand over live sessions. */
  hash: string;
}

export function createSessionToken(): SessionToken {
  const value = randomBytes(TOKEN_BYTES).toString('base64url');
  return { value, hash: hashSessionToken(value) };
}

/**
 * SHA-256 rather than argon2: the token is already high-entropy random, so
 * there is nothing to brute-force, and session lookup happens on every request.
 */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time comparison, for cases where a hash is compared in application code. */
export function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
