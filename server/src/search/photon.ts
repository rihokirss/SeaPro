import type { BBox, SearchResult } from '@seapro/shared';
import { cache } from '../cache.js';
import { config } from '../config.js';
import { fetchJson } from '../http.js';

interface PhotonFeature {
  properties?: {
    osm_type?: string;
    osm_id?: number;
    osm_key?: string;
    osm_value?: string;
    name?: string;
    street?: string;
    district?: string;
    city?: string;
    county?: string;
    state?: string;
    country?: string;
    extent?: [number, number, number, number];
  };
  geometry?: { coordinates?: unknown[] };
}

interface PhotonResponse {
  type?: string;
  features?: PhotonFeature[];
}

const HARBOUR_VALUES = new Set(['marina', 'harbour', 'port', 'dock']);
let nextRequestAt = 0;
let requestQueue: Promise<void> = Promise.resolve();

/** Hoiame avaliku demo koormuse konservatiivselt ühe välispäringu juures sekundis. */
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

function zoomFor(kind: SearchResult['kind'], value: string, bbox?: BBox): number {
  if (kind === 'harbour') return 14;
  if (value === 'city' || value === 'town') return 11;
  if (!bbox) return 13;
  const span = Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]);
  if (span > 10) return 5;
  if (span > 3) return 7;
  if (span > 0.7) return 9;
  if (span > 0.15) return 11;
  return 13;
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase().normalize('NFKD').replace(/\p{Diacritic}/gu, '');
}

export function parsePhotonResults(input: unknown, query: string): SearchResult[] {
  const response = input as PhotonResponse;
  if (!response || !Array.isArray(response.features)) throw new Error('Photoni vastuse kuju muutus');
  const queryKey = normalized(query);

  const ranked = response.features.flatMap((feature, index) => {
    const p = feature.properties;
    const coordinates = feature.geometry?.coordinates;
    const lon = Number(coordinates?.[0]);
    const lat = Number(coordinates?.[1]);
    const name = p?.name?.trim();
    if (!p || !name || !Number.isFinite(lat) || !Number.isFinite(lon)) return [];

    const extent = p.extent;
    const bbox = extent?.length === 4 && extent.every(Number.isFinite)
      ? [extent[3], extent[0], extent[1], extent[2]] as BBox
      : undefined;
    const kind: SearchResult['kind'] = HARBOUR_VALUES.has(p.osm_value ?? '') ? 'harbour' : 'location';
    const subtitleParts = [p.street, p.district, p.city, p.county, p.state, p.country]
      .filter((part, i, all): part is string => Boolean(part) && part !== name && all.indexOf(part) === i);
    const nameKey = normalized(name);
    const score = (nameKey === queryKey ? 100 : nameKey.startsWith(queryKey) ? 50 : 0)
      + (kind === 'harbour' ? 75 : 0);

    return [{
      id: p.osm_type && p.osm_id ? `${p.osm_type}${p.osm_id}` : `photon-${index}`,
      name,
      subtitle: subtitleParts.join(', ') || undefined,
      kind,
      lat,
      lon,
      zoom: zoomFor(kind, p.osm_value ?? '', bbox),
      bbox,
      _score: score,
    }];
  });

  const seen = new Set<string>();
  return ranked.sort((a, b) => b._score - a._score)
    .filter((result) => {
      if (seen.has(result.id)) return false;
      seen.add(result.id);
      return true;
    })
    .map(({ _score: _ignored, ...result }) => result);
}

export async function searchPlaces(query: string, lang: 'et' | 'en', viewbox?: BBox): Promise<SearchResult[]> {
  const normalizedQuery = query.trim().replace(/\s+/g, ' ');
  const viewKey = viewbox?.map((n) => n.toFixed(2)).join(',') ?? '-';
  const key = `search:photon:v2:${lang}:${viewKey}:${normalized(normalizedQuery)}`;

  const { value } = await cache.get(key, config.ttl.search, async () => {
    const url = new URL('/api/', config.photonUrl);
    url.searchParams.set('q', normalizedQuery);
    url.searchParams.set('limit', '12');
    if (lang === 'en') url.searchParams.set('lang', 'en');
    if (viewbox) {
      const [south, west, north, east] = viewbox;
      url.searchParams.set('lat', String((south + north) / 2));
      url.searchParams.set('lon', String((west + east) / 2));
      url.searchParams.set('zoom', '10');
      url.searchParams.set('location_bias_scale', '0.25');
    }
    const harbourUrl = new URL(url);
    harbourUrl.searchParams.set('limit', '8');
    harbourUrl.searchParams.set('osm_tag', 'leisure:marina');

    // Kaks haru jagavad sama ühe-päringu-sekundis järjekorda. Üldotsing annab
    // kohad ja osalised nimed, sadamaharu tagab, et tiheda nimega päringus ei
    // jää marina esimese tulemuste lehe taha peitu.
    const [general, harbours] = await Promise.all([
      rateLimited(() => fetchJson<PhotonResponse>(url.toString(), { retries: 0 })),
      rateLimited(() => fetchJson<PhotonResponse>(harbourUrl.toString(), { retries: 0 })),
    ]);
    return parsePhotonResults({
      type: 'FeatureCollection',
      features: [...(general.features ?? []), ...(harbours.features ?? [])],
    }, normalizedQuery);
  });
  return value;
}
