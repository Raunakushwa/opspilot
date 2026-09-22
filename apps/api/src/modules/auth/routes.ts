import { type FastifyInstance } from 'fastify';

import { AppError } from '../../platform/errors.js';
import { loginBody, meResponse, registerBody, userResponse } from './schemas.js';
import { type AuthService } from './service.js';
import { clearSessionCookie, SESSION_COOKIE, setSessionCookie } from './session-cookie.js';

export interface AuthRoutesOptions {
  service: AuthService;
  secureCookies: boolean;
  /** Requests per window for the credential endpoints. */
  loginRateLimit: { max: number; timeWindow: string };
}

export function registerAuthRoutes(app: FastifyInstance, options: AuthRoutesOptions): void {
  const cookieOptions = { secure: options.secureCookies };

  // Credential endpoints are rate limited per IP *and* per email, so one
  // attacker cannot spread guesses across many accounts from one address, and
  // a distributed attack cannot lock onto a single account either.
  const credentialRateLimit = {
    config: {
      rateLimit: {
        max: options.loginRateLimit.max,
        timeWindow: options.loginRateLimit.timeWindow,
        keyGenerator: (request: { ip: string; body?: unknown }) => {
          const email = (request.body as { email?: unknown } | undefined)?.email;
          return typeof email === 'string' ? `${request.ip}:${email.toLowerCase()}` : request.ip;
        },
      },
    },
  };

  app.post('/api/auth/register', credentialRateLimit, async (request, reply) => {
    const body = registerBody.parse(request.body);
    const result = await options.service.register(body, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });
    setSessionCookie(reply, result.token, result.expiresAt, cookieOptions);
    return reply.status(201).send({ user: userResponse.parse(result.user) });
  });

  app.post('/api/auth/login', credentialRateLimit, async (request, reply) => {
    const body = loginBody.parse(request.body);
    const result = await options.service.login(body, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });
    setSessionCookie(reply, result.token, result.expiresAt, cookieOptions);
    return reply.send({ user: userResponse.parse(result.user) });
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) {
      await options.service.logout(token);
    }
    clearSessionCookie(reply, cookieOptions);
    // 204 whether or not a session existed: logout is idempotent.
    return reply.status(204).send();
  });

  app.get('/api/me', async (request, reply) => {
    if (!request.user) {
      throw new AppError(401, 'unauthenticated', 'Authentication required');
    }
    const memberships = await options.service.memberships(request.user.id);
    return reply.send(
      meResponse.parse({
        user: request.user,
        memberships,
      }),
    );
  });
}
