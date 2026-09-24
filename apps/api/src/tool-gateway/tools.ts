import { z } from 'zod';

import { type Permission } from '../platform/authorization.js';
import { type ToolRepository } from './repository.js';

/**
 * The agent's tool surface.
 *
 * Every tool is read-only. Writes are never exposed here: the agent proposes
 * actions and a human approves them (ADR-007), so a prompt injection can at
 * worst produce a proposal nobody accepts.
 *
 * Each tool declares the permission it needs, and the gateway checks it against
 * the *current* role of the user the run belongs to.
 */

export interface ToolContext {
  organizationId: string;
  repository: ToolRepository;
}

export interface ToolDefinition<TSchema extends z.ZodType> {
  name: string;
  description: string;
  permission: Permission;
  schema: TSchema;
  /** Short human-readable label shown in the UI while the tool runs. */
  progressLabel: string;
  execute: (args: z.infer<TSchema>, context: ToolContext) => Promise<unknown>;
}

function defineTool<TSchema extends z.ZodType>(
  tool: ToolDefinition<TSchema>,
): ToolDefinition<TSchema> {
  return tool;
}

const windowMinutes = z.coerce
  .number()
  .int()
  .min(1)
  .max(60 * 24 * 30)
  .default(180);
const limit = z.coerce.number().int().min(1).max(100).default(20);

const since = (minutes: number): Date => new Date(Date.now() - minutes * 60_000);

export const TOOLS = [
  defineTool({
    name: 'search_incidents',
    description:
      "Full-text search over this organization's incidents, past and present. Use it to find whether a similar failure has happened before.",
    permission: 'incident:read',
    progressLabel: 'Searching incident history',
    schema: z.object({ query: z.string().min(2).max(200), limit }),
    execute: (args, ctx) =>
      ctx.repository.searchIncidents(ctx.organizationId, args.query, args.limit),
  }),

  defineTool({
    name: 'get_incident',
    description: 'Fetch one incident with its affected services.',
    permission: 'incident:read',
    progressLabel: 'Reading the incident',
    schema: z.object({ incident_id: z.uuid() }),
    execute: async (args, ctx) => {
      const incident = await ctx.repository.getIncident(ctx.organizationId, args.incident_id);
      return incident ?? null;
    },
  }),

  defineTool({
    name: 'get_service',
    description: 'Fetch a service by slug, including its description and tier.',
    permission: 'service:read',
    progressLabel: 'Looking up the service',
    schema: z.object({ service: z.string().min(1).max(100) }),
    execute: async (args, ctx) => {
      const service = await ctx.repository.getService(ctx.organizationId, args.service);
      return service ?? null;
    },
  }),

  defineTool({
    name: 'get_deployments',
    description:
      'Recent deployments for a service, newest first. Use it to answer "what changed before this started?".',
    permission: 'service:read',
    progressLabel: 'Checking deployment history',
    schema: z.object({ service: z.string().min(1).max(100), window_minutes: windowMinutes, limit }),
    execute: (args, ctx) =>
      ctx.repository.getDeployments(
        ctx.organizationId,
        args.service,
        since(args.window_minutes),
        args.limit,
      ),
  }),

  defineTool({
    name: 'get_logs',
    description:
      'Log lines for a service in a time window, optionally filtered by level and a search term.',
    permission: 'service:read',
    progressLabel: 'Reading logs',
    schema: z.object({
      service: z.string().min(1).max(100),
      window_minutes: windowMinutes,
      levels: z.array(z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR'])).default(['ERROR', 'WARN']),
      query: z.string().max(200).optional(),
      limit,
    }),
    execute: (args, ctx) =>
      ctx.repository.getLogs(ctx.organizationId, args.service, {
        since: since(args.window_minutes),
        levels: args.levels,
        query: args.query,
        limit: args.limit,
      }),
  }),

  defineTool({
    name: 'get_log_patterns',
    description:
      'Error and warning messages for a service grouped by text, with counts and first/last seen. Cheaper and clearer than reading raw lines.',
    permission: 'service:read',
    progressLabel: 'Grouping error patterns',
    schema: z.object({ service: z.string().min(1).max(100), window_minutes: windowMinutes, limit }),
    execute: (args, ctx) =>
      ctx.repository.getLogPatterns(
        ctx.organizationId,
        args.service,
        since(args.window_minutes),
        args.limit,
      ),
  }),

  defineTool({
    name: 'get_metrics',
    description:
      'Time series for one metric of a service (error_rate, latency_p95_ms) over a window.',
    permission: 'service:read',
    progressLabel: 'Inspecting metrics',
    schema: z.object({
      service: z.string().min(1).max(100),
      metric: z.string().min(1).max(60).default('error_rate'),
      window_minutes: windowMinutes,
    }),
    execute: (args, ctx) =>
      ctx.repository.getMetrics(
        ctx.organizationId,
        args.service,
        args.metric,
        since(args.window_minutes),
      ),
  }),

  defineTool({
    name: 'get_previous_postmortems',
    description: 'List postmortem documents, optionally filtered by a title fragment.',
    permission: 'document:read',
    progressLabel: 'Looking for past postmortems',
    schema: z.object({ query: z.string().max(200).optional(), limit }),
    execute: (args, ctx) =>
      ctx.repository.getPostmortems(ctx.organizationId, args.query, args.limit),
  }),
] as const;

export const TOOLS_BY_NAME = new Map<string, ToolDefinition<z.ZodType>>(
  TOOLS.map((tool) => [tool.name, tool as unknown as ToolDefinition<z.ZodType>]),
);

/** The catalogue the agent is given; descriptions are the model's only guide. */
export function toolCatalogue(): { name: string; description: string; schema: unknown }[] {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    schema: z.toJSONSchema(tool.schema),
  }));
}
