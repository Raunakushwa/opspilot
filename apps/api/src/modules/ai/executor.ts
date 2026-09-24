import { type IncidentService } from '../incidents/service.js';
import { AppError } from '../../platform/errors.js';
import { type Permission } from '../../platform/authorization.js';

/**
 * Executes an approved proposal — the only place a write the agent suggested
 * actually happens (ADR-007).
 *
 * It runs as the *approver*, not as whoever started the investigation, and it
 * re-validates the arguments against current state first: a proposal made five
 * minutes ago may already be wrong.
 */

export interface ExecutionContext {
  organizationId: string;
  approverId: string;
  incidentId: string | null;
  requestId?: string | undefined;
  ip?: string | undefined;
}

export interface ActionDefinition {
  /** Which permission an approver needs. Operational actions need ADMIN. */
  permission: Permission;
  label: string;
  execute: (
    args: Record<string, unknown>,
    context: ExecutionContext,
  ) => Promise<Record<string, unknown>>;
}

export interface ExecutorDependencies {
  incidents: IncidentService;
  /** Simulated in the demo; a real deploy adapter implements this later. */
  deploy?: {
    rollback: (service: string, toVersion: string) => Promise<Record<string, unknown>>;
    restart: (service: string) => Promise<Record<string, unknown>>;
  };
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError(400, 'invalid_action_arguments', `Action argument "${key}" is required`);
  }
  return value;
}

export function createActionRegistry(deps: ExecutorDependencies): Map<string, ActionDefinition> {
  const registry = new Map<string, ActionDefinition>();

  registry.set('ASSIGN_ENGINEER', {
    // Assigning an incident is reversible and low risk.
    permission: 'ai:approve:low_risk',
    label: 'Assign engineer',
    execute: async (args, context) => {
      const userId = requireString(args, 'user_id');
      if (!context.incidentId) {
        throw new AppError(400, 'invalid_action_arguments', 'No incident for this proposal');
      }
      const incident = await deps.incidents.get(context.organizationId, context.incidentId);
      await deps.incidents.update(
        context.organizationId,
        context.incidentId,
        incident.version,
        { assignedTo: userId },
        { actorId: context.approverId, requestId: context.requestId, ip: context.ip },
      );
      return { assignedTo: userId };
    },
  });

  registry.set('CHANGE_SEVERITY', {
    permission: 'ai:approve:low_risk',
    label: 'Change severity',
    execute: async (args, context) => {
      const severity = requireString(args, 'severity');
      if (!['SEV1', 'SEV2', 'SEV3', 'SEV4'].includes(severity)) {
        throw new AppError(400, 'invalid_action_arguments', 'Unknown severity');
      }
      if (!context.incidentId) {
        throw new AppError(400, 'invalid_action_arguments', 'No incident for this proposal');
      }
      const incident = await deps.incidents.get(context.organizationId, context.incidentId);
      await deps.incidents.update(
        context.organizationId,
        context.incidentId,
        incident.version,
        { severity: severity as 'SEV1' | 'SEV2' | 'SEV3' | 'SEV4' },
        { actorId: context.approverId, requestId: context.requestId, ip: context.ip },
      );
      return { severity };
    },
  });

  registry.set('ROLLBACK_DEPLOYMENT', {
    // Rolling back production is an administrator's decision.
    permission: 'ai:approve:operational',
    label: 'Roll back deployment',
    execute: async (args) => {
      const service = requireString(args, 'service');
      const version = requireString(args, 'to_version');
      if (!deps.deploy) {
        throw new AppError(
          501,
          'action_unavailable',
          'No deployment adapter is configured in this environment',
        );
      }
      return deps.deploy.rollback(service, version);
    },
  });

  registry.set('RESTART_SERVICE', {
    permission: 'ai:approve:operational',
    label: 'Restart service',
    execute: async (args) => {
      const service = requireString(args, 'service');
      if (!deps.deploy) {
        throw new AppError(
          501,
          'action_unavailable',
          'No deployment adapter is configured in this environment',
        );
      }
      return deps.deploy.restart(service);
    },
  });

  return registry;
}

/**
 * Demo adapter. It records what would have happened rather than pretending to
 * touch infrastructure, and the response says so plainly.
 */
export function createSimulatedDeployAdapter() {
  return {
    rollback: (service: string, toVersion: string) =>
      Promise.resolve({
        simulated: true,
        action: 'rollback',
        service,
        toVersion,
        note: 'No deployment system is connected; the rollback was recorded, not performed.',
      }),
    restart: (service: string) =>
      Promise.resolve({
        simulated: true,
        action: 'restart',
        service,
        note: 'No orchestrator is connected; the restart was recorded, not performed.',
      }),
  };
}
