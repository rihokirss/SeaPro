import { afterEach, describe, expect, it, vi } from 'vitest';

const fetchJson = vi.hoisted(() => vi.fn());
vi.mock('../src/http.js', () => ({ fetchJson }));

import { cache } from '../src/cache.js';
import { fetchNavigationWarningsWithMeta } from '../src/navigation/arcgis.js';

const BBOX: [number, number, number, number] = [58.01, 25.01, 58.02, 25.02];
const KEY = 'nutimeri:warnings:v1:58,25,58.25,25.25';
const RETRY_KEY = 'nutimeri:warnings:retry:v1';

describe('Eesti navigatsioonihoiatuste päringusagedus', () => {
  afterEach(() => {
    vi.useRealTimers();
    fetchJson.mockReset();
    cache.delete(KEY);
    cache.delete(RETRY_KEY);
  });

  it('uuendab tunni järel ja peatab pärast 403 korduskatsed tunniks', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-03T09:00:00Z'));
    fetchJson.mockResolvedValue({ features: [] });

    await fetchNavigationWarningsWithMeta(BBOX);
    expect(fetchJson).toHaveBeenCalledTimes(3);

    vi.setSystemTime(new Date('2026-10-03T09:59:00Z'));
    await fetchNavigationWarningsWithMeta(BBOX);
    expect(fetchJson).toHaveBeenCalledTimes(3);

    vi.setSystemTime(new Date('2026-10-03T10:01:00Z'));
    fetchJson.mockRejectedValue(new Error('HTTP 403 Forbidden'));
    expect((await fetchNavigationWarningsWithMeta(BBOX)).stale).toBe(true);
    expect(fetchJson).toHaveBeenCalledTimes(6);

    vi.setSystemTime(new Date('2026-10-03T10:30:00Z'));
    expect((await fetchNavigationWarningsWithMeta(BBOX)).error).toContain('403');
    expect(fetchJson).toHaveBeenCalledTimes(6);
  });
});
