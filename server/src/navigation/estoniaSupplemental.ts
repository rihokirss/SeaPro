import type { BBox, ExerciseArea, LightSector, NavigationAid, NavigationGeometry } from '@seapro/shared';
import { fetchJson } from '../http.js';
import { categoryFromRegistry } from './categories.js';
import { navigationSnapshots, snapshotAids } from './snapshots.js';

const SERVICES = 'https://gis.transpordiamet.ee/arcgis/rest/services/';
export const EXERCISE_AREAS_URL = `${SERVICES}Navigatsioonihoiatused/Laskealad/MapServer`;
const SECTORS_URL = `${SERVICES}Nutimeri/Tulesektorid_teenus/MapServer`;
const LOCAL_AIDS_URL = `${SERVICES}Nutimeri/Reglementeerimata_margid/MapServer`;
export const STATIC_NAVIGATION_TTL = 30 * 24 * 3600;
const PAGE_SIZE = 1000;

interface Feature {
  id?: number | string;
  geometry: NavigationGeometry;
  properties: Record<string, unknown>;
}

/** Täielik riiklik koopia: kaardivaade ei kuulu välispäringu võtmesse. */
async function readLayer<T>(url: string, parse: (features: Feature[]) => T[]): Promise<T[]> {
  const features: Feature[] = [];
  const seen = new Set<string>();
  for (let offset = 0; offset < 100_000; offset += PAGE_SIZE) {
    const params = new URLSearchParams({
      f: 'geojson', where: '1=1', outFields: '*', outSR: '4326',
      returnGeometry: 'true', orderByFields: 'objectid ASC',
      resultOffset: String(offset), resultRecordCount: String(PAGE_SIZE),
    });
    const page = await fetchJson<{
      type?: string; features?: Feature[]; error?: { message?: string };
      exceededTransferLimit?: boolean; properties?: { exceededTransferLimit?: boolean };
    }>(`${url}/query?${params}`, { timeoutMs: 12_000, retries: 0 });
    if (page.error || page.type !== 'FeatureCollection' || !Array.isArray(page.features)
      || page.features.some((f) => !f || !f.properties || !validGeometry(f.geometry))) {
      throw new Error(`Vigane navigatsioonikiht: ${url}: ${page.error?.message ?? 'GeoJSON'}`);
    }
    for (const feature of page.features) {
      const id = identity(feature);
      if (seen.has(id)) throw new Error(`Korduv navigatsiooniobjekt lehekülgedel: ${url}: ${id}`);
      seen.add(id);
      features.push(feature);
    }
    const more = page.exceededTransferLimit || page.properties?.exceededTransferLimit;
    if (!more && page.features.length < PAGE_SIZE) return parse(features);
    if (!page.features.length) throw new Error(`Katkenud navigatsioonikihi lehekülg: ${url}`);
  }
  throw new Error(`Navigatsioonikihi lehekülgede piir ületatud: ${url}`);
}

export async function fetchLightSectors(bbox: BBox): Promise<LightSector[]> {
  const snapshot = await navigationSnapshots.get('estonia:light-sectors:v1', STATIC_NAVIGATION_TTL,
    async () => {
      const out: LightSector[] = [];
      // Ainult pindgeomeetriad: siltide/kaarte kihid kordaksid samu sektoreid.
      // Üks järjestikune allalaadimine; mitme brauseri päringud jagavad sama tööd.
      for (const layer of [2, 5, 8, 11, 15, 18, 21, 24]) {
        out.push(...await readLayer(`${SECTORS_URL}/${layer}`, (features) => parseLightSectors(features, layer)));
      }
      return out;
    }, isLightSectors, 3600);
  return snapshot.value.filter((item) => intersectsBbox(item.geometry, bbox));
}

export async function fetchExerciseAreasWithMeta(bbox: BBox) {
  const snapshot = await navigationSnapshots.get('estonia:exercise-areas:v1', STATIC_NAVIGATION_TTL,
    () => readLayer(`${EXERCISE_AREAS_URL}/0`, parseExerciseAreas), isExerciseAreas, 3600);
  return { ...snapshot, value: snapshot.value.filter((item) => intersectsBbox(item.geometry, bbox)) };
}

export async function fetchLocalNavigationAids(bbox: BBox): Promise<NavigationAid[]> {
  const snapshot = await navigationSnapshots.get('estonia:local-aids:v1', STATIC_NAVIGATION_TTL,
    () => readLayer(`${LOCAL_AIDS_URL}/0`, parseLocalNavigationAids), isLocalAids, 3600);
  return snapshotAids(snapshot.value.filter((aid) => aid.lat >= bbox[0] && aid.lat <= bbox[2]
    && aid.lon >= bbox[1] && aid.lon <= bbox[3]), snapshot);
}

export function parseLightSectors(features: Feature[], layer: number): LightSector[] {
  return features.map((f) => {
    const p = f.properties;
    const atonCode = text(p.aton), name = text(p.atonn);
    const mode = text(p.night_day);
    const colour = text(p.sect_colour).toUpperCase();
    const fromDegrees = number(p.begin_direction), toDegrees = number(p.end_direction), rangeNm = number(p.range);
    if (!atonCode || !name || (mode !== 'day' && mode !== 'night') || !colour
      || fromDegrees === undefined || fromDegrees < 0 || fromDegrees > 360
      || toDegrees === undefined || toDegrees < 0 || toDegrees > 360
      || rangeNm === undefined || rangeNm < 0 || !isArea(f.geometry)) {
      throw new Error('Tulesektori kohustuslikud väljad on vigased');
    }
    return { id: `light-sector:${layer}:${identity(f)}`, atonCode, name,
      geometry: f.geometry, mode, colour, fromDegrees, toDegrees, rangeNm };
  });
}

export function parseExerciseAreas(features: Feature[]): ExerciseArea[] {
  return features.map((f) => {
    if (!isArea(f.geometry) || !text(f.properties.objnam)) throw new Error('Laskeala andmed on vigased');
    return { id: `exercise-area:${identity(f)}`, name: text(f.properties.objnam), geometry: f.geometry,
      description: text(f.properties.ninfom) || text(f.properties.inform) || undefined };
  });
}

export function parseLocalNavigationAids(features: Feature[]): NavigationAid[] {
  return features.map((f) => {
    const p = f.properties;
    const name = text(p.nimi), registryType = text(p.liik);
    if (!name || f.geometry.type !== 'Point') throw new Error('Kohaliku meremärgi andmed on vigased');
    const kind = /poi|tooder/i.test(registryType) ? 'floating' : 'fixed';
    const colours = text(p['värv']).toLowerCase();
    const markColours = (['punane', 'roheline', 'valge', 'kollane', 'oranž', 'must', 'hall'] as const)
      .flatMap((colour, i) => colours.includes(colour)
        ? [(['red', 'green', 'white', 'yellow', 'orange', 'black', 'grey'] as const)[i]!] : []);
    return { id: `aton:local:${identity(f)}`, name, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1],
      kind, registryType, category: categoryFromRegistry(name, kind, colours, registryType),
      markColours, unregulated: true, description: text(p.kirjeldus) || undefined,
      location: text(p.asukoht) || undefined, lightDetails: text(p.tuli) || undefined,
      sources: ['transpordiamet-local'] };
  });
}

function identity(f: Feature): string {
  const id = f.properties.objectid ?? f.id;
  if ((typeof id !== 'number' && typeof id !== 'string') || !String(id).trim()) {
    throw new Error('Navigatsiooniobjekti identifikaator puudub');
  }
  return String(id);
}

function text(value: unknown): string { return value == null ? '' : String(value).trim(); }
function number(value: unknown): number | undefined {
  if (value == null || text(value) === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
function isArea(g: NavigationGeometry): g is ExerciseArea['geometry'] {
  return g.type === 'Polygon' || g.type === 'MultiPolygon';
}
function validGeometry(value: unknown): value is NavigationGeometry {
  if (!value || typeof value !== 'object') return false;
  const g = value as NavigationGeometry;
  const point = (p: unknown): boolean => Array.isArray(p) && p.length >= 2
    && typeof p[0] === 'number' && typeof p[1] === 'number' && Number.isFinite(p[0]) && Number.isFinite(p[1])
    && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
  const ring = (r: unknown): boolean => Array.isArray(r) && r.length >= 4 && r.every(point)
    && r[0][0] === r.at(-1)[0] && r[0][1] === r.at(-1)[1];
  const polygon = (p: unknown): boolean => Array.isArray(p) && p.length > 0 && p.every(ring);
  return g.type === 'Point' ? point(g.coordinates)
    : g.type === 'Polygon' ? polygon(g.coordinates)
      : g.type === 'MultiPolygon' && Array.isArray(g.coordinates) && g.coordinates.length > 0 && g.coordinates.every(polygon);
}
function intersectsBbox(g: ExerciseArea['geometry'], bbox: BBox): boolean {
  const points = g.type === 'Polygon' ? g.coordinates.flat() : g.coordinates.flat(2);
  let south = Infinity, west = Infinity, north = -Infinity, east = -Infinity;
  for (const [lon, lat] of points) {
    south = Math.min(south, lat); north = Math.max(north, lat);
    west = Math.min(west, lon); east = Math.max(east, lon);
  }
  return south <= bbox[2] && north >= bbox[0] && west <= bbox[3] && east >= bbox[1];
}
const isLightSectors = (v: unknown): v is LightSector[] => Array.isArray(v) && v.every((s) => s
  && typeof s.id === 'string' && typeof s.atonCode === 'string' && typeof s.name === 'string'
  && (s.mode === 'day' || s.mode === 'night') && typeof s.colour === 'string'
  && Number.isFinite(s.fromDegrees) && Number.isFinite(s.toDegrees) && Number.isFinite(s.rangeNm)
  && validGeometry(s.geometry) && isArea(s.geometry));
const isExerciseAreas = (v: unknown): v is ExerciseArea[] => Array.isArray(v) && v.every((a) => a
  && typeof a.id === 'string' && typeof a.name === 'string' && validGeometry(a.geometry) && isArea(a.geometry));
const isLocalAids = (v: unknown): v is NavigationAid[] => Array.isArray(v) && v.every((a) => a
  && typeof a.id === 'string' && typeof a.name === 'string' && a.unregulated === true
  && Number.isFinite(a.lat) && Math.abs(a.lat) <= 90 && Number.isFinite(a.lon) && Math.abs(a.lon) <= 180
  && Array.isArray(a.sources) && a.sources.includes('transpordiamet-local'));
