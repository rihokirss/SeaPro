import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LayerState } from '../components/LayerPanel';
import { loadLayerState, saveLayerState } from './layerState';

const defaults: LayerState = {
  overlays: [],
  windDisplay: 'off',
  scalarField: null,
  stations: false,
  vessels: false,
  harbours: false,
  anchorages: false,
  placeLabels: true,
  navigationWarnings: false,
  navigationAids: false,
  trafficSchemes: false,
  wrecks: false,
  officialNavigation: true,
  routingGraph: false,
};

describe('layer state routing graph migration', () => {
  const values = new Map<string, string>();

  beforeEach(() => {
    values.clear();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
  });

  it('keeps the new diagnostic layer off when loading a version 2 preference', () => {
    values.set('seapro.layers', JSON.stringify({
      version: 2,
      officialNavigation: false,
      routingGraph: true,
    }));

    expect(loadLayerState(defaults)).toMatchObject({
      officialNavigation: false,
      routingGraph: false,
    });
  });

  it('persists the routing graph toggle in version 3', () => {
    saveLayerState({ ...defaults, routingGraph: true });

    expect(JSON.parse(values.get('seapro.layers')!)).toMatchObject({
      version: 3,
      routingGraph: true,
    });
  });
});
