import Fastify from 'fastify';
import { describe, it, expect, vi } from 'vitest';
vi.mock('../src/db/pool.js', () => ({
  database: {
    query: vi.fn().mockRejectedValue(new Error('offline')),
    connect: vi.fn().mockRejectedValue(new Error('offline')),
  },
  databaseStatus: { connected: false, error: null },
}));
import { registerHistoryApi } from '../src/ais/historyApi.js';
describe('history API', () => {
  it('validates MMSIs and bounded date ranges', async () => {
    const app = Fastify();
    await registerHistoryApi(app);
    for (const url of [
      '/api/ais/vessels?mmsi=0',
      '/api/ais/vessels?mmsi=1;DROP',
      '/api/ais/vessels?mmsi=' + Array(101).fill('1').join(','),
      '/api/ais/vessels/1/track?from=2026-01-01&to=2026-02-01',
      '/api/ais/vessels/1/track?from=no&to=no',
    ])
      expect((await app.inject(url)).statusCode).toBe(400);
    await app.close();
  });
  it('reports database failure instead of empty history', async () => {
    const app = Fastify();
    await registerHistoryApi(app);
    expect((await app.inject('/api/ais/vessels?mmsi=230000001')).statusCode).toBe(503);
    expect(
      (await app.inject('/api/ais/vessels/230000001/track?from=2026-01-01&to=2026-01-02')).statusCode,
    ).toBe(503);
    await app.close();
  });
});
