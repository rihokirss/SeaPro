import type { Map as MapLibreMap, SymbolLayerSpecification } from 'maplibre-gl';
import { COLOR_BASE_SOURCE_ID } from '../colorBase';

export const PLACE_LABELS_LAYER = 'place-labels';
export const MINOR_PLACE_LABELS_LAYER = 'place-labels-minor';
export const ISLAND_LABELS_LAYER = 'place-labels-islands';
const LABEL_LAYERS = [PLACE_LABELS_LAYER, MINOR_PLACE_LABELS_LAYER, ISLAND_LABELS_LAYER];

const labelLayout: NonNullable<SymbolLayerSpecification['layout']> = {
  'text-field': ['coalesce', ['get', 'name:et'], ['get', 'name']],
  'text-font': ['Open Sans Regular'],
  'text-anchor': 'top',
  'text-offset': [0, 0.4],
  'text-optional': true,
};

const labelPaint: NonNullable<SymbolLayerSpecification['paint']> = {
  // Halo teeb ühe värvi loetavaks nii heledal kui tumedal aluskaardil ja
  // valevärvi-ilmakihi peal.
  'text-color': '#dce8ee',
  'text-halo-color': '#132733dd',
  'text-halo-width': 1.5,
};

/**
 * OpenFreeMapi kohanimed eraldi kihina.
 *
 * Kasutame värvilise aluskaardi allikat ka tumeda taustaga: allikas on kogu
 * aeg olemas ning eraldi paanistikku pole vaja. Näitame ainult asulaid, mitte
 * tänavaid ega maismaa POI-sid, mis merel kaardi üle koormaksid. Saared ja
 * väiksemad asulad tulevad nähtavale alles lähemal suumil, et tihedas
 * saarestikus sildid üksteist ei mataks.
 */
export function addPlaceLabels(map: MapLibreMap): void {
  if (map.getLayer(PLACE_LABELS_LAYER)) return;
  map.addLayer({
    id: PLACE_LABELS_LAYER,
    type: 'symbol',
    source: COLOR_BASE_SOURCE_ID,
    'source-layer': 'place',
    filter: ['match', ['get', 'class'], ['city', 'town', 'village'], true, false],
    layout: {
      ...labelLayout,
      'text-size': ['interpolate', ['linear'], ['zoom'], 6, 10, 12, 14],
    },
    paint: labelPaint,
  });
  map.addLayer({
    id: MINOR_PLACE_LABELS_LAYER,
    type: 'symbol',
    source: COLOR_BASE_SOURCE_ID,
    'source-layer': 'place',
    minzoom: 11,
    filter: ['match', ['get', 'class'], ['hamlet', 'isolated_dwelling'], true, false],
    layout: { ...labelLayout, 'text-size': 11 },
    paint: { ...labelPaint, 'text-color': '#c8d8df' },
  });
  map.addLayer({
    id: ISLAND_LABELS_LAYER,
    type: 'symbol',
    source: COLOR_BASE_SOURCE_ID,
    'source-layer': 'place',
    minzoom: 9,
    filter: ['==', ['get', 'class'], 'island'],
    layout: {
      ...labelLayout,
      'text-size': ['interpolate', ['linear'], ['zoom'], 9, 10, 14, 12],
      'text-font': ['Open Sans Semibold'],
      'text-letter-spacing': 0.04,
    },
    paint: labelPaint,
  });
}

export function setPlaceLabelsVisible(map: MapLibreMap, visible: boolean): void {
  for (const id of LABEL_LAYERS) {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    }
  }
}
