import type { StyleSpecification } from 'maplibre-gl';

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

export const BASE_LAYERS: RasterLayerDef[] = [
  {
    id: 'osm',
    labelKey: 'layer.osm',
    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    attribution: '© OpenStreetMap contributors',
    maxzoom: 19,
  },
];

/**
 * Vaikimisi nähtav aluskaart.
 *
 * Tume variant EI OLE siin: ta pole rasterpaanistik, vaid ise kokku pandud
 * vektorstiil (`darkBase.ts`), sest ainult nii saab vee maast tumedamaks
 * teha. Vt sealset kommentaari mõõtmiste ja kaalutud alternatiividega.
 */
export const DEFAULT_BASE_ID = 'osm';

export const OVERLAY_LAYERS: RasterLayerDef[] = [
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
    id: 'chart-fi',
    labelKey: 'layer.chartFI',
    // Läbi meie proxy, MITTE otse. Allikas ei saada CORS-päiseid ja MapLibre
    // laeb rasterpaane crossOrigin-iga (WebGL vajab pikslitele ligipääsu),
    // seega otseühendusel tõmmatakse paan ära ja visatakse kohe minema —
    // mõõdetult 48 päringut ja null pikslit. Vt server/src/routes/tiles.ts.
    tiles: ['/api/tiles/chart-fi/{z}/{x}/{y}'],
    attribution: '<a href="https://einavigointiin.fi/">Väylävirasto</a>',
    bounds: [19.0, 59.0, 31.6, 70.1],
    minzoom: 6,
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
    tiles: [
      'https://ilmgs.envir.ee/geoserver/ilm/wms?' +
        'SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=ilm:cmp_cap&STYLES=' +
        '&FORMAT=image/png&TRANSPARENT=true&SRS=EPSG:3857' +
        '&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256',
    ],
    attribution: '<a href="https://www.ilmateenistus.ee/">Keskkonnaagentuur</a>',
    bounds: [20.0, 56.8, 29.0, 60.5],
    opacity: 0.6,
  },
];

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
