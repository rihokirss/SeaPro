import { cache } from './cache.js';
import { fetchJson, request } from './http.js';
import { contours } from 'd3-contour';
import { fromArrayBuffer } from 'geotiff';

const EMODNET_WFS = 'https://ows.emodnet-bathymetry.eu/wfs';
const EMODNET_REST = 'https://rest.emodnet-bathymetry.eu/depth_sample';
const EMODNET_WCS = 'https://ows.emodnet-bathymetry.eu/wcs';
const DTM_RESOLUTION = 1 / 960; // 1/16 kaareminutit

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

interface DepthContourFeature {
  type: 'Feature';
  geometry: { type: 'MultiLineString'; coordinates: number[][][] };
  properties: { elevation: number; generated: true };
}

export interface DepthContourCollection {
  type: 'FeatureCollection';
  features: DepthContourFeature[];
}

/** Kleebib ja laiendab ala DTM-i võrgule, et nihutamine tabaks sama cache'i. */
export function snapDepthContourBbox(
  [west, south, east, north]: DepthContourBbox,
): DepthContourBbox {
  const margin = 3 * DTM_RESOLUTION;
  const floor = (value: number): number => Math.floor(value / DTM_RESOLUTION) * DTM_RESOLUTION;
  const ceil = (value: number): number => Math.ceil(value / DTM_RESOLUTION) * DTM_RESOLUTION;
  return [
    Number(floor(west - margin).toFixed(8)),
    Number(floor(south - margin).toFixed(8)),
    Number(ceil(east + margin).toFixed(8)),
    Number(ceil(north + margin).toFixed(8)),
  ];
}

export function depthCoverageUrl([west, south, east, north]: DepthContourBbox): string {
  const params = new URLSearchParams({
    service: 'WCS',
    version: '1.0.0',
    request: 'GetCoverage',
    coverage: 'emodnet:mean',
    crs: 'EPSG:4326',
    bbox: `${west},${south},${east},${north}`,
    format: 'GeoTIFF',
    interpolation: 'bilinear',
    resx: String(DTM_RESOLUTION),
    resy: String(DTM_RESOLUTION),
  });
  return `${EMODNET_WCS}?${params}`;
}

function splitContourRing(ring: number[][], width: number, height: number): number[][][] {
  const onOuterEdge = (a: number[], b: number[]): boolean =>
    (a[0] === 0 && b[0] === 0) || (a[0] === width && b[0] === width)
    || (a[1] === 0 && b[1] === 0) || (a[1] === height && b[1] === height);
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

/** Genereerib DTM-ist 1–5 m meetrise sammuga, edasi 5 m intervalliga jooned. */
export async function fetchDenseDepthContours(
  requestedBbox: DepthContourBbox,
): Promise<DepthContourCollection> {
  const bbox = snapDepthContourBbox(requestedBbox);
  const cacheKey = `emodnet:dense-contours:v2:${bbox.join(':')}`;
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
    const maxDepth = depths.reduce((max, depth) => Number.isFinite(depth) ? Math.max(max, depth) : max, 0);
    const thresholds = [1, 2, 3, 4];
    for (let depth = 5; depth <= Math.ceil(maxDepth / 5) * 5; depth += 5) thresholds.push(depth);

    const [minLon, minLat, maxLon, maxLat] = image.getBoundingBox() as [
      number,
      number,
      number,
      number,
    ];
    const features: DepthContourFeature[] = contours()
      .size([width, height])
      .thresholds(thresholds)(depths)
      .map((contour) => {
        const pixelLines = contour.coordinates.flatMap((polygon) =>
          polygon.flatMap((ring) => splitContourRing(ring, width, height)));
        const coordinates = pixelLines
          .filter((line) => line.length >= 2)
          .map((line) => smoothContourLine(line).map(([x, y]) => [
            minLon + (x! / width) * (maxLon - minLon),
            maxLat - (y! / height) * (maxLat - minLat),
          ]));
        return {
          type: 'Feature' as const,
          geometry: { type: 'MultiLineString' as const, coordinates },
          properties: { elevation: Number(contour.value), generated: true as const },
        };
      })
      .filter((feature) => feature.geometry.coordinates.length > 0);
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
