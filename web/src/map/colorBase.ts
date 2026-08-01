import type { LayerSpecification, Map as MapLibreMap } from 'maplibre-gl';

/**
 * Värviline aluskaart — VEKTORINA, samast allikast mis tume (`darkBase.ts`).
 *
 * Miks OSM-i rasterpaanid ära vahetati:
 *
 *  - OSM-i paanistik on tehtud MAISMAA jaoks. Kollased ja valged teed,
 *    roheline mets ja punakad hooned domineerivad pildil, samal ajal kui meri
 *    on üks lame sinine laik. Kaatrimehe jaoks on tähtsuste järjekord täpselt
 *    vastupidine.
 *  - Rasterkihil ei saa seda parandada: `raster-saturation` ja
 *    `raster-brightness` mõjuvad tervikpildile.
 *  - Kaks eri tehnoloogiat kahe aluskaardi jaoks tähendas ka kahte eri
 *    zoomikäitumist ja teravust. Vektor on mõlemal pool sama.
 *
 * Palett on siin sihilikult VAIKNE. Kaardi peal on juba merekaart, sügavused,
 * navigatsioonimärgid, valevärvi-väli, tuulenooled, laevad ja jaamad — kõik
 * värvi kandvad. Aluskaart peab andma orientiiri (kus on maa, kus vesi, kus
 * linn, kus tee) ja siis vait olema.
 *
 * Kohanimed on eraldi kihis (`layers/placeLabels.ts`), et kasutaja saaks need
 * välja lülitada ja et need jääksid nähtavaks ka tumeda ilma-aluskaardi peal.
 */

export const COLOR_BASE_SOURCE_ID = 'ofm-color';

const LAND = '#eaeade';
const WATER = '#a8cfe0';
const WOOD = '#d4e0cd';
const GRASS = '#dfe7d5';
const BUILDING = '#ded9d0';
const ROAD_MAJOR = '#ffffff';
const ROAD_MINOR = '#f4f2ec';
const ROAD_CASING = '#d8d4c8';
const PIER = '#cfcabc';

export const COLOR_BASE_LAYER_IDS = [
  'color-land',
  'color-landcover',
  'color-water',
  'color-waterway',
  'color-building',
  'color-road-casing',
  'color-road',
  'color-pier',
] as const;

function layers(): LayerSpecification[] {
  return [
    // OMT-s pole "maa" polügooni, ainult vesi — maismaa tuleb taustavärvist.
    { id: 'color-land', type: 'background', paint: { 'background-color': LAND } },
    {
      id: 'color-landcover',
      type: 'fill',
      source: COLOR_BASE_SOURCE_ID,
      'source-layer': 'landcover',
      paint: {
        'fill-color': [
          'match',
          ['get', 'class'],
          'wood', WOOD,
          'grass', GRASS,
          'farmland', GRASS,
          'rgba(0,0,0,0)',
        ],
        'fill-opacity': 0.7,
      },
    },
    {
      id: 'color-water',
      type: 'fill',
      source: COLOR_BASE_SOURCE_ID,
      'source-layer': 'water',
      paint: { 'fill-color': WATER },
    },
    {
      id: 'color-waterway',
      type: 'line',
      source: COLOR_BASE_SOURCE_ID,
      'source-layer': 'waterway',
      paint: {
        'line-color': WATER,
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 16, 3],
      },
    },
    {
      id: 'color-building',
      type: 'fill',
      source: COLOR_BASE_SOURCE_ID,
      'source-layer': 'building',
      minzoom: 14,
      paint: { 'fill-color': BUILDING, 'fill-opacity': 0.8 },
    },
    // Teed kahes kihis: laiem ääris all, kitsam täidis peal. Ilma ääriseta
    // sulavad heledad teed heleda maapinnaga kokku.
    {
      id: 'color-road-casing',
      type: 'line',
      source: COLOR_BASE_SOURCE_ID,
      'source-layer': 'transportation',
      minzoom: 7,
      filter: ['match', ['get', 'class'], ['motorway', 'trunk', 'primary', 'secondary'], true, false],
      paint: {
        'line-color': ROAD_CASING,
        'line-width': ['interpolate', ['linear'], ['zoom'], 7, 1.4, 14, 6],
      },
    },
    {
      id: 'color-road',
      type: 'line',
      source: COLOR_BASE_SOURCE_ID,
      'source-layer': 'transportation',
      minzoom: 7,
      filter: [
        'match',
        ['get', 'class'],
        ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor'],
        true,
        false,
      ],
      paint: {
        'line-color': [
          'match',
          ['get', 'class'],
          ['motorway', 'trunk', 'primary'], ROAD_MAJOR,
          ROAD_MINOR,
        ],
        'line-width': ['interpolate', ['linear'], ['zoom'], 7, 0.6, 14, 3.5],
      },
    },
    {
      id: 'color-pier',
      type: 'line',
      source: COLOR_BASE_SOURCE_ID,
      'source-layer': 'transportation',
      filter: ['==', ['get', 'class'], 'pier'],
      paint: {
        'line-color': PIER,
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.6, 17, 4],
      },
    },
  ];
}

/**
 * Lisab värvilise aluskaardi. Vaikimisi NÄHTAV — see on rakenduse tavavaade,
 * tume tuleb ette alles siis, kui valevärvi-väli sisse lülitatakse.
 */
export function addColorBase(map: MapLibreMap, beforeId?: string): void {
  if (!map.getSource(COLOR_BASE_SOURCE_ID)) {
    map.addSource(COLOR_BASE_SOURCE_ID, {
      type: 'vector',
      url: 'https://tiles.openfreemap.org/planet',
      attribution:
        '<a href="https://openfreemap.org/">OpenFreeMap</a> © OpenMapTiles, © OpenStreetMap contributors',
    });
  }
  for (const layer of layers()) {
    if (map.getLayer(layer.id)) continue;
    map.addLayer(layer, beforeId);
  }
}

export function setColorBaseVisible(map: MapLibreMap, visible: boolean): void {
  for (const id of COLOR_BASE_LAYER_IDS) {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    }
  }
}
