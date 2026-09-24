import { z } from 'zod';

import { type OpsPilotClient } from './client.js';

/**
 * Read-only tools exposed to a general-purpose agent.
 *
 * This is ADR-011 in practice: rather than competing with a general agent,
 * OpsPilot lets one ask it questions and get a permission-checked, cited
 * answer. Nothing here can change anything — writes stay behind the approval
 * flow in the product.
 */

export interface IncidentSummary {
  id: string;
  number: number;
  title: string;
  severity: string;
  status: string;
  createdAt: string;
}

export interface McpTool {
  name: string;
  title: string;
  description: string;
  schema: z.ZodRawShape;
  run: (args: Record<string, unknown>, client: OpsPilotClient) => Promise<string>;
}

const statusEnum = z.enum(['INVESTIGATING', 'IDENTIFIED', 'MITIGATING', 'RESOLVED', 'CLOSED']);

export const TOOLS: McpTool[] = [
  {
    name: 'list_incidents',
    title: 'List incidents',
    description:
      'List incidents in the configured OpsPilot organization, newest first. Optionally filter by status.',
    schema: { status: statusEnum.optional(), limit: z.number().int().min(1).max(50).optional() },
    run: async (args, client) => {
      const status = typeof args.status === 'string' ? `status=${args.status}&` : '';
      const limit = typeof args.limit === 'number' ? args.limit : 20;
      const result = await client.get<{ data: IncidentSummary[] }>(
        `/incidents?${status}limit=${String(limit)}`,
      );
      if (result.data.length === 0) return 'No incidents match that filter.';
      return result.data
        .map(
          (incident) =>
            `INC-${String(incident.number)} [${incident.severity}/${incident.status}] ${incident.title} (${incident.id})`,
        )
        .join('\n');
    },
  },
  {
    name: 'get_incident',
    title: 'Get incident detail',
    description:
      'Fetch one incident with its affected services and full timeline, including AI investigation events.',
    schema: { incident_id: z.string().min(1) },
    run: async (args, client) => {
      const id = String(args.incident_id);
      const incident = await client.get<{
        number: number;
        title: string;
        description: string | null;
        severity: string;
        status: string;
        services?: { slug: string }[];
      }>(`/incidents/${id}`);
      const timeline = await client.get<{
        data: { type: string; createdAt: string; actorType: string }[];
      }>(`/incidents/${id}/events`);

      const services = (incident.services ?? []).map((service) => service.slug).join(', ');
      const events = timeline.data
        .map((event) => `  ${event.createdAt} ${event.type} (${event.actorType})`)
        .join('\n');

      return [
        `INC-${String(incident.number)}: ${incident.title}`,
        `severity=${incident.severity} status=${incident.status} services=${services || 'none'}`,
        incident.description ?? '',
        '',
        'Timeline:',
        events || '  (no events)',
      ].join('\n');
    },
  },
  {
    name: 'get_investigation',
    title: 'Get AI investigation result',
    description:
      'Fetch the most recent AI investigation for an incident, including its summary, probable causes, cited sources and what it could not inspect.',
    schema: { incident_id: z.string().min(1) },
    run: async (args, client) => {
      const id = String(args.incident_id);
      const runs = await client.get<{ data: { id: string; status: string }[] }>(
        `/incidents/${id}/ai/runs`,
      );
      const latest = runs.data[0];
      if (!latest) return 'No AI investigation has been run for this incident.';

      const run = await client.get<{
        status: string;
        confidence: number | null;
        result: {
          summary: string;
          probable_causes: { description: string; confidence: number }[];
          citations: { label: string }[];
          not_inspected: string[];
        } | null;
      }>(`/ai/runs/${latest.id}`);

      if (!run.result) return `Investigation ${latest.id} is ${run.status.toLowerCase()}.`;

      const causes = run.result.probable_causes
        .map((cause) => `  - ${cause.description} (${String(Math.round(cause.confidence * 100))}%)`)
        .join('\n');
      const sources = run.result.citations.map((citation) => `  - ${citation.label}`).join('\n');

      return [
        `Confidence: ${String(Math.round((run.confidence ?? 0) * 100))}%`,
        run.result.summary,
        '',
        'Probable causes:',
        causes || '  (none)',
        '',
        'Sources actually consulted:',
        sources || '  (none)',
        '',
        // Carried across verbatim: the honesty is the point of the integration.
        `Not inspected: ${run.result.not_inspected.join(', ') || 'nothing omitted'}`,
      ].join('\n');
    },
  },
  {
    name: 'list_pending_approvals',
    title: 'List actions awaiting approval',
    description:
      'List AI-proposed actions that are waiting for a human decision. This server cannot approve them; approval happens in OpsPilot.',
    schema: {},
    run: async (_args, client) => {
      const result = await client.get<{
        data: { id: string; actionType: string; rationale: string; status: string }[];
      }>('/ai/proposals?status=PROPOSED');
      if (result.data.length === 0) return 'No actions are awaiting approval.';
      return result.data
        .map((proposal) => `${proposal.actionType}: ${proposal.rationale} (${proposal.id})`)
        .join('\n');
    },
  },
];
