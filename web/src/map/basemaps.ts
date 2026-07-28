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
  {
    /**
     * Tume aluskaart valevärvi-välja alla.
     *
     * Miks eraldi paanistik, mitte OSM-i tumendamine: rasterkihil saab muuta
     * ainult küllastust ja heledust TERVIKUNA — vett ja maad ei saa seal
     * eraldi puutuda.
     *
     * Nõue on, et VESI oleks tumedam kui maa: valevärvi-väli joonistatakse
     * peamiselt merele ja tume vesi annab talle kontrasti, samal ajal kui
     * rannajoon peab jääma loetavaks.
     *
     * Varem oli siin CARTO `dark_nolabels`. Mõõdetuna (keskmine heledus, z8,
     * avameri 58.5/20.0 vs sisemaa 58.6/25.8) on seal asi TAGURPIDI:
     * meri 38, maa 11 — vesi heledam kui maa. Mõõdetud alternatiivid:
     *
     *   Esri Dark Gray   meri 35, maa 70   <- maa 2x heledam, kaart tume
     *   CARTO dark_all   meri 38, maa 12   <- vale suund
     *   CARTO positron   meri 217, maa 247 <- vale suund ja liiga hele
     *   Esri Ocean       meri 207, maa 231 <- hele
     *
     * Sildid puuduvad sihilikult — need tuleksid värvivälja alt loetamatult.
     * NB: Esri paanide URL on {z}/{y}/{x}, mitte {z}/{x}/{y}.
     */
    id: 'esri-dark',
    labelKey: 'layer.darkBase',
    tiles: [
      'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/' +
        'World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    ],
    attribution: 'Esri, HERE, Garmin, © OpenStreetMap contributors',
    maxzoom: 16,
  },
];

/** Vaikimisi nähtav aluskaart. Teine lisatakse peidetuna ja lülitub vajadusel. */
export const DEFAULT_BASE_ID = 'osm';
export const MUTED_BASE_ID = 'esri-dark';

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
