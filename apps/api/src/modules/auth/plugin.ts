import { type FastifyInstance } from 'fastify';

import { type AuthenticatedUser } from './repository.js';
import { type AuthService } from './service.js';
import { SESSION_COOKIE } from './session-cookie.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Present when the request carried a valid session cookie. */
    user?: AuthenticatedUser;
  }
}

/**
 * Resolves the session cookie on every request. Authentication is never
 * inferred from anything the client can set other than the cookie itself, and
 * an invalid cookie is simply an anonymous request — route handlers decide
 * whether that is acceptable.
 */
export function registerSessionAuth(app: FastifyInstance, service: AuthService): void {
  app.decorateRequest('user', undefined);

  app.addHook('preHandler', async (request) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return;
    const user = await service.authenticate(token);
    if (user) {
      request.user = user;
    }
  });
}
