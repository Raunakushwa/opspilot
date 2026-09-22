import { z } from 'zod';

/**
 * Password policy: length over composition rules. NIST advises against forced
 * character classes, which push users toward predictable substitutions.
 */
const password = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(200, 'Password must be at most 200 characters');

export const registerBody = z.object({
  email: z.email().max(320).toLowerCase(),
  password,
  displayName: z.string().trim().min(1).max(100),
});

export const loginBody = z.object({
  email: z.email().max(320).toLowerCase(),
  password: z.string().min(1).max(200),
});

export const userResponse = z.object({
  id: z.uuid(),
  email: z.string(),
  displayName: z.string(),
});

export const meResponse = z.object({
  user: userResponse,
  memberships: z.array(
    z.object({
      organizationId: z.uuid(),
      organizationName: z.string(),
      organizationSlug: z.string(),
      role: z.enum(['OWNER', 'ADMIN', 'ENGINEER', 'VIEWER']),
    }),
  ),
});

export type RegisterBody = z.infer<typeof registerBody>;
export type LoginBody = z.infer<typeof loginBody>;
