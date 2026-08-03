import proj4 from 'proj4';
import { request } from './http.js';

export type DepthTileLayer = 'contours' | 'soundings';

const HIS_WMS = 'https://his.vta.ee:8443/HIS/WMS';
const LEST97 =
  '+proj=lcc +lat_0=57.5175539305556 +lon_0=24 +lat_1=59.3333333333333 ' +
  '+lat_2=58 +x_0=500000 +y_0=6375000 +ellps=GRS80 +units=m +no_defs';

const WMS_LAYER: Record<DepthTileLayer, { name: string; style: string }> = {
  contours: { name: 'sea_dl', style: 'default' },
  // Ametliku WMS-i hõredam valik. `default` kuvab kõik mõõdistuspunktid ja
  // muutub ka lähisuumis raskesti loetavaks.
  soundings: { name: 'sea_dp', style: 'reduced' },
};

function tileLon(x: number, zoom: number): number {
  return (x / 2 ** zoom) * 360 - 180;
}

function tileLat(y: number, zoom: number): number {
  return Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** zoom))) * 180 / Math.PI;
}

/**
 * Teisendab MapLibre'i XYZ-paani piirid HIS-i ainsasse toetatud
 * projektsiooni (L-EST97 / EPSG:3301).
 */
export function depthTileBbox(z: number, x: number, y: number): [number, number, number, number] {
  const west = tileLon(x, z);
  const east = tileLon(x + 1, z);
  const north = tileLat(y, z);
  const south = tileLat(y + 1, z);
  const corners: [number, number][] = [
    [west, south],
    [west, north],
    [east, south],
    [east, north],
  ].map((point) => {
    const [easting, northing] = proj4('EPSG:4326', LEST97, point);
    return [easting!, northing!];
  });

  return [
    Math.min(...corners.map(([easting]) => easting)),
    Math.min(...corners.map(([, northing]) => northing)),
    Math.max(...corners.map(([easting]) => easting)),
    Math.max(...corners.map(([, northing]) => northing)),
  ];
}

export function depthTileUrl(layer: DepthTileLayer, z: number, x: number, y: number): string {
  const source = WMS_LAYER[layer];
  const params = new URLSearchParams({
    SERVICE: 'WMS',
    VERSION: '1.1.0',
    REQUEST: 'GetMap',
    LAYERS: source.name,
    STYLES: source.style,
    FORMAT: 'image/png',
    TRANSPARENT: 'true',
    SRS: 'EPSG:3301',
    WIDTH: '256',
    HEIGHT: '256',
    BBOX: depthTileBbox(z, x, y).join(','),
  });
  return `${HIS_WMS}?${params}`;
}

export async function fetchDepthTile(
  layer: DepthTileLayer,
  z: number,
  x: number,
  y: number,
): Promise<Buffer> {
  const response = await request(depthTileUrl(layer, z, x, y), {
    headers: { Accept: 'image/png' },
    timeoutMs: 20_000,
    retries: 1,
  });
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('image/png')) {
    const body = await response.text().catch(() => '');
    throw new Error(`HIS tagastas pildi asemel ${contentType || 'tundmatu formaadi'}: ${body.slice(0, 160)}`);
  }
  return Buffer.from(await response.arrayBuffer());
}
