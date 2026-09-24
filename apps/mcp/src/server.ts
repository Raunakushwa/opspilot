#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createOpsPilotClient, OpsPilotError } from './client.js';
import { TOOLS } from './tools.js';

/**
 * OpsPilot as an MCP server.
 *
 * The point of this (ADR-011): a general-purpose agent is good at
 * investigating, but has no notion of an organization's incident history,
 * permissions or audit trail. This lets it ask OpsPilot, and get an answer
 * that is scoped to a real user's access and carries its citations.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    process.stderr.write(`${name} is required\n`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const client = createOpsPilotClient({
    baseUrl: process.env.OPSPILOT_URL ?? 'http://localhost:4000',
    email: requireEnv('OPSPILOT_EMAIL'),
    password: requireEnv('OPSPILOT_PASSWORD'),
    organizationSlug: process.env.OPSPILOT_ORG,
  });

  const server = new McpServer({ name: 'opspilot', version: '0.1.0' });

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.schema },
      async (args: Record<string, unknown>) => {
        try {
          return { content: [{ type: 'text' as const, text: await tool.run(args, client) }] };
        } catch (err) {
          // Errors are returned as content, not thrown: an agent should see
          // "you may not read the audit log" and move on, not crash.
          const message =
            err instanceof OpsPilotError
              ? `OpsPilot refused: ${err.message}`
              : 'OpsPilot request failed';
          return { content: [{ type: 'text' as const, text: message }], isError: true };
        }
      },
    );
  }

  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
