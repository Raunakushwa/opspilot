import { AppError } from '../../platform/errors.js';
import {
  type AuditContext,
  type IncidentRepository,
  type ListFilters,
  type Severity,
  type Status,
} from './repository.js';

export interface UpdateInput {
  title?: string | undefined;
  description?: string | null | undefined;
  severity?: Severity | undefined;
  status?: Status | undefined;
  assignedTo?: string | null | undefined;
}

/**
 * Terminal statuses. Reopening a closed incident is deliberately not allowed:
 * the postmortem refers to a closed record, so a follow-up is a new incident.
 */
const TERMINAL: Status[] = ['CLOSED'];

export function createIncidentService(repository: IncidentRepository) {
  return {
    create: async (
      input: {
        orgId: string;
        title: string;
        description?: string | undefined;
        severity: Severity;
        serviceIds: string[];
        assignedTo?: string | undefined;
      },
      actor: AuditContext,
    ) => {
      if (!(await repository.servicesExist(input.orgId, input.serviceIds))) {
        throw new AppError(400, 'unknown_service', 'One or more services do not exist');
      }
      if (input.assignedTo && !(await repository.isMember(input.orgId, input.assignedTo))) {
        throw new AppError(400, 'not_a_member', 'Assignee is not a member of this organization');
      }
      return repository.create(input, actor);
    },

    list: async (orgId: string, filters: ListFilters) => repository.list(orgId, filters),

    get: async (orgId: string, incidentId: string) => {
      const incident = await repository.findById(orgId, incidentId);
      if (!incident) throw new AppError(404, 'not_found', 'Incident not found');
      return incident;
    },

    timeline: async (orgId: string, incidentId: string) => {
      await requireIncident(repository, orgId, incidentId);
      return repository.listEvents(orgId, incidentId);
    },

    update: async (
      orgId: string,
      incidentId: string,
      expectedVersion: number | undefined,
      changes: UpdateInput,
      actor: AuditContext,
    ) => {
      const current = await requireIncident(repository, orgId, incidentId);

      if (expectedVersion === undefined) {
        // Without If-Match a client would silently overwrite a colleague's edit.
        throw new AppError(
          428,
          'precondition_required',
          'If-Match with the current version is required',
        );
      }
      if (expectedVersion !== current.version) {
        throw new AppError(
          412,
          'stale_version',
          'The incident changed since you loaded it; reload and retry',
        );
      }
      if (TERMINAL.includes(current.status) && changes.status !== undefined) {
        throw new AppError(409, 'incident_closed', 'A closed incident cannot change status');
      }
      if (changes.assignedTo && !(await repository.isMember(orgId, changes.assignedTo))) {
        throw new AppError(400, 'not_a_member', 'Assignee is not a member of this organization');
      }

      // One timeline entry per meaningful change, not one per request: the
      // timeline should read like a story, not a diff log.
      const events: { type: string; payload: Record<string, unknown>; action: string }[] = [];
      if (changes.status && changes.status !== current.status) {
        events.push({
          type: 'incident.status.changed',
          payload: { from: current.status, to: changes.status },
          action: 'INCIDENT_STATUS_CHANGED',
        });
      }
      if (changes.severity && changes.severity !== current.severity) {
        events.push({
          type: 'incident.severity.changed',
          payload: { from: current.severity, to: changes.severity },
          action: 'INCIDENT_SEVERITY_CHANGED',
        });
      }
      if (changes.assignedTo !== undefined && changes.assignedTo !== current.assignedTo) {
        events.push({
          type: 'incident.assignee.changed',
          payload: { from: current.assignedTo, to: changes.assignedTo },
          action: 'INCIDENT_ASSIGNED',
        });
      }
      if (
        (changes.title !== undefined && changes.title !== current.title) ||
        (changes.description !== undefined && changes.description !== current.description)
      ) {
        events.push({
          type: 'incident.updated',
          payload: { fields: Object.keys(changes) },
          action: 'INCIDENT_UPDATED',
        });
      }

      const updated = await repository.update(
        orgId,
        incidentId,
        expectedVersion,
        changes,
        actor,
        events,
      );
      if (!updated) {
        // Lost the race between reading the version and writing.
        throw new AppError(412, 'stale_version', 'The incident changed while you were saving it');
      }
      return updated;
    },

    audit: async (orgId: string, limit: number) => repository.listAudit(orgId, limit),
  };
}

async function requireIncident(repository: IncidentRepository, orgId: string, incidentId: string) {
  const incident = await repository.findById(orgId, incidentId);
  if (!incident) throw new AppError(404, 'not_found', 'Incident not found');
  return incident;
}

export type IncidentService = ReturnType<typeof createIncidentService>;
