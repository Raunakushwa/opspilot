import { z } from 'zod';

export const roleSchema = z.enum(['OWNER', 'ADMIN', 'ENGINEER', 'VIEWER']);

export const createOrganizationBody = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(40)
    // Slugs appear in URLs and must stay unambiguous.
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'Use lowercase letters, digits and hyphens')
    .toLowerCase(),
});

export const updateOrganizationBody = z.object({
  name: z.string().trim().min(1).max(120),
});

export const addMemberBody = z.object({
  email: z.email().max(320).toLowerCase(),
  role: roleSchema,
});

export const changeRoleBody = z.object({ role: roleSchema });

export const organizationResponse = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
});

export const memberResponse = z.object({
  userId: z.uuid(),
  email: z.string(),
  displayName: z.string(),
  role: roleSchema,
  joinedAt: z.iso.datetime(),
});
