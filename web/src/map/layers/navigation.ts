import type { Feature, FeatureCollection, Geometry } from 'geojson';
import type { FilterSpecification, GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import type { NavigationData } from '@seapro/shared';
import { insertBefore } from '../layerOrder';
import { fixedAidIconCategory, NAVIGATION_WARNING_ICON, WRECK_ICON } from '../icons';

const SOURCE_ID = 'navigation-src';

export const FAIRWAYS_LAYER = 'official-fairways';
export const WARNING_AREAS_LAYER = 'navigation-warning-areas';
export const WARNING_LINES_LAYER = 'navigation-warning-lines';
export const WARNING_POINTS_LAYER = 'navigation-warning-points';
export const WRECKS_LAYER = 'wrecks';
export const WRECK_LABELS_LAYER = 'wreck-labels';
export const NAVIGATION_AIDS_LAYER = 'navigation-aids';
export const NAVIGATION_AID_ALERTS_LAYER = 'navigation-aid-alerts';
export const NAVIGATION_AID_LABELS_LAYER = 'navigation-aid-labels';

export const NAVIGATION_CLICK_LAYERS = [
  WARNING_POINTS_LAYER,
  WARNING_LINES_LAYER,
  WARNING_AREAS_LAYER,
  WRECKS_LAYER,
  NAVIGATION_AIDS_LAYER,
  FAIRWAYS_LAYER,
];

export interface NavigationVisibility {
  warnings: boolean;
  wrecks: boolean;
  aids: boolean;
  official: boolean;
}

export function updateNavigation(map: MapLibreMap, data: NavigationData): void {
  const features: Feature[] = [];

  for (const warning of data.warnings) {
    features.push({
      type: 'Feature',
      geometry: warning.geometry as Geometry,
      properties: {
        featureKind: 'warning',
        id: warning.id,
        number: warning.number ?? null,
        titleEt: warning.titleEt ?? '',
        titleEn: warning.titleEn ?? '',
        textEt: warning.textEt ?? '',
        textEn: warning.textEn ?? '',
        areaEt: warning.areaEt ?? '',
        areaEn: warning.areaEn ?? '',
        charts: warning.charts ?? '',
        validFrom: warning.validFrom ?? '',
        validTo: warning.validTo ?? '',
        documentUrl: warning.documentUrl ?? '',
      },
    });
  }

  for (const wreck of data.wrecks) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [wreck.lon, wreck.lat] },
      properties: {
        featureKind: 'wreck',
        ...wreck,
        wreckDepthM: wreck.wreckDepthM ?? null,
        surroundingDepthM: wreck.surroundingDepthM ?? null,
        heightM: wreck.heightM ?? null,
        lengthM: wreck.lengthM ?? null,
        widthM: wreck.widthM ?? null,
      },
    });
  }

  for (const aid of data.aids) {
    const category = aid.category ?? (aid.virtual ? 'virtual' : 'unknown');
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [aid.lon, aid.lat] },
      properties: {
        featureKind: 'aid',
        ...aid,
        category,
        icon: `navigation-${fixedAidIconCategory(category, aid.markColours)}`,
        sources: aid.sources.join(','),
        virtual: aid.virtual ?? false,
        offPosition: aid.offPosition ?? false,
        mmsi: aid.mmsi ?? null,
        status: aid.status ?? null,
        atonType: aid.atonType ?? null,
        lightActive: aid.lightActive ?? null,
      },
    });
  }

  for (const fairway of data.fairways) {
    features.push({
      type: 'Feature',
      geometry: fairway.geometry as Geometry,
      properties: {
        featureKind: 'fairway',
        id: fairway.id,
        name: fairway.name,
        fairwayClass: fairway.fairwayClass ?? '',
        depthM: fairway.depthM ?? null,
        shipDraughtM: fairway.shipDraughtM ?? null,
        widthM: fairway.widthM ?? null,
        fairwayType: fairway.type ?? '',
      },
    });
  }

  const collection: FeatureCollection = { type: 'FeatureCollection', features };
  const source = map.getSource<GeoJSONSource>(SOURCE_ID);
  if (source) source.setData(collection);
  else map.addSource(SOURCE_ID, { type: 'geojson', data: collection });

  ensureLayers(map);
}

function ensureLayers(map: MapLibreMap): void {
  if (!map.getLayer(FAIRWAYS_LAYER)) {
    map.addLayer({
      id: FAIRWAYS_LAYER,
      type: 'line',
      source: SOURCE_ID,
      filter: ['==', ['get', 'featureKind'], 'fairway'],
      minzoom: 9,
      paint: {
        'line-color': '#a337c8',
        'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1.5, 14, 3],
        'line-opacity': 0.75,
        'line-dasharray': [3, 2],
      },
    }, insertBefore(map, FAIRWAYS_LAYER));
  }

  if (!map.getLayer(WARNING_AREAS_LAYER)) {
    map.addLayer({
      id: WARNING_AREAS_LAYER,
      type: 'fill',
      source: SOURCE_ID,
      filter: ['all', ['==', ['get', 'featureKind'], 'warning'], ['==', ['geometry-type'], 'Polygon']],
      paint: {
        'fill-color': '#f1b51c',
        'fill-opacity': 0.2,
        'fill-outline-color': '#9b6500',
      },
    }, insertBefore(map, WARNING_AREAS_LAYER));
  }

  if (!map.getLayer(WARNING_LINES_LAYER)) {
    map.addLayer({
      id: WARNING_LINES_LAYER,
      type: 'line',
      source: SOURCE_ID,
      filter: ['all', ['==', ['get', 'featureKind'], 'warning'], ['!=', ['geometry-type'], 'Point']],
      paint: {
        'line-color': '#d88a00',
        'line-width': 3,
        'line-dasharray': [2, 1.5],
      },
    }, insertBefore(map, WARNING_LINES_LAYER));
  }

  if (!map.getLayer(WARNING_POINTS_LAYER)) {
    map.addLayer({
      id: WARNING_POINTS_LAYER,
      type: 'symbol',
      source: SOURCE_ID,
      filter: ['all', ['==', ['get', 'featureKind'], 'warning'], ['==', ['geometry-type'], 'Point']],
      layout: {
        'icon-image': NAVIGATION_WARNING_ICON,
        'icon-size': [
          'interpolate', ['linear'], ['zoom'],
          7, 0.72,
          11, 0.92,
          15, 1.08,
        ],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    }, insertBefore(map, WARNING_POINTS_LAYER));
  }

  if (!map.getLayer(WRECKS_LAYER)) {
    map.addLayer({
      id: WRECKS_LAYER,
      type: 'symbol',
      source: SOURCE_ID,
      filter: ['==', ['get', 'featureKind'], 'wreck'],
      minzoom: 10,
      layout: {
        'icon-image': WRECK_ICON,
        'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.72, 14, 0.95, 17, 1.1],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    }, insertBefore(map, WRECKS_LAYER));
  }

  if (!map.getLayer(WRECK_LABELS_LAYER)) {
    map.addLayer({
      id: WRECK_LABELS_LAYER,
      type: 'symbol',
      source: SOURCE_ID,
      filter: ['==', ['get', 'featureKind'], 'wreck'],
      minzoom: 12,
      layout: {
        'text-field': ['get', 'name'],
        'text-font': ['Open Sans Regular'],
        'text-size': 10,
        'text-offset': [0, 1.55],
        'text-anchor': 'top',
        'text-optional': true,
      },
      paint: {
        'text-color': '#2e2140',
        'text-halo-color': 'rgba(255,255,255,0.9)',
        'text-halo-width': 1.2,
      },
    }, insertBefore(map, WRECK_LABELS_LAYER));
  }

  if (!map.getLayer(NAVIGATION_AID_ALERTS_LAYER)) {
    map.addLayer({
      id: NAVIGATION_AID_ALERTS_LAYER,
      type: 'circle',
      source: SOURCE_ID,
      filter: ['all', ['==', ['get', 'featureKind'], 'aid'], ['==', ['get', 'offPosition'], true]],
      minzoom: 10,
      paint: {
        'circle-radius': 12,
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': '#e5483f',
        'circle-stroke-width': 2.5,
      },
    }, insertBefore(map, NAVIGATION_AID_ALERTS_LAYER));
  }

  if (!map.getLayer(NAVIGATION_AIDS_LAYER)) {
    map.addLayer({
      id: NAVIGATION_AIDS_LAYER,
      type: 'symbol',
      source: SOURCE_ID,
      filter: ['==', ['get', 'featureKind'], 'aid'],
      minzoom: 10,
      layout: {
        'icon-image': ['get', 'icon'],
        'icon-size': [
          'interpolate', ['linear'], ['zoom'],
          10, 0.9,
          13, 1.1,
          16, 1.3,
        ],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    }, insertBefore(map, NAVIGATION_AIDS_LAYER));
  }

  if (!map.getLayer(NAVIGATION_AID_LABELS_LAYER)) {
    map.addLayer({
      id: NAVIGATION_AID_LABELS_LAYER,
      type: 'symbol',
      source: SOURCE_ID,
      filter: ['==', ['get', 'featureKind'], 'aid'],
      minzoom: 12,
      layout: {
        'text-field': ['get', 'name'],
        'text-font': ['Open Sans Regular'],
        'text-size': 10,
        'text-offset': [0, 1.45],
        'text-anchor': 'top',
        'text-optional': true,
      },
      paint: {
        'text-color': '#183544',
        'text-halo-color': 'rgba(255,255,255,0.92)',
        'text-halo-width': 1.2,
      },
    }, insertBefore(map, NAVIGATION_AID_LABELS_LAYER));
  }
}

export function setNavigationVisibility(map: MapLibreMap, visibility: NavigationVisibility): void {
  setVisible(map, [WARNING_AREAS_LAYER, WARNING_LINES_LAYER, WARNING_POINTS_LAYER], visibility.warnings);
  setVisible(map, [WRECKS_LAYER, WRECK_LABELS_LAYER], visibility.wrecks);

  // AIS AToN ja registrimärgid jagavad allikat. Registriobjektide lüliti
  // võib märgid sisse tuua ka siis, kui reaalaja AIS-märgid on väljas.
  setVisible(
    map,
    [NAVIGATION_AID_ALERTS_LAYER, NAVIGATION_AIDS_LAYER, NAVIGATION_AID_LABELS_LAYER],
    visibility.aids || visibility.official,
  );
  const kindFilter: FilterSpecification = ['==', ['get', 'featureKind'], 'aid'];
  const sourceFilter: FilterSpecification | null = visibility.aids && visibility.official
    ? null
    : visibility.aids
      ? ['in', 'ais', ['get', 'sources']]
      : ['in', 'registry', ['get', 'sources']];
  const visibleAidFilter: FilterSpecification = sourceFilter
    ? ['all', kindFilter, sourceFilter]
    : kindFilter;
  if (map.getLayer(NAVIGATION_AIDS_LAYER)) {
    map.setFilter(NAVIGATION_AIDS_LAYER, visibleAidFilter);
  }
  if (map.getLayer(NAVIGATION_AID_LABELS_LAYER)) {
    map.setFilter(NAVIGATION_AID_LABELS_LAYER, visibleAidFilter);
  }
  if (map.getLayer(NAVIGATION_AID_ALERTS_LAYER)) {
    const offPositionFilter: FilterSpecification = ['==', ['get', 'offPosition'], true];
    map.setFilter(
      NAVIGATION_AID_ALERTS_LAYER,
      sourceFilter
        ? ['all', kindFilter, sourceFilter, offPositionFilter]
        : ['all', kindFilter, offPositionFilter],
    );
  }
  setVisible(map, [FAIRWAYS_LAYER], visibility.official);
}

function setVisible(map: MapLibreMap, layers: string[], visible: boolean): void {
  for (const layer of layers) {
    if (map.getLayer(layer)) map.setLayoutProperty(layer, 'visibility', visible ? 'visible' : 'none');
  }
}
