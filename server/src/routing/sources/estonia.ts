import type { BBox } from '@seapro/shared';
import { database } from '../../db/pool.js';
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
  dedupeById,
  finiteNumber,
  intersectBbox,
  isoDate,
  positiveNumber,
  sourceMeta,
  text,
  type GeoJsonCollection,
  type LoadedTile,
} from './common.js';

const HIS = 'https://his.vta.ee:8443/HIS/WFS';
const ESTONIA: BBox = [57, 20, 60.5, 29];
const SOURCE = 'transpordiamet-his' as const;
const REFRESH_DAYS = 30;
const LAYER_NAMES: Record<string, keyof EstonianRoutingCollections> = {
  aton: 'aids', takist: 'obstructions', kivi: 'rocks', vrakk: 'wrecks',
  laevatee: 'fairways', mooteala: 'surveys', sadam: 'harbours',
};

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

/** Eesti ametlikud routingukihid loetakse ainult kohalikust PostGIS-i koopiast. */
export async function loadEstonianRoutingData(bbox: BBox): Promise<EstonianRoutingData> {
  const clipped = intersectBbox(bbox, ESTONIA);
  if (!clipped) {
    return emptyResult(sourceMeta({
      source: SOURCE,
      attribution: 'Transpordiamet, Hüdrograafia infosüsteem',
      attributionUrl: HIS,
      requested: 0,
      loaded: [],
      errors: [],
      outside: true,
    }));
  }
  try {
    const { collections, completedAt } = await queryLocalHis(clipped);
    if (!completedAt) throw new Error('HIS-i kohalikku koopiat ei ole veel loodud');
    const ageSeconds = Math.max(0, (Date.now() - completedAt.getTime()) / 1000);
    const stamp = { source: SOURCE, fetchedAt: completedAt.toISOString(), stale: ageSeconds > REFRESH_DAYS * 86400 };
    const parsed = parseEstonianRoutingData(collections, stamp);
    const loaded: LoadedTile<EstonianRoutingCollections>[] = [{ value: collections, stamp, ageSeconds }];
    return {
      hazards: withinBbox(dedupeById(parsed.hazards), clipped),
      corridors: withinBbox(dedupeById(parsed.corridors), clipped),
      surveyAreas: withinBbox(dedupeById(parsed.surveyAreas), clipped),
      harbours: withinBbox(dedupeById(parsed.harbours), clipped),
      source: sourceMeta({
        source: SOURCE,
        attribution: 'Transpordiamet, Hüdrograafia infosüsteem',
        attributionUrl: HIS,
        requested: 1,
        loaded,
        errors: [],
      }),
    };
  } catch (error) {
    return emptyResult(sourceMeta({
      source: SOURCE,
      attribution: 'Transpordiamet, Hüdrograafia infosüsteem',
      attributionUrl: HIS,
      requested: 1,
      loaded: [],
      errors: [error],
    }));
  }
}

function withinBbox<T extends { geometry: Parameters<typeof routingGeometryIntersectsBbox>[0] }>(
  features: T[],
  bbox: BBox,
): T[] {
  return features.filter((feature) => routingGeometryIntersectsBbox(feature.geometry, bbox));
}

async function queryLocalHis(bbox: BBox): Promise<{
  collections: EstonianRoutingCollections;
  completedAt: Date | null;
}> {
  const collections: EstonianRoutingCollections = {
    aids: { features: [] }, obstructions: { features: [] }, rocks: { features: [] },
    wrecks: { features: [] }, fairways: { features: [] }, surveys: { features: [] },
    harbours: { features: [] },
  };
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL statement_timeout = 60000');
    const active = await client.query(`
      SELECT a.snapshot_id, s.completed_at FROM his_active_snapshot a
      JOIN his_snapshots s ON s.id=a.snapshot_id WHERE a.singleton=true
    `);
    if (!active.rows[0]) return { collections, completedAt: null };
    const [south, west, north, east] = bbox;
    const result = await client.query(`
      SELECT layer, feature_id, properties, ST_AsGeoJSON(geom) AS geometry
      FROM his_features
      WHERE snapshot_id=$1
        AND geom && ST_MakeEnvelope($2,$3,$4,$5,4326)
        AND ST_Intersects(geom, ST_MakeEnvelope($2,$3,$4,$5,4326))
    `, [active.rows[0].snapshot_id, west, south, east, north]);
    for (const row of result.rows) {
      const name = LAYER_NAMES[row.layer];
      if (name) collections[name].features!.push({
        id: row.feature_id,
        properties: row.properties,
        geometry: JSON.parse(row.geometry),
      });
    }
    return { collections, completedAt: active.rows[0].completed_at };
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
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
  if (/(?:pohja)(?:poi|tooder)/.test(normalized)) return 'cardinal-north';
  if (/(?:ida)(?:poi|tooder)/.test(normalized)) return 'cardinal-east';
  if (/(?:louna)(?:poi|tooder)/.test(normalized)) return 'cardinal-south';
  if (/(?:laane)(?:poi|tooder)/.test(normalized)) return 'cardinal-west';
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
