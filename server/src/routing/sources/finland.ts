import type { BBox } from '@seapro/shared';
import { cache } from '../../cache.js';
import { fetchJson } from '../../http.js';
import { categoryFromFinnishNavigationCode } from '../../navigation/categories.js';
import { routingGeometryIntersectsBbox } from '../sourceGeometry.js';
import type {
  RoutingAreaRestriction,
  RoutingBridgeRestriction,
  RoutingCorridor,
  RoutingFeatureSource,
  RoutingHazard,
  RoutingLockRestriction,
  RoutingSourceMeta,
  RoutingWarning,
} from '../sourceTypes.js';
import {
  asRoutingGeometry,
  adaptiveBboxTiles,
  bboxTiles,
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

const WFS = 'https://avoinapi.vaylapilvi.fi/vaylatiedot/ows';
const FINLAND: BBox = [59.4, 19, 70.2, 31.7];
const SOURCE = 'vaylavirasto-wfs' as const;
const ATTRIBUTION = 'Väylävirasto avoin WFS';
const ATTRIBUTION_URL = 'https://vayla.fi/vaylista/aineistot/avoindata';
const STATIC_TTL_SECONDS = 7 * 24 * 3600;
const FAULT_TTL_SECONDS = 120;
const PAGE_SIZE = 10_000;
const MARINE_BRIDGE_CLEARANCE_PROPERTY = 'alittav_vayla_korkraj_vesiv';

const STATIC_LAYERS = {
  // `_uusi` on avaliku WFS-i koondvaade: GetFeature'i loendused on aladel
  // 3812 = 2904 + 908 ja joontel 12882 = 10447 + 2435 (Väylävirasto + muud
  // väylänpitäjad). Eraldi `_muut_vaylanpitajat` päring dubleeriks seetõttu
  // samad alad ja jooned.
  fairwayAreas: 'vesivaylatiedot:vaylaalueet_uusi',
  navigationLines: 'vesivaylatiedot:navigointilinjat_uusi',
  restrictions: 'vesivaylatiedot:rajoitusalue_a_uusi',
  structures: 'vesivaylatiedot:sulkukanavat_uusi',
  bridges: 'taitorakenteet:silta',
  aids: 'vesivaylatiedot:turvalaitteet_uusi',
} as const;

const FAULT_LAYERS = {
  faultsCommercial: 'vesivaylatiedot:vesivaylien_turvalaiteviat_kauppamerenkulku',
  faultsShallow: 'vesivaylatiedot:vesivaylien_turvalaiteviat_matalavaylat',
} as const;

type FinnishStaticRoutingCollections = Pick<
  FinnishRoutingCollections,
  'fairwayAreas' | 'navigationLines' | 'restrictions' | 'structures' | 'bridges' | 'aids'
>;

type FinnishFaultCollections = Pick<
  FinnishRoutingCollections,
  'faultsCommercial' | 'faultsShallow'
>;

export interface FinnishRoutingCollections {
  fairwayAreas: GeoJsonCollection;
  navigationLines: GeoJsonCollection;
  restrictions: GeoJsonCollection;
  structures: GeoJsonCollection;
  bridges: GeoJsonCollection;
  faultsCommercial: GeoJsonCollection;
  faultsShallow: GeoJsonCollection;
  aids: GeoJsonCollection;
}

export interface FinnishRoutingData {
  hazards: RoutingHazard[];
  corridors: RoutingCorridor[];
  restrictions: Array<RoutingAreaRestriction | RoutingBridgeRestriction | RoutingLockRestriction>;
  warnings: RoutingWarning[];
  source: RoutingSourceMeta;
}

export type FinnishStaticRoutingData = Omit<FinnishRoutingData, 'warnings'>;

/**
 * Ainult nädalase TTL-iga graafiallikad. Graafiehitaja ei vaja 120 s
 * AToN-rikkeid ning nende ajutine tõrge ei tohi staatilist faili poolikuks
 * märkida.
 */
export async function loadFinnishStaticRoutingData(
  bbox: BBox,
  departureTime: string,
): Promise<FinnishStaticRoutingData> {
  const clipped = intersectBbox(bbox, FINLAND);
  if (!clipped) {
    return { hazards: [], corridors: [], restrictions: [], source: outsideSourceMeta() };
  }

  const collections = await loadStaticCollections(clipped, departureTime);
  return {
    hazards: collections.hazards,
    corridors: collections.corridors,
    restrictions: collections.restrictions,
    source: sourceMeta({
      source: SOURCE,
      attribution: ATTRIBUTION,
      attributionUrl: ATTRIBUTION_URL,
      requested: collections.tiles.length,
      loaded: collections.loaded,
      errors: collections.errors,
    }),
  };
}

export async function loadFinnishRoutingData(
  bbox: BBox,
  departureTime: string,
): Promise<FinnishRoutingData> {
  const clipped = intersectBbox(bbox, FINLAND);
  if (!clipped) return emptyResult(outsideSourceMeta());

  // Kiiresti muutuvad rikked ei kuulu laia staatilisse baaskihti. Need jäävad
  // väikese TTL-iga senisele adaptiivsele päringule. Rühmad lahendatakse
  // sõltumatult, et ühe rühma tõrge ei kustutaks teise edukaid objekte.
  const faultTiles = adaptiveBboxTiles(clipped, 1, 16);
  const [collections, faultSettled] = await Promise.all([
    loadStaticCollections(clipped, departureTime),
    settleMapLimit(faultTiles, 2, loadFaultTile),
  ]);
  const faultLoaded = faultSettled.flatMap((result): LoadedTile<FinnishFaultCollections>[] =>
    result.status === 'fulfilled' ? [result.value] : []);
  const warnings = faultLoaded.flatMap((tile) => [
    ...parseFaults(tile.value.faultsCommercial, tile.stamp),
    ...parseFaults(tile.value.faultsShallow, tile.stamp),
  ]);

  return {
    hazards: collections.hazards,
    corridors: collections.corridors,
    restrictions: collections.restrictions,
    warnings: withinBbox(dedupeById(warnings), clipped),
    source: sourceMeta({
      source: SOURCE,
      attribution: ATTRIBUTION,
      attributionUrl: ATTRIBUTION_URL,
      requested: collections.tiles.length + faultTiles.length,
      loaded: [...collections.loaded, ...faultLoaded],
      errors: [
        ...collections.errors,
        ...faultSettled.flatMap((result) => result.status === 'rejected' ? [result.reason] : []),
      ],
    }),
  };
}

/** Staatiliste paanide ühine konveier; mõlemad avalikud laadijad koostavad
 * sellest sama paanivaliku ja tulemuse, nii et graafiehitus ja runtime ei
 * saa eri tükeldust näha. */
async function loadStaticCollections(clipped: BBox, departureTime: string): Promise<{
  hazards: RoutingHazard[];
  corridors: RoutingCorridor[];
  restrictions: FinnishStaticRoutingData['restrictions'];
  tiles: BBox[];
  loaded: LoadedTile<FinnishStaticRoutingCollections>[];
  errors: unknown[];
}> {
  const canonicalTiles = bboxTiles(clipped, 1);
  const tiles = canonicalTiles.every(isFreshStaticTile)
    ? canonicalTiles
    : adaptiveBboxTiles(clipped, 1, 16);
  const settled = await settleMapLimit(tiles, 2, loadStaticTile);
  const loaded = settled.flatMap((result): LoadedTile<FinnishStaticRoutingCollections>[] =>
    result.status === 'fulfilled' ? [result.value] : []);
  const errors = settled.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
  const parsed = loaded.map((tile) => parseFinnishStaticRoutingData(
    tile.value,
    tile.stamp,
    departureTime,
  ));
  return {
    hazards: withinBbox(dedupeById(parsed.flatMap((item) => item.hazards)), clipped),
    corridors: withinBbox(dedupeById(parsed.flatMap((item) => item.corridors)), clipped),
    restrictions: withinBbox(dedupeById(parsed.flatMap((item) => item.restrictions)), clipped),
    tiles,
    loaded,
    errors,
  };
}

function outsideSourceMeta(): RoutingSourceMeta {
  return sourceMeta({
    source: SOURCE,
    attribution: ATTRIBUTION,
    attributionUrl: ATTRIBUTION_URL,
    requested: 0,
    loaded: [],
    errors: [],
    outside: true,
  });
}

function withinBbox<T extends { geometry: Parameters<typeof routingGeometryIntersectsBbox>[0] }>(
  features: T[],
  bbox: BBox,
): T[] {
  return features.filter((feature) => routingGeometryIntersectsBbox(feature.geometry, bbox));
}

async function loadStaticTile(tile: BBox): Promise<LoadedTile<FinnishStaticRoutingCollections>> {
  const key = staticTileKey(tile);
  const result = await cache.get(key, STATIC_TTL_SECONDS, () => loadLayers(STATIC_LAYERS, tile));
  return {
    value: result.value,
    stamp: sourceStamp(SOURCE, result),
    ageSeconds: result.ageSeconds,
  };
}

function staticTileKey(tile: BBox): string {
  return `routing:vaylavirasto-wfs:static:v3:${tile.join(',')}`;
}

function isFreshStaticTile(tile: BBox): boolean {
  return cache.peek(staticTileKey(tile))?.stale === false;
}

/** Staatiline osa eraldi, et eellaadimine ei lukustaks AToN-rikkeid cache'i. */
export async function warmFinnishStaticRoutingTile(tile: BBox): Promise<boolean> {
  if (!intersectBbox(tile, FINLAND)) return false;
  await loadStaticTile(tile);
  return true;
}

export function isFinnishStaticRoutingTileFresh(tile: BBox): boolean {
  return !intersectBbox(tile, FINLAND) || isFreshStaticTile(tile);
}

async function loadFaultTile(tile: BBox): Promise<LoadedTile<FinnishFaultCollections>> {
  const key = `routing:vaylavirasto-wfs:faults:v1:${tile.join(',')}`;
  const result = await cache.get(key, FAULT_TTL_SECONDS, () => loadLayers(FAULT_LAYERS, tile));
  return {
    value: result.value,
    stamp: sourceStamp(SOURCE, result),
    ageSeconds: result.ageSeconds,
  };
}

async function loadLayers<T extends Record<string, string>>(
  layers: T,
  tile: BBox,
): Promise<{ [K in keyof T]: GeoJsonCollection }> {
  const entries = await Promise.all(Object.entries(layers).map(async ([name, layer]) =>
    [name, await queryWfsLayer(layer, tile, wfsQueryOptions(layer))] as const));
  return Object.fromEntries(entries) as { [K in keyof T]: GeoJsonCollection };
}

interface WfsQueryOptions {
  pageSize?: number;
  propertyNames?: readonly string[];
  sortBy?: string;
  /** Sorteeritud kihi korral võib esimese tühja väärtuse juures lõpetada. */
  stopAtEmptyProperty?: string;
}

function wfsQueryOptions(layer: string): WfsQueryOptions | undefined {
  if (layer !== STATIC_LAYERS.bridges) return undefined;
  // CQL/FES `IS NOT NULL` ei ole selle GeoServeri silla-vaates töökindel.
  // Descending sort toob kõik masinloetava veetee läbipääsukõrgusega sillad
  // ettepoole; nii ei pea igas paanis alla laadima tuhandeid maanteesildu.
  return {
    pageSize: 1_000,
    propertyNames: [
      'id',
      'nimi',
      'tila',
      MARINE_BRIDGE_CLEARANCE_PROPERTY,
      'kayttotarkoitukset_nimi',
      'geom',
    ],
    sortBy: `${MARINE_BRIDGE_CLEARANCE_PROPERTY} D`,
    stopAtEmptyProperty: MARINE_BRIDGE_CLEARANCE_PROPERTY,
  };
}

async function queryWfsLayer(
  layer: string,
  bbox: BBox,
  options?: WfsQueryOptions,
): Promise<GeoJsonCollection> {
  const features: NonNullable<GeoJsonCollection['features']> = [];
  const pageSize = options?.pageSize ?? PAGE_SIZE;
  let startIndex = 0;
  for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
    const [south, west, north, east] = bbox;
    const params = new URLSearchParams({
      service: 'WFS',
      version: '2.0.0',
      request: 'GetFeature',
      typeNames: layer,
      bbox: `${west},${south},${east},${north},EPSG:4326`,
      srsName: 'EPSG:4326',
      outputFormat: 'application/json',
      count: String(pageSize),
      startIndex: String(startIndex),
    });
    if (options?.propertyNames?.length) {
      params.set('propertyName', options.propertyNames.join(','));
    }
    if (options?.sortBy) params.set('sortBy', options.sortBy);
    const page = await fetchJson<GeoJsonCollection>(`${WFS}?${params}`, { timeoutMs: 30_000 });
    const pageFeatures = page.features ?? [];
    const returned = pageFeatures.length;
    const reachedEmpty = options?.stopAtEmptyProperty
      ? pageFeatures.some((feature) => text(
        feature.properties?.[options.stopAtEmptyProperty!],
      ) === undefined)
      : false;
    if (options?.stopAtEmptyProperty) {
      features.push(...pageFeatures.filter((feature) => text(
        feature.properties?.[options.stopAtEmptyProperty!],
      ) !== undefined));
    } else {
      features.push(...pageFeatures);
    }
    startIndex += returned;
    const matched = finiteNumber(page.numberMatched);
    if (reachedEmpty || returned === 0 || returned < pageSize
      || (matched !== undefined && startIndex >= matched)) break;
  }
  return { features };
}

export function parseFinnishRoutingData(
  collections: FinnishRoutingCollections,
  stamp: RoutingFeatureSource,
  departureTime: string,
): Pick<FinnishRoutingData, 'hazards' | 'corridors' | 'restrictions' | 'warnings'> {
  const parsed = parseFinnishStaticRoutingData(collections, stamp, departureTime);
  const warnings = parseFaults(collections.faultsCommercial, stamp)
    .concat(parseFaults(collections.faultsShallow, stamp));
  return { ...parsed, warnings };
}

function parseFinnishStaticRoutingData(
  collections: FinnishStaticRoutingCollections,
  stamp: RoutingFeatureSource,
  departureTime: string,
): Pick<FinnishRoutingData, 'hazards' | 'corridors' | 'restrictions'> {
  const corridors = [
    ...parseFairwayAreas(collections.fairwayAreas, stamp),
    ...parseNavigationLines(collections.navigationLines, stamp),
  ];
  const restrictions = [
    ...parseAreaRestrictions(collections.restrictions, stamp, departureTime),
    ...parseStructures(collections.structures, stamp),
    ...parseMarineBridges(collections.bridges, stamp),
  ];
  return {
    hazards: parsePhysicalAids(collections.aids, stamp),
    corridors,
    restrictions,
  };
}

function parseFairwayAreas(
  collection: GeoJsonCollection,
  stamp: RoutingFeatureSource,
): RoutingCorridor[] {
  return (collection.features ?? []).flatMap((feature) => {
    const geometry = asRoutingGeometry(feature.geometry);
    if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) return [];
    const p = feature.properties ?? {};
    return [{
      id: `vaylavirasto-wfs:fairway-area:${featureId(feature, p)}`,
      kind: 'fairway',
      geometry,
      geometryRole: 'area',
      name: fairwayName(p.vaylan_nimi) ?? text(p.tyyppi) ?? 'Väyläalue',
      // `mitoitussyvays` on avaldatud projekteeritud süvis, mitte mõõdetud
      // veesügavus. Füüsilise haraussügavuse annab ainult `haraussyvyys`.
      maxDraughtM: positiveNumber(p.mitoitussyvays),
      sweptDepthM: positiveNumber(p.haraussyvyys),
      directionDegrees: bearing(p.suunta),
      direction: trafficDirection(p.liikennointisuunta),
      official: true,
      referenceLevel: text(p.vertaustaso),
      fairwayNumber: text(p.jnro),
      category: text(p.merkintalaji) ?? text(p.tyyppi),
      ...stamp,
    }];
  });
}

function parseNavigationLines(
  collection: GeoJsonCollection,
  stamp: RoutingFeatureSource,
): RoutingCorridor[] {
  return (collection.features ?? []).flatMap((feature) => {
    const geometry = asRoutingGeometry(feature.geometry);
    if (!geometry || (geometry.type !== 'LineString' && geometry.type !== 'MultiLineString')) return [];
    const p = feature.properties ?? {};
    return [{
      id: `vaylavirasto-wfs:navigation-line:${featureId(feature, p)}`,
      kind: 'fairway',
      geometry,
      geometryRole: 'centreline',
      name: fairwayName(p.vaylan_nimi) ?? text(p.tyyppi) ?? 'Navigointilinja',
      maxDraughtM: positiveNumber(p.mitoitussyvays),
      sweptDepthM: positiveNumber(p.haraussyvyys),
      directionDegrees: bearing(p.tosisuunta) ?? bearing(p.suunta),
      direction: 'unknown',
      official: true,
      referenceLevel: text(p.vertaustaso),
      fairwayNumber: text(p.jnro),
      category: text(p.tyyppi),
      ...stamp,
    }];
  });
}

function parseAreaRestrictions(
  collection: GeoJsonCollection,
  stamp: RoutingFeatureSource,
  departureTime: string,
): RoutingAreaRestriction[] {
  const departureMs = new Date(departureTime).getTime();
  return (collection.features ?? []).flatMap((feature) => {
    const geometry = asRoutingGeometry(feature.geometry);
    if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) return [];
    const p = feature.properties ?? {};
    const validFrom = isoDate(p.alkupaivamaara);
    const validTo = isoDate(p.loppupaivamaara);
    if (Number.isFinite(departureMs)) {
      if (validFrom && new Date(validFrom).getTime() > departureMs) return [];
      if (validTo && new Date(validTo).getTime() < departureMs) return [];
    }
    const rule = text(p.rajoitustyyppi);
    const speedKmh = rule?.toLocaleLowerCase('fi').includes('nopeusrajoitus')
      ? positiveNumber(p.suuruus)
      : undefined;
    return [{
      id: `vaylavirasto-wfs:restriction:${featureId(feature, p)}`,
      kind: 'restricted_area',
      geometry,
      name: text(p.nimisijainti) ?? fairwayName(p.vaylan_nimi) ?? rule ?? 'Rajoitusalue',
      description: text(p.lisatieto),
      rule,
      ruleCodes: text(p.rajoitustyypit)?.split(',').map((value) => value.trim()).filter(Boolean),
      prohibited: Boolean(rule && /aluksen\s+kulku.*kielletty/i.test(rule)),
      speedLimitMps: speedKmh === undefined ? undefined : speedKmh / 3.6,
      exception: text(p.poikkeus),
      schedule: text(p.lisatieto),
      validFrom,
      validTo,
      ...stamp,
    }];
  });
}

function parseStructures(
  collection: GeoJsonCollection,
  stamp: RoutingFeatureSource,
): Array<RoutingBridgeRestriction | RoutingLockRestriction> {
  const result: Array<RoutingBridgeRestriction | RoutingLockRestriction> = [];
  for (const feature of collection.features ?? []) {
    const geometry = asRoutingGeometry(feature.geometry);
    if (!geometry) continue;
    const p = feature.properties ?? {};
    const type = text(p.kanavaaluetyyppi) ?? '';
    const common = {
      id: `vaylavirasto-wfs:structure:${featureId(feature, p)}`,
      geometry,
      name: text(p.nimi) ?? (type || 'Kanavarakenne'),
      description: [text(p.mista), text(p.mihin)].filter(Boolean).join(' – ') || undefined,
      maxHeightM: positiveNumber(p.aluskorkeus),
      maxBeamM: positiveNumber(p.alusleveys) ?? positiveNumber(p.sulkuleveys),
      maxLengthM: positiveNumber(p.aluspituus) ?? positiveNumber(p.sulkuleveyspituus),
      maxDraughtM: positiveNumber(p.alussyvyys),
      operation: text(p.kayttoselite),
      ...stamp,
    };
    if (/silta/i.test(type)) {
      result.push({ ...common, kind: 'bridge', opens: /avattava/i.test(type) });
    } else {
      result.push({ ...common, kind: 'lock' });
    }
  }
  return result;
}

function parseMarineBridges(
  collection: GeoJsonCollection,
  stamp: RoutingFeatureSource,
): RoutingBridgeRestriction[] {
  return (collection.features ?? []).flatMap((feature) => {
    const geometry = asRoutingGeometry(feature.geometry);
    if (!geometry || (geometry.type !== 'Point' && geometry.type !== 'MultiPoint')) return [];
    const p = feature.properties ?? {};
    const maxHeightM = finiteNumber(p[MARINE_BRIDGE_CLEARANCE_PROPERTY]);
    // `korkeusrajoitus` kirjeldab maanteesõiduki kõrgust silla peal ja ei ole
    // laeva vertikaalne läbipääs. Ilma veetee väljata ei saa piirangut tuletada.
    if (maxHeightM === undefined || maxHeightM < 0) return [];
    return [{
      id: `vaylavirasto-wfs:bridge:${featureId(feature, p)}`,
      kind: 'bridge',
      geometry,
      name: text(p.nimi) ?? 'Silta',
      description: text(p.kayttotarkoitukset_nimi),
      maxHeightM,
      operation: text(p.tila),
      ...stamp,
    }];
  });
}

function parseFaults(collection: GeoJsonCollection, stamp: RoutingFeatureSource): RoutingWarning[] {
  return (collection.features ?? []).flatMap((feature) => {
    const geometry = asRoutingGeometry(feature.geometry);
    if (!geometry || geometry.type !== 'Point') return [];
    const p = feature.properties ?? {};
    const fault = text(p.vikatyyppien) ?? text(p.vikatyyppifi) ?? 'Turvalaitevika';
    return [{
      id: `vaylavirasto-wfs:aton-fault:${featureId(feature, p)}`,
      kind: 'aton_fault',
      geometry,
      name: text(p.turvalaitenimifi) ?? text(p.turvalaitenimisv) ?? 'Turvalaitevika',
      description: fault,
      severity: /destroyed|missing|kadonnut|tuhoutunut|off.?position|pois paikaltaan/i.test(fault)
        ? 'critical'
        : 'caution',
      reportedAt: isoDate(p.kirjausaika),
      aidNumber: text(p.turvalaitenumero),
      faultCode: text(p.vikatyyppikoodi),
      fairwayClass: text(p.vaylaluokitus),
      ...stamp,
    }];
  });
}

function parsePhysicalAids(collection: GeoJsonCollection, stamp: RoutingFeatureSource): RoutingHazard[] {
  return (collection.features ?? []).flatMap((feature) => {
    const rawGeometry = asRoutingGeometry(feature.geometry);
    const point = rawGeometry?.type === 'Point'
      ? rawGeometry.coordinates
      : rawGeometry?.type === 'MultiPoint' ? rawGeometry.coordinates[0] : undefined;
    if (!point) return [];
    const p = feature.properties ?? {};
    // Virtuaalne AIS AToN on kaardimärk, mitte vees olev keha. Väylävirasto
    // väljade nimed on versiooniti erinenud, seega kontrollime nii otseseid
    // virtuaalsuslippe kui tüübi/alamtüübi teksti.
    if (isVirtualAid(p)) return [];
    const aidCategory = categoryFromFinnishNavigationCode(finiteNumber(p.navigointilajikoodi));
    return [{
      id: `vaylavirasto-wfs:physical-aid:${featureId(feature, p)}`,
      kind: 'physical_aid',
      geometry: { type: 'Point', coordinates: point },
      name: text(p.nimifi) ?? text(p.nimisv) ?? text(p.turvalaitetyyppifi) ?? 'Turvalaite',
      confidence: 'high',
      category: text(p.turvalaitetyyppifi) ?? text(p.navigointilajikoodi),
      navigationRole: aidCategory === 'lateral-port'
        || aidCategory === 'lateral-starboard'
        || aidCategory === 'cardinal-north'
        || aidCategory === 'cardinal-east'
        || aidCategory === 'cardinal-south'
        || aidCategory === 'cardinal-west'
        ? aidCategory
        : 'other',
      operational: finiteNumber(p.toimintatilakoodi) === undefined
        || finiteNumber(p.toimintatilakoodi) === 1,
      ...stamp,
    }];
  });
}

function isVirtualAid(properties: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(properties)) {
    if (!/virtua|virtual|alityyppi|turvalaitetyyppi/i.test(key)) continue;
    const directFlag = /virtua|virtual/i.test(key);
    if (directFlag && (value === true || value === 1)) return true;
    const normalized = text(value)?.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    if (!normalized) continue;
    if (directFlag && (normalized === 'true' || normalized === 'yes' || normalized === 'k')) return true;
    if (normalized.includes('virtuaal') || normalized.includes('virtual')) return true;
  }
  return false;
}

function fairwayName(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const names = [...raw.matchAll(/\[\d+:\s*([^\]]+?)\s*\]/g)].map((match) => match[1]!.trim());
  return names.length ? [...new Set(names)].join(', ') : raw.replace(/\([^)]*\)/g, '').trim();
}

function trafficDirection(value: unknown): RoutingCorridor['direction'] {
  const raw = text(value)?.toLocaleLowerCase('fi');
  if (raw?.includes('kaksisuuntainen')) return 'two_way';
  if (raw?.includes('yksisuuntainen')) return 'one_way';
  return 'unknown';
}

function bearing(value: unknown): number | undefined {
  const result = finiteNumber(value);
  return result === undefined ? undefined : ((result % 360) + 360) % 360;
}

function featureId(
  feature: { id?: string | number },
  properties: Record<string, unknown>,
): string {
  return text(properties.id) ?? text(properties.navigointilinjaid) ?? text(properties.vikaid)
    ?? text(properties.turvalaitenumero) ?? text(feature.id) ?? 'unknown';
}

function emptyResult(source: RoutingSourceMeta): FinnishRoutingData {
  return { hazards: [], corridors: [], restrictions: [], warnings: [], source };
}
