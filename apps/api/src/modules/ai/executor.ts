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

export interface DeploymentRecord {
  version: string;
  status: string;
  startedAt: Date;
}

export interface ExecutorDependencies {
  incidents: IncidentService;
  /** Reads deployment history so a rollback target is verified, not trusted. */
  deployments?: {
    recent: (organizationId: string, service: string, limit: number) => Promise<DeploymentRecord[]>;
  };
  /** Simulated in the demo; a real deploy adapter implements this later. */
  deploy?: {
    rollback: (service: string, toVersion: string) => Promise<Record<string, unknown>>;
    restart: (service: string) => Promise<Record<string, unknown>>;
  };
}

/** First of `keys` present as a non-empty string; models vary their naming. */
function firstString(args: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError(400, 'invalid_action_arguments', `Action argument "${key}" is required`);
  }
  return value;
}

/**
 * Works out which service an action targets.
 *
 * A model names this field differently from run to run, and its value could be
 * wrong anyway. The incident's affected service is authoritative, so it wins;
 * an argument is only used when it names one of those services. This is the
 * "re-validate against current state" rule from ADR-007 doing real work.
 */
async function resolveService(
  args: Record<string, unknown>,
  context: ExecutionContext,
  incidents: IncidentService,
): Promise<string> {
  const affected = context.incidentId
    ? (await incidents.get(context.organizationId, context.incidentId)).services.map(
        (service) => service.slug,
      )
    : [];

  const candidate = firstString(args, ['service', 'service_slug', 'service_name']);

  if (candidate && affected.includes(candidate)) return candidate;
  if (affected.length === 1 && affected[0]) return affected[0];
  if (candidate && affected.length === 0) return candidate;

  throw new AppError(
    400,
    'ambiguous_service',
    affected.length === 0
      ? 'This incident has no affected service, so the target cannot be determined'
      : `Specify which service to act on: ${affected.join(', ')}`,
  );
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
    execute: async (args, context) => {
      const service = await resolveService(args, context, deps.incidents);
      if (!deps.deploy || !deps.deployments) {
        throw new AppError(
          501,
          'action_unavailable',
          'No deployment adapter is configured in this environment',
        );
      }

      // The target version is resolved from deployment history, not taken from
      // the proposal. A model-supplied version could be stale, mistyped or
      // invented, and this executes against production (ADR-007): arguments are
      // re-validated against current state at approval time.
      const history = await deps.deployments.recent(context.organizationId, service, 5);
      const succeeded = history.filter((deployment) => deployment.status === 'SUCCEEDED');
      const current = succeeded.at(0);
      const previous = succeeded.at(1);

      if (!current || !previous) {
        throw new AppError(
          409,
          'no_rollback_target',
          `${service} has no earlier successful deployment to roll back to`,
        );
      }

      const requestedRaw = firstString(args, ['to_version', 'target_version', 'version']);
      const requested = requestedRaw === 'previous' ? null : requestedRaw;
      if (requested && requested !== previous.version) {
        const known = history.some((deployment) => deployment.version === requested);
        if (!known) {
          throw new AppError(400, 'unknown_version', `${service} has no deployment ${requested}`);
        }
      }

      const target = requested ?? previous.version;
      const result = await deps.deploy.rollback(service, target);
      return { ...result, from: current.version, to: target };
    },
  });

  registry.set('RESTART_SERVICE', {
    permission: 'ai:approve:operational',
    label: 'Restart service',
    execute: async (args, context) => {
      const service = await resolveService(args, context, deps.incidents);
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
