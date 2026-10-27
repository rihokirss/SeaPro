import type { NavigationData } from '@seapro/shared';
import type { Feature } from 'geojson';
import type { Map as MapLibreMap, FilterSpecification } from 'maplibre-gl';
import { insertBefore } from '../layerOrder';

export const EXERCISE_AREAS_FILL = 'exercise-areas-fill';
export const EXERCISE_AREAS_LINE = 'exercise-areas-line';
export const SECTORS_FILL = 'light-sectors-fill';
export const SECTORS_LINE = 'light-sectors-line';
const SELECTED_SECTOR = 'light-sectors-selected';
const SELECTED_SECTOR_FILL = 'light-sectors-selected-fill';
export const EXTRA_CLICK_LAYERS = [EXERCISE_AREAS_FILL, SECTORS_FILL];

export function navigationExtraFeatures(data: NavigationData): Feature[] {
  return [
    ...(data.exerciseAreas ?? []).map((area): Feature => ({
      type: 'Feature', geometry: area.geometry,
      properties: { ...area, geometry: undefined, featureKind: 'exercise-area' },
    })),
    ...(data.lightSectors ?? []).map((sector): Feature => ({
      type: 'Feature', geometry: sector.geometry,
      properties: { ...sector, geometry: undefined, featureKind: 'light-sector',
        sectorColour: sectorColour(sector.colour), fullCircle: (sector.toDegrees - sector.fromDegrees) % 360 === 0 },
    })),
  ];
}

function sectorColour(colour: string): string {
  return ({ W: '#fff4b0', R: '#ed5252', G: '#39b979', Y: '#f5ca45', B: '#4e91ed', V: '#b67adb' } as Record<string, string>)[colour] ?? '#c8c8c8';
}

export function ensureNavigationExtras(map: MapLibreMap, source: string): void {
  const areaFilter: FilterSpecification = ['==', ['get', 'featureKind'], 'exercise-area'];
  if (!map.getLayer(EXERCISE_AREAS_FILL)) {
    map.addLayer({ id: EXERCISE_AREAS_FILL, type: 'fill', source, minzoom: 6,
      filter: areaFilter, paint: { 'fill-color': '#9b88a5', 'fill-opacity': 0.045 },
    }, insertBefore(map, EXERCISE_AREAS_FILL));
    map.addLayer({ id: EXERCISE_AREAS_LINE, type: 'line', source, minzoom: 6,
      filter: areaFilter, paint: { 'line-color': '#9b88a5', 'line-width': 1.5, 'line-dasharray': [5, 4] },
    }, insertBefore(map, EXERCISE_AREAS_LINE));
  }
  if (!map.getLayer(SECTORS_FILL)) {
    map.addLayer({ id: SECTORS_FILL, type: 'fill', source, minzoom: 11,
      paint: { 'fill-color': ['get', 'sectorColour'], 'fill-opacity': 0.1 },
    }, insertBefore(map, SECTORS_FILL));
    map.addLayer({ id: SECTORS_LINE, type: 'line', source, minzoom: 11,
      paint: { 'line-color': ['get', 'sectorColour'], 'line-width': 0.8, 'line-opacity': 0.65 },
    }, insertBefore(map, SECTORS_LINE));
    map.addLayer({ id: SELECTED_SECTOR_FILL, type: 'fill', source, minzoom: 6,
      paint: { 'fill-color': ['get', 'sectorColour'], 'fill-opacity': 0.2 },
    }, insertBefore(map, SELECTED_SECTOR_FILL));
    map.addLayer({ id: SELECTED_SECTOR, type: 'line', source, minzoom: 6,
      paint: { 'line-color': ['get', 'sectorColour'], 'line-width': 2, 'line-opacity': 0.95 },
    }, insertBefore(map, SELECTED_SECTOR));
    setSelectedLightSector(map, null);
  }
}

export function setSelectedLightSector(map: MapLibreMap, code: string | null): void {
  for (const layer of [SELECTED_SECTOR, SELECTED_SECTOR_FILL]) {
    if (map.getLayer(layer)) map.setFilter(layer, ['all',
      ['==', ['get', 'featureKind'], 'light-sector'], ['==', ['get', 'atonCode'], code ?? ''],
      ['==', ['get', 'mode'], selectedModes.get(map) ?? 'night'],
    ]);
  }
  selectedCodes.set(map, code);
}

const selectedModes = new WeakMap<MapLibreMap, 'day' | 'night'>();
const selectedCodes = new WeakMap<MapLibreMap, string | null>();

export function setNavigationExtrasVisibility(map: MapLibreMap, sectors: boolean, areas: boolean, mode: 'day' | 'night'): void {
  // Ringtuled kattuvad sadamas kümnete täisringidena. Nende ulatus avaneb
  // valitud märgil; ülevaates jäävad alles päris sektorite piirid.
  const filter: FilterSpecification = ['all', ['==', ['get', 'featureKind'], 'light-sector'],
    ['==', ['get', 'mode'], mode], ['!=', ['get', 'fullCircle'], true]];
  for (const layer of [SECTORS_FILL, SECTORS_LINE]) {
    if (map.getLayer(layer)) map.setFilter(layer, filter);
  }
  selectedModes.set(map, mode);
  setSelectedLightSector(map, selectedCodes.get(map) ?? null);
  for (const [layers, on] of [
    [[SECTORS_FILL, SECTORS_LINE, SELECTED_SECTOR, SELECTED_SECTOR_FILL], sectors],
    [[EXERCISE_AREAS_FILL, EXERCISE_AREAS_LINE], areas],
  ] as const) {
    for (const layer of layers) if (map.getLayer(layer)) map.setLayoutProperty(layer, 'visibility', on ? 'visible' : 'none');
  }
}
