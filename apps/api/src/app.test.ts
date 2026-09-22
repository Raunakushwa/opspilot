import { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { AppError, type ProblemDetails } from './platform/errors.js';
import { type DependencyCheck } from './platform/health.js';

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://localhost:5432/opspilot',
  REDIS_URL: 'redis://localhost:6379',
  CORS_ORIGINS: 'http://localhost:3000',
  READINESS_TIMEOUT_MS: '50',
});

const healthy = (name: string): DependencyCheck => ({ name, check: () => Promise.resolve() });
const failing = (name: string): DependencyCheck => ({
  name,
  check: () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.5:5432')),
});
const hanging = (name: string): DependencyCheck => ({
  name,
  check: () => new Promise<void>(() => undefined),
});

let app: FastifyInstance | undefined;

async function createApp(checks: DependencyCheck[] = []): Promise<FastifyInstance> {
  app = await buildApp({ config, checks });
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('health endpoints', () => {
  it('reports liveness without consulting dependencies', async () => {
    const server = await createApp([failing('postgres')]);

    const response = await server.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('is ready when every dependency responds', async () => {
    const server = await createApp([healthy('postgres'), healthy('redis')]);

    const response = await server.inject({ method: 'GET', url: '/readyz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      checks: { postgres: { status: 'ok' }, redis: { status: 'ok' } },
    });
  });

  it('is not ready when a dependency fails, without leaking failure details', async () => {
    const server = await createApp([healthy('postgres'), failing('redis')]);

    const response = await server.inject({ method: 'GET', url: '/readyz' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'unavailable',
      checks: { postgres: { status: 'ok' }, redis: { status: 'unavailable' } },
    });
    expect(response.body).not.toContain('ECONNREFUSED');
  });

  it('fails a dependency that exceeds the readiness timeout', async () => {
    const server = await createApp([hanging('postgres')]);

    const response = await server.inject({ method: 'GET', url: '/readyz' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ checks: { postgres: { status: 'unavailable' } } });
  });
});

describe('request IDs', () => {
  it('generates a request ID and returns it in a header', async () => {
    const server = await createApp();

    const response = await server.inject({ method: 'GET', url: '/healthz' });

    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('propagates a well-formed caller request ID', async () => {
    const server = await createApp();

    const response = await server.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-request-id': 'lb-7f3a.91' },
    });

    expect(response.headers['x-request-id']).toBe('lb-7f3a.91');
  });

  it('replaces a malformed caller request ID', async () => {
    const server = await createApp();

    const response = await server.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-request-id': 'bad id\twith "injection"' },
    });

    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('error responses', () => {
  const problem = (body: string) => JSON.parse(body) as ProblemDetails;

  it('returns problem+json for unknown routes', async () => {
    const server = await createApp();

    const response = await server.inject({ method: 'GET', url: '/nope' });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(problem(response.body)).toMatchObject({
      status: 404,
      code: 'not_found',
      requestId: response.headers['x-request-id'],
    });
  });

  it('maps AppError to its status and code', async () => {
    const server = await createApp();
    server.get('/conflict', () => {
      throw new AppError(409, 'incident_version_conflict', 'Incident was modified', 'Reload');
    });

    const response = await server.inject({ method: 'GET', url: '/conflict' });

    expect(response.statusCode).toBe(409);
    expect(problem(response.body)).toMatchObject({
      code: 'incident_version_conflict',
      title: 'Incident was modified',
      detail: 'Reload',
    });
  });

  it('lists validation failures with property paths', async () => {
    const server = await createApp();
    server.post(
      '/things',
      {
        schema: {
          body: {
            type: 'object',
            required: ['title'],
            properties: { title: { type: 'string' }, severity: { type: 'integer' } },
          },
        },
      },
      () => ({ ok: true }),
    );

    const response = await server.inject({
      method: 'POST',
      url: '/things',
      payload: { severity: 1 },
    });

    expect(response.statusCode).toBe(400);
    expect(problem(response.body)).toMatchObject({
      code: 'validation_failed',
      errors: [{ path: '/title' }],
    });
  });

  it('rejects malformed JSON as a client error', async () => {
    const server = await createApp();
    server.post('/things', () => ({ ok: true }));

    const response = await server.inject({
      method: 'POST',
      url: '/things',
      headers: { 'content-type': 'application/json' },
      payload: '{"title":',
    });

    expect(response.statusCode).toBe(400);
    expect(problem(response.body).status).toBe(400);
  });

  it('hides internal error details behind a generic 500', async () => {
    const server = await createApp();
    server.get('/boom', () => {
      throw new Error('password authentication failed for user "opspilot_app"');
    });

    const response = await server.inject({ method: 'GET', url: '/boom' });

    expect(response.statusCode).toBe(500);
    expect(problem(response.body)).toMatchObject({ code: 'internal_error' });
    expect(response.body).not.toContain('opspilot_app');
  });
});

describe('security headers and CORS', () => {
  it('sets hardening headers', async () => {
    const server = await createApp();

    const response = await server.inject({ method: 'GET', url: '/healthz' });

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('allows credentialed requests from configured origins', async () => {
    const server = await createApp();

    const response = await server.inject({
      method: 'OPTIONS',
      url: '/healthz',
      headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'GET' },
    });

    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('does not grant CORS to other origins', async () => {
    const server = await createApp();

    const response = await server.inject({
      method: 'GET',
      url: '/healthz',
      headers: { origin: 'https://evil.example' },
    });

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('product status endpoint', () => {
  it('serves the readiness report under /api/status for the browser', async () => {
    const server = await createApp([healthy('postgres'), failing('redis')]);

    const response = await server.inject({ method: 'GET', url: '/api/status' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'unavailable',
      checks: { postgres: { status: 'ok' }, redis: { status: 'unavailable' } },
    });
  });
});
