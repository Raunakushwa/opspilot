import {
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, orgId, primaryId } from './columns.js';
import { users } from './identity.js';
import { incidents } from './incidents.js';

export const aiRunStatus = pgEnum('ai_run_status', ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED']);

export const proposalStatus = pgEnum('proposal_status', [
  'PROPOSED',
  'APPROVED',
  'REJECTED',
  'EXECUTED',
  'FAILED',
  'EXPIRED',
]);

/** One investigation. The structured result is stored whole for replay. */
export const aiRuns = pgTable(
  'ai_runs',
  {
    id: primaryId(),
    orgId: orgId(),
    incidentId: uuid('incident_id'),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    question: text().notNull(),
    status: aiRunStatus().notNull().default('QUEUED'),
    promptVersion: text('prompt_version'),
    result: jsonb().$type<Record<string, unknown>>(),
    confidence: doublePrecision(),
    error: text(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      columns: [table.orgId, table.incidentId],
      foreignColumns: [incidents.orgId, incidents.id],
      name: 'ai_runs_incident_fk',
    }).onDelete('cascade'),
    index('ai_runs_incident_idx').on(table.incidentId, table.createdAt.desc()),
    index('ai_runs_org_idx').on(table.orgId, table.createdAt.desc()),
  ],
);

/**
 * Per-call LLM telemetry. Cost is stored as an estimate computed from a
 * versioned price table: it is not a bill, and the column name says so.
 */
export const aiLlmCalls = pgTable(
  'ai_llm_calls',
  {
    id: primaryId(),
    orgId: orgId(),
    runId: uuid('run_id').notNull(),
    provider: text().notNull(),
    model: text().notNull(),
    promptVersion: text('prompt_version'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    estimatedCostUsd: numeric('estimated_cost_usd', { precision: 12, scale: 6 }),
    latencyMs: integer('latency_ms').notNull().default(0),
    createdAt: createdAt(),
  },
  (table) => [index('ai_llm_calls_run_idx').on(table.runId)],
);

/** The provenance ledger, persisted: what the agent actually read. */
export const aiToolCalls = pgTable(
  'ai_tool_calls',
  {
    id: primaryId(),
    orgId: orgId(),
    runId: uuid('run_id').notNull(),
    toolCallId: text('tool_call_id'),
    tool: text().notNull(),
    arguments: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    ok: text().notNull().default('true'),
    latencyMs: integer('latency_ms').notNull().default(0),
    error: text(),
    createdAt: createdAt(),
  },
  (table) => [index('ai_tool_calls_run_idx').on(table.runId)],
);

/**
 * A write the agent proposed and may not perform (ADR-007). Execution happens
 * in the API, as the approver, after the arguments are re-validated.
 */
export const aiActionProposals = pgTable(
  'ai_action_proposals',
  {
    id: primaryId(),
    orgId: orgId(),
    runId: uuid('run_id').notNull(),
    incidentId: uuid('incident_id'),
    actionType: text('action_type').notNull(),
    arguments: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    rationale: text().notNull(),
    evidenceIds: text('evidence_ids').array().notNull().default([]),
    status: proposalStatus().notNull().default('PROPOSED'),
    decidedBy: uuid('decided_by').references(() => users.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    executedAt: timestamp('executed_at', { withTimezone: true }),
    executionResult: jsonb().$type<Record<string, unknown>>(),
    // A stale proposal is a hazard: the system it describes has moved on.
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index('ai_proposals_status_idx').on(table.orgId, table.status, table.createdAt.desc()),
    index('ai_proposals_incident_idx').on(table.incidentId),
  ],
);
