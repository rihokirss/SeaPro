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
  aisBaseStations: false,
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

  it('turns the AIS base-station layer off when migrating an older preference', () => {
    values.set('seapro.layers', JSON.stringify({
      version: 4,
      aisBaseStations: true,
    }));

    expect(loadLayerState(defaults).aisBaseStations).toBe(false);
  });

  it('persists the toggles in version 5', () => {
    saveLayerState({ ...defaults, routingGraph: true, aisBaseStations: true });

    expect(JSON.parse(values.get('seapro.layers')!)).toMatchObject({
      version: 5,
      routingGraph: true,
      aisBaseStations: true,
    });
  });
});
