import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cacheGet: vi.fn(),
  fetchJson: vi.fn(),
}));

vi.mock('../src/cache.js', () => ({
  cache: { get: mocks.cacheGet },
}));

vi.mock('../src/http.js', () => ({
  fetchJson: mocks.fetchJson,
}));

import { loadFinnishRoutingData } from '../src/routing/sources/finland.js';

const BBOX = [60, 24, 60.1, 24.1] as const;

describe('Soome routinguallika cache-rühmad', () => {
  beforeEach(() => {
    mocks.cacheGet.mockReset();
    mocks.fetchJson.mockReset();
    mocks.fetchJson.mockResolvedValue({ features: [], numberMatched: 0 });
    mocks.cacheGet.mockImplementation(async (
      _key: string,
      _ttlSeconds: number,
      loader: () => Promise<unknown>,
    ) => ({
      value: await loader(),
      cacheOutcome: 'loaded',
      stale: false,
      ageSeconds: 0,
    }));
  });

  it('cacheb staatilised kihid 24 tunniks ja AToN rikked 120 sekundiks', async () => {
    const result = await loadFinnishRoutingData([...BBOX], '2026-08-08T12:00:00Z');
    const calls = mocks.cacheGet.mock.calls.map(([key, ttl]) => [String(key), Number(ttl)] as const);

    expect(calls).toEqual(expect.arrayContaining([
      [expect.stringContaining(':static:'), 24 * 3600],
      [expect.stringContaining(':faults:'), 120],
    ]));
    expect(calls).toHaveLength(2);
    expect(result.source).toMatchObject({
      status: 'ok',
      stale: false,
      coverage: 'complete',
      tilesRequested: 2,
      tilesLoaded: 2,
    });
  });

  it('pärib sillad veetee läbipääsukõrguse järgi ja lõpetab enne maanteesildu', async () => {
    mocks.fetchJson.mockImplementation(async (urlValue: string) => {
      const params = new URL(urlValue).searchParams;
      if (params.get('typeNames') !== 'taitorakenteet:silta') {
        return { features: [], numberMatched: 0 };
      }
      return {
        features: [
          {
            id: 'silta.1',
            geometry: { type: 'Point', coordinates: [24.05, 60.05] },
            properties: {
              id: 1,
              nimi: 'Vesistösilta',
              alittav_vayla_korkraj_vesiv: '7,2',
              korkeusrajoitus: '3.5',
            },
          },
          {
            id: 'silta.2',
            geometry: { type: 'Point', coordinates: [24.06, 60.06] },
            properties: { id: 2, nimi: 'Maantiesilta', korkeusrajoitus: '4.1' },
          },
        ],
        numberMatched: 26_228,
      };
    });

    const result = await loadFinnishRoutingData([...BBOX], '2026-08-08T12:00:00Z');
    const bridgeCalls = mocks.fetchJson.mock.calls.filter(([urlValue]) =>
      new URL(String(urlValue)).searchParams.get('typeNames') === 'taitorakenteet:silta');

    expect(bridgeCalls).toHaveLength(1);
    const params = new URL(String(bridgeCalls[0]![0])).searchParams;
    expect(params.get('count')).toBe('1000');
    expect(params.get('sortBy')).toBe('alittav_vayla_korkraj_vesiv D');
    expect(params.get('propertyName')).toContain('alittav_vayla_korkraj_vesiv');
    expect(result.restrictions).toEqual([expect.objectContaining({
      id: 'vaylavirasto-wfs:bridge:1',
      maxHeightM: 7.2,
    })]);
  });

  it('märgib stale fault-cache tõttu kogu koondsnapshoti stale-iks', async () => {
    mocks.cacheGet.mockImplementation(async (
      key: string,
      _ttlSeconds: number,
      loader: () => Promise<unknown>,
    ) => ({
      value: await loader(),
      cacheOutcome: key.includes(':faults:') ? 'stale' : 'loaded',
      stale: key.includes(':faults:'),
      ageSeconds: key.includes(':faults:') ? 500 : 0,
      fallbackError: key.includes(':faults:') ? new Error('fault source unavailable') : undefined,
    }));

    const result = await loadFinnishRoutingData([...BBOX], '2026-08-08T12:00:00Z');
    expect(result.source).toMatchObject({
      status: 'stale',
      stale: true,
      coverage: 'complete',
      tilesRequested: 2,
      tilesLoaded: 2,
    });
  });

  it('säilitab staatilised objektid, kuid märgib puuduva fault-rühma partial-iks', async () => {
    mocks.cacheGet.mockImplementation(async (
      key: string,
      _ttlSeconds: number,
      loader: () => Promise<unknown>,
    ) => {
      if (key.includes(':faults:')) throw new Error('fault source unavailable');
      return {
        value: await loader(),
        cacheOutcome: 'loaded',
        stale: false,
        ageSeconds: 0,
      };
    });

    const result = await loadFinnishRoutingData([...BBOX], '2026-08-08T12:00:00Z');
    expect(result.source).toMatchObject({
      status: 'partial',
      stale: false,
      coverage: 'partial',
      tilesRequested: 2,
      tilesLoaded: 1,
    });
    expect(result.source.error).toMatch(/fault source unavailable/);
  });
});
