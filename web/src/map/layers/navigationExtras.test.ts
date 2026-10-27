import { describe, expect, it } from 'vitest';
import type { NavigationData } from '@seapro/shared';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { ensureNavigationExtras, navigationExtraFeatures, setNavigationExtrasVisibility, setSelectedLightSector } from './navigationExtras';

describe('täiendavate navigatsioonikihtide kuvamine', () => {
  it('eristab püsivat laskeala aktiivsest hoiatusest ja säilitab sektori täpsed andmed', () => {
    const geometry = { type: 'Polygon' as const, coordinates: [[[24, 59], [24.1, 59], [24.1, 59.1], [24, 59]]] as [number, number][][] };
    const data: NavigationData = { aids: [], warnings: [], wrecks: [], baseStations: [], fairways: [], trafficSchemes: [],
      exerciseAreas: [{ id: 'area:1', name: '1A', geometry }],
      lightSectors: [{ id: 'sector:1', atonCode: '045', name: 'Vaindloo', mode: 'night', colour: 'R',
        fromDegrees: 350, toDegrees: 10, rangeNm: 11, geometry }],
    };
    const features = navigationExtraFeatures(data);
    expect(features.map((f) => f.properties?.featureKind)).toEqual(['exercise-area', 'light-sector']);
    expect(features[1]?.properties).toMatchObject({ atonCode: '045', fromDegrees: 350, toDegrees: 10, sectorColour: '#ed5252' });
    expect(features[1]?.geometry).toEqual(geometry);
  });

  it('näitab korraga üht valgusrežiimi ja kustutab valiku sulgemisel', () => {
    const layers = new Map<string, Record<string, unknown>>();
    const map = {
      getLayer: (id: string) => layers.get(id),
      addLayer: (layer: { id: string }) => layers.set(layer.id, { ...layer }),
      setFilter: (id: string, filter: unknown) => { layers.get(id)!.filter = filter; },
      setLayoutProperty: (id: string, _key: string, value: unknown) => { layers.get(id)!.visibility = value; },
    } as unknown as MapLibreMap;
    ensureNavigationExtras(map, 'test');
    setNavigationExtrasVisibility(map, true, false, 'night');
    setSelectedLightSector(map, '045');
    expect(JSON.stringify(layers.get('light-sectors-selected')?.filter)).toContain('045');
    setNavigationExtrasVisibility(map, true, false, 'day');
    expect(layers.get('light-sectors-fill')?.filter).toEqual(['all', ['==', ['get', 'featureKind'], 'light-sector'], ['==', ['get', 'mode'], 'day'], ['!=', ['get', 'fullCircle'], true]]);
    expect(JSON.stringify(layers.get('light-sectors-selected')?.filter)).toContain('day');
    expect(layers.get('exercise-areas-fill')?.visibility).toBe('none');
    setSelectedLightSector(map, null);
    expect(JSON.stringify(layers.get('light-sectors-selected')?.filter)).not.toContain('045');
    setNavigationExtrasVisibility(map, false, true, 'day');
    expect(layers.get('light-sectors-selected')?.visibility).toBe('none');
    expect(layers.get('exercise-areas-fill')?.visibility).toBe('visible');
  });
});
