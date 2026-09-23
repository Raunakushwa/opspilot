import { type Database, withTenant } from '@opspilot/database';
import {
  auditLogs,
  incidentCounters,
  incidentEvents,
  incidents,
  incidentServices,
  outboxEvents,
  services,
  users,
} from '@opspilot/database/schema';
import { and, count, desc, eq, inArray, lt, sql } from 'drizzle-orm';

export type Severity = 'SEV1' | 'SEV2' | 'SEV3' | 'SEV4';
export type Status = 'INVESTIGATING' | 'IDENTIFIED' | 'MITIGATING' | 'RESOLVED' | 'CLOSED';

export interface AuditContext {
  actorId: string;
  requestId?: string | undefined;
  ip?: string | undefined;
}

export interface CreateIncidentInput {
  orgId: string;
  title: string;
  description?: string | undefined;
  severity: Severity;
  serviceIds: string[];
  assignedTo?: string | undefined;
}

export interface ListFilters {
  status?: Status[] | undefined;
  severity?: Severity[] | undefined;
  assignedTo?: string | undefined;
  serviceId?: string | undefined;
  limit: number;
  cursor?: string | undefined;
}

/** Inside withTenant the callback receives the tenant-scoped transaction. */
type Tx = Database;

/** Timeline entry + audit record + outbox event, always written with the change. */
async function record(
  tx: Tx,
  input: {
    orgId: string;
    incidentId: string;
    actor: AuditContext;
    eventType: string;
    payload?: Record<string, unknown>;
    auditAction: string;
  },
): Promise<void> {
  const payload = input.payload ?? {};
  await tx.insert(incidentEvents).values({
    orgId: input.orgId,
    incidentId: input.incidentId,
    actorType: 'USER',
    actorId: input.actor.actorId,
    type: input.eventType,
    payload,
  });
  await tx.insert(auditLogs).values({
    orgId: input.orgId,
    actorType: 'USER',
    actorId: input.actor.actorId,
    action: input.auditAction,
    resourceType: 'incident',
    resourceId: input.incidentId,
    metadata: payload,
    requestId: input.actor.requestId ?? null,
    ip: input.actor.ip ?? null,
  });
  await tx.insert(outboxEvents).values({
    orgId: input.orgId,
    topic: input.eventType,
    payload: { incidentId: input.incidentId, ...payload },
  });
}

export function createIncidentRepository(db: Database) {
  return {
    create: async (input: CreateIncidentInput, actor: AuditContext) =>
      withTenant(db, input.orgId, async (tx) => {
        // Reserve the next number under a row lock; max()+1 would race.
        await tx
          .insert(incidentCounters)
          .values({ orgId: input.orgId, nextNumber: 1 })
          .onConflictDoNothing();
        const [counter] = await tx
          .update(incidentCounters)
          .set({ nextNumber: sql`${incidentCounters.nextNumber} + 1` })
          .where(eq(incidentCounters.orgId, input.orgId))
          .returning({ number: incidentCounters.nextNumber });

        const [incident] = await tx
          .insert(incidents)
          .values({
            orgId: input.orgId,
            number: (counter?.number ?? 2) - 1,
            title: input.title,
            description: input.description ?? null,
            severity: input.severity,
            createdBy: actor.actorId,
            assignedTo: input.assignedTo ?? null,
          })
          .returning();
        if (!incident) throw new Error('incident insert returned no row');

        if (input.serviceIds.length > 0) {
          await tx.insert(incidentServices).values(
            input.serviceIds.map((serviceId) => ({
              orgId: input.orgId,
              incidentId: incident.id,
              serviceId,
            })),
          );
        }

        await record(tx, {
          orgId: input.orgId,
          incidentId: incident.id,
          actor,
          eventType: 'incident.created',
          payload: { title: incident.title, severity: incident.severity },
          auditAction: 'INCIDENT_CREATED',
        });

        return incident;
      }),

    list: async (orgId: string, filters: ListFilters) =>
      withTenant(db, orgId, async (tx) => {
        const conditions = [eq(incidents.orgId, orgId)];
        if (filters.status?.length) conditions.push(inArray(incidents.status, filters.status));
        if (filters.severity?.length)
          conditions.push(inArray(incidents.severity, filters.severity));
        if (filters.assignedTo) conditions.push(eq(incidents.assignedTo, filters.assignedTo));
        if (filters.cursor) {
          // Keyset pagination on the UUIDv7 primary key, which is time-ordered:
          // stable under concurrent inserts, unlike OFFSET.
          conditions.push(lt(incidents.id, filters.cursor));
        }
        if (filters.serviceId) {
          conditions.push(
            sql`EXISTS (SELECT 1 FROM incident_services s WHERE s.incident_id = ${incidents.id} AND s.service_id = ${filters.serviceId})`,
          );
        }

        return tx
          .select()
          .from(incidents)
          .where(and(...conditions))
          .orderBy(desc(incidents.id))
          .limit(filters.limit);
      }),

    findById: async (orgId: string, incidentId: string) =>
      withTenant(db, orgId, async (tx) => {
        const [incident] = await tx
          .select()
          .from(incidents)
          .where(and(eq(incidents.orgId, orgId), eq(incidents.id, incidentId)))
          .limit(1);
        if (!incident) return undefined;

        const affected = await tx
          .select({ id: services.id, name: services.name, slug: services.slug })
          .from(incidentServices)
          .innerJoin(services, eq(services.id, incidentServices.serviceId))
          .where(eq(incidentServices.incidentId, incidentId));

        return { ...incident, services: affected };
      }),

    /**
     * Applies changes only if the caller's version is current; the returned
     * row is undefined when someone else has written in the meantime.
     */
    update: async (
      orgId: string,
      incidentId: string,
      expectedVersion: number,
      changes: {
        title?: string | undefined;
        description?: string | null | undefined;
        severity?: Severity | undefined;
        status?: Status | undefined;
        assignedTo?: string | null | undefined;
      },
      actor: AuditContext,
      events: { type: string; payload: Record<string, unknown>; action: string }[],
    ) =>
      withTenant(db, orgId, async (tx) => {
        const resolved = changes.status === 'RESOLVED' ? { resolvedAt: new Date() } : ({} as const);
        const closed = changes.status === 'CLOSED' ? { closedAt: new Date() } : ({} as const);

        const [updated] = await tx
          .update(incidents)
          .set({
            ...changes,
            ...resolved,
            ...closed,
            version: sql`${incidents.version} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(incidents.orgId, orgId),
              eq(incidents.id, incidentId),
              eq(incidents.version, expectedVersion),
            ),
          )
          .returning();

        if (!updated) return undefined;

        for (const event of events) {
          await record(tx, {
            orgId,
            incidentId,
            actor,
            eventType: event.type,
            payload: event.payload,
            auditAction: event.action,
          });
        }
        return updated;
      }),

    listEvents: async (orgId: string, incidentId: string) =>
      withTenant(db, orgId, (tx) =>
        tx
          .select({
            id: incidentEvents.id,
            type: incidentEvents.type,
            actorType: incidentEvents.actorType,
            actorId: incidentEvents.actorId,
            actorName: users.displayName,
            payload: incidentEvents.payload,
            createdAt: incidentEvents.createdAt,
          })
          .from(incidentEvents)
          .leftJoin(users, eq(users.id, incidentEvents.actorId))
          .where(and(eq(incidentEvents.orgId, orgId), eq(incidentEvents.incidentId, incidentId)))
          .orderBy(incidentEvents.createdAt),
      ),

    listAudit: async (orgId: string, limit: number) =>
      withTenant(db, orgId, (tx) =>
        tx
          .select()
          .from(auditLogs)
          .where(eq(auditLogs.orgId, orgId))
          .orderBy(desc(auditLogs.createdAt))
          .limit(limit),
      ),

    /** Validates that every referenced service belongs to this organization. */
    servicesExist: async (orgId: string, serviceIds: string[]) =>
      withTenant(db, orgId, async (tx) => {
        if (serviceIds.length === 0) return true;
        const [row] = await tx
          .select({ found: count() })
          .from(services)
          .where(and(eq(services.orgId, orgId), inArray(services.id, serviceIds)));
        return (row?.found ?? 0) === serviceIds.length;
      }),

    isMember: async (orgId: string, userId: string) =>
      withTenant(db, orgId, async (tx) => {
        const [row] = await tx
          .execute<{ exists: boolean }>(
            sql`SELECT EXISTS (SELECT 1 FROM memberships WHERE org_id = ${orgId} AND user_id = ${userId}) AS exists`,
          )
          .then((result) => result.rows);
        return row?.exists ?? false;
      }),
  };
}

export type IncidentRepository = ReturnType<typeof createIncidentRepository>;
