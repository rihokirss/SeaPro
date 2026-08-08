import { cache } from './cache.js';
import { fetchJson, request } from './http.js';
import { contours } from 'd3-contour';
import { fromArrayBuffer } from 'geotiff';
import { distanceMetres, interpolatePosition, type DepthRiskSegment } from '@seapro/shared';

const EMODNET_WFS = 'https://ows.emodnet-bathymetry.eu/wfs';
const EMODNET_REST = 'https://rest.emodnet-bathymetry.eu/depth_sample';
const EMODNET_WCS = 'https://ows.emodnet-bathymetry.eu/wcs';
const DTM_RESOLUTION = 1 / 960; // 1/16 kaareminutit
const ROUTE_TILE_DEGREES = 0.1;

/** WFS-i ja GeoJSON-i tavapärane järjestus: lääs, lõuna, ida, põhi. */
export type DepthContourBbox = [number, number, number, number];

export function depthContourUrl([west, south, east, north]: DepthContourBbox): string {
  const params = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeNames: 'emodnet:contours',
    srsName: 'EPSG:4326',
    bbox: `${west},${south},${east},${north},EPSG:4326`,
    outputFormat: 'application/json',
    count: '2000',
  });
  return `${EMODNET_WFS}?${params}`;
}

export async function fetchDepthContours(bbox: DepthContourBbox): Promise<string> {
  const response = await request(depthContourUrl(bbox), {
    headers: { Accept: 'application/geo+json, application/json' },
    timeoutMs: 30_000,
    retries: 1,
  });
  const contentType = response.headers.get('content-type') ?? '';
  const body = await response.text();
  if (!contentType.toLowerCase().includes('json')) {
    throw new Error(
      `EMODnet tagastas GeoJSON-i asemel ${contentType || 'tundmatu formaadi'}: ${body.slice(0, 160)}`,
    );
  }
  return body;
}

interface DepthSampleResponse {
  avg?: number;
  reference?: Record<string, unknown>;
}

interface DepthSampleFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: { depth: number; depthLabel: string; modelled: true };
}

export interface DepthSampleCollection {
  type: 'FeatureCollection';
  features: DepthSampleFeature[];
}

export interface DepthContourFeature {
  type: 'Feature';
  geometry: { type: 'MultiLineString'; coordinates: number[][][] };
  properties: { elevation: number; generated: true };
}

export interface DepthContourCollection {
  type: 'FeatureCollection';
  features: DepthContourFeature[];
}

/**
 * Kleebib ja laiendab ala DTM-i võrgule, et nihutamine tabaks sama cache'i.
 * Varu on vaateaknast tükk maad laiem, sest kaart hoiab vana ala jooni kuni
 * uue vastuse saabumiseni: väike paan ei tohi tuua laadimisala serva vaatesse.
 */
export function snapDepthContourBbox(
  [west, south, east, north]: DepthContourBbox,
): DepthContourBbox {
  const margin = 12 * DTM_RESOLUTION;
  const floor = (value: number): number => Math.floor(value / DTM_RESOLUTION) * DTM_RESOLUTION;
  const ceil = (value: number): number => Math.ceil(value / DTM_RESOLUTION) * DTM_RESOLUTION;
  return [
    Number(floor(west - margin).toFixed(8)),
    Number(floor(south - margin).toFixed(8)),
    Number(ceil(east + margin).toFixed(8)),
    Number(ceil(north + margin).toFixed(8)),
  ];
}

export function depthCoverageUrl(
  [west, south, east, north]: DepthContourBbox,
  options: { resolution?: number; coverage?: 'emodnet:mean' | 'emodnet:mean_atlas_land' } = {},
): string {
  const resolution = options.resolution ?? DTM_RESOLUTION;
  const params = new URLSearchParams({
    service: 'WCS',
    version: '1.0.0',
    request: 'GetCoverage',
    coverage: options.coverage ?? 'emodnet:mean',
    crs: 'EPSG:4326',
    bbox: `${west},${south},${east},${north}`,
    format: 'GeoTIFF',
    interpolation: 'bilinear',
    resx: String(resolution),
    resy: String(resolution),
  });
  return `${EMODNET_WCS}?${params}`;
}

// d3-contour sulgeb iga läve piirkonna ka rastri raami ääres: sinna tekib
// sirge „isobaat" iga läve kohta kuni poole piksli võrra raamist seespool.
// Täpne servavõrdlus neid ei tabanud ja paanimisel paistis avamerel suvalise
// sildiga sirgjoon (nt „35 m" 130 m süviku kohal). Ühe piksli tolerants
// eemaldab raamijooned; maa/NoData piirile (rannajoonele) kuhjuv joon jääb.
const EDGE_TOLERANCE_PX = 1;

function splitContourRing(ring: number[][], width: number, height: number): number[][][] {
  const nearLow = (value: number | undefined): boolean =>
    value !== undefined && value <= EDGE_TOLERANCE_PX;
  const nearHigh = (value: number | undefined, limit: number): boolean =>
    value !== undefined && value >= limit - EDGE_TOLERANCE_PX;
  const onOuterEdge = (a: number[], b: number[]): boolean =>
    (nearLow(a[0]) && nearLow(b[0])) || (nearHigh(a[0], width) && nearHigh(b[0], width))
    || (nearLow(a[1]) && nearLow(b[1])) || (nearHigh(a[1], height) && nearHigh(b[1], height));
  const segments = ring.slice(0, -1).map((point, index) => [point, ring[index + 1]!] as const);
  const firstEdge = segments.findIndex(([a, b]) => onOuterEdge(a, b));
  if (firstEdge < 0) return ring.length >= 3 ? [ring] : [];

  // Alustame välisservast, et sama avatud isojoone kaks otsa ei satuks
  // massiivi algusesse ja lõppu eraldi juppidena.
  const ordered = [...segments.slice(firstEdge + 1), ...segments.slice(0, firstEdge + 1)];
  const lines: number[][][] = [];
  let line: number[][] = [];
  for (const [a, b] of ordered) {
    if (onOuterEdge(a, b)) {
      if (line.length >= 2) lines.push(line);
      line = [];
      continue;
    }
    if (line.length === 0) line.push(a);
    line.push(b);
  }
  if (line.length >= 2) lines.push(line);
  return lines;
}

/**
 * Chaikini nurgalõikus pehmendab marching-squares'i võrgusakke. Kaks sammu
 * on visuaalselt selged, kuid jäävad DTM-i ühe algse võrguraku täpsuse sisse.
 */
export function smoothContourLine(line: number[][], passes = 2): number[][] {
  let current = line;
  for (let pass = 0; pass < passes && current.length >= 3; pass++) {
    const closed = current[0]![0] === current.at(-1)![0]
      && current[0]![1] === current.at(-1)![1];
    const points = closed ? current.slice(0, -1) : current;
    const next: number[][] = [];
    if (!closed) next.push(points[0]!);

    const pairCount = closed ? points.length : points.length - 1;
    for (let index = 0; index < pairCount; index++) {
      const a = points[index]!;
      const b = points[(index + 1) % points.length]!;
      next.push(
        [0.75 * a[0]! + 0.25 * b[0]!, 0.75 * a[1]! + 0.25 * b[1]!],
        [0.25 * a[0]! + 0.75 * b[0]!, 0.25 * a[1]! + 0.75 * b[1]!],
      );
    }
    if (closed) next.push(next[0]!);
    else next.push(points.at(-1)!);
    current = next;
  }
  return current;
}

/**
 * Genereerib pikslivõrest samasügavusjooned. Eraldi funktsioon, et
 * raami-artefaktide eemaldust saaks testida ilma võrgu ja cache'ita.
 * `depths` on meetrites vee all, maa/NoData on NaN.
 */
export function denseContourFeatures(
  depths: number[],
  width: number,
  height: number,
  [minLon, minLat, maxLon, maxLat]: DepthContourBbox,
): DepthContourFeature[] {
  // WCS kleebib ala oma võrgule ja servaribad võivad jääda NoData-ks. Kärbime
  // tühjad servaread/-veerud enne kontuurimist: muidu jookseb iga läve joon
  // andmete/NoData kraepiiril, sisemal kui raamifilter ulatub, ja kaardile
  // ilmub avamerre sirge suvalise sildiga „isobaat".
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!Number.isFinite(depths[y * width + x]!)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX) return [];

  let values = depths;
  let gridWidth = width;
  let gridHeight = height;
  let west = minLon;
  let east = maxLon;
  let north = maxLat;
  let south = minLat;
  if (maxX - minX + 1 !== width || maxY - minY + 1 !== height) {
    gridWidth = maxX - minX + 1;
    gridHeight = maxY - minY + 1;
    values = new Array<number>(gridWidth * gridHeight);
    for (let y = 0; y < gridHeight; y++) {
      for (let x = 0; x < gridWidth; x++) {
        values[y * gridWidth + x] = depths[(y + minY) * width + (x + minX)]!;
      }
    }
    const lonStep = (maxLon - minLon) / width;
    const latStep = (maxLat - minLat) / height;
    west = minLon + minX * lonStep;
    east = minLon + (maxX + 1) * lonStep;
    north = maxLat - minY * latStep;
    south = maxLat - (maxY + 1) * latStep;
  }

  const maxDepth = values.reduce((max, depth) => Number.isFinite(depth) ? Math.max(max, depth) : max, 0);
  const thresholds = [1, 2, 3, 4];
  for (let depth = 5; depth <= Math.ceil(maxDepth / 5) * 5; depth += 5) thresholds.push(depth);

  return contours()
    .size([gridWidth, gridHeight])
    .thresholds(thresholds)(values)
    .map((contour) => {
      const pixelLines = contour.coordinates.flatMap((polygon) =>
        polygon.flatMap((ring) => splitContourRing(ring, gridWidth, gridHeight)));
      const coordinates = pixelLines
        .filter((line) => line.length >= 2)
        .map((line) => smoothContourLine(line).map(([x, y]) => [
          west + (x! / gridWidth) * (east - west),
          north - (y! / gridHeight) * (north - south),
        ]));
      return {
        type: 'Feature' as const,
        geometry: { type: 'MultiLineString' as const, coordinates },
        properties: { elevation: Number(contour.value), generated: true as const },
      };
    })
    .filter((feature) => feature.geometry.coordinates.length > 0);
}

/** Genereerib DTM-ist 1–5 m meetrise sammuga, edasi 5 m intervalliga jooned. */
export async function fetchDenseDepthContours(
  requestedBbox: DepthContourBbox,
): Promise<DepthContourCollection> {
  const bbox = snapDepthContourBbox(requestedBbox);
  // v3: v2 sisaldas raami-artefaktjooni; igavene stale-kiht ei tohi neid
  // pärast parandust edasi teenindada.
  const cacheKey = `emodnet:dense-contours:v3:${bbox.join(':')}`;
  const { value } = await cache.get(cacheKey, 10 * 86400, async () => {
    const response = await request(depthCoverageUrl(bbox), {
      headers: { Accept: 'image/tiff' },
      timeoutMs: 30_000,
      retries: 1,
    });
    const tiff = await fromArrayBuffer(await response.arrayBuffer());
    const image = await tiff.getImage();
    const width = image.getWidth();
    const height = image.getHeight();
    const raster = await image.readRasters({ interleave: true });
    const depths = Array.from(raster as ArrayLike<number>, (elevation) =>
      Number.isFinite(elevation) && elevation < 0 ? -elevation : Number.NaN);
    const features = denseContourFeatures(
      depths,
      width,
      height,
      image.getBoundingBox() as DepthContourBbox,
    );
    return { type: 'FeatureCollection' as const, features };
  });
  return value;
}

export function depthSampleUrl(lon: number, lat: number): string {
  const params = new URLSearchParams({ geom: `POINT(${lon} ${lat})` });
  return `${EMODNET_REST}?${params}`;
}

/**
 * Valib MapLibre'i zoomiga seotud püsiva võre. Ühes ekraanipaanis on umbes
 * kaks numbrit reas; nihutamisel jäävad samad koordinaadid cache'i tabama.
 */
export function depthSampleGrid(
  [west, south, east, north]: DepthContourBbox,
  zoom: number,
): Array<[number, number]> {
  if (zoom < 12) return [];
  const step = 360 / 2 ** (Math.min(Math.floor(zoom), 17) + 1);
  const firstLon = Math.ceil(west / step) * step;
  const firstLat = Math.ceil(south / step) * step;
  const points: Array<[number, number]> = [];
  for (let lat = firstLat; lat <= north && points.length < 80; lat += step) {
    for (let lon = firstLon; lon <= east && points.length < 80; lon += step) {
      points.push([Number(lon.toFixed(6)), Number(lat.toFixed(6))]);
    }
  }
  return points;
}

export async function fetchDepthSamples(
  bbox: DepthContourBbox,
  zoom: number,
): Promise<DepthSampleCollection> {
  const points = depthSampleGrid(bbox, zoom);
  const features: DepthSampleFeature[] = [];

  // Väikesed partiid ei ujuta avalikku REST-teenust korraga päringutega üle.
  for (let offset = 0; offset < points.length; offset += 6) {
    const batch = points.slice(offset, offset + 6);
    const results = await Promise.allSettled(batch.map(async ([lon, lat]) => {
      const key = `emodnet:depth:${lon}:${lat}`;
      const { value } = await cache.get(key, 30 * 86400, () =>
        fetchJson<DepthSampleResponse>(depthSampleUrl(lon, lat), { timeoutMs: 15_000, retries: 1 }));
      return { lon, lat, sample: value };
    }));

    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const { lon, lat, sample } = result.value;
      if (!Number.isFinite(sample.avg)) continue;
      // EMODneti kõrgus on Läänemeres vee all negatiivne. Mõni maismaarakk
      // annab positiivse väärtuse ilma lähteviiteta; seda kaardile ei pane.
      const hasReference = Boolean(sample.reference && Object.keys(sample.reference).length);
      if (sample.avg! >= 0 && !hasReference) continue;
      const depth = Math.abs(sample.avg!);
      const rounded = depth < 10 ? Math.round(depth * 10) / 10 : Math.round(depth);
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: { depth: rounded, depthLabel: String(rounded), modelled: true },
      });
    }
  }

  return { type: 'FeatureCollection', features };
}

interface DepthTile {
  bbox: DepthContourBbox;
  width: number;
  height: number;
  values: Array<number | null>;
}

function routeTileBbox(lon: number, lat: number): DepthContourBbox {
  const west = Math.floor(lon / ROUTE_TILE_DEGREES) * ROUTE_TILE_DEGREES;
  const south = Math.floor(lat / ROUTE_TILE_DEGREES) * ROUTE_TILE_DEGREES;
  return [west, south, west + ROUTE_TILE_DEGREES, south + ROUTE_TILE_DEGREES]
    .map((n) => Number(n.toFixed(8))) as DepthContourBbox;
}

async function fetchDepthTile(bbox: DepthContourBbox): Promise<DepthTile> {
  const key = `emodnet:route-depth:v1:${bbox.join(':')}`;
  const { value } = await cache.get(key, 30 * 86400, async () => {
    const response = await request(depthCoverageUrl(bbox), {
      headers: { Accept: 'image/tiff' }, timeoutMs: 30_000, retries: 1,
    });
    const tiff = await fromArrayBuffer(await response.arrayBuffer());
    const image = await tiff.getImage();
    const raw = await image.readRasters({ interleave: true });
    return {
      bbox: image.getBoundingBox() as DepthContourBbox,
      width: image.getWidth(),
      height: image.getHeight(),
      values: Array.from(raw as ArrayLike<number>, (n) => Number.isFinite(n) && n < 0 ? -n : null),
    } satisfies DepthTile;
  });
  return value;
}

function tileDepth(tile: DepthTile, lon: number, lat: number): number | null {
  const [west, south, east, north] = tile.bbox;
  const x = Math.max(0, Math.min(tile.width - 1, Math.floor((lon - west) / (east - west) * tile.width)));
  const y = Math.max(0, Math.min(tile.height - 1, Math.floor((north - lat) / (north - south) * tile.height)));
  return tile.values[y * tile.width + x] ?? null;
}

/**
 * Proovib marsruuti DTM-i lahutuse lähedalt. Väga pika raja korral kasvab samm,
 * et üks raport ei saaks laadida piiramatult WCS-paanisid.
 */
export async function analyseRouteDepth(
  waypoints: Array<{ lat: number; lon: number }>,
  requiredDepthM: number,
): Promise<DepthRiskSegment[]> {
  const totalMetres = waypoints.slice(1).reduce((sum, p, i) => sum + distanceMetres(waypoints[i]!, p), 0);
  const stepM = Math.max(120, totalMetres / 5000);
  const probes: Array<{ lat: number; lon: number }> = [];
  for (let i = 1; i < waypoints.length; i++) {
    const a = waypoints[i - 1]!; const b = waypoints[i]!;
    const count = Math.max(1, Math.ceil(distanceMetres(a, b) / stepM));
    if (i === 1) probes.push(a);
    for (let n = 1; n <= count; n++) probes.push(interpolatePosition(a, b, n / count));
  }
  const wantedTiles = new Map<string, DepthContourBbox>();
  for (const point of probes) {
    const bbox = routeTileBbox(point.lon, point.lat); wantedTiles.set(bbox.join(':'), bbox);
  }
  const entries = [...wantedTiles.entries()];
  const loadedTiles = new Map<string, DepthTile | null>();
  let tileCursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, entries.length) }, async () => {
    while (tileCursor < entries.length) {
      const [key, bbox] = entries[tileCursor++]!;
      try { loadedTiles.set(key, await fetchDepthTile(bbox)); } catch { loadedTiles.set(key, null); }
    }
  }));
  const depths = probes.map((point) => {
    const bbox = routeTileBbox(point.lon, point.lat);
    const tile = loadedTiles.get(bbox.join(':'));
    return tile ? tileDepth(tile, point.lon, point.lat) : null;
  });
  return probes.slice(1).map((point, i) => {
    const pair = [depths[i] ?? null, depths[i + 1] ?? null].filter((v): v is number => v !== null);
    const minDepthM = pair.length ? Math.min(...pair) : null;
    const risk = minDepthM === null ? 'unknown'
      : minDepthM < requiredDepthM ? 'danger'
        : minDepthM < requiredDepthM + 0.5 ? 'caution' : 'safe';
    return {
      from: [probes[i]!.lon, probes[i]!.lat], to: [point.lon, point.lat],
      risk, minDepthM, requiredDepthM,
    } satisfies DepthRiskSegment;
  });
}
