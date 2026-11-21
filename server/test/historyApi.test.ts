import Fastify from 'fastify';
import { describe, it, expect, vi } from 'vitest';
vi.mock('../src/db/pool.js', () => ({
  database: {
    query: vi.fn().mockRejectedValue(new Error('offline')),
    connect: vi.fn().mockRejectedValue(new Error('offline')),
  },
  databaseStatus: { connected: false, error: null },
}));
import { database } from '../src/db/pool.js';
import { vessels } from '../src/ais/registry.js';
import { registerHistoryApi } from '../src/ais/historyApi.js';
describe('history API', () => {
  it('validates MMSIs and bounded date ranges', async () => {
    const app = Fastify();
    await registerHistoryApi(app);
    for (const url of [
      '/api/ais/traffic-density?days=999&bbox=58,24,60,26',
      '/api/ais/traffic-density?days=7&bbox=58,24,60,NaN',
      '/api/ais/traffic-density?days=1&bbox=60,24,58,26',
      '/api/ais/vessels/search?q=x',
      '/api/ais/vessels/search?q=' + 'a'.repeat(101),
      '/api/ais/vessels?mmsi=0',
      '/api/ais/vessels?mmsi=1;DROP',
      '/api/ais/vessels?mmsi=' + Array(101).fill('1').join(','),
      '/api/ais/vessels/1/track?from=2026-01-01&to=2026-02-01',
      '/api/ais/vessels/1/track?from=no&to=no',
    ])
      expect((await app.inject(url)).statusCode).toBe(400);
    await app.close();
  });
  it('combines live and stored name matches, keeping the newest report for each MMSI', async () => {
    const app = Fastify();
    await registerHistoryApi(app);
    const ship = { mmsi: 999000123, name: 'Test Ferry', source: 'digitraffic' as const,
      lat: 59, lon: 24, timestamp: new Date().toISOString() };
    const old = { ...ship, timestamp: new Date(Date.now() - 86400000).toISOString() };
    vessels.upsertPosition(ship);
    vi.mocked(database.query).mockResolvedValueOnce({ rows: [
      { data: old }, { data: { ...old, mmsi: 999000124, name: 'Test Ferry II' } },
      { data: { ...old, mmsi: 999000125, name: 'Test Ferry III', shipType: 35 } },
    ] } as never);
    const response = (await app.inject('/api/ais/vessels/search?q=tEsT%20fErRy')).json();
    expect(response.historyAvailable).toBe(true);
    expect(response.results).toEqual([
      { kind: 'vessel', name: ship.name, vessel: { ...ship, stale: false } },
      { kind: 'vessel', name: 'Test Ferry II', vessel: { ...old, name: 'Test Ferry II', mmsi: 999000124, stale: true } },
      { kind: 'vessel', name: 'Test Ferry III', vessel: { ...old, name: 'Test Ferry III', mmsi: 999000125, shipType: 35, stale: true } },
    ]);
    const offline = (await app.inject('/api/ais/vessels/search?q=test%20ferry')).json();
    expect(offline.historyAvailable).toBe(false);
    expect(offline.results).toHaveLength(1);
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
