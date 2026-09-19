import { afterEach, describe, it, expect, vi } from 'vitest';
import { loadVesselFavorites, mergeVesselPositions, extendLiveTrack } from './vesselTracking';
describe('client vessel favorites', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('restores unique MMSIs independently of place favorites', () => {
    const getItem = vi.fn(() =>
      JSON.stringify({
        version: 1,
        items: [
          { mmsi: 230000001, name: 'Ship' },
          { mmsi: 230000001, name: 'Ship' },
          { mmsi: -1, name: 'invalid' },
        ],
      }),
    );
    vi.stubGlobal('localStorage', { getItem });
    expect(loadVesselFavorites()).toEqual([{ mmsi: 230000001, name: 'Ship' }]);
    expect(getItem).toHaveBeenCalledWith('seapro.vessel-favorites');
  });
  it('handles disabled storage and corrupt data', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('disabled');
      },
    });
    expect(loadVesselFavorites()).toEqual([]);
    vi.stubGlobal('localStorage', { getItem: () => '{broken' });
    expect(loadVesselFavorites()).toEqual([]);
  });
});

describe('shared vessel positions and live track ends', () => {
  const vessel = (timestamp: string, lon: number) => ({ mmsi: 230000001, timestamp, lon, lat: 59, source: 'digitraffic' as const });
  it('uses the freshest report regardless of which request finishes last', () => {
    const old = vessel('2026-09-19T08:00:00Z', 24);
    const fresh = vessel('2026-09-19T08:00:30Z', 24.001);
    expect(mergeVesselPositions([fresh], [{ ...old, stale: false }])[0]?.lon).toBe(fresh.lon);
    expect(mergeVesselPositions([old], [{ ...fresh, stale: false }])[0]?.lon).toBe(fresh.lon);
  });
  it('extends only beyond stored history, retaining real intermediate positions', () => {
    const start = vessel('2026-09-19T08:00:00Z', 24);
    const next = vessel('2026-09-19T08:00:30Z', 24.001);
    const latest = vessel('2026-09-19T08:01:00Z', 24.002);
    const history = [[start, next]];
    expect(extendLiveTrack(history, [start, next, latest])).toEqual([[start, next, latest]]);
    expect(history).toEqual([[start, next]]);
  });
  it('does not connect long gaps or impossible jumps', () => {
    const start = vessel('2026-09-19T08:00:00Z', 24);
    const jump = vessel('2026-09-19T08:00:30Z', 25);
    const gap = vessel('2026-09-19T09:00:00Z', 25.001);
    expect(extendLiveTrack([[start]], [jump, gap])).toEqual([[start], [jump], [gap]]);
  });
});
