import { afterEach, expect, it, vi } from 'vitest';
import { cache } from '../src/cache.js';
import { config } from '../src/config.js';
import { OpenMeteoProvider } from '../src/providers/openMeteo.js';
import { HttpError } from '../src/http.js';

const now = Date.parse('2026-09-18T12:00:00Z');
const value = { latitude: 59, longitude: 24, hourly: { time: ['2026-09-18T12:00'], wind_speed_10m: [5] } };
const originalTtl = config.ttl.openMeteo;
afterEach(() => { vi.restoreAllMocks(); config.ttl.openMeteo = originalTtl; });

it('reports the oldest tile age and the configured freshness deadline', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  config.ttl.openMeteo = 10800;
  let calls = 0;
  vi.spyOn(cache, 'get').mockImplementation(async () => ({
    value: value as never, cacheOutcome: 'fresh', stale: false,
    ageSeconds: ++calls === 1 ? 3600 : 600,
  }));
  const result = await new OpenMeteoProvider().gridDay({ bbox: [59, 24, 60, 26], steps: 20, variables: ['wind_speed'], time: new Date(now).toISOString() });
  expect(calls).toBeGreaterThan(1);
  expect(result.freshness).toEqual({ fetchedAt: '2026-09-18T11:00:00.000Z', expiresAt: '2026-09-18T14:00:00.000Z', stale: false, partial: false });
});

it('distinguishes missing tiles from successfully returned stale fallback tiles', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  let calls = 0;
  vi.spyOn(cache, 'get').mockImplementation(async () => {
    const error = new HttpError('offline', 503, 'https://example.test');
    if (++calls === 1) throw error;
    return { value: value as never, cacheOutcome: 'stale', stale: true, ageSeconds: 14400, fallbackError: error };
  });
  const result = await new OpenMeteoProvider().gridDay({ bbox: [59, 24, 60, 26], steps: 20, variables: ['wind_speed'], time: new Date(now).toISOString() });
  expect(result.frames[0]?.points.length).toBeGreaterThan(0);
  expect(result.freshness).toMatchObject({ stale: true, partial: true });
  expect(result.warning).toEqual({ kind: 'error' });
});
