import { z } from 'zod';

export const severitySchema = z.enum(['SEV1', 'SEV2', 'SEV3', 'SEV4']);
export const statusSchema = z.enum([
  'INVESTIGATING',
  'IDENTIFIED',
  'MITIGATING',
  'RESOLVED',
  'CLOSED',
]);

export const createIncidentBody = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().max(10_000).optional(),
  severity: severitySchema.default('SEV3'),
  serviceIds: z.array(z.uuid()).max(20).default([]),
  assignedTo: z.uuid().optional(),
});

export const updateIncidentBody = z
  .object({
    title: z.string().trim().min(3).max(200).optional(),
    description: z.string().max(10_000).nullable().optional(),
    severity: severitySchema.optional(),
    status: statusSchema.optional(),
    assignedTo: z.uuid().nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'No changes supplied' });

export const listQuery = z.object({
  status: z
    .union([statusSchema, z.array(statusSchema)])
    .transform((value) => (Array.isArray(value) ? value : [value]))
    .optional(),
  severity: z
    .union([severitySchema, z.array(severitySchema)])
    .transform((value) => (Array.isArray(value) ? value : [value]))
    .optional(),
  assignedTo: z.uuid().optional(),
  serviceId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.uuid().optional(),
});
