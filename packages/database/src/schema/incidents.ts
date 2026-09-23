import { relations, sql } from 'drizzle-orm';
import {
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, orgId, primaryId, updatedAt } from './columns.js';
import { organizations, users } from './identity.js';
import { services } from './org.js';

export const incidentSeverity = pgEnum('incident_severity', ['SEV1', 'SEV2', 'SEV3', 'SEV4']);
export const incidentStatus = pgEnum('incident_status', [
  'INVESTIGATING',
  'IDENTIFIED',
  'MITIGATING',
  'RESOLVED',
  'CLOSED',
]);
export const actorType = pgEnum('actor_type', ['USER', 'AI', 'SYSTEM']);

/**
 * Per-organization incident numbering (INC-142). A counter row is updated with
 * `UPDATE ... RETURNING` inside the creating transaction, which takes a row
 * lock — `max(number) + 1` would race under concurrent creation.
 */
export const incidentCounters = pgTable('incident_counters', {
  orgId: uuid('org_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  nextNumber: integer('next_number').notNull().default(1),
});

export const incidents = pgTable(
  'incidents',
  {
    id: primaryId(),
    orgId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
    number: integer().notNull(),
    title: text().notNull(),
    description: text(),
    severity: incidentSeverity().notNull().default('SEV3'),
    status: incidentStatus().notNull().default('INVESTIGATING'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    assignedTo: uuid('assigned_to').references(() => users.id),
    /** Optimistic concurrency: a stale PATCH is rejected rather than merged. */
    version: integer().notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (table) => [
    unique('incidents_org_number_key').on(table.orgId, table.number),
    unique('incidents_org_id_key').on(table.orgId, table.id),
    // The incident list, filtered by status — the most frequent query.
    index('incidents_org_status_idx').on(table.orgId, table.status, table.createdAt.desc()),
    index('incidents_org_severity_idx').on(table.orgId, table.severity, table.createdAt.desc()),
    // "My open incidents": partial, so the index stays small as history grows.
    index('incidents_assigned_open_idx')
      .on(table.orgId, table.assignedTo)
      .where(sql`status NOT IN ('RESOLVED', 'CLOSED')`),
  ],
);

/** Which services an incident affects. */
export const incidentServices = pgTable(
  'incident_services',
  {
    orgId: orgId(),
    incidentId: uuid('incident_id').notNull(),
    serviceId: uuid('service_id').notNull(),
  },
  (table) => [
    unique('incident_services_pkey').on(table.incidentId, table.serviceId),
    foreignKey({
      columns: [table.orgId, table.incidentId],
      foreignColumns: [incidents.orgId, incidents.id],
      name: 'incident_services_incident_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.orgId, table.serviceId],
      foreignColumns: [services.orgId, services.id],
      name: 'incident_services_service_fk',
    }).onDelete('cascade'),
    index('incident_services_service_idx').on(table.serviceId),
  ],
);

/**
 * The timeline. Append-only by convention and by API: every meaningful change
 * writes an event in the same transaction as the change itself, so the story of
 * an incident cannot drift from its state.
 */
export const incidentEvents = pgTable(
  'incident_events',
  {
    id: primaryId(),
    orgId: orgId(),
    incidentId: uuid('incident_id').notNull(),
    actorType: actorType('actor_type').notNull().default('USER'),
    actorId: uuid('actor_id').references(() => users.id),
    type: text().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      columns: [table.orgId, table.incidentId],
      foreignColumns: [incidents.orgId, incidents.id],
      name: 'incident_events_incident_fk',
    }).onDelete('cascade'),
    index('incident_events_incident_idx').on(table.incidentId, table.createdAt),
  ],
);

/**
 * Immutable audit trail. The application role holds INSERT and SELECT only, and
 * a trigger rejects UPDATE and DELETE, so history cannot be rewritten by the
 * application even if a bug tried.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: primaryId(),
    orgId: orgId(),
    actorType: actorType('actor_type').notNull().default('USER'),
    actorId: uuid('actor_id'),
    action: text().notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id'),
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    requestId: text('request_id'),
    ip: text(),
    createdAt: createdAt(),
  },
  (table) => [index('audit_logs_org_created_idx').on(table.orgId, table.createdAt.desc())],
);

/**
 * Transactional outbox (ADR-002). Written in the same transaction as the state
 * change; a relay publishes it to Redis and the queues afterwards, so an event
 * cannot be lost between commit and publish.
 */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: primaryId(),
    orgId: orgId(),
    topic: text().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (table) => [
    // The relay scans only unpublished rows; partial keeps it small.
    index('outbox_unpublished_idx')
      .on(table.createdAt)
      .where(sql`published_at IS NULL`),
  ],
);

export const incidentsRelations = relations(incidents, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [incidents.orgId],
    references: [organizations.id],
  }),
  events: many(incidentEvents),
  services: many(incidentServices),
}));
