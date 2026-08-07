import type { BBox, NavigationAid } from '@seapro/shared';
import { cache } from '../cache.js';
import { fetchJson } from '../http.js';
import { categoryFromFinnishNavigationCode } from './categories.js';

const WFS = 'https://avoinapi.vaylapilvi.fi/vaylatiedot/ows';
const LAYER = 'vesivaylatiedot:turvalaitteet_uusi';
const FINLAND: BBox = [59.4, 19.0, 70.2, 31.7];
const STATIC_TTL = 24 * 3600;
const PAGE_SIZE = 10_000;

interface FinnishAidFeature {
  id?: string;
  geometry?: {
    type?: string;
    coordinates?: unknown;
  };
  properties?: Record<string, unknown>;
}

interface FinnishAidCollection {
  features?: FinnishAidFeature[];
  numberMatched?: number;
  numberReturned?: number;
}

/**
 * Laadib nähtava ala Soome ametlikud navigatsioonimärgid GeoJSON-ina.
 *
 * Rasterkaart jääb visuaalseks aluseks; need punktid annavad samadele
 * märkidele klikitavuse ja registri atribuudid. Väga laias vaates pole
 * punktikiht niikuinii nähtav (klient näitab seda alates suumist 10), seega
 * ei tõmba me kogemata kogu Soome 35 000 märki korraga.
 */
export async function fetchFinnishNavigationAids(bbox: BBox): Promise<NavigationAid[]> {
  const clipped = intersectBbox(bbox, FINLAND);
  if (!clipped) return [];
  if (clipped[2] - clipped[0] > 5 || clipped[3] - clipped[1] > 5) return [];

  const snapped = snapBbox(clipped);
  const key = `vaylavirasto:navigation:v1:${snapped.join(',')}`;
  const { value } = await cache.get(key, STATIC_TTL, async () => {
    const features: FinnishAidFeature[] = [];
    let startIndex = 0;

    do {
      const page = await queryAids(snapped, startIndex);
      const returned = page.features?.length ?? 0;
      features.push(...(page.features ?? []));
      startIndex += returned;
      if (returned === 0 || startIndex >= (page.numberMatched ?? startIndex)) break;
    } while (startIndex < 50_000);

    return parseFinnishNavigationAids({ features });
  });
  return value;
}

async function queryAids(bbox: BBox, startIndex: number): Promise<FinnishAidCollection> {
  const [south, west, north, east] = bbox;
  const params = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeNames: LAYER,
    bbox: `${west},${south},${east},${north},EPSG:4326`,
    srsName: 'EPSG:4326',
    outputFormat: 'application/json',
    count: String(PAGE_SIZE),
    startIndex: String(startIndex),
  });
  return fetchJson<FinnishAidCollection>(`${WFS}?${params}`, { timeoutMs: 30_000 });
}

export function parseFinnishNavigationAids(
  collection: FinnishAidCollection,
): NavigationAid[] {
  return (collection.features ?? []).flatMap((feature) => {
    const coordinates = firstPoint(feature.geometry?.coordinates);
    if (!coordinates) return [];

    const p = feature.properties ?? {};
    const id = text(p.id) ?? feature.id ?? text(p.turvalaitenumero) ?? 'unknown';
    const type = text(p.turvalaitetyyppifi);
    const navigationCode = finiteNumber(p.navigointilajikoodi);
    const kind: NavigationAid['kind'] = text(p.alityyppi) === 'KELLUVA'
      ? 'floating'
      : 'fixed';
    const name = text(p.nimifi) ?? text(p.nimisv) ?? type ?? 'Navigatsioonimärk';
    const category = categoryFromFinnishNavigationCode(navigationCode)
      ?? categoryFromFinnishType(type, name);

    return [{
      id: `aton:vaylavirasto:${id}`,
      lon: coordinates[0],
      lat: coordinates[1],
      name,
      kind,
      category,
      atonCode: text(p.turvalaitenumero),
      registryType: type,
      markColours: markColours(text(p.paivatunnusten_tiedot)),
      status: finiteNumber(p.toimintatilakoodi),
      lightActive: text(p.valaistu) === 'K',
      mmsi: finiteNumber(p.mmsi),
      owner: text(p.omistajafi) ?? text(p.omistaja),
      location: text(p.sijaintifi),
      fairwayName: cleanFairwayName(text(p.vaylan_nimi)),
      lightDetails: usefulDetails(p.loistojen_tiedot),
      lightSectors: usefulDetails(p.valosektorien_tiedot),
      updatedAt: isoDate(p.paivitypaivamaara),
      sources: ['vaylavirasto'],
    } satisfies NavigationAid];
  });
}

function firstPoint(value: unknown): [number, number] | null {
  if (!Array.isArray(value)) return null;
  const candidate = typeof value[0] === 'number' ? value : value[0];
  if (!Array.isArray(candidate)) return null;
  const lon = Number(candidate[0]);
  const lat = Number(candidate[1]);
  return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : null;
}

function categoryFromFinnishType(
  type: string | undefined,
  name: string,
): NavigationAid['category'] {
  if (type === 'Merimajakka') return 'lighthouse';
  if (type === 'Linjamerkki') {
    if (/\b(alempi|nedre)\b/i.test(name)) return 'leading-front';
    if (/\b(ylempi|övre)\b/i.test(name)) return 'leading-rear';
    return 'leading';
  }
  if (type === 'Suuntaloisto') return 'leading';
  return 'beacon';
}

function markColours(value: string | undefined): NavigationAid['markColours'] | undefined {
  if (!value) return undefined;
  const colourField = value.match(/Väri:\s*([^,\n]+)/i)?.[1] ?? value;
  const colours: NonNullable<NavigationAid['markColours']> = [];
  const mappings: Array<[RegExp, NonNullable<NavigationAid['markColours']>[number]]> = [
    [/punainen/i, 'red'],
    [/vihreä/i, 'green'],
    [/valkoinen/i, 'white'],
    [/keltainen/i, 'yellow'],
    [/oranssi/i, 'orange'],
    [/musta/i, 'black'],
    [/harmaa/i, 'grey'],
  ];
  for (const [pattern, colour] of mappings) {
    if (pattern.test(colourField)) colours.push(colour);
  }
  return colours.length ? colours : undefined;
}

function cleanFairwayName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const names = [...value.matchAll(/\[\d+:\s*([^\]]+)\]/g)].map((match) => match[1]!.trim());
  return names.length ? [...new Set(names)].join(', ') : value.replace(/\([^)]*\)/g, '').trim();
}

function usefulDetails(value: unknown): string | undefined {
  const result = text(value);
  return result && result !== '-' ? result : undefined;
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const result = String(value).trim();
  return result || undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}

function isoDate(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function intersectBbox(a: BBox, b: BBox): BBox | null {
  const clipped: BBox = [
    Math.max(a[0], b[0]),
    Math.max(a[1], b[1]),
    Math.min(a[2], b[2]),
    Math.min(a[3], b[3]),
  ];
  return clipped[0] < clipped[2] && clipped[1] < clipped[3] ? clipped : null;
}

function snapBbox([south, west, north, east]: BBox): BBox {
  const step = 0.25;
  return [
    Math.floor(south / step) * step,
    Math.floor(west / step) * step,
    Math.ceil(north / step) * step,
    Math.ceil(east / step) * step,
  ];
}
