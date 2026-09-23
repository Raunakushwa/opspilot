import { sql } from 'drizzle-orm';
import {
  bigserial,
  doublePrecision,
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

export const documentType = pgEnum('document_type', [
  'RUNBOOK',
  'POSTMORTEM',
  'ARCHITECTURE',
  'TROUBLESHOOTING',
  'GENERAL',
]);

export const documents = pgTable(
  'documents',
  {
    id: primaryId(),
    orgId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
    title: text().notNull(),
    type: documentType().notNull().default('GENERAL'),
    tags: text()
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    serviceId: uuid('service_id'),
    currentVersionId: uuid('current_version_id'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('documents_org_id_key').on(table.orgId, table.id),
    index('documents_org_type_idx').on(table.orgId, table.type, table.updatedAt.desc()),
    index('documents_tags_idx').using('gin', table.tags),
    foreignKey({
      columns: [table.orgId, table.serviceId],
      foreignColumns: [services.orgId, services.id],
      name: 'documents_service_fk',
    }).onDelete('set null'),
  ],
);

/**
 * Documents are versioned, and retrieval indexes a *version*. Re-indexing is
 * therefore idempotent, and a citation always points at the text that was
 * actually retrieved rather than at whatever the document says today.
 */
export const documentVersions = pgTable(
  'document_versions',
  {
    id: primaryId(),
    orgId: orgId(),
    documentId: uuid('document_id').notNull(),
    versionNo: integer('version_no').notNull(),
    title: text().notNull(),
    content: text().notNull(),
    contentHash: text('content_hash').notNull(),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
    ingestionStatus: text('ingestion_status').notNull().default('PENDING'),
    ingestionError: text('ingestion_error'),
    indexedAt: timestamp('indexed_at', { withTimezone: true }),
  },
  (table) => [
    unique('document_versions_doc_no_key').on(table.documentId, table.versionNo),
    unique('document_versions_org_id_key').on(table.orgId, table.id),
    foreignKey({
      columns: [table.orgId, table.documentId],
      foreignColumns: [documents.orgId, documents.id],
      name: 'document_versions_document_fk',
    }).onDelete('cascade'),
  ],
);

/** Chunk text lives here as well as in Qdrant, so the index is rebuildable. */
export const documentChunks = pgTable(
  'document_chunks',
  {
    id: primaryId(),
    orgId: orgId(),
    documentVersionId: uuid('document_version_id').notNull(),
    chunkIndex: integer('chunk_index').notNull(),
    headingPath: text('heading_path'),
    content: text().notNull(),
    tokenCount: integer('token_count').notNull().default(0),
    createdAt: createdAt(),
  },
  (table) => [
    unique('document_chunks_version_index_key').on(table.documentVersionId, table.chunkIndex),
    foreignKey({
      columns: [table.orgId, table.documentVersionId],
      foreignColumns: [documentVersions.orgId, documentVersions.id],
      name: 'document_chunks_version_fk',
    }).onDelete('cascade'),
  ],
);

/**
 * Deployment history. Seeded for the demo and read through an adapter, so a
 * real source (GitHub, Argo, Spinnaker) can replace it without touching the
 * agent (ADR-010).
 */
export const deployments = pgTable(
  'deployments',
  {
    id: primaryId(),
    orgId: orgId(),
    serviceId: uuid('service_id').notNull(),
    version: text().notNull(),
    commitSha: text('commit_sha'),
    status: text().notNull().default('SUCCEEDED'),
    changeSummary: text('change_summary'),
    deployedBy: text('deployed_by'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    unique('deployments_org_id_key').on(table.orgId, table.id),
    foreignKey({
      columns: [table.orgId, table.serviceId],
      foreignColumns: [services.orgId, services.id],
      name: 'deployments_service_fk',
    }).onDelete('cascade'),
    // "What changed before the failures started?"
    index('deployments_service_time_idx').on(table.orgId, table.serviceId, table.startedAt.desc()),
  ],
);

export const metricPoints = pgTable(
  'metric_points',
  {
    orgId: orgId(),
    serviceId: uuid('service_id').notNull(),
    metric: text().notNull(),
    ts: timestamp({ withTimezone: true }).notNull(),
    value: doublePrecision().notNull(),
    labels: jsonb().$type<Record<string, string>>().notNull().default({}),
  },
  (table) => [
    unique('metric_points_pkey').on(table.serviceId, table.metric, table.ts),
    foreignKey({
      columns: [table.orgId, table.serviceId],
      foreignColumns: [services.orgId, services.id],
      name: 'metric_points_service_fk',
    }).onDelete('cascade'),
  ],
);

export const logEntries = pgTable(
  'log_entries',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    orgId: orgId(),
    serviceId: uuid('service_id').notNull(),
    ts: timestamp({ withTimezone: true }).notNull(),
    level: text().notNull(),
    message: text().notNull(),
    attributes: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    traceId: text('trace_id'),
  },
  (table) => [
    foreignKey({
      columns: [table.orgId, table.serviceId],
      foreignColumns: [services.orgId, services.id],
      name: 'log_entries_service_fk',
    }).onDelete('cascade'),
    index('log_entries_service_time_idx').on(table.orgId, table.serviceId, table.ts.desc()),
    // BRIN is tiny on append-only time-ordered data, where a B-tree would not be.
    index('log_entries_ts_brin_idx').using('brin', table.ts),
  ],
);
