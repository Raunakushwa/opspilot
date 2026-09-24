import { type Database, withTenant } from '@opspilot/database';
import { memberships } from '@opspilot/database/schema';
import { and, eq } from 'drizzle-orm';
import Fastify, { type FastifyServerOptions } from 'fastify';
import { v7 as uuidv7 } from 'uuid';

import { can } from '../platform/authorization.js';
import { registerErrorHandlers } from '../platform/errors.js';
import { AppError } from '../platform/errors.js';
import { DelegationError, verifyDelegationToken } from './delegation.js';
import { createToolRepository } from './repository.js';
import { toolCatalogue, TOOLS_BY_NAME } from './tools.js';

export interface ToolGatewayOptions {
  db: Database;
  secret: string;
  logger?: FastifyServerOptions['logger'];
}

export interface ToolCallResult {
  toolCallId: string;
  tool: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  latencyMs: number;
}

/**
 * The agent's only door to tenant data.
 *
 * It listens on a separate internal port that is never routed publicly, and it
 * re-derives authorization on every call rather than trusting the token: the
 * token proves *which* run and user, the database decides what they may read.
 */
export function buildToolGateway({ db, secret, logger }: ToolGatewayOptions) {
  const repository = createToolRepository(db);
  const app = Fastify({ logger: logger ?? false, genReqId: () => uuidv7() });

  registerErrorHandlers(app);

  app.get('/internal/tools', async (_request, reply) => reply.send({ tools: toolCatalogue() }));

  app.post('/internal/tools/:tool', async (request, reply) => {
    const started = performance.now();
    const { tool: toolName } = request.params as { tool: string };

    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new AppError(401, 'unauthenticated', 'Delegation token required');
    }

    let claims;
    try {
      claims = await verifyDelegationToken(header.slice('Bearer '.length), secret);
    } catch (err) {
      // An expired or forged token is indistinguishable to the caller.
      throw new AppError(
        401,
        'invalid_delegation',
        err instanceof DelegationError ? 'Invalid delegation token' : 'Invalid delegation token',
      );
    }

    const tool = TOOLS_BY_NAME.get(toolName);
    if (!tool) {
      throw new AppError(404, 'unknown_tool', `No tool named "${toolName}"`);
    }

    // Membership is re-read per call: a role revoked mid-investigation takes
    // effect immediately, which a claim baked into the token could not do.
    const [membership] = await withTenant(db, claims.organizationId, (tx) =>
      tx
        .select({ role: memberships.role })
        .from(memberships)
        .where(
          and(eq(memberships.orgId, claims.organizationId), eq(memberships.userId, claims.userId)),
        )
        .limit(1),
    );

    if (!membership) {
      throw new AppError(403, 'forbidden', 'The delegating user is no longer a member');
    }
    if (!can(membership.role, tool.permission)) {
      throw new AppError(403, 'forbidden', `Role ${membership.role} cannot use ${tool.name}`);
    }

    const parsed = tool.schema.safeParse(
      (request.body as { args?: unknown } | undefined)?.args ?? {},
    );
    if (!parsed.success) {
      // Arguments come from a language model: validate, never coerce silently.
      throw new AppError(
        400,
        'invalid_tool_arguments',
        parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
      );
    }

    const toolCallId = uuidv7();
    try {
      const result = await tool.execute(parsed.data, {
        organizationId: claims.organizationId,
        repository,
      });
      const payload: ToolCallResult = {
        toolCallId,
        tool: tool.name,
        ok: true,
        result,
        latencyMs: Math.round(performance.now() - started),
      };
      request.log.info(
        { tool: tool.name, runId: claims.runId, toolCallId, latencyMs: payload.latencyMs },
        'tool call',
      );
      return await reply.send(payload);
    } catch (err) {
      request.log.error({ err, tool: tool.name, runId: claims.runId }, 'tool call failed');
      const payload: ToolCallResult = {
        toolCallId,
        tool: tool.name,
        ok: false,
        error: 'Tool execution failed',
        latencyMs: Math.round(performance.now() - started),
      };
      return reply.status(500).send(payload);
    }
  });

  return app;
}
