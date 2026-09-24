import { AppError } from '../../platform/errors.js';
import { can, type Role } from '../../platform/authorization.js';
import { type IncidentService } from '../incidents/service.js';
import { type ActionDefinition, type ExecutionContext } from './executor.js';
import { type AiRepository } from './repository.js';

export type EnqueueInvestigation = (input: {
  organizationId: string;
  runId: string;
  incidentId: string;
  userId: string;
  question: string;
}) => Promise<void>;

export interface AiServiceOptions {
  repository: AiRepository;
  incidents: IncidentService;
  enqueue: EnqueueInvestigation;
  actions: Map<string, ActionDefinition>;
}

export function createAiService({ repository, incidents, enqueue, actions }: AiServiceOptions) {
  return {
    startInvestigation: async (input: {
      organizationId: string;
      incidentId: string;
      userId: string;
      question: string;
    }) => {
      // Fails here if the incident does not exist or is another tenant's.
      await incidents.get(input.organizationId, input.incidentId);

      const run = await repository.createRun({
        orgId: input.organizationId,
        incidentId: input.incidentId,
        userId: input.userId,
        question: input.question,
      });

      await enqueue({
        organizationId: input.organizationId,
        runId: run.id,
        incidentId: input.incidentId,
        userId: input.userId,
        question: input.question,
      });
      return run;
    },

    getRun: async (organizationId: string, runId: string) => {
      const run = await repository.getRun(organizationId, runId);
      if (!run) throw new AppError(404, 'not_found', 'Investigation not found');
      return run;
    },

    listRuns: async (organizationId: string, incidentId: string) =>
      repository.listRunsForIncident(organizationId, incidentId),

    listProposals: async (
      organizationId: string,
      filters: { status?: string | undefined; incidentId?: string | undefined },
    ) => repository.listProposals(organizationId, filters),

    /**
     * Approve-and-execute.
     *
     * Authorization happens here, against the approver's role and the action's
     * own permission — not against whoever started the investigation, who may
     * have been an engineer proposing an administrator's action.
     */
    decideProposal: async (input: {
      organizationId: string;
      proposalId: string;
      approverId: string;
      approverRole: Role;
      decision: 'APPROVED' | 'REJECTED';
      requestId?: string | undefined;
      ip?: string | undefined;
    }) => {
      const proposal = await repository.getProposal(input.organizationId, input.proposalId);
      if (!proposal) throw new AppError(404, 'not_found', 'Proposal not found');

      const action = actions.get(proposal.actionType);
      if (!action) {
        throw new AppError(400, 'unknown_action', `No executor for ${proposal.actionType}`);
      }
      if (input.decision === 'APPROVED' && !can(input.approverRole, action.permission)) {
        throw new AppError(
          403,
          'forbidden',
          `Your role (${input.approverRole}) cannot approve "${action.label}"`,
        );
      }
      if (proposal.expiresAt.getTime() <= Date.now()) {
        throw new AppError(
          409,
          'proposal_expired',
          'This proposal has expired; run a new investigation',
        );
      }

      const claimed = await repository.decideProposal({
        orgId: input.organizationId,
        proposalId: input.proposalId,
        userId: input.approverId,
        status: input.decision,
      });
      if (!claimed) {
        // Someone else decided first, or it expired between the checks.
        throw new AppError(409, 'already_decided', 'This proposal has already been decided');
      }

      await repository.recordDecisionAudit({
        orgId: input.organizationId,
        proposalId: input.proposalId,
        userId: input.approverId,
        status: input.decision,
        actionType: proposal.actionType,
      });

      if (input.decision === 'REJECTED') {
        return { proposal: claimed, execution: null };
      }

      const context: ExecutionContext = {
        organizationId: input.organizationId,
        approverId: input.approverId,
        incidentId: proposal.incidentId,
        requestId: input.requestId,
        ip: input.ip,
      };

      try {
        const result = await action.execute(proposal.arguments, context);
        await repository.recordExecution({
          orgId: input.organizationId,
          proposalId: input.proposalId,
          userId: input.approverId,
          incidentId: proposal.incidentId,
          status: 'EXECUTED',
          result,
          actionType: proposal.actionType,
        });
        return { proposal: { ...claimed, status: 'EXECUTED' as const }, execution: result };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'execution failed';
        await repository.recordExecution({
          orgId: input.organizationId,
          proposalId: input.proposalId,
          userId: input.approverId,
          incidentId: proposal.incidentId,
          status: 'FAILED',
          result: { error: message },
          actionType: proposal.actionType,
        });
        throw err;
      }
    },
  };
}

export type AiOrchestrationService = ReturnType<typeof createAiService>;
