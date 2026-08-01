import type { BBox, SearchResult } from '@seapro/shared';
import { cache } from '../cache.js';
import { config } from '../config.js';
import { fetchJson } from '../http.js';

interface NominatimPlace {
  place_id?: number;
  osm_type?: 'node' | 'way' | 'relation';
  osm_id?: number;
  lat?: string;
  lon?: string;
  display_name?: string;
  name?: string;
  type?: string;
  category?: string;
  class?: string;
  boundingbox?: [string, string, string, string];
}

const HARBOUR_TYPES = new Set(['marina', 'harbour', 'port', 'dock']);
let nextRequestAt = 0;
let requestQueue: Promise<void> = Promise.resolve();

/** Avaliku Nominatimi piir on kogu rakenduse peale üks päring sekundis. */
function rateLimited<T>(task: () => Promise<T>): Promise<T> {
  const run = requestQueue.then(async () => {
    const waitMs = Math.max(0, nextRequestAt - Date.now());
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    nextRequestAt = Date.now() + 1000;
    return task();
  });
  requestQueue = run.then(() => undefined, () => undefined);
  return run;
}

function finite(raw: string | undefined): number | undefined {
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function resultZoom(place: NominatimPlace, bbox: BBox | undefined): number {
  if (HARBOUR_TYPES.has(place.type ?? '')) return 14;
  if (!bbox) return place.type === 'city' || place.type === 'town' ? 11 : 13;
  const span = Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]);
  if (span > 10) return 5;
  if (span > 3) return 7;
  if (span > 0.7) return 9;
  if (span > 0.15) return 11;
  return 13;
}

export function parseNominatimResults(input: unknown): SearchResult[] {
  if (!Array.isArray(input)) throw new Error('Nominatimi vastuse kuju muutus');

  const results: SearchResult[] = [];
  for (const raw of input as NominatimPlace[]) {
    const lat = finite(raw.lat);
    const lon = finite(raw.lon);
    const display = raw.display_name?.trim();
    if (lat === undefined || lon === undefined || !display) continue;

    const parts = display.split(',').map((part) => part.trim()).filter(Boolean);
    const displayName = parts.shift();
    const name = raw.name?.trim() || displayName;
    if (!name) continue;

    const bounds = raw.boundingbox?.map(Number);
    const bbox = bounds?.length === 4 && bounds.every(Number.isFinite)
      ? [bounds[0]!, bounds[2]!, bounds[1]!, bounds[3]!] as BBox
      : undefined;
    const osmPrefix = raw.osm_type?.[0]?.toUpperCase();
    const id = osmPrefix && raw.osm_id ? `${osmPrefix}${raw.osm_id}` : `place-${raw.place_id ?? results.length}`;
    const type = raw.type ?? '';
    const category = raw.category ?? raw.class ?? '';
    const kind = HARBOUR_TYPES.has(type) || category === 'waterway' && type === 'dock'
      ? 'harbour'
      : 'location';

    results.push({
      id,
      name,
      subtitle: parts.join(', ') || undefined,
      kind,
      lat,
      lon,
      zoom: resultZoom(raw, bbox),
      bbox,
    });
  }
  return results;
}

export async function searchPlaces(
  query: string,
  lang: 'et' | 'en',
  viewbox?: BBox,
): Promise<SearchResult[]> {
  const normalized = query.trim().replace(/\s+/g, ' ');
  const viewKey = viewbox?.map((n) => n.toFixed(2)).join(',') ?? '-';
  const key = `search:v1:${lang}:${viewKey}:${normalized.toLocaleLowerCase(lang)}`;

  const { value } = await cache.get(key, config.ttl.search, () => rateLimited(async () => {
    const url = new URL('/search', config.nominatimUrl);
    url.searchParams.set('q', normalized);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('addressdetails', '0');
    url.searchParams.set('limit', '8');
    url.searchParams.set('accept-language', lang);
    if (viewbox) {
      const [south, west, north, east] = viewbox;
      url.searchParams.set('viewbox', `${west},${north},${east},${south}`);
      url.searchParams.set('bounded', '0');
    }
    return parseNominatimResults(await fetchJson<unknown>(url.toString(), { retries: 0 }));
  }));
  return value;
}
