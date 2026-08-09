import type { Map as MapLibreMap } from 'maplibre-gl';

export const ESTONIA_DEPTH_SOURCE = 'src-estonia-depth';
export const ESTONIA_DEPTH_MIN_ZOOM = 9;
export const ESTONIA_SOUNDING_MIN_ZOOM = 12;

const ESTONIA_DEPTH_LAYERS = [
  'estonia-depth-soundings',
  'estonia-depth-contour-labels',
  'estonia-depth-contours',
  // Eelmise stiiliversiooni halo eemaldatakse ka HMR-i ajal, kuigi uut enam
  // ei lisata: EMODnet lõigatakse nüüd serveris ametliku katvuse seest välja.
  'estonia-depth-contour-halo',
] as const;

/**
 * Eesti ametlik lähisuumi kiht. PMTiles loetakse samast origin'ist HTTP Range
 * päringutega, seega ei laadita 42 MB arhiivi kunagi tervikuna brauserisse.
 */
export function addEstoniaDepth(map: MapLibreMap, archiveUrl: string, beforeId?: string): void {
  if (!map.getSource(ESTONIA_DEPTH_SOURCE)) {
    map.addSource(ESTONIA_DEPTH_SOURCE, {
      type: 'vector',
      url: `pmtiles://${archiveUrl}`,
      attribution: '<a href="https://geoportaal.maaamet.ee/est/ruumiandmed/korgusandmed/horisontaalid-ja-korguspunktid-p509.html">Maa- ja Ruumiamet / Transpordiamet HIS</a>',
    });
  }

  if (!map.getLayer('estonia-depth-contours')) {
    map.addLayer({
      id: 'estonia-depth-contours',
      type: 'line',
      source: ESTONIA_DEPTH_SOURCE,
      'source-layer': 'depth_contours',
      minzoom: ESTONIA_DEPTH_MIN_ZOOM,
      layout: {
        'line-join': 'round',
        'line-cap': 'round',
      },
      paint: {
        'line-color': '#0878a8',
        'line-opacity': 0.82,
        'line-width': [
          'interpolate', ['linear'], ['zoom'],
          7, 0.8,
          14, 1.6,
        ],
      },
    }, beforeId);
  }

  if (!map.getLayer('estonia-depth-contour-labels')) {
    map.addLayer({
      id: 'estonia-depth-contour-labels',
      type: 'symbol',
      source: ESTONIA_DEPTH_SOURCE,
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

  if (!map.getLayer('estonia-depth-soundings')) {
    map.addLayer({
      id: 'estonia-depth-soundings',
      type: 'symbol',
      source: ESTONIA_DEPTH_SOURCE,
      'source-layer': 'depth_soundings',
      minzoom: ESTONIA_SOUNDING_MIN_ZOOM,
      layout: {
        'text-field': [
          'concat',
          ['number-format', ['get', 'depth'], { 'max-fraction-digits': 1 }],
          ' m',
        ],
        'text-font': ['Open Sans Regular'],
        'text-size': [
          'interpolate', ['linear'], ['zoom'],
          ESTONIA_SOUNDING_MIN_ZOOM, 10,
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

export function removeEstoniaDepthLayers(map: MapLibreMap): void {
  for (const layerId of ESTONIA_DEPTH_LAYERS) {
    if (map.getLayer(layerId)) map.removeLayer(layerId);
  }
}
