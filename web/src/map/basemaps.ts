import type { StyleSpecification } from 'maplibre-gl';
import type { RadarTimeline } from '@seapro/shared';

/**
 * Aluskaardid ja overlay'd.
 *
 * Kõik on rasterpaanid ilma API võtmeta — MapTiler/Mapbox on sihilikult
 * välditud, et rakendusel poleks ühtki kvooti ega võtmesõltuvust.
 */

export interface RasterLayerDef {
  id: string;
  /** i18n võti */
  labelKey: string;
  tiles: string[];
  attribution: string;
  minzoom?: number;
  maxzoom?: number;
  tileSize?: number;
  /** Katvuspiirkond [lääs, lõuna, ida, põhi] — MapLibre'i järjekord. */
  bounds?: [number, number, number, number];
  /** Vaikimisi läbipaistvus. */
  opacity?: number;
}

export interface OverlayControlDef {
  id: string;
  labelKey: string;
}

export interface RadarFrame {
  def: RasterLayerDef | null;
  kind: 'observation' | 'forecast' | 'unavailable';
  /** WMS-ist valitud tegelik kaadriaeg. */
  time: string | null;
}

const RADAR_WMS = 'https://ilmgs.envir.ee/geoserver/ilm/wms';

function radarTileUrl(layer: 'cmp_cap' | 'nowcasting', time?: string): string {
  return (
    `${RADAR_WMS}?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap` +
    `&LAYERS=ilm:${layer}&STYLES=&FORMAT=image/png&TRANSPARENT=true&SRS=EPSG:3857` +
    '&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256' +
    (time ? `&TIME=${encodeURIComponent(time)}` : '')
  );
}

/**
 * Aluskaarte SIIN EI OLE.
 *
 * Mõlemad — värviline ja tume — on vektorstiilid, mille me ise kokku paneme:
 * `colorBase.ts` ja `darkBase.ts`. Rasterpaanistikuga ei saanud kumbagi nõuet
 * täita: tumedal on vaja vett maast tumedamana (rasterkihil ei saa vett
 * eraldi puutuda) ja värvilisel on vaja merd esiplaanile, mitte OSM-i
 * maismaakeskset paletti.
 *
 * Siia jäävad ainult overlay'd, mis on päris rasterallikad (WMS ja paanid).
 */

export const OVERLAY_LAYERS: RasterLayerDef[] = [
  {
    // Soome ametlik ENC. Nutimeri kasutab sama Traficomi WMS-i ja just
    // läbipaistva maismaaga stiili: nii ei kata Soome kattealast väljapoole
    // jääv valge paan Eesti kaarti kinni.
    id: 'chart-fi',
    labelKey: 'layer.chartFI',
    tiles: [
      'https://julkinen.traficom.fi/s57/wms?' +
        'SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=cells&STYLES=style-id-203' +
        '&FORMAT=image/png&TRANSPARENT=true&SRS=EPSG:3857' +
        '&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256',
    ],
    attribution: '<a href="https://www.traficom.fi/">Traficom</a>',
    bounds: [18.0, 59.0, 32.0, 70.5],
    minzoom: 6,
  },
  {
    // Eesti ametlik merekaart. Kaatrimehele olulisem kui OSM: faarvaatrid,
    // sügavused, kardinaalmärgid.
    id: 'chart-ee',
    labelKey: 'layer.chartEE',
    tiles: [
      'https://gis.transpordiamet.ee/primar/wms_ip/TranspordiametNutimeri?' +
        'SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=cells&STYLES=style-id-263' +
        '&FORMAT=image/png&TRANSPARENT=true&SRS=EPSG:3857' +
        '&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256',
    ],
    attribution: '<a href="https://gis.transpordiamet.ee/nutimeri/">Transpordiamet</a>',
    bounds: [20.07, 57.45, 28.41, 60.1],
    minzoom: 7,
  },
  {
    id: 'seamark',
    labelKey: 'layer.seamark',
    tiles: ['https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png'],
    attribution: '<a href="https://www.openseamap.org/">OpenSeaMap</a>',
    minzoom: 9,
  },
  {
    id: 'bathymetry',
    labelKey: 'layer.bathymetry',
    tiles: [
      'https://ows.emodnet-bathymetry.eu/wms?' +
        'SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=emodnet:mean_atlas_land' +
        '&STYLES=&FORMAT=image/png&TRANSPARENT=true&CRS=EPSG:3857' +
        '&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256',
    ],
    attribution: '<a href="https://emodnet.ec.europa.eu/">EMODnet Bathymetry</a>',
    opacity: 0.7,
  },
  {
    id: 'radar',
    labelKey: 'layer.radar',
    tiles: [radarTileUrl('cmp_cap')],
    attribution: '<a href="https://www.ilmateenistus.ee/">Keskkonnaagentuur</a>',
    bounds: [20.0, 56.8, 29.0, 60.5],
    opacity: 0.6,
  },
];

const RADAR_DEF = OVERLAY_LAYERS.find((layer) => layer.id === 'radar')!;

function closestTime(times: string[], target: number): string | null {
  let closest: string | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const time of times) {
    const next = Math.abs(Date.parse(time) - target);
    if (next < distance) {
      closest = time;
      distance = next;
    }
  }
  // Ajaliugur on tunnise sammuga, radar viieminutiline. Üle poole tunni
  // kaugune kaader kuulub juba teise liuguripositsiooni juurde.
  return distance <= 30 * 60_000 ? closest : null;
}

/** Valib ajaliuguri hetkele päris vaatluse või radari lühiennustuse. */
export function radarFrameAt(
  selectedTime: Date,
  timeline: RadarTimeline | null,
  now = new Date(),
): RadarFrame {
  const currentHour = new Date(now);
  currentHour.setMinutes(0, 0, 0);

  // Ajainfo laadimise ajal säilitame tänase käitumise: NÜÜD näitab WMS-i
  // vaikimisi kõige värskemat vaatlust.
  if (!timeline) {
    return selectedTime.getTime() === currentHour.getTime()
      ? { def: RADAR_DEF, kind: 'observation', time: null }
      : { def: null, kind: 'unavailable', time: null };
  }

  const target = selectedTime.getTime();
  const isCurrentHour = target === currentHour.getTime();
  const latestAge = timeline.latestObservation
    ? now.getTime() - Date.parse(timeline.latestObservation)
    : Number.POSITIVE_INFINITY;
  // Kui ajajoone päring jäi cache'i varukoopia peale, ei lukusta me NÜÜD
  // vaadet vanale ajatemplile. Ilma TIME parameetrita annab WMS ise värskeima.
  if (isCurrentHour && latestAge > 30 * 60_000) {
    return { def: RADAR_DEF, kind: 'observation', time: null };
  }

  const time = isCurrentHour
    ? timeline.latestObservation
    : closestTime(target > currentHour.getTime() ? timeline.forecasts : timeline.observations, target);
  if (!time) return { def: null, kind: 'unavailable', time: null };

  const kind = target > currentHour.getTime() ? 'forecast' : 'observation';
  const layer = kind === 'forecast' ? 'nowcasting' : 'cmp_cap';
  return {
    def: { ...RADAR_DEF, tiles: [radarTileUrl(layer, time)] },
    kind,
    time,
  };
}

/**
 * Kasutaja lülitid. Eesti ja Soome ENC on üks navigatsioonikaart: nende
 * lahutamine laseks ühe poole piirialal kogemata välja lülitada ning jätaks
 * mulje, et kaardikate on katki.
 */
export const OVERLAY_CONTROLS: OverlayControlDef[] = [
  { id: 'chart', labelKey: 'layer.chart' },
  { id: 'seamark', labelKey: 'layer.seamark' },
  { id: 'bathymetry', labelKey: 'layer.bathymetry' },
  { id: 'radar', labelKey: 'layer.radar' },
];

export function overlayIsActive(layerId: string, activeControls: string[]): boolean {
  return layerId === 'chart-ee' || layerId === 'chart-fi'
    ? activeControls.includes('chart')
    : activeControls.includes(layerId);
}

/** Minimaalne stiil — rasterkihid lisatakse dünaamiliselt. */
export function baseStyle(): StyleSpecification {
  return {
    version: 8,
    // Ilma glyphs'ita ei renderdu ükski tekstisilt (jaamanimed, laevanimed).
    //
    // Fondinimi peab olema selline, mida SEE server tegelikult pakub. Puuduva
    // fondi korral ei vasta ta 404-ga, vaid annab HTML-vealehe staatusega 200;
    // MapLibre üritab seda protobuf'ina parsida ja vuliseb konsooli iga
    // koodipunkti kohta hoiatuse "Unimplemented type: 4". Sildid joonistuvad
    // siis brauseri varufondiga, seega viga on nähtav ainult konsoolis.
    //
    // Kontrollitud olemasolevad: Open Sans Regular / Bold / Semibold,
    // Metropolis Regular. "Noto Sans" siin EI ole — just seda me varem küsisime.
    glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
    sources: {},
    layers: [
      {
        id: 'background',
        type: 'background',
        paint: { 'background-color': '#a3c9dd' },
      },
    ],
  };
}
