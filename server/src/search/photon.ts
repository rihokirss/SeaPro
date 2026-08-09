import { distanceMetres, type BBox, type SearchResult } from '@seapro/shared';
import { cache } from '../cache.js';
import { config } from '../config.js';
import { fetchJson } from '../http.js';

interface PhotonFeature {
  properties?: {
    osm_type?: string;
    osm_id?: number;
    osm_key?: string;
    osm_value?: string;
    type?: string;
    name?: string;
    street?: string;
    locality?: string;
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
const PLACE_VALUES = new Set(['city', 'town', 'village', 'hamlet', 'island', 'islet', 'locality', 'municipality']);
const MAX_NEARBY_HARBOUR_DISTANCE_M = 5_000;
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
    .slice(0, 12)
    .map(({ _score: _ignored, ...result }) => result);
}

interface ReverseCandidate {
  feature: PhotonFeature;
  lat: number;
  lon: number;
  distanceM: number;
  index: number;
}

function reverseCandidate(feature: PhotonFeature, index: number, lat: number, lon: number): ReverseCandidate | null {
  const coordinates = feature.geometry?.coordinates;
  const featureLon = Number(coordinates?.[0]);
  const featureLat = Number(coordinates?.[1]);
  if (!feature.properties || !Number.isFinite(featureLat) || !Number.isFinite(featureLon)) return null;
  return {
    feature,
    lat: featureLat,
    lon: featureLon,
    distanceM: distanceMetres({ lat, lon }, { lat: featureLat, lon: featureLon }),
    index,
  };
}

function reverseResult(candidate: ReverseCandidate, name: string, kind: SearchResult['kind']): SearchResult {
  const p = candidate.feature.properties!;
  const subtitleParts = [p.locality, p.district, p.city, p.county, p.state, p.country]
    .filter((part, i, all): part is string => Boolean(part) && part !== name && all.indexOf(part) === i);
  return {
    id: p.osm_type && p.osm_id ? `${p.osm_type}${p.osm_id}` : `photon-reverse-${candidate.index}`,
    name,
    subtitle: subtitleParts.join(', ') || undefined,
    kind,
    lat: candidate.lat,
    lon: candidate.lon,
    zoom: kind === 'harbour' ? 14 : 11,
  };
}

/**
 * Valib pöördotsingu vastusest navigatsiooni jaoks arusaadava nime. Lähedal
 * asuv sadam on kõige kasulikum orientiir; muidu kasutame asulat või lähima
 * objekti aadressihierarhia kõige täpsemat kohanime, mitte maja/tee nime.
 */
export function parsePhotonReverse(input: unknown, lat: number, lon: number): SearchResult | null {
  const response = input as PhotonResponse;
  if (!response || !Array.isArray(response.features)) throw new Error('Photoni vastuse kuju muutus');
  const candidates = response.features
    .map((feature, index) => reverseCandidate(feature, index, lat, lon))
    .filter((candidate): candidate is ReverseCandidate => candidate !== null)
    .sort((a, b) => a.distanceM - b.distanceM);

  const harbour = candidates.find((candidate) => {
    const p = candidate.feature.properties!;
    return Boolean(p.name?.trim())
      && HARBOUR_VALUES.has(p.osm_value ?? '')
      && candidate.distanceM <= MAX_NEARBY_HARBOUR_DISTANCE_M;
  });
  if (harbour) return reverseResult(harbour, harbour.feature.properties!.name!.trim(), 'harbour');

  const explicitPlace = candidates.find((candidate) => {
    const p = candidate.feature.properties!;
    return Boolean(p.name?.trim())
      && (p.osm_key === 'place' || PLACE_VALUES.has(p.osm_value ?? '') || p.type === 'city' || p.type === 'locality');
  });
  if (explicitPlace) return reverseResult(explicitPlace, explicitPlace.feature.properties!.name!.trim(), 'location');

  for (const candidate of candidates) {
    const p = candidate.feature.properties!;
    const name = [p.locality, p.district, p.city, p.county]
      .find((part): part is string => Boolean(part?.trim()))?.trim();
    if (name) return reverseResult(candidate, name, 'location');
  }
  return null;
}

export async function searchPlaces(query: string, lang: 'et' | 'en' | 'fi', viewbox?: BBox): Promise<SearchResult[]> {
  const normalizedQuery = query.trim().replace(/\s+/g, ' ');
  const viewKey = viewbox?.map((n) => n.toFixed(2)).join(',') ?? '-';
  const key = `search:photon:v3:${lang}:${viewKey}:${normalized(normalizedQuery)}`;

  const { value } = await cache.get(key, config.ttl.search, () => rateLimited(async () => {
    const url = new URL('/api/', config.photonUrl);
    url.searchParams.set('q', normalizedQuery);
    // Võtame järjestamiseks laiema hulga: tiheda nimega „Tilgu” puhul oli
    // sadam Photoni 13. tulemus ja jäi väiksema limiidi korral üldse nägemata.
    // Kliendile tagastab parser pärast merendusjärjestust endiselt kuni 12.
    url.searchParams.set('limit', '50');
    if (lang !== 'et') url.searchParams.set('lang', lang);
    if (viewbox) {
      const [south, west, north, east] = viewbox;
      url.searchParams.set('lat', String((south + north) / 2));
      url.searchParams.set('lon', String((west + east) / 2));
      url.searchParams.set('zoom', '10');
      url.searchParams.set('location_bias_scale', '0.25');
    }
    return parsePhotonResults(
      await fetchJson<PhotonResponse>(url.toString(), { retries: 0 }),
      normalizedQuery,
    );
  }));
  return value;
}

export async function reversePlace(lat: number, lon: number, lang: 'et' | 'en' | 'fi'): Promise<SearchResult | null> {
  const key = `search:photon:reverse:v1:${lang}:${lat.toFixed(3)}:${lon.toFixed(3)}`;
  const { value } = await cache.get(key, config.ttl.search, () => rateLimited(async () => {
    const url = new URL('/reverse', config.photonUrl);
    url.searchParams.set('lat', String(lat));
    url.searchParams.set('lon', String(lon));
    url.searchParams.set('limit', '20');
    if (lang !== 'et') url.searchParams.set('lang', lang);
    return parsePhotonReverse(
      await fetchJson<PhotonResponse>(url.toString(), { retries: 0 }),
      lat,
      lon,
    );
  }));
  return value;
}
