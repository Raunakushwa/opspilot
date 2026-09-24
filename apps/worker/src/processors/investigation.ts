import { type Database, withTenant } from '@opspilot/database';
import { incidents, incidentServices, services } from '@opspilot/database/schema';
import { and, eq } from 'drizzle-orm';
import { UnrecoverableError } from 'bullmq';

import { type AiServiceClient } from '../clients/ai-service.js';
import { type JobContext } from './index.js';
import { type RunInvestigationPayload } from '../queues/definitions.js';

export interface InvestigationDependencies {
  db: Database;
  ai: AiServiceClient;
  mintToken: (claims: { userId: string; organizationId: string; runId: string }) => Promise<string>;
  /** Writes results back through the API's own repository logic. */
  persist: {
    markRunning: (orgId: string, runId: string) => Promise<unknown>;
    complete: (input: {
      orgId: string;
      runId: string;
      incidentId: string;
      userId: string;
      result: Record<string, unknown>;
      confidence: number;
      telemetry: Record<string, unknown>;
      proposals: {
        actionType: string;
        arguments: Record<string, unknown>;
        rationale: string;
        evidenceIds: string[];
      }[];
      estimatedCostUsd: number | null;
    }) => Promise<unknown>;
    fail: (orgId: string, runId: string, error: string) => Promise<unknown>;
  };
  estimateCost: (model: string, inputTokens: number, outputTokens: number) => number | null;
}

interface AgentResult {
  summary: string;
  confidence: number;
  proposed_actions?: {
    action_type: string;
    arguments?: Record<string, unknown>;
    rationale: string;
    evidence_ids?: string[];
  }[];
  [key: string]: unknown;
}

/**
 * Orchestrates one investigation.
 *
 * The worker holds the database credentials and mints the delegation token;
 * the AI service receives only the incident and a token that expires in
 * minutes. Results are persisted here so a client that disconnected still
 * finds the answer waiting.
 */
export function createInvestigationProcessor(deps: InvestigationDependencies) {
  return async (payload: RunInvestigationPayload, _job: unknown, context: JobContext) => {
    const { organizationId, runId, incidentId, userId, question } = payload;

    const incident = await withTenant(deps.db, organizationId, async (tx) => {
      const [found] = await tx
        .select()
        .from(incidents)
        .where(and(eq(incidents.orgId, organizationId), eq(incidents.id, incidentId)))
        .limit(1);
      if (!found) return undefined;
      const affected = await tx
        .select({ slug: services.slug, name: services.name })
        .from(incidentServices)
        .innerJoin(services, eq(services.id, incidentServices.serviceId))
        .where(eq(incidentServices.incidentId, incidentId));
      return { ...found, services: affected };
    });

    if (!incident) {
      await deps.persist.fail(organizationId, runId, 'Incident no longer exists');
      throw new UnrecoverableError(`incident ${incidentId} no longer exists`);
    }

    await deps.persist.markRunning(organizationId, runId);
    const token = await deps.mintToken({ userId, organizationId, runId });

    try {
      const response = await deps.ai.runInvestigation({
        runId,
        organizationId,
        userId,
        question,
        incident: {
          ...incident,
          createdAt: incident.createdAt.toISOString(),
        },
        delegationToken: token,
      });

      const result = response.result as unknown as AgentResult;
      const telemetry = response.telemetry;
      const model = typeof telemetry.model === 'string' ? telemetry.model : 'unknown';
      const inputTokens = typeof telemetry.inputTokens === 'number' ? telemetry.inputTokens : 0;
      const outputTokens = typeof telemetry.outputTokens === 'number' ? telemetry.outputTokens : 0;
      const estimatedCostUsd = deps.estimateCost(model, inputTokens, outputTokens);

      await deps.persist.complete({
        orgId: organizationId,
        runId,
        incidentId,
        userId,
        result,
        confidence: result.confidence,
        telemetry,
        proposals: (result.proposed_actions ?? []).map((proposal) => ({
          actionType: proposal.action_type,
          arguments: proposal.arguments ?? {},
          rationale: proposal.rationale,
          evidenceIds: proposal.evidence_ids ?? [],
        })),
        estimatedCostUsd,
      });

      context.logger.info(
        { runId, confidence: result.confidence, costUsd: estimatedCostUsd ?? 'unpriced' },
        'investigation completed',
      );
      return { runId, confidence: result.confidence };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'investigation failed';
      await deps.persist.fail(organizationId, runId, message);
      throw err;
    }
  };
}
