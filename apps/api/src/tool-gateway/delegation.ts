import { jwtVerify, SignJWT } from 'jose';

/**
 * Delegation tokens.
 *
 * The agent never holds a user's session. It receives a token scoped to one
 * (user, organization, run) that expires in minutes and grants read access
 * only. Even with the token, every call re-checks the user's *current*
 * membership, so a revoked role takes effect mid-investigation.
 */

export const DELEGATION_AUDIENCE = 'opspilot-tool-gateway';
export const DELEGATION_ISSUER = 'opspilot-api';

export interface DelegationClaims {
  userId: string;
  organizationId: string;
  runId: string;
}

export class DelegationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DelegationError';
  }
}

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function mintDelegationToken(
  claims: DelegationClaims,
  secret: string,
  ttlSeconds: number,
): Promise<string> {
  return new SignJWT({ org: claims.organizationId, run: claims.runId, scope: 'tools:read' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.userId)
    .setIssuer(DELEGATION_ISSUER)
    .setAudience(DELEGATION_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${String(ttlSeconds)}s`)
    .sign(key(secret));
}

export async function verifyDelegationToken(
  token: string,
  secret: string,
): Promise<DelegationClaims> {
  try {
    const { payload } = await jwtVerify(token, key(secret), {
      audience: DELEGATION_AUDIENCE,
      issuer: DELEGATION_ISSUER,
    });
    const organizationId = payload.org;
    const runId = payload.run;
    if (
      typeof payload.sub !== 'string' ||
      typeof organizationId !== 'string' ||
      typeof runId !== 'string' ||
      payload.scope !== 'tools:read'
    ) {
      throw new DelegationError('Malformed delegation token');
    }
    return { userId: payload.sub, organizationId, runId };
  } catch (err) {
    if (err instanceof DelegationError) throw err;
    throw new DelegationError(err instanceof Error ? err.message : 'Invalid delegation token');
  }
}
