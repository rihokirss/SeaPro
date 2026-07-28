import type { LayerSpecification, Map as MapLibreMap } from 'maplibre-gl';

/**
 * Tume aluskaart valevärvi-välja alla — VEKTORINA, mitte valmis paanistikuna.
 *
 * Nõue on kaks asja korraga:
 *   1. vesi peab olema TUMEDAM kui maa (väli joonistatakse merele ja vajab
 *      tumedat tausta, rannajoon peab jääma loetavaks);
 *   2. sadamad peavad olema näha — akvatooriumid, muulid, kaid.
 *
 * Ükski proovitud valmis-paanistik ei anna mõlemat. Mõõdetud keskmine heledus
 * (256x256 paan, z8, avameri 58.5/20.0 vs sisemaa 58.6/25.8):
 *
 *   CARTO dark_nolabels    meri 38, maa 11   detailne, aga vesi HELEDAM
 *   CARTO light_nolabels   meri 217, maa 247 vale suund, liiga hele
 *   Esri Ocean Base        meri 207, maa 231 liiga hele
 *   Esri Dark Gray Canvas  meri 35, maa 70   õige suund, AGA üldistatud —
 *                                            sadamaakvatooriume seal pole
 *
 * Rasterpaanil ei saa vett ja maad eraldi puutuda: `raster-saturation` ja
 * `raster-brightness` mõjuvad tervikpildile. Vektorkaardil saab, sest vesi on
 * oma kihina olemas — seepärast ehitame stiili ise ja määrame värvid otse.
 *
 * Allikas: OpenFreeMap (OpenMapTiles skeem), võtmeta ja kvoodita, nagu kõik
 * ülejäänud selles rakenduses.
 *
 * Silte siin sihilikult EI OLE: need tuleksid valevärvi-välja alt loetamatult
 * ja rakendusel on niikuinii oma sildikihid (jaamad, laevad, sadamad).
 */

const SOURCE_ID = 'ofm-dark';

/** Maa. Heledam kui vesi — see ongi kogu mõte. */
const LAND = '#2e3d47';
/** Vesi. Nii tume, et küllastunud valevärvi-väli loeks selle peal selgelt. */
const WATER = '#0a151c';
/** Muulid, kaid, lainemurdjad — sadama loetavuse jaoks olulisim joonestik. */
const PIER = '#46586485';

export const DARK_BASE_LAYER_IDS = [
  'dark-land',
  'dark-water',
  'dark-waterway',
  'dark-pier',
  'dark-building',
] as const;

function layers(): LayerSpecification[] {
  return [
    // Maismaa tuleb taustavärvist: OMT-s pole "maa" polügooni, on ainult vesi.
    {
      id: 'dark-land',
      type: 'background',
      paint: { 'background-color': LAND },
    },
    {
      id: 'dark-water',
      type: 'fill',
      source: SOURCE_ID,
      'source-layer': 'water',
      paint: { 'fill-color': WATER },
    },
    // Jõed ja kanalid joonena — polügoonina on nad olemas alles suurel zoomil.
    {
      id: 'dark-waterway',
      type: 'line',
      source: SOURCE_ID,
      'source-layer': 'waterway',
      paint: {
        'line-color': WATER,
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 16, 3],
      },
    },
    {
      id: 'dark-pier',
      type: 'line',
      source: SOURCE_ID,
      'source-layer': 'transportation',
      filter: ['==', ['get', 'class'], 'pier'],
      paint: {
        'line-color': PIER,
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.6, 17, 4],
      },
    },
    // Hooned alles lähivaates: sadamas aitavad nad kai ja hoonestuse eristada,
    // väljazoomitult oleksid nad ainult müra.
    {
      id: 'dark-building',
      type: 'fill',
      source: SOURCE_ID,
      'source-layer': 'building',
      minzoom: 14,
      paint: { 'fill-color': '#3a4b57', 'fill-opacity': 0.75 },
    },
  ];
}

/**
 * Lisab tumeda aluskaardi PEIDETUNA, kohe kaardi ehitamisel.
 *
 * Miks kohe ja mitte alles vajadusel: kihtide järjekord peab olema paigas
 * enne andmekihtide lisamist. Vektorallika paane MapLibre peidetud kihtide
 * jaoks ei tõmba, seega olemasolu ise ei maksa midagi.
 */
export function addDarkBase(map: MapLibreMap, beforeId?: string): void {
  if (!map.getSource(SOURCE_ID)) {
    map.addSource(SOURCE_ID, {
      type: 'vector',
      url: 'https://tiles.openfreemap.org/planet',
      attribution:
        '<a href="https://openfreemap.org/">OpenFreeMap</a> © OpenMapTiles, © OpenStreetMap contributors',
    });
  }
  for (const layer of layers()) {
    if (map.getLayer(layer.id)) continue;
    map.addLayer({ ...layer, layout: { visibility: 'none' } } as LayerSpecification, beforeId);
  }
}

export function setDarkBaseVisible(map: MapLibreMap, visible: boolean): void {
  for (const id of DARK_BASE_LAYER_IDS) {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    }
  }
}
