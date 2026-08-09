import type { Map as MapLibreMap } from 'maplibre-gl';

export const OFFICIAL_DEPTH_SOURCE = 'src-official-depth';
export const OFFICIAL_DEPTH_MIN_ZOOM = 7;
export const OFFICIAL_SOUNDING_MIN_ZOOM = 12;

const OFFICIAL_DEPTH_LAYERS = [
  'official-depth-soundings',
  'official-depth-contour-labels',
  'official-depth-contours',
  // Eelmise Eesti-only stiili kihid eemaldatakse ka HMR-i ja vana salvestatud
  // stiiliseisundi korral.
  'estonia-depth-soundings',
  'estonia-depth-contour-labels',
  'estonia-depth-contours',
  'estonia-depth-contour-halo',
] as const;
const LEGACY_ESTONIA_DEPTH_SOURCE = 'src-estonia-depth';

/**
 * Eesti ja Soome ühine ametlik kuvakiht. PMTiles loetakse samast origin'ist
 * HTTP Range päringutega, seega ei laadita kogu arhiivi brauserisse.
 */
export function addOfficialDepth(map: MapLibreMap, archiveUrl: string, beforeId?: string): void {
  for (const legacyLayer of OFFICIAL_DEPTH_LAYERS.slice(3)) {
    if (map.getLayer(legacyLayer)) map.removeLayer(legacyLayer);
  }
  if (map.getSource(LEGACY_ESTONIA_DEPTH_SOURCE)) {
    map.removeSource(LEGACY_ESTONIA_DEPTH_SOURCE);
  }

  if (!map.getSource(OFFICIAL_DEPTH_SOURCE)) {
    map.addSource(OFFICIAL_DEPTH_SOURCE, {
      type: 'vector',
      url: `pmtiles://${archiveUrl}`,
      attribution: [
        '<a href="https://geoportaal.maaamet.ee/est/ruumiandmed/korgusandmed/horisontaalid-ja-korguspunktid-p509.html">Maa- ja Ruumiamet / Transpordiamet HIS</a>',
        '<a href="https://ckan.ymparisto.fi/dataset/merikartan-syvyystiedot">Traficom</a>',
      ].join('; '),
    });
  }

  if (!map.getLayer('official-depth-contours')) {
    map.addLayer({
      id: 'official-depth-contours',
      type: 'line',
      source: OFFICIAL_DEPTH_SOURCE,
      'source-layer': 'depth_contours',
      minzoom: OFFICIAL_DEPTH_MIN_ZOOM,
      layout: {
        'line-join': 'round',
        'line-cap': 'round',
      },
      paint: {
        'line-color': '#0878a8',
        'line-opacity': 0.82,
        'line-width': [
          'interpolate', ['linear'], ['zoom'],
          OFFICIAL_DEPTH_MIN_ZOOM, 0.8,
          14, 1.6,
        ],
      },
    }, beforeId);
  }

  if (!map.getLayer('official-depth-contour-labels')) {
    map.addLayer({
      id: 'official-depth-contour-labels',
      type: 'symbol',
      source: OFFICIAL_DEPTH_SOURCE,
      'source-layer': 'depth_contours',
      minzoom: 10,
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 300,
        'text-field': [
          'concat',
          ['number-format', ['get', 'depth'], { 'max-fraction-digits': 1 }],
          ' m',
        ],
        'text-font': ['Open Sans Regular'],
        'text-size': 11,
        'text-keep-upright': true,
      },
      paint: {
        'text-color': '#075f86',
        'text-halo-color': 'rgba(235, 247, 251, 0.95)',
        'text-halo-width': 1.5,
      },
    }, beforeId);
  }

  if (!map.getLayer('official-depth-soundings')) {
    map.addLayer({
      id: 'official-depth-soundings',
      type: 'symbol',
      source: OFFICIAL_DEPTH_SOURCE,
      'source-layer': 'depth_soundings',
      minzoom: OFFICIAL_SOUNDING_MIN_ZOOM,
      layout: {
        'text-field': [
          'concat',
          ['number-format', ['get', 'depth'], { 'max-fraction-digits': 1 }],
          ' m',
        ],
        'text-font': ['Open Sans Regular'],
        'text-size': [
          'interpolate', ['linear'], ['zoom'],
          OFFICIAL_SOUNDING_MIN_ZOOM, 10,
          16, 12,
        ],
        'text-allow-overlap': false,
      },
      paint: {
        'text-color': '#123f57',
        'text-halo-color': 'rgba(238, 248, 251, 0.94)',
        'text-halo-width': 1.4,
      },
    }, beforeId);
  }
}

export function removeOfficialDepthLayers(map: MapLibreMap): void {
  for (const layerId of OFFICIAL_DEPTH_LAYERS) {
    if (map.getLayer(layerId)) map.removeLayer(layerId);
  }
}
