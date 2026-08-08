import type { BBox, RoutePlanSource } from '@seapro/shared';
import { fromArrayBuffer } from 'geotiff';
import { cache } from '../cache.js';
import { depthCoverageUrl, type DepthContourBbox } from '../depthContours.js';
import { request } from '../http.js';

const NATIVE_RESOLUTION = 1 / 960;
const TTL_SECONDS = 30 * 86400;
const DEFAULT_MAX_CELLS = 750_000;

export const enum RoutingDepthState {
  NoData = 0,
  Water = 1,
  Land = 2,
}

/** Marsruutimiseks loetav, põhjast üles indekseeritud WGS84 sügavusvõre. */
export interface RoutingDepthRaster {
  bbox: DepthContourBbox;
  width: number;
  height: number;
  depths: Float32Array;
  states: Uint8Array;
  source: RoutePlanSource;
}

function routeResolution([south, west, north, east]: BBox, maxCells: number): number {
  const nativeCells = Math.max(1, (north - south) / NATIVE_RESOLUTION)
    * Math.max(1, (east - west) / NATIVE_RESOLUTION);
  const scale = Math.max(1, Math.sqrt(nativeCells / maxCells));
  return Number((NATIVE_RESOLUTION * scale).toPrecision(8));
}

function snapBbox([south, west, north, east]: BBox, resolution: number): DepthContourBbox {
  const margin = resolution * 2;
  const floor = (value: number): number => Math.floor(value / resolution) * resolution;
  const ceil = (value: number): number => Math.ceil(value / resolution) * resolution;
  return [
    Number(floor(west - margin).toFixed(8)),
    Number(floor(south - margin).toFixed(8)),
    Number(ceil(east + margin).toFixed(8)),
    Number(ceil(north + margin).toFixed(8)),
  ];
}

function isNoData(value: number, marker: number | null): boolean {
  if (!Number.isFinite(value)) return true;
  if (marker === null || !Number.isFinite(marker)) return false;
  return value === marker || Math.abs(value - marker) <= Number.EPSILON * Math.max(1, Math.abs(marker));
}

export async function fetchRoutingDepthRaster(
  bbox: BBox,
  maxCells = DEFAULT_MAX_CELLS,
): Promise<RoutingDepthRaster> {
  const resolution = routeResolution(bbox, maxCells);
  const requested = snapBbox(bbox, resolution);
  const key = `emodnet:routing-raster:v2:${requested.join(':')}:${resolution}`;
  const result = await cache.get(key, TTL_SECONDS, async () => {
    const response = await request(depthCoverageUrl(requested, {
      // `mean_atlas_land` on WCS GetCapabilities'is küll kirjas, kuid server
      // keeldub seda GetCoverage'is teenindamast. Maa tuleb OpenFreeMapi
      // vektormaskist; siin säilitame `mean` kattes land/noData eraldi.
      coverage: 'emodnet:mean',
      resolution,
    }), {
      headers: { Accept: 'image/tiff' }, timeoutMs: 45_000, retries: 1,
    });
    const contentType = response.headers.get('content-type') ?? '';
    const payload = await response.arrayBuffer();
    if (!contentType.toLowerCase().includes('tiff')) {
      const detail = new TextDecoder().decode(payload).replace(/<[^>]+>/g, ' ').trim();
      throw new Error(`EMODnet WCS ei tagastanud GeoTIFF-i: ${detail.slice(0, 180)}`);
    }
    const tiff = await fromArrayBuffer(payload);
    const image = await tiff.getImage();
    const raw = await image.readRasters({ interleave: true });
    const marker = image.getGDALNoData();
    const values = raw as ArrayLike<number>;
    const depths = new Float32Array(values.length);
    depths.fill(Number.NaN);
    const states = new Uint8Array(values.length);

    for (let index = 0; index < values.length; index++) {
      const value = Number(values[index]);
      if (isNoData(value, marker)) continue;
      if (value < 0) {
        states[index] = RoutingDepthState.Water;
        depths[index] = -value;
      } else {
        states[index] = RoutingDepthState.Land;
      }
    }

    return {
      bbox: image.getBoundingBox() as DepthContourBbox,
      width: image.getWidth(),
      height: image.getHeight(),
      depths,
      states,
    };
  });

  return {
    ...result.value,
    source: {
      id: 'emodnet-depth',
      fetchedAt: new Date(Date.now() - result.ageSeconds * 1000).toISOString(),
      ageSeconds: result.ageSeconds,
      stale: result.stale,
      coverage: 'complete',
      error: result.fallbackError instanceof Error ? result.fallbackError.message : undefined,
    },
  };
}

export function routingDepthAt(
  raster: RoutingDepthRaster,
  lon: number,
  lat: number,
): { state: RoutingDepthState; depthM: number | null } {
  const [west, south, east, north] = raster.bbox;
  if (lon < west || lon > east || lat < south || lat > north) {
    return { state: RoutingDepthState.NoData, depthM: null };
  }
  const x = Math.max(0, Math.min(raster.width - 1,
    Math.floor((lon - west) / (east - west) * raster.width)));
  const y = Math.max(0, Math.min(raster.height - 1,
    Math.floor((north - lat) / (north - south) * raster.height)));
  const index = y * raster.width + x;
  const state = raster.states[index] as RoutingDepthState;
  return {
    state,
    depthM: state === RoutingDepthState.Water && Number.isFinite(raster.depths[index])
      ? raster.depths[index]!
      : null,
  };
}
