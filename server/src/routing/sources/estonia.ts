import type { BBox } from '@seapro/shared';
import { cache } from '../../cache.js';
import { fetchJson } from '../../http.js';
import { routingGeometryIntersectsBbox } from '../sourceGeometry.js';
import type {
  RoutingCorridor,
  RoutingFeatureSource,
  RoutingHarbour,
  RoutingHazard,
  RoutingSourceMeta,
  RoutingSurveyArea,
} from '../sourceTypes.js';
import {
  asRoutingGeometry,
  adaptiveBboxTiles,
  dedupeById,
  finiteNumber,
  intersectBbox,
  isoDate,
  positiveNumber,
  settleMapLimit,
  sourceMeta,
  sourceStamp,
  text,
  type GeoJsonCollection,
  type LoadedTile,
} from './common.js';

const HIS = 'https://gis.transpordiamet.ee/arcgis/rest/services/Nutimeri/HIS/MapServer';
const ESTONIA: BBox = [57, 20, 60.5, 29];
const SOURCE = 'transpordiamet-his' as const;
const TTL_SECONDS = 24 * 3600;
const PAGE_SIZE = 2_000;

const LAYERS = {
  aids: 1,
  obstructions: 3,
  rocks: 5,
  wrecks: 7,
  fairways: 8,
  surveys: 9,
  harbours: 6,
} as const;

export interface EstonianRoutingCollections {
  aids: GeoJsonCollection;
  obstructions: GeoJsonCollection;
  rocks: GeoJsonCollection;
  wrecks: GeoJsonCollection;
  fairways: GeoJsonCollection;
  surveys: GeoJsonCollection;
  harbours: GeoJsonCollection;
}

export interface EstonianRoutingData {
  hazards: RoutingHazard[];
  corridors: RoutingCorridor[];
  surveyAreas: RoutingSurveyArea[];
  harbours: RoutingHarbour[];
  source: RoutingSourceMeta;
}

/**
 * Eesti HIS-i masinloetav routingukiht. Ühe kraadi paanid annavad nihutamisel
 * püsivad cache-võtmed; ArcGIS-i 2000 kirje piir ületatakse lehekülgede kaupa.
 */
export async function loadEstonianRoutingData(bbox: BBox): Promise<EstonianRoutingData> {
  const clipped = intersectBbox(bbox, ESTONIA);
  if (!clipped) {
    return emptyResult(sourceMeta({
      source: SOURCE,
      attribution: 'Transpordiamet, Hüdrograafia infosüsteem',
      attributionUrl: 'https://gis.transpordiamet.ee/arcgis/rest/services/Nutimeri/HIS/MapServer',
      requested: 0,
      loaded: [],
      errors: [],
      outside: true,
    }));
  }

  const tiles = adaptiveBboxTiles(clipped, 1, 16);
  const settled = await settleMapLimit(tiles, 2, loadTile);
  const loaded = settled.flatMap((result): LoadedTile<EstonianRoutingCollections>[] =>
    result.status === 'fulfilled' ? [result.value] : []);
  const errors = settled.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);

  const parsed = loaded.map((tile) => parseEstonianRoutingData(tile.value, tile.stamp));
  return {
    hazards: withinBbox(dedupeById(parsed.flatMap((item) => item.hazards)), clipped),
    corridors: withinBbox(dedupeById(parsed.flatMap((item) => item.corridors)), clipped),
    surveyAreas: withinBbox(dedupeById(parsed.flatMap((item) => item.surveyAreas)), clipped),
    harbours: withinBbox(dedupeById(parsed.flatMap((item) => item.harbours)), clipped),
    source: sourceMeta({
      source: SOURCE,
      attribution: 'Transpordiamet, Hüdrograafia infosüsteem',
      attributionUrl: 'https://gis.transpordiamet.ee/arcgis/rest/services/Nutimeri/HIS/MapServer',
      requested: tiles.length,
      loaded,
      errors,
    }),
  };
}

function withinBbox<T extends { geometry: Parameters<typeof routingGeometryIntersectsBbox>[0] }>(
  features: T[],
  bbox: BBox,
): T[] {
  return features.filter((feature) => routingGeometryIntersectsBbox(feature.geometry, bbox));
}

async function loadTile(tile: BBox): Promise<LoadedTile<EstonianRoutingCollections>> {
  const key = `routing:transpordiamet-his:v2:${tile.join(',')}`;
  const result = await cache.get(key, TTL_SECONDS, async () => {
    const entries = await Promise.all(Object.entries(LAYERS).map(async ([name, layer]) =>
      [name, await queryArcGisLayer(layer, tile)] as const));
    return Object.fromEntries(entries) as unknown as EstonianRoutingCollections;
  });
  return {
    value: result.value,
    stamp: sourceStamp(SOURCE, result),
    ageSeconds: result.ageSeconds,
  };
}

async function queryArcGisLayer(layer: number, bbox: BBox): Promise<GeoJsonCollection> {
  const features: NonNullable<GeoJsonCollection['features']> = [];
  let offset = 0;
  for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
    const [south, west, north, east] = bbox;
    const params = new URLSearchParams({
      f: 'geojson',
      where: '1 = 1',
      outFields: '*',
      returnGeometry: 'true',
      geometry: `${west},${south},${east},${north}`,
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      outSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      orderByFields: 'objectid ASC',
      resultOffset: String(offset),
      resultRecordCount: String(PAGE_SIZE),
    });
    const page = await fetchJson<GeoJsonCollection>(`${HIS}/${layer}/query?${params}`, {
      timeoutMs: 30_000,
    });
    if (page.error) throw new Error(`ArcGIS HIS kiht ${layer}: ${page.error.message ?? 'päring ebaõnnestus'}`);
    const returned = page.features?.length ?? 0;
    features.push(...(page.features ?? []));
    offset += returned;
    if (returned === 0 || (!page.exceededTransferLimit && returned < PAGE_SIZE)) break;
  }
  return { features };
}

export function parseEstonianRoutingData(
  collections: EstonianRoutingCollections,
  stamp: RoutingFeatureSource,
): Pick<EstonianRoutingData, 'hazards' | 'corridors' | 'surveyAreas' | 'harbours'> {
  const hazards = [
    ...parsePointHazards(collections.rocks, 'rock', stamp),
    ...parsePointHazards(collections.obstructions, 'obstruction', stamp),
    ...parseWrecks(collections.wrecks, stamp),
    ...parsePhysicalAids(collections.aids, stamp),
  ];

  const corridors: RoutingCorridor[] = (collections.fairways.features ?? []).flatMap((feature) => {
    const geometry = asRoutingGeometry(feature.geometry);
    if (!geometry || (geometry.type !== 'LineString' && geometry.type !== 'MultiLineString')) return [];
    const p = feature.properties ?? {};
    return [{
      id: `transpordiamet-his:fairway:${featureId(feature, p)}`,
      kind: 'fairway',
      geometry,
      geometryRole: 'centreline',
      name: text(p.nimi) ?? 'Laevatee',
      depthM: positiveNumber(p.depth),
      maxDraughtM: positiveNumber(p.ship_draught),
      widthM: positiveNumber(p.width),
      official: true,
      ...stamp,
    }];
  });

  const surveyAreas: RoutingSurveyArea[] = (collections.surveys.features ?? []).flatMap((feature) => {
    const geometry = asRoutingGeometry(feature.geometry);
    if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) return [];
    const p = feature.properties ?? {};
    return [{
      id: `transpordiamet-his:survey:${featureId(feature, p)}`,
      geometry,
      name: text(p.nimi),
      ihoS44Category: text(p.iho_s44_kat_id),
      surveyedAt: isoDate(p.aeg) ?? isoDate(p.mooteaeg),
      processedAt: isoDate(p.puhastusaeg) ?? isoDate(p.sisestusaeg),
      minDepthM: finiteNumber(p.minz),
      maxDepthM: finiteNumber(p.maxz),
      statusCode: text(p.staatus_id),
      ...stamp,
    }];
  });

  const harbours: RoutingHarbour[] = (collections.harbours?.features ?? []).flatMap((feature) => {
    const geometry = asRoutingGeometry(feature.geometry);
    if (!geometry || geometry.type !== 'Point') return [];
    const p = feature.properties ?? {};
    return [{
      id: `transpordiamet-his:harbour:${featureId(feature, p)}`,
      kind: 'harbour',
      geometry,
      name: text(p.nimi) ?? 'Sadam',
      maxLengthM: positiveNumber(p.max_laev_pik),
      maxBeamM: positiveNumber(p.max_laev_lai),
      maxDraughtM: positiveNumber(p.max_laev_syv),
      official: true,
      ...stamp,
    }];
  });

  return { hazards, corridors, surveyAreas, harbours };
}

function parsePointHazards(
  collection: GeoJsonCollection,
  kind: 'rock' | 'obstruction',
  stamp: RoutingFeatureSource,
): RoutingHazard[] {
  return (collection.features ?? []).flatMap((feature) => {
    const geometry = asRoutingGeometry(feature.geometry);
    if (!geometry || geometry.type !== 'Point') return [];
    const p = feature.properties ?? {};
    const surveyAreaId = text(p.mooteala_id);
    return [{
      id: `transpordiamet-his:${kind}:${featureId(feature, p)}`,
      kind,
      geometry,
      name: text(p.kirjeldus) ?? (kind === 'rock' ? 'Kivi' : 'Takistus'),
      description: text(p.mooteala_nimi),
      depthM: positiveNumber(p.sygavus),
      sizeM: positiveNumber(p.suurus),
      heightM: positiveNumber(p.korgus),
      confidence: surveyAreaId ? 'high' : 'medium',
      surveyAreaId,
      category: text(p.catobs_id),
      waterLevelCode: text(p.watlev_id),
      ...stamp,
    }];
  });
}

function parseWrecks(collection: GeoJsonCollection, stamp: RoutingFeatureSource): RoutingHazard[] {
  return (collection.features ?? []).flatMap((feature) => {
    const geometry = asRoutingGeometry(feature.geometry);
    if (!geometry || geometry.type !== 'Point') return [];
    const p = feature.properties ?? {};
    const surveyAreaId = text(p.mooteala_id);
    const dimensions = [positiveNumber(p.vraki_pikkus), positiveNumber(p.vraki_laius), positiveNumber(p.laeva_pikkus), positiveNumber(p.laeva_laius)]
      .filter((value): value is number => value !== undefined);
    return [{
      id: `transpordiamet-his:wreck:${featureId(feature, p)}`,
      kind: 'wreck',
      geometry,
      name: text(p.laevanimi) ?? 'Vrakk',
      description: text(p.markused),
      depthM: positiveNumber(p.vraki_sygavus),
      sizeM: dimensions.length ? Math.max(...dimensions) : undefined,
      heightM: positiveNumber(p.vraki_korgus),
      confidence: surveyAreaId ? 'high' : 'medium',
      surveyAreaId,
      category: text(p.catwrk_id) ?? text(p.laevatyyp),
      waterLevelCode: text(p.watlev_id),
      ...stamp,
    }];
  });
}

function parsePhysicalAids(collection: GeoJsonCollection, stamp: RoutingFeatureSource): RoutingHazard[] {
  return (collection.features ?? []).flatMap((feature) => {
    const geometry = asRoutingGeometry(feature.geometry);
    if (!geometry || geometry.type !== 'Point') return [];
    const p = feature.properties ?? {};
    return [{
      id: `transpordiamet-his:physical-aid:${featureId(feature, p)}`,
      kind: 'physical_aid',
      geometry,
      name: text(p.nimi) ?? 'Navigatsioonimärk',
      heightM: positiveNumber(p.m_korgus) ?? positiveNumber(p.korgus),
      confidence: 'high',
      category: text(p.tyyp_nimi) ?? text(p.tyyp_id),
      navigationRole: estonianAidRole(p),
      operational: finiteNumber(p.margi_olek) === undefined || finiteNumber(p.margi_olek) === 0,
      ...stamp,
    }];
  });
}

function estonianAidRole(properties: Record<string, unknown>): RoutingHazard['navigationRole'] {
  const normalized = `${text(properties.tyyp_nimi) ?? ''} ${text(properties.nimi) ?? ''}`
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('et');
  if (normalized.includes('vasaku kulje')) return 'lateral-port';
  if (normalized.includes('parema kulje')) return 'lateral-starboard';
  // Sadamamuuli punane/roheline tuli piirab sama kanalit nagu külgmärk.
  if (normalized.includes('sadama') || normalized.includes('muuli')) {
    const light = text(properties.tule_karakt)?.toUpperCase() ?? '';
    if (/(?:^|\s)R(?:\s|$)/.test(light)) return 'lateral-port';
    if (/(?:^|\s)G(?:\s|$)/.test(light)) return 'lateral-starboard';
  }
  return 'other';
}

function featureId(
  feature: { id?: string | number },
  properties: Record<string, unknown>,
): string {
  return text(properties.id) ?? text(properties.gmlid) ?? text(properties.gml_id)
    ?? text(properties.objectid) ?? text(feature.id) ?? 'unknown';
}

function emptyResult(source: RoutingSourceMeta): EstonianRoutingData {
  return { hazards: [], corridors: [], surveyAreas: [], harbours: [], source };
}
