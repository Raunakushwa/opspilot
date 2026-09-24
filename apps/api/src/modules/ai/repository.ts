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
import { and, desc, eq, sql } from 'drizzle-orm';

export interface RunTelemetry {
  promptVersion?: string;
  model?: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  toolCalls?: {
    tool: string;
    toolCallId?: string;
    ok: boolean;
    latencyMs?: number;
    arguments?: Record<string, unknown>;
  }[];
}

export interface ProposedActionInput {
  actionType: string;
  arguments: Record<string, unknown>;
  rationale: string;
  evidenceIds: string[];
}

/** Proposals go stale: the system they describe moves on. */
export const PROPOSAL_TTL_MINUTES = 60;

export function createAiRepository(db: Database) {
  return {
    createRun: async (input: {
      orgId: string;
      incidentId: string;
      userId: string;
      question: string;
    }) =>
      withTenant(db, input.orgId, async (tx) => {
        const [run] = await tx
          .insert(aiRuns)
          .values({
            orgId: input.orgId,
            incidentId: input.incidentId,
            userId: input.userId,
            question: input.question,
            status: 'QUEUED',
          })
          .returning();
        if (!run) throw new Error('ai run insert returned no row');

        await tx.insert(incidentEvents).values({
          orgId: input.orgId,
          incidentId: input.incidentId,
          actorType: 'USER',
          actorId: input.userId,
          type: 'ai.investigation.started',
          payload: { runId: run.id, question: input.question },
        });
        await tx.insert(auditLogs).values({
          orgId: input.orgId,
          actorType: 'USER',
          actorId: input.userId,
          action: 'AI_INVESTIGATION_STARTED',
          resourceType: 'ai_run',
          resourceId: run.id,
          metadata: { incidentId: input.incidentId },
        });
        return run;
      }),

    markRunning: async (orgId: string, runId: string) =>
      withTenant(db, orgId, (tx) =>
        tx
          .update(aiRuns)
          .set({ status: 'RUNNING', startedAt: new Date() })
          .where(and(eq(aiRuns.orgId, orgId), eq(aiRuns.id, runId))),
      ),

    /**
     * Persists the answer, its telemetry, the provenance ledger and any
     * proposed actions in one transaction: a half-recorded investigation would
     * be worse than none, because the citations would not match the evidence.
     */
    completeRun: async (input: {
      orgId: string;
      runId: string;
      incidentId: string;
      userId: string;
      result: Record<string, unknown>;
      confidence: number;
      telemetry: RunTelemetry;
      proposals: ProposedActionInput[];
      estimatedCostUsd: number;
    }) =>
      withTenant(db, input.orgId, async (tx) => {
        await tx
          .update(aiRuns)
          .set({
            status: 'COMPLETED',
            result: input.result,
            confidence: input.confidence,
            promptVersion: input.telemetry.promptVersion ?? null,
            finishedAt: new Date(),
          })
          .where(and(eq(aiRuns.orgId, input.orgId), eq(aiRuns.id, input.runId)));

        await tx.insert(aiLlmCalls).values({
          orgId: input.orgId,
          runId: input.runId,
          provider: input.telemetry.provider ?? 'unknown',
          model: input.telemetry.model ?? 'unknown',
          promptVersion: input.telemetry.promptVersion ?? null,
          inputTokens: input.telemetry.inputTokens ?? 0,
          outputTokens: input.telemetry.outputTokens ?? 0,
          estimatedCostUsd: input.estimatedCostUsd.toFixed(6),
          latencyMs: input.telemetry.latencyMs ?? 0,
        });

        for (const call of input.telemetry.toolCalls ?? []) {
          await tx.insert(aiToolCalls).values({
            orgId: input.orgId,
            runId: input.runId,
            toolCallId: call.toolCallId ?? null,
            tool: call.tool,
            arguments: call.arguments ?? {},
            ok: String(call.ok),
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
          metadata: { confidence: input.confidence, proposals: input.proposals.length },
        });
        await tx.insert(outboxEvents).values({
          orgId: input.orgId,
          topic: 'ai.run.completed',
          payload: { runId: input.runId, incidentId: input.incidentId },
        });
      }),

    failRun: async (orgId: string, runId: string, error: string) =>
      withTenant(db, orgId, (tx) =>
        tx
          .update(aiRuns)
          .set({ status: 'FAILED', error: error.slice(0, 500), finishedAt: new Date() })
          .where(and(eq(aiRuns.orgId, orgId), eq(aiRuns.id, runId))),
      ),

    getRun: async (orgId: string, runId: string) =>
      withTenant(db, orgId, async (tx) => {
        const [run] = await tx
          .select()
          .from(aiRuns)
          .where(and(eq(aiRuns.orgId, orgId), eq(aiRuns.id, runId)))
          .limit(1);
        return run;
      }),

    listRunsForIncident: async (orgId: string, incidentId: string) =>
      withTenant(db, orgId, (tx) =>
        tx
          .select({
            id: aiRuns.id,
            question: aiRuns.question,
            status: aiRuns.status,
            confidence: aiRuns.confidence,
            createdAt: aiRuns.createdAt,
            finishedAt: aiRuns.finishedAt,
          })
          .from(aiRuns)
          .where(and(eq(aiRuns.orgId, orgId), eq(aiRuns.incidentId, incidentId)))
          .orderBy(desc(aiRuns.createdAt)),
      ),

    listProposals: async (
      orgId: string,
      filters: { status?: string | undefined; incidentId?: string | undefined },
    ) =>
      withTenant(db, orgId, (tx) => {
        const conditions = [eq(aiActionProposals.orgId, orgId)];
        if (filters.status) {
          conditions.push(
            eq(
              aiActionProposals.status,
              filters.status as
                'PROPOSED' | 'APPROVED' | 'REJECTED' | 'EXECUTED' | 'FAILED' | 'EXPIRED',
            ),
          );
        }
        if (filters.incidentId) {
          conditions.push(eq(aiActionProposals.incidentId, filters.incidentId));
        }
        return tx
          .select()
          .from(aiActionProposals)
          .where(and(...conditions))
          .orderBy(desc(aiActionProposals.createdAt));
      }),

    getProposal: async (orgId: string, proposalId: string) =>
      withTenant(db, orgId, async (tx) => {
        const [proposal] = await tx
          .select()
          .from(aiActionProposals)
          .where(and(eq(aiActionProposals.orgId, orgId), eq(aiActionProposals.id, proposalId)))
          .limit(1);
        return proposal;
      }),

    /**
     * Claims a proposal for a decision. The WHERE clause includes the current
     * status, so two approvers racing produce one winner and one 409 rather
     * than two executions.
     */
    decideProposal: async (input: {
      orgId: string;
      proposalId: string;
      userId: string;
      status: 'APPROVED' | 'REJECTED';
    }) =>
      withTenant(db, input.orgId, async (tx) => {
        const [updated] = await tx
          .update(aiActionProposals)
          .set({ status: input.status, decidedBy: input.userId, decidedAt: new Date() })
          .where(
            and(
              eq(aiActionProposals.orgId, input.orgId),
              eq(aiActionProposals.id, input.proposalId),
              eq(aiActionProposals.status, 'PROPOSED'),
              sql`${aiActionProposals.expiresAt} > now()`,
            ),
          )
          .returning();
        return updated;
      }),

    recordExecution: async (input: {
      orgId: string;
      proposalId: string;
      userId: string;
      incidentId: string | null;
      status: 'EXECUTED' | 'FAILED';
      result: Record<string, unknown>;
      actionType: string;
    }) =>
      withTenant(db, input.orgId, async (tx) => {
        await tx
          .update(aiActionProposals)
          .set({ status: input.status, executedAt: new Date(), executionResult: input.result })
          .where(
            and(
              eq(aiActionProposals.orgId, input.orgId),
              eq(aiActionProposals.id, input.proposalId),
            ),
          );

        if (input.incidentId) {
          await tx.insert(incidentEvents).values({
            orgId: input.orgId,
            incidentId: input.incidentId,
            actorType: 'USER',
            actorId: input.userId,
            type: 'ai.action.executed',
            payload: {
              proposalId: input.proposalId,
              actionType: input.actionType,
              ...input.result,
            },
          });
        }
        await tx.insert(auditLogs).values({
          orgId: input.orgId,
          actorType: 'USER',
          actorId: input.userId,
          action: input.status === 'EXECUTED' ? 'AI_ACTION_EXECUTED' : 'AI_ACTION_FAILED',
          resourceType: 'ai_action_proposal',
          resourceId: input.proposalId,
          metadata: { actionType: input.actionType, ...input.result },
        });
      }),

    recordDecisionAudit: async (input: {
      orgId: string;
      proposalId: string;
      userId: string;
      status: 'APPROVED' | 'REJECTED';
      actionType: string;
    }) =>
      withTenant(db, input.orgId, (tx) =>
        tx.insert(auditLogs).values({
          orgId: input.orgId,
          actorType: 'USER',
          actorId: input.userId,
          action: input.status === 'APPROVED' ? 'AI_ACTION_APPROVED' : 'AI_ACTION_REJECTED',
          resourceType: 'ai_action_proposal',
          resourceId: input.proposalId,
          metadata: { actionType: input.actionType },
        }),
      ),
  };
}

export type AiRepository = ReturnType<typeof createAiRepository>;
