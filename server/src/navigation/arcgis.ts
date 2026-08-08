import type {
  Fairway,
  Harbour,
  NavigationAid,
  NavigationGeometry,
  NavigationWarning,
  Wreck,
} from '@seapro/shared';
import { cache } from '../cache.js';
import { fetchJson } from '../http.js';
import { categoryFromRegistry } from './categories.js';
import { fetchNmaAidIndex, markColoursFromNma, type NmaAidIndex } from './nmaRegistry.js';

const WARNINGS =
  'https://gis.transpordiamet.ee/arcgis/rest/services/' +
  'Navigatsioonihoiatused/Nav_hoiatused_avalik/FeatureServer';
const MARITIME =
  'https://gis.transpordiamet.ee/arcgis/rest/services/Nutimeri/pohiandmed/MapServer';
const WRECKS =
  'https://gis.transpordiamet.ee/arcgis/rest/services/Nutimeri/HIS/MapServer/7';

const STATIC_TTL = 24 * 3600;
const WARNING_TTL = 2 * 60;

interface ArcFeature {
  id?: string | number;
  geometry?: NavigationGeometry;
  properties?: Record<string, unknown>;
}

interface ArcCollection {
  features?: ArcFeature[];
  error?: { message?: string };
}

export async function fetchNavigationWarnings(
  bbox: [number, number, number, number],
): Promise<NavigationWarning[]> {
  return (await fetchNavigationWarningsWithMeta(bbox)).warnings;
}

export interface NavigationWarningResult {
  warnings: NavigationWarning[];
  ageSeconds: number;
  stale: boolean;
  error?: string;
}

/** Sama hoiatuseloend koos routingus vajaliku cache'i värskusjäljega. */
export async function fetchNavigationWarningsWithMeta(
  bbox: [number, number, number, number],
): Promise<NavigationWarningResult> {
  const snapped = snapBbox(bbox);
  const key = `nutimeri:warnings:v1:${snapped.join(',')}`;
  const result = await cache.get(key, WARNING_TTL, async () => {
    const collections = await Promise.all(
      [7, 8, 9].map((layer) => queryLayer(`${WARNINGS}/${layer}`, snapped, 'status = 2')),
    );
    return collections.flatMap((collection, index) =>
      (collection.features ?? []).flatMap((feature) => {
        if (!feature.geometry) return [];
        const p = feature.properties ?? {};
        return [{
          id: `warning:${index + 7}:${stringValue(p.objectid) ?? feature.id ?? 'unknown'}`,
          geometry: feature.geometry,
          number: numberValue(p.warning_number),
          titleEt: clean(p.ntfct_title_est),
          titleEn: clean(p.ntfct_title_eng),
          textEt: plainText(p.ntfct_text_est),
          textEn: plainText(p.ntfct_text_eng),
          areaEt: clean(p.area_est),
          areaEn: clean(p.area_eng),
          charts: clean(p.charts),
          validFrom: dateValue(p.date_from),
          validTo: dateValue(p.date_to),
          documentUrl: safeHttpUrl(p.document_url),
        } satisfies NavigationWarning];
      }),
    );
  });

  const now = Date.now();
  return {
    warnings: result.value.filter((warning) =>
      !warning.validTo || new Date(warning.validTo).getTime() >= now),
    ageSeconds: result.ageSeconds,
    stale: result.stale,
    ...(result.fallbackError
      ? { error: result.fallbackError instanceof Error ? result.fallbackError.message : String(result.fallbackError) }
      : {}),
  };
}

export async function fetchWrecks(bbox: [number, number, number, number]): Promise<Wreck[]> {
  const snapped = snapBbox(bbox);
  const key = `nutimeri:wrecks:v1:${snapped.join(',')}`;
  const { value } = await cache.get(key, STATIC_TTL, async () => {
    const collection = await queryLayer(WRECKS, snapped, '1 = 1');
    return (collection.features ?? []).flatMap((feature) => {
      if (feature.geometry?.type !== 'Point') return [];
      const p = feature.properties ?? {};
      return [{
        id: `wreck:${stringValue(p.id) ?? p.objectid ?? feature.id ?? 'unknown'}`,
        lat: feature.geometry.coordinates[1],
        lon: feature.geometry.coordinates[0],
        name: clean(p.laevanimi) ?? 'Nimetu vrakk',
        wreckDepthM: positiveNumber(p.vraki_sygavus),
        surroundingDepthM: positiveNumber(p.ymbr_ala_sygavus),
        heightM: positiveNumber(p.vraki_korgus),
        lengthM: positiveNumber(p.vraki_pikkus) ?? positiveNumber(p.laeva_pikkus),
        widthM: positiveNumber(p.vraki_laius) ?? positiveNumber(p.laeva_laius),
        vesselType: clean(p.laevatyyp),
        sunkAt: clean(p.hukk_aeg),
        sunkReason: clean(p.hukk_pohjus),
        condition: clean(p.vraki_seisund),
        history: clean(p.ajalugu),
        notes: clean(p.markused),
        model3dUrl: safeHttpUrl(p.link3d),
      } satisfies Wreck];
    });
  });
  return value;
}

export async function fetchOfficialNavigation(
  bbox: [number, number, number, number],
): Promise<{ aids: NavigationAid[]; fairways: Fairway[] }> {
  const snapped = snapBbox(bbox);
  const key = `nutimeri:navigation:v6:${snapped.join(',')}`;
  const { value } = await cache.get(key, STATIC_TTL, async () => {
    const [nmaIndex, fairwayCollection, ...aidCollections] = await Promise.all([
      // Registri koondfail on rikastus, mitte kaardi töötamise eeltingimus.
      fetchNmaAidIndex().catch((): NmaAidIndex => ({})),
      queryLayer(`${MARITIME}/0`, snapped, '1 = 1'),
      queryLayer(`${MARITIME}/1`, snapped, '1 = 1'),
      queryLayer(`${MARITIME}/2`, snapped, '1 = 1'),
      queryLayer(`${MARITIME}/3`, snapped, '1 = 1'),
    ]);

    const fairways: Fairway[] = (fairwayCollection.features ?? []).flatMap((feature) => {
      if (feature.geometry?.type !== 'LineString' && feature.geometry?.type !== 'MultiLineString') {
        return [];
      }
      const p = feature.properties ?? {};
      return [{
        id: `fairway:${stringValue(p.ident) ?? p.objectid ?? feature.id ?? 'unknown'}`,
        geometry: feature.geometry,
        name: clean(p.nimi) ?? clean(p.ident) ?? 'Laevatee',
        fairwayClass: clean(p.fairway_class),
        depthM: positiveNumber(p.depth),
        shipDraughtM: positiveNumber(p.ship_draught),
        widthM: positiveNumber(p.width) ?? positiveNumber(p.laius),
        type: clean(p.type_text) ?? clean(p.type),
      } satisfies Fairway];
    });

    const kinds: NavigationAid['kind'][] = ['fixed', 'floating', 'seasonal'];
    const aids = aidCollections.flatMap((collection, index) =>
      (collection.features ?? []).flatMap((feature) => {
        if (feature.geometry?.type !== 'Point') return [];
        const p = feature.properties ?? {};
        const name = clean(p.atonn) ?? clean(p.aton) ?? 'Navigatsioonimärk';
        const kind = kinds[index]!;
        const atonCode = clean(p.aton);
        const registryId = stringValue(p.aton_id);
        const registry = atonCode ? nmaIndex[atonCode] : undefined;
        const lightColour = clean(p.light_colour_name) ?? clean(p.light_colour);
        return [{
          id: `aton:registry:${registryId ?? p.objectid ?? feature.id ?? 'unknown'}`,
          lat: feature.geometry.coordinates[1],
          lon: feature.geometry.coordinates[0],
          name,
          nameEn: clean(p.atonn_enl),
          kind,
          category: categoryFromRegistry(name, kind, lightColour, registry?.typeName),
          atonCode,
          registryType: registry?.typeName,
          registryUrl: registryId ? `https://nma.vta.ee/aton/${encodeURIComponent(registryId)}/` : undefined,
          markColours: markColoursFromNma(registry),
          status: numberValue(p.status),
          lightActive: booleanNumber(p.light_active),
          lightColour,
          owner: clean(p.owner),
          activeFrom: clean(p.active_from),
          activeTill: clean(p.active_till),
          updatedAt: dateValue(p.updated),
          sources: ['registry'],
        } satisfies NavigationAid];
      }),
    );

    return { fairways, aids };
  });
  return value;
}

export async function fetchOfficialHarbours(
  bbox: [number, number, number, number],
): Promise<Harbour[]> {
  const snapped = snapBbox(bbox);
  const key = `nutimeri:harbours:v2:${snapped.join(',')}`;
  const { value } = await cache.get(key, STATIC_TTL, async () => {
    const collection = await queryLayer(`${MARITIME}/4`, snapped, '1 = 1');
    return (collection.features ?? []).flatMap((feature) => {
      if (feature.geometry?.type !== 'Point') return [];
      const p = feature.properties ?? {};
      // Selle kihi IFCID on kõigil kontrollitud sadamatel 0. ArcGIS objectid
      // on tegelik unikaalne võti, kui INSPIRE localid puudub.
      const id = clean(p.id_localid) ?? stringValue(p.objectid) ?? stringValue(p.ifcid);
      return [{
        id: `transpordiamet/${id ?? feature.id ?? 'unknown'}`,
        officialId: id,
        kind: 'harbour' as const,
        name: clean(p.name) ?? 'Sadam',
        lat: feature.geometry.coordinates[1],
        lon: feature.geometry.coordinates[0],
        maxDraught: positiveNumber(p.ship_draugth) ?? positiveNumber(p.in_depth),
        registryUrl: safeHttpUrl(p.reg_link),
        locode: clean(p.locode),
        category: clean(p.port_task),
        sources: ['transpordiamet' as const],
      }];
    });
  });
  return value;
}

async function queryLayer(
  layerUrl: string,
  bbox: [number, number, number, number],
  where: string,
): Promise<ArcCollection> {
  const [south, west, north, east] = bbox;
  const params = new URLSearchParams({
    f: 'geojson',
    where,
    outFields: '*',
    returnGeometry: 'true',
    geometry: `${west},${south},${east},${north}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    outSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
  });
  const result = await fetchJson<ArcCollection>(`${layerUrl}/query?${params}`, {
    timeoutMs: 30_000,
  });
  if (result.error) throw new Error(`ArcGIS: ${result.error.message ?? 'päring ebaõnnestus'}`);
  return result;
}

function snapBbox([south, west, north, east]: [number, number, number, number]): [number, number, number, number] {
  const step = 0.25;
  return [
    Math.floor(south / step) * step,
    Math.floor(west / step) * step,
    Math.ceil(north / step) * step,
    Math.ceil(east / step) * step,
  ];
}

function clean(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.trim();
  return cleaned || undefined;
}

function plainText(value: unknown): string | undefined {
  const text = clean(value);
  if (!text) return undefined;
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .trim();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

function numberValue(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  if (typeof value === 'string') {
    const match = value.replace(',', '.').match(/\d+(?:\.\d+)?/);
    if (!match) return undefined;
    value = Number(match[0]);
  }
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function booleanNumber(value: unknown): boolean | undefined {
  const number = numberValue(value);
  return number === undefined ? undefined : number !== 0;
}

function dateValue(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const date = new Date(typeof value === 'number' ? value : String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function safeHttpUrl(value: unknown): string | undefined {
  const raw = clean(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}
