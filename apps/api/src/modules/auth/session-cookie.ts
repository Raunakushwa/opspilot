import { type FastifyReply } from 'fastify';

export const SESSION_COOKIE = 'opspilot_session';

export interface CookieOptions {
  secure: boolean;
}

/**
 * httpOnly: unreadable from JavaScript, so an XSS bug cannot exfiltrate the
 * session. SameSite=Lax: the browser withholds the cookie on cross-site POSTs,
 * which is the main CSRF defence (a custom-header requirement backs it up).
 * Path=/: the cookie must reach both the app and the API under one origin.
 */
export function setSessionCookie(
  reply: FastifyReply,
  token: string,
  expiresAt: Date,
  options: CookieOptions,
): void {
  void reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: options.secure,
    path: '/',
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply, options: CookieOptions): void {
  void reply.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: options.secure,
    path: '/',
  });
}
