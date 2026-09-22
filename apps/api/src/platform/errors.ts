import { STATUS_CODES } from 'node:http';

import {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';

/**
 * RFC 9457 problem details. `code` is a stable machine-readable identifier that
 * clients branch on; `title`/`detail` are for humans and may change.
 */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  requestId: string;
  errors?: { path: string; message: string }[];
}

const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** An error that is safe to expose to clients as-is. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

function problemType(code: string): string {
  return `https://opspilot.dev/problems/${code}`;
}

function sendProblem(
  reply: FastifyReply,
  request: FastifyRequest,
  problem: Omit<ProblemDetails, 'type' | 'requestId'>,
): FastifyReply {
  const body: ProblemDetails = {
    type: problemType(problem.code),
    requestId: request.id,
    ...problem,
  };
  return reply.status(problem.status).type(PROBLEM_CONTENT_TYPE).send(body);
}

export function registerErrorHandlers(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) =>
    sendProblem(reply, request, {
      status: 404,
      code: 'not_found',
      title: 'Not Found',
      detail: `Route ${request.method} ${request.url} does not exist`,
    }),
  );

  app.setErrorHandler((error: FastifyError | AppError, request, reply) => {
    if (error instanceof AppError) {
      return sendProblem(reply, request, {
        status: error.status,
        code: error.code,
        title: error.message,
        ...(error.detail === undefined ? {} : { detail: error.detail }),
      });
    }

    if (error.validation) {
      return sendProblem(reply, request, {
        status: 400,
        code: 'validation_failed',
        title: 'Request validation failed',
        errors: error.validation.map((issue) => {
          // A missing required property is reported on its parent, so point at the property itself.
          const missing = issue.params.missingProperty;
          const path =
            typeof missing === 'string' ? `${issue.instancePath}/${missing}` : issue.instancePath;
          return { path, message: issue.message ?? 'is invalid' };
        }),
      });
    }

    // Framework-level client errors (malformed JSON, payload too large, …)
    // carry a 4xx status and a message that is safe to show.
    // Plain errors thrown with a `statusCode` have no `code`, despite the type.
    const status = error.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      const code: unknown = error.code;
      return sendProblem(reply, request, {
        status,
        code: typeof code === 'string' ? code.toLowerCase() : 'client_error',
        title: STATUS_CODES[status] ?? 'Client Error',
        detail: error.message,
      });
    }

    // Anything else is a bug or an infrastructure failure: log everything,
    // expose nothing but the request ID for correlation.
    request.log.error({ err: error }, 'unhandled error');
    return sendProblem(reply, request, {
      status: 500,
      code: 'internal_error',
      title: 'Internal Server Error',
    });
  });
}
