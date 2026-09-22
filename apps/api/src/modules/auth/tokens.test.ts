import { describe, expect, it } from 'vitest';

import { createSessionToken, hashSessionToken, tokensMatch } from './tokens.js';

describe('session tokens', () => {
  it('issues unguessable tokens and stores only their hash', () => {
    const token = createSessionToken();

    // 32 random bytes, base64url encoded.
    expect(token.value).toMatch(/^[\w-]{43}$/);
    expect(token.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(token.hash).not.toContain(token.value);
  });

  it('never repeats a token', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => createSessionToken().value));

    expect(tokens.size).toBe(200);
  });

  it('hashes deterministically, so a cookie can be looked up', () => {
    const token = createSessionToken();

    expect(hashSessionToken(token.value)).toBe(token.hash);
  });

  it('compares in constant time and rejects different lengths', () => {
    const token = createSessionToken();

    expect(tokensMatch(token.hash, token.hash)).toBe(true);
    expect(tokensMatch(token.hash, token.hash.slice(0, -1))).toBe(false);
    expect(tokensMatch(token.hash, createSessionToken().hash)).toBe(false);
  });
});
