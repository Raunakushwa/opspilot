import { describe, expect, it, vi } from 'vitest';

import { type OpsPilotClient } from './client.js';
import { TOOLS } from './tools.js';

function tool(name: string) {
  const found = TOOLS.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

function client(responses: Record<string, unknown>): OpsPilotClient {
  return {
    resolveOrganization: vi.fn().mockResolvedValue('org-1'),
    get: vi.fn((path: string) => {
      const match = Object.entries(responses).find(([prefix]) => path.startsWith(prefix));
      return Promise.resolve(match?.[1] ?? { data: [] });
    }),
  } as unknown as OpsPilotClient;
}

describe('exposed tools', () => {
  it('offers only read operations', () => {
    // The whole point: an agent reaching OpsPilot through MCP cannot change it.
    const names = TOOLS.map((candidate) => candidate.name);

    expect(names).toEqual([
      'list_incidents',
      'get_incident',
      'get_investigation',
      'list_pending_approvals',
    ]);
    expect(names.some((name) => /create|update|delete|approve|rollback/.test(name))).toBe(false);
  });

  it('describes each tool well enough for a model to choose it', () => {
    for (const candidate of TOOLS) {
      expect(candidate.description.length).toBeGreaterThan(40);
      expect(candidate.title).toBeTruthy();
    }
  });
});

describe('list_incidents', () => {
  it('renders incidents compactly with their identifiers', async () => {
    const text = await tool('list_incidents').run(
      { status: 'INVESTIGATING' },
      client({
        '/incidents': {
          data: [
            {
              id: 'abc',
              number: 21,
              title: 'payment-service 5xx',
              severity: 'SEV1',
              status: 'INVESTIGATING',
              createdAt: '2026-09-24T09:00:00Z',
            },
          ],
        },
      }),
    );

    expect(text).toContain('INC-21');
    expect(text).toContain('[SEV1/INVESTIGATING]');
    expect(text).toContain('abc');
  });

  it('says so plainly when nothing matches', async () => {
    const text = await tool('list_incidents').run({}, client({ '/incidents': { data: [] } }));

    expect(text).toBe('No incidents match that filter.');
  });
});

describe('get_investigation', () => {
  it('carries the citations and the not-inspected list across verbatim', async () => {
    const text = await tool('get_investigation').run(
      { incident_id: 'abc' },
      client({
        '/incidents/abc/ai/runs': { data: [{ id: 'run-1', status: 'COMPLETED' }] },
        '/ai/runs/run-1': {
          status: 'COMPLETED',
          confidence: 0.82,
          result: {
            summary: 'A deploy reduced the connection pool.',
            probable_causes: [{ description: 'Pool too small', confidence: 0.82 }],
            citations: [{ label: 'Runbook: rolling back payment-service' }],
            not_inspected: ['get_metrics (failed)'],
          },
        },
      }),
    );

    expect(text).toContain('82%');
    expect(text).toContain('Runbook: rolling back payment-service');
    // The honesty must survive the integration, not be summarised away.
    expect(text).toContain('Not inspected: get_metrics (failed)');
  });

  it('reports when no investigation has been run', async () => {
    const text = await tool('get_investigation').run(
      { incident_id: 'abc' },
      client({ '/incidents/abc/ai/runs': { data: [] } }),
    );

    expect(text).toContain('No AI investigation');
  });
});

describe('list_pending_approvals', () => {
  it('states that approval happens in OpsPilot, not here', () => {
    expect(tool('list_pending_approvals').description).toContain('cannot approve');
  });

  it('lists proposals awaiting a decision', async () => {
    const text = await tool('list_pending_approvals').run(
      {},
      client({
        '/ai/proposals': {
          data: [
            {
              id: 'p1',
              actionType: 'ROLLBACK_DEPLOYMENT',
              rationale: 'The deploy correlates with onset.',
              status: 'PROPOSED',
            },
          ],
        },
      }),
    );

    expect(text).toContain('ROLLBACK_DEPLOYMENT');
    expect(text).toContain('p1');
  });
});
