import { type Database, withTenant } from '@opspilot/database';
import {
  aiActionProposals,
  aiLlmCalls,
  aiRuns,
  aiToolCalls,
  auditLogs,
  incidentEvents,
  outboxEvents,
} from '@opspilot/database/schema';
import { and, eq } from 'drizzle-orm';

/**
 * Persists an investigation's outcome.
 *
 * The worker writes this rather than the API because the run outlives the
 * request that started it. Everything lands in one transaction: a half-written
 * investigation would show citations that do not match its evidence.
 */

const PROPOSAL_TTL_MINUTES = 60;

export interface CompleteRunInput {
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
  estimatedCostUsd: number;
}

interface ToolCallTelemetry {
  tool: string;
  toolCallId?: string;
  ok?: boolean;
  latencyMs?: number;
  arguments?: Record<string, unknown>;
}

/** Telemetry crosses a service boundary as JSON: read it defensively. */
function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function createRunPersistence(db: Database) {
  return {
    markRunning: (orgId: string, runId: string) =>
      withTenant(db, orgId, (tx) =>
        tx
          .update(aiRuns)
          .set({ status: 'RUNNING', startedAt: new Date() })
          .where(and(eq(aiRuns.orgId, orgId), eq(aiRuns.id, runId))),
      ),

    fail: (orgId: string, runId: string, error: string) =>
      withTenant(db, orgId, (tx) =>
        tx
          .update(aiRuns)
          .set({ status: 'FAILED', error: error.slice(0, 500), finishedAt: new Date() })
          .where(and(eq(aiRuns.orgId, orgId), eq(aiRuns.id, runId))),
      ),

    complete: (input: CompleteRunInput) =>
      withTenant(db, input.orgId, async (tx) => {
        const telemetry = input.telemetry;
        await tx
          .update(aiRuns)
          .set({
            status: 'COMPLETED',
            result: input.result,
            confidence: input.confidence,
            promptVersion: text(telemetry.promptVersion),
            finishedAt: new Date(),
          })
          .where(and(eq(aiRuns.orgId, input.orgId), eq(aiRuns.id, input.runId)));

        await tx.insert(aiLlmCalls).values({
          orgId: input.orgId,
          runId: input.runId,
          provider: text(telemetry.provider, 'unknown'),
          model: text(telemetry.model, 'unknown'),
          promptVersion: text(telemetry.promptVersion),
          inputTokens: count(telemetry.inputTokens),
          outputTokens: count(telemetry.outputTokens),
          estimatedCostUsd: input.estimatedCostUsd.toFixed(6),
          latencyMs: count(telemetry.latencyMs),
        });

        const toolCalls = (telemetry.toolCalls ?? []) as ToolCallTelemetry[];
        for (const call of toolCalls) {
          await tx.insert(aiToolCalls).values({
            orgId: input.orgId,
            runId: input.runId,
            toolCallId: call.toolCallId ?? null,
            tool: call.tool,
            arguments: call.arguments ?? {},
            ok: String(call.ok ?? true),
            latencyMs: call.latencyMs ?? 0,
          });
        }

        const expiresAt = new Date(Date.now() + PROPOSAL_TTL_MINUTES * 60_000);
        for (const proposal of input.proposals) {
          await tx.insert(aiActionProposals).values({
            orgId: input.orgId,
            runId: input.runId,
            incidentId: input.incidentId,
            actionType: proposal.actionType,
            arguments: proposal.arguments,
            rationale: proposal.rationale,
            evidenceIds: proposal.evidenceIds,
            expiresAt,
          });
        }

        await tx.insert(incidentEvents).values({
          orgId: input.orgId,
          incidentId: input.incidentId,
          actorType: 'AI',
          actorId: input.userId,
          type: 'ai.recommendation.generated',
          payload: {
            runId: input.runId,
            confidence: input.confidence,
            proposals: input.proposals.length,
          },
        });
        await tx.insert(auditLogs).values({
          orgId: input.orgId,
          actorType: 'AI',
          actorId: input.userId,
          action: 'AI_INVESTIGATION_COMPLETED',
          resourceType: 'ai_run',
          resourceId: input.runId,
          metadata: {
            confidence: input.confidence,
            proposals: input.proposals.length,
            model: text(telemetry.model),
            estimatedCostUsd: input.estimatedCostUsd,
          },
        });
        await tx.insert(outboxEvents).values({
          orgId: input.orgId,
          topic: 'ai.run.completed',
          payload: { runId: input.runId, incidentId: input.incidentId },
        });
      }),
  };
}
