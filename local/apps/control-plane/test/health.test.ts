import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

describe('GET /health', () => {
  it('reports control-plane readiness', async () => {
    const app = buildApp({ logger: false });
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ service: 'errandos-control-plane', status: 'ok' });
    await app.close();
  });
  it('fails readiness when PostgreSQL is unavailable', async () => {
    const app = buildApp({ logger: false, database: { ready: async () => false } });
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ service: 'errandos-control-plane', status: 'unavailable' });
    await app.close();
  });
});