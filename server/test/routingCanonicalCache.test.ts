import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cacheGet: vi.fn(),
  cachePeek: vi.fn(),
  fetchJson: vi.fn(),
}));

vi.mock('../src/cache.js', () => ({
  cache: { get: mocks.cacheGet, peek: mocks.cachePeek },
}));

vi.mock('../src/http.js', () => ({
  fetchJson: mocks.fetchJson,
}));

import { loadOsmRoutingData } from '../src/routing/sources/osm.js';
import { fetchTrafficSchemesSnapshot } from '../src/navigation/osmTraffic.js';
import { loadEstonianRoutingData } from '../src/routing/sources/estonia.js';
import { loadFinnishRoutingData } from '../src/routing/sources/finland.js';

const EMPTY_ESTONIA = {
  aids: { features: [] }, obstructions: { features: [] }, rocks: { features: [] },
  wrecks: { features: [] }, fairways: { features: [] }, surveys: { features: [] },
  harbours: { features: [] },
};
const EMPTY_FINNISH_STATIC = {
  fairwayAreas: { features: [] }, navigationLines: { features: [] },
  restrictions: { features: [] }, structures: { features: [] },
  bridges: { features: [] }, aids: { features: [] },
};
const EMPTY_FINNISH_FAULTS = {
  faultsCommercial: { features: [] }, faultsShallow: { features: [] },
};

describe('routingu kanooniliste paanide taaskasutus', () => {
  beforeEach(() => {
    mocks.cacheGet.mockReset();
    mocks.cachePeek.mockReset();
    mocks.fetchJson.mockReset();
    mocks.cachePeek.mockReturnValue({ stale: false });
    mocks.cacheGet.mockImplementation(async (keyValue: string) => ({
      value: keyValue.startsWith('routing:transpordiamet-his:')
        ? EMPTY_ESTONIA
        : keyValue.startsWith('routing:vaylavirasto-wfs:static:')
          ? EMPTY_FINNISH_STATIC
          : keyValue.startsWith('routing:vaylavirasto-wfs:faults:')
            ? EMPTY_FINNISH_FAULTS
            : { elements: [] },
      cacheOutcome: 'fresh',
      stale: false,
      ageSeconds: 10,
    }));
  });

  it('koostab üle 16 paani ulatuva OSM-kihi eellaaditud 1° paanidest', async () => {
    const result = await loadOsmRoutingData([59.1, 20.1, 61.1, 28.1]);
    const keys = mocks.cacheGet.mock.calls.map(([key]) => String(key));

    expect(keys).toHaveLength(27);
    expect(mocks.cacheGet.mock.calls.every(([, ttl]) => ttl === 7 * 24 * 3600)).toBe(true);
    expect(keys).toContain('routing:openstreetmap-overpass:v3:59,20,60,21');
    expect(keys).toContain('routing:openstreetmap-overpass:v3:61,28,62,29');
    expect(keys.every((key) => {
      const coordinates = key.split(':').at(-1)!.split(',').map(Number);
      return coordinates[2]! - coordinates[0]! === 1
        && coordinates[3]! - coordinates[1]! === 1;
    })).toBe(true);
    expect(mocks.fetchJson).not.toHaveBeenCalled();
    expect(result.source).toMatchObject({
      status: 'ok',
      coverage: 'complete',
      tilesRequested: 27,
      tilesLoaded: 27,
    });
  });

  it('loeb kaardi liiklusskeemid samast kanoonilisest OSM routing-cache’ist', async () => {
    const result = await fetchTrafficSchemesSnapshot([59.2, 24.2, 59.4, 24.4]);

    expect(mocks.cacheGet).toHaveBeenCalledOnce();
    expect(mocks.cacheGet.mock.calls[0]?.[0])
      .toBe('routing:openstreetmap-overpass:v3:59,24,60,25');
    expect(mocks.cacheGet.mock.calls[0]?.[1]).toBe(7 * 24 * 3600);
    expect(mocks.fetchJson).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      trafficSchemes: [],
      ageSeconds: 10,
      stale: false,
    });
  });

  it('säilitab osalise 1° katte korral senise adaptiivse fallback’i', async () => {
    mocks.cachePeek.mockReturnValue(undefined);

    const result = await loadOsmRoutingData([59.1, 20.1, 61.1, 28.1]);
    const keys = mocks.cacheGet.mock.calls.map(([key]) => String(key));

    expect(keys.length).toBeLessThanOrEqual(16);
    expect(keys.some((key) => {
      const coordinates = key.split(':').at(-1)!.split(',').map(Number);
      return coordinates[2]! - coordinates[0]! > 1;
    })).toBe(true);
    expect(result.source).toMatchObject({ status: 'ok', coverage: 'complete' });
  });

  it('koostab Transpordiameti suure ala eellaaditud 1° paanidest', async () => {
    const result = await loadEstonianRoutingData([57.1, 20.1, 60.1, 28.1]);
    const keys = mocks.cacheGet.mock.calls.map(([key]) => String(key));

    expect(keys).toHaveLength(36);
    expect(mocks.cacheGet.mock.calls.every(([, ttl]) => ttl === 7 * 24 * 3600)).toBe(true);
    expect(keys).toContain('routing:transpordiamet-his:v2:57,20,58,21');
    expect(keys).toContain('routing:transpordiamet-his:v2:60,28,61,29');
    expect(result.source).toMatchObject({
      status: 'ok', coverage: 'complete', tilesRequested: 36, tilesLoaded: 36,
    });
  });

  it('kasutab Soome staatikaks 1° cache’i, kuid jätab rikked adaptiivseks', async () => {
    const result = await loadFinnishRoutingData(
      [59.5, 19.1, 62.1, 28.1],
      '2026-08-09T12:00:00Z',
    );
    const keys = mocks.cacheGet.mock.calls.map(([key]) => String(key));
    const staticKeys = keys.filter((key) => key.includes(':static:'));
    const faultKeys = keys.filter((key) => key.includes(':faults:'));

    expect(staticKeys).toHaveLength(40);
    expect(mocks.cacheGet.mock.calls
      .filter(([key]) => String(key).includes(':static:'))
      .every(([, ttl]) => ttl === 7 * 24 * 3600)).toBe(true);
    expect(mocks.cacheGet.mock.calls
      .filter(([key]) => String(key).includes(':faults:'))
      .every(([, ttl]) => ttl === 120)).toBe(true);
    expect(staticKeys.every((key) => {
      const coordinates = key.split(':').at(-1)!.split(',').map(Number);
      return coordinates[2]! - coordinates[0]! === 1
        && coordinates[3]! - coordinates[1]! === 1;
    })).toBe(true);
    expect(faultKeys.length).toBeLessThanOrEqual(16);
    expect(result.source).toMatchObject({ status: 'ok', coverage: 'complete' });
  });
});
