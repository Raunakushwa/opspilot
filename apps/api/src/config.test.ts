import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './config.js';

const validEnv = {
  DATABASE_URL: 'postgres://app:s3cret-password@localhost:5432/opspilot',
  REDIS_URL: 'redis://localhost:6379',
};

describe('loadConfig', () => {
  it('applies defaults for optional settings', () => {
    const config = loadConfig(validEnv);

    expect(config).toMatchObject({
      NODE_ENV: 'development',
      API_PORT: 4000,
      TRUST_PROXY: false,
      CORS_ORIGINS: ['http://localhost:3000'],
    });
  });

  it('coerces numeric and list settings from strings', () => {
    const config = loadConfig({
      ...validEnv,
      API_PORT: '8080',
      CORS_ORIGINS: 'https://app.example.com, https://admin.example.com ,',
    });

    expect(config.API_PORT).toBe(8080);
    expect(config.CORS_ORIGINS).toEqual(['https://app.example.com', 'https://admin.example.com']);
  });

  it.each([
    ['true', true],
    ['1', true],
    ['false', false],
    ['0', false],
  ])('parses TRUST_PROXY=%s as %s', (raw, expected) => {
    expect(loadConfig({ ...validEnv, TRUST_PROXY: raw }).TRUST_PROXY).toBe(expected);
  });

  it('rejects ambiguous booleans instead of guessing', () => {
    expect(() => loadConfig({ ...validEnv, TRUST_PROXY: 'yes' })).toThrow(ConfigError);
  });

  it('reports every invalid variable at once', () => {
    const attempt = () => loadConfig({ API_PORT: '99999' });

    expect(attempt).toThrow(ConfigError);
    try {
      attempt();
    } catch (err) {
      const paths = (err as ConfigError).issues.map((issue) => issue.split(':')[0]);
      expect(paths).toEqual(expect.arrayContaining(['API_PORT', 'DATABASE_URL', 'REDIS_URL']));
    }
  });

  it('rejects connection URLs with the wrong scheme', () => {
    expect(() => loadConfig({ ...validEnv, DATABASE_URL: 'mysql://localhost/db' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('never echoes variable values in error messages', () => {
    const secret = 'hunter2-super-secret';

    expect(() =>
      loadConfig({ ...validEnv, DATABASE_URL: `not a url ${secret}`, REDIS_URL: secret }),
    ).toThrow(expect.objectContaining({ message: expect.not.stringContaining(secret) as string }));
  });
});
