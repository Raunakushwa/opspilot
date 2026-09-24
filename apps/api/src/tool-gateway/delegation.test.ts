import { describe, expect, it } from 'vitest';

import { DelegationError, mintDelegationToken, verifyDelegationToken } from './delegation.js';

const secret = 'a-test-secret-that-is-long-enough-32';
const claims = {
  userId: '01a0c000-0000-7000-8000-000000000001',
  organizationId: '01a0c000-0000-7000-8000-0000000000aa',
  runId: '01a0c000-0000-7000-8000-0000000000bb',
};

describe('delegation tokens', () => {
  it('round-trips the user, organization and run', async () => {
    const token = await mintDelegationToken(claims, secret, 900);

    await expect(verifyDelegationToken(token, secret)).resolves.toEqual(claims);
  });

  it('rejects a token signed with another secret', async () => {
    const token = await mintDelegationToken(claims, 'another-secret-long-enough-for-hs256', 900);

    await expect(verifyDelegationToken(token, secret)).rejects.toThrow(DelegationError);
  });

  it('rejects an expired token', async () => {
    // Scoping by time is what limits the damage of a leaked token.
    const token = await mintDelegationToken(claims, secret, 1);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    await expect(verifyDelegationToken(token, secret)).rejects.toThrow(DelegationError);
  });

  it('rejects a tampered token', async () => {
    const token = await mintDelegationToken(claims, secret, 900);
    const [header, payload, signature] = token.split('.');
    const forged = [header, payload, `${signature?.slice(0, -2) ?? ''}xy`].join('.');

    await expect(verifyDelegationToken(forged, secret)).rejects.toThrow(DelegationError);
  });

  it('rejects a well-formed JWT that is not a delegation token', async () => {
    const { SignJWT } = await import('jose');
    const token = await new SignJWT({ org: claims.organizationId, run: claims.runId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.userId)
      .setIssuer('somewhere-else')
      .setAudience('another-audience')
      .setExpirationTime('10m')
      .sign(new TextEncoder().encode(secret));

    await expect(verifyDelegationToken(token, secret)).rejects.toThrow(DelegationError);
  });

  it('rejects a token without the read scope', async () => {
    const { SignJWT } = await import('jose');
    const token = await new SignJWT({
      org: claims.organizationId,
      run: claims.runId,
      scope: 'tools:write',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.userId)
      .setIssuer('opspilot-api')
      .setAudience('opspilot-tool-gateway')
      .setExpirationTime('10m')
      .sign(new TextEncoder().encode(secret));

    // There is no write scope in the system; a token claiming one is a forgery
    // or a bug, and either way must not be honoured.
    await expect(verifyDelegationToken(token, secret)).rejects.toThrow(DelegationError);
  });
});
