import { afterEach, describe, it, expect, vi } from 'vitest';
import { loadVesselFavorites } from './vesselTracking';
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
