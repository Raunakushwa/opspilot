import { z } from 'zod';

export const startInvestigationBody = z.object({
  incidentId: z.uuid(),
  question: z
    .string()
    .trim()
    .min(5)
    .max(1000)
    .default('Investigate this incident and explain the probable cause.'),
});

export const decideProposalBody = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
});

export const proposalQuery = z.object({
  status: z.enum(['PROPOSED', 'APPROVED', 'REJECTED', 'EXECUTED', 'FAILED', 'EXPIRED']).optional(),
  incidentId: z.uuid().optional(),
});
