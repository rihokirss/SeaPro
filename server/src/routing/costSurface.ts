import type { BBox } from '@seapro/shared';
import type { GridCoordinate, RouteRisk, RoutingCell, RoutingGrid } from './engineTypes.js';
import { ROUTING_COST_MULTIPLIERS } from './engineTypes.js';
import { serviceAreaRowSampler } from './coverage.js';
import { createDepthRowSampler, DEPTH_SAMPLE_LAND, type RoutingDepthRaster } from './depthRaster.js';
import { pointInRoutingGeometry, routingGeometryBbox } from './sourceGeometry.js';
import type {
  Position,
  RoutingCorridor,
  RoutingGeometry,
  RoutingHazard,
  RoutingRestriction,
  RoutingSourceMeta,
  RoutingVectorData,
  RoutingWarning,
} from './sourceTypes.js';
import { createRoutingWaterSampler, routingWaterAt, type RoutingWaterMask } from './waterMask.js';

const METRES_PER_LATITUDE_DEGREE = 111_320;
const DEFAULT_MAX_CELLS = 600_000;
const MIN_CELL_SIZE_M = 75;
const OFFICIAL_POINT_STRUCTURE_BUFFER_M = 500;
const CARDINAL_INFLUENCE_M = 0.5 * 1_852;
const CARDINAL_HARD_CLEARANCE_M = 10;
const TRUSTED_ROUTE_MAX_DRAUGHT_M = 3;
const TRUSTED_ROUTE_MAX_BEAM_M = 10;
/**
 * Baasrastri hinnangud, mille avaldatud keskjoon tühistab. Päris vektorohud
 * ja -piirangud siia ei kuulu; need jäävad kõvaks piiriks ka usaldatud teel.
 */
export const TRUSTED_ROUTE_CLEARED_REASONS = [
  'known_shallow',
  'depth_unknown',
  'water_mask_unknown',
  'land',
  'low_clearance',
] as const;
const CELL_SAMPLE_OFFSETS = [-0.49, 0, 0.49] as const;
const NOOP_CHECKPOINT = (): void => undefined;

const BLOCK_WATER_LAND = 1 << 0;
const BLOCK_DEPTH_LAND = 1 << 1;
const BLOCK_SHALLOW = 1 << 2;
const BLOCK_HAZARD = 1 << 3;
const BLOCK_RESTRICTION = 1 << 4;
const BASE_BLOCK_MASK = BLOCK_WATER_LAND | BLOCK_DEPTH_LAND | BLOCK_SHALLOW;

export const ROUTING_REASON_CODES = [
  'depth_unknown',
  'water_mask_unknown',
  'low_clearance',
  'known_shallow',
  'land',
  'official_corridor',
  'harbour_access',
  'official_corridor_limit',
  'recommended_route',
  'traffic_lane',
  'traffic_direction_unverified',
  'traffic_crossing',
  'traffic_wrong_way',
  'cardinal_wrong_side',
  'separation_zone',
  'restricted_area',
  'structure_clearance',
  'structure_unverified',
  'hazard',
  'submerged_hazard',
  'aton_fault',
  'navigation_warning',
  'official_source_incomplete',
  'official_coverage_unknown',
] as const;

export type RoutingReasonCode = (typeof ROUTING_REASON_CODES)[number];

const REASON_BITS = Object.fromEntries(
  ROUTING_REASON_CODES.map((reason, index) => [reason, 2 ** index]),
) as Record<RoutingReasonCode, number>;

const UNKNOWN_REASON_MASK = REASON_BITS.depth_unknown
  | REASON_BITS.water_mask_unknown
  | REASON_BITS.official_source_incomplete
  | REASON_BITS.official_coverage_unknown;
const CAUTION_REASON_MASK = REASON_BITS.low_clearance
  | REASON_BITS.harbour_access
  | REASON_BITS.official_corridor_limit
  | REASON_BITS.traffic_crossing
  | REASON_BITS.traffic_wrong_way
  | REASON_BITS.cardinal_wrong_side
  | REASON_BITS.traffic_direction_unverified
  | REASON_BITS.separation_zone
  | REASON_BITS.restricted_area
  | REASON_BITS.structure_clearance
  | REASON_BITS.structure_unverified
  | REASON_BITS.submerged_hazard
  | REASON_BITS.aton_fault
  | REASON_BITS.navigation_warning;

export interface RoutingVesselProfile {
  draughtM: number;
  underKeelClearanceM: number;
  beamM: number;
  airDraughtM: number;
}

export interface RoutingGridProjection {
  readonly bbox: BBox;
  readonly width: number;
  readonly height: number;
  readonly cellSizeM: number;
  readonly lonStep: number;
  readonly latStep: number;
  readonly metresPerLongitudeDegree: number;
}

export interface RoutingCellDetails {
  readonly blocked: boolean;
  readonly risk: RouteRisk;
  readonly costMultiplier: number;
  readonly reasons: RoutingReasonCode[];
  readonly sourceIds: string[];
  readonly depthM: number | null;
}

export interface RoutingTransitionDetails {
  readonly costMultiplier: number;
  readonly risk: RouteRisk;
  readonly reasons: RoutingReasonCode[];
  readonly sourceIds: string[];
}

export interface RoutingCostSurface extends RoutingGrid {
  readonly projection: RoutingGridProjection;
  readonly requiredDepthM: number;
  /** Avaldatud keskjoon on selle väikelaevaprofiili jaoks alusrastrist autoriteetsem. */
  readonly trustPublishedRoutes: boolean;
  toGrid(point: { lon: number; lat: number }): GridCoordinate;
  toPosition(point: GridCoordinate): Position;
  detailsAt(x: number, y: number): RoutingCellDetails;
  transitionDetails?(from: GridCoordinate, to: GridCoordinate, at?: GridCoordinate): RoutingTransitionDetails;
  /** Täpsete vektorkoordinaatidega servakontroll valmisgraafi jaoks. */
  positionTransitionAllowed?(from: Position, to: Position): boolean;
  /**
   * Tõene ainult jämeda alusvõre segarakul, kus osa üheksast vee-/sügavusproovist
   * blokeerib ja osa mitte ning ükski vektorpiirang ei blokeeri rakku. Planner
   * kasutab seda ainult selleks, et otsustada, kas rangem peenvõre võiks
   * `no_route` tulemust muuta; tavalises otsingus jääb rakk blokeerituks.
   */
  refinementCandidateAt?(x: number, y: number): boolean;
}

export interface BuildRoutingCostSurfaceInput {
  bbox: BBox;
  depth: RoutingDepthRaster;
  water: RoutingWaterMask;
  vectors: RoutingVectorData;
  vessel: RoutingVesselProfile;
  /** Sünkroonse klassifitseerimise katkestus-/tähtajakontroll. */
  checkpoint?: () => void;
  maxCells?: number;
  minCellSizeM?: number;
  /** Täpsed sadamavärava punktid, millega asendatakse vastava võreraku väljundkeskpunkt. */
  positionOverrides?: readonly Position[];
  /** Faasimõõtmine benchmarki jaoks: baasklassifikatsioon vs vektorkihid. */
  onPhase?: (name: 'base_classification' | 'vector_passes', ms: number) => void;
}

export function isSmallCraftRoutingProfile(vessel: RoutingVesselProfile): boolean {
  return vessel.draughtM <= TRUSTED_ROUTE_MAX_DRAUGHT_M
    && vessel.beamM <= TRUSTED_ROUTE_MAX_BEAM_M;
}

/**
 * Muudab eri täpsuse ja usaldusastmega kihid üheks ruutmeetriliseks kulupinnaks.
 * Rakendamise järjekord on oluline: ametlik sobiv koridor võib üldistatud DTM-i
 * täpsustada, kuid hilisem ametlik piirang või ohu puhver võidab alati.
 */
export function buildRoutingCostSurface(input: BuildRoutingCostSurfaceInput): RoutingCostSurface {
  const checkpoint = input.checkpoint ?? NOOP_CHECKPOINT;
  checkpoint();
  const projection = createRoutingProjection(input.bbox, input.maxCells, input.minCellSizeM);
  const size = projection.width * projection.height;
  const requiredDepthM = input.vessel.draughtM + input.vessel.underKeelClearanceM;
  const blocks = new Uint8Array(size);
  const costs = new Float32Array(size);
  costs.fill(ROUTING_COST_MULTIPLIERS.clear);
  const reasonMasks = new Uint32Array(size);
  const sourceMasks = new Uint32Array(size);
  const depths = new Float32Array(size);
  const mixedBaseCells = new Uint8Array(size);
  const trafficCells = new Map<number, RoutingCorridor[]>();
  const trafficCellMask = new Uint8Array(size);
  const cardinalClearances = new Map<number, Array<{ position: Position; radiusM: number }>>();
  const cardinalTransitionMask = new Uint8Array(size);
  depths.fill(Number.NaN);
  const sourceIds = collectSourceIds(input.vectors.sources);
  const sourceIndexes = new Map(sourceIds.map((source, index) => [source, index]));
  const baseSourceMask = sourceBit(sourceIndexes, 'emodnet-depth')
    | sourceBit(sourceIndexes, 'openfreemap-water');
  sourceMasks.fill(baseSourceMask);
  const [, projectionWest, projectionNorth] = projection.bbox;
  const positionOverrides = new Map<number, Position>();
  for (const position of input.positionOverrides ?? []) {
    const grid = coordinateToGrid(projection, position[0], position[1]);
    const x = Math.round(grid.x);
    const y = Math.round(grid.y);
    if (x >= 0 && x < projection.width && y >= 0 && y < projection.height) {
      positionOverrides.set(y * projection.width + x, position);
    }
  }
  const harbourBoundaryAidIds = new Set(input.vectors.corridors
    .filter((corridor) => corridor.harbourAccess)
    .flatMap((corridor) => corridor.boundaryAidIds ?? []));

  const addReason = (index: number, reason: RoutingReasonCode, source?: string): void => {
    reasonMasks[index] = reasonMasks[index]! | REASON_BITS[reason];
    if (source) sourceMasks[index] = sourceMasks[index]! | sourceBit(sourceIndexes, source);
  };
  const clearReason = (index: number, ...reasons: RoutingReasonCode[]): void => {
    let clearMask = 0;
    for (const reason of reasons) clearMask |= REASON_BITS[reason];
    reasonMasks[index] = reasonMasks[index]! & ~clearMask;
  };

  // Alusklassifikatsioon: OpenFreeMap eristab rannajoont, EMODnet annab sügavuse.
  // Kontrollime keskpunkti ja kaheksat lahtriserva lähedast punkti. Üks maa- või
  // madalavee proov blokeerib kogu lahtri; ühe proovi puudumine muudab lahtri
  // tundmatuks. Nii ei kao kitsas saar või madalik lahtrikeskmete vahele.
  const baseStartedAt = performance.now();
  const waterSampler = createRoutingWaterSampler(input.water);
  for (let y = 0; y < projection.height; y++) {
    if ((y & 7) === 0) checkpoint();
    // Rea kolm proovilaiuskraadi on kõigil lahtritel samad: veemaski,
    // sügavusrastri ja teenindusmaski rea-samplerid tehakse üks kord rea
    // kohta, mitte iga lahtri iga proovi kohta. Tulemus on proovihaaval sama.
    const rowSamplers = CELL_SAMPLE_OFFSETS.map((dy) => {
      const lat = projectionNorth - (y + dy + 0.5) * projection.latStep;
      return {
        water: waterSampler.rowAt(lat),
        depth: createDepthRowSampler(input.depth, lat),
        service: serviceAreaRowSampler(lat),
      };
    });
    for (let x = 0; x < projection.width; x++) {
      const index = cellIndex(projection, x, y);
      let waterLand = false;
      let waterUnknown = false;
      let depthLand = false;
      let depthUnknown = false;
      let outsideOfficialCoverage = false;
      let minimumDepthM = Number.POSITIVE_INFINITY;
      let blockedSampleCount = 0;

      for (const row of rowSamplers) {
        for (const dx of CELL_SAMPLE_OFFSETS) {
          const lon = projectionWest + (x + dx + 0.5) * projection.lonStep;
          const water = row.water(lon);
          waterLand ||= water === false;
          waterUnknown ||= water === null;
          const depthSample = row.depth(lon);
          if (depthSample === DEPTH_SAMPLE_LAND) depthLand = true;
          if (depthSample < 0) depthUnknown = true;
          else minimumDepthM = Math.min(minimumDepthM, depthSample);
          if (water === false || depthSample === DEPTH_SAMPLE_LAND
            || (depthSample >= 0 && depthSample < requiredDepthM)) {
            blockedSampleCount++;
          }
          outsideOfficialCoverage ||= !row.service(lon);
        }
      }

      if (blockedSampleCount > 0 && blockedSampleCount < CELL_SAMPLE_OFFSETS.length ** 2) {
        mixedBaseCells[index] = 1;
      }

      if (waterLand) {
        blocks[index] = blocks[index]! | BLOCK_WATER_LAND;
        addReason(index, 'land', 'openfreemap-water');
      } else if (waterUnknown) {
        costs[index] = Math.max(costs[index]!, ROUTING_COST_MULTIPLIERS.unknown);
        addReason(index, 'water_mask_unknown', 'openfreemap-water');
      }

      if (depthLand) {
        blocks[index] = blocks[index]! | BLOCK_DEPTH_LAND;
        addReason(index, 'land', 'emodnet-depth');
      } else if (depthUnknown) {
        costs[index] = Math.max(costs[index]!, ROUTING_COST_MULTIPLIERS.unknown);
        addReason(index, 'depth_unknown', 'emodnet-depth');
      }

      if (Number.isFinite(minimumDepthM)) {
        depths[index] = minimumDepthM;
        if (minimumDepthM < requiredDepthM) {
          blocks[index] = blocks[index]! | BLOCK_SHALLOW;
          addReason(index, 'known_shallow', 'emodnet-depth');
        } else if (minimumDepthM < requiredDepthM + 0.5) {
          costs[index] = Math.max(costs[index]!, ROUTING_COST_MULTIPLIERS.lowClearance);
          addReason(index, 'low_clearance', 'emodnet-depth');
        }
      }

      if (outsideOfficialCoverage) {
        costs[index] = Math.max(costs[index]!, ROUTING_COST_MULTIPLIERS.unknown);
        addReason(index, 'official_coverage_unknown');
      }
    }
  }

  input.onPhase?.('base_classification', performance.now() - baseStartedAt);
  const vectorStartedAt = performance.now();

  // Avaldatud keskjoon võib väikelaeval üldistatud vee-/sügavusrastri avada;
  // hiljem rakendatavad päris vektorohud ja -piirangud jäävad kõvaks piiriks.
  for (const corridor of input.vectors.corridors) {
    checkpoint();
    if (corridor.official) {
      applyOfficialCorridor(corridor);
    } else {
      applyCommunityCorridor(corridor);
    }
  }

  // Osaline ametlik ohukiht muudab vastava riigi mereala tundmatuks. See ei
  // blokeeri teed, kuid sunnib nii otsingut kui UI-d ebakindlust nähtavaks tegema.
  for (const source of input.vectors.sources) {
    checkpoint();
    applyIncompleteOfficialSource(source);
  }

  for (const restriction of input.vectors.restrictions) {
    checkpoint();
    applyRestriction(restriction);
  }
  for (const hazard of input.vectors.hazards) {
    checkpoint();
    applyHazard(hazard);
  }
  for (const warning of input.vectors.warnings) {
    checkpoint();
    applyWarning(warning);
  }
  input.onPhase?.('vector_passes', performance.now() - vectorStartedAt);

  // A* loeb samu rakke miljoneid kordi. Hoia iga tegelikult esineva
  // (blokeering, põhjusmask, hind) kombinatsiooni kohta üks muutumatu objekt,
  // et kuum otsingutsükkel ei looks iga cellAt-kutsega uut objekti ja uut
  // reasons-massiivi. Risk tuleneb põhjusmaskist, seega ei vaja eraldi võtit.
  const openCellCache = new Map<number, Map<number, RoutingCell>>();
  const blockedCellCache = new Map<number, Map<number, RoutingCell>>();
  const cachedCellAt = (index: number): RoutingCell => {
    const blocked = blocks[index] !== 0;
    const mask = reasonMasks[index]!;
    const costMultiplier = costs[index]!;
    const cache = blocked ? blockedCellCache : openCellCache;
    let cellsByCost = cache.get(mask);
    if (!cellsByCost) {
      cellsByCost = new Map<number, RoutingCell>();
      cache.set(mask, cellsByCost);
    }
    const cached = cellsByCost.get(costMultiplier);
    if (cached) return cached;

    const cell = Object.freeze({
      blocked,
      costMultiplier,
      risk: riskFromReasonMask(mask),
      ...(mask ? { reasons: Object.freeze(reasonsFromMask(mask)) } : {}),
    });
    cellsByCost.set(costMultiplier, cell);
    return cell;
  };

  return {
    width: projection.width,
    height: projection.height,
    minimumCostMultiplier: ROUTING_COST_MULTIPLIERS.preferred,
    projection,
    requiredDepthM,
    trustPublishedRoutes: isSmallCraftRoutingProfile(input.vessel),
    cellAt(x, y): RoutingCell {
      return cachedCellAt(cellIndex(projection, x, y));
    },
    transitionCostMultiplier(from, to) {
      const x = Math.max(0, Math.min(projection.width - 1, Math.round(to.x)));
      const y = Math.max(0, Math.min(projection.height - 1, Math.round(to.y)));
      if (trafficCellMask[y * projection.width + x] === 0) return 1;
      return transitionDetails(from, to).costMultiplier;
    },
    transitionAllowed(from, to) {
      const exactFrom = exactTransitionPosition(from);
      const exactTo = exactTransitionPosition(to);
      return exactFrom || exactTo
        ? cardinalTransitionAllowed(exactFrom ?? gridPosition(from), exactTo ?? gridPosition(to))
        : cardinalGridTransitionAllowed(from, to);
    },
    diagonalCornerTransitionAllowed(from, to) {
      const fromIndex = from.y * projection.width + from.x;
      const toIndex = to.y * projection.width + to.x;
      return (reasonMasks[fromIndex]! & REASON_BITS.harbour_access) !== 0
        && (reasonMasks[toIndex]! & REASON_BITS.harbour_access) !== 0;
    },
    positionTransitionAllowed(from, to) {
      return cardinalTransitionAllowed(from, to);
    },
    toGrid(point) {
      return coordinateToGrid(projection, point.lon, point.lat);
    },
    toPosition(point) {
      if (Number.isInteger(point.x) && Number.isInteger(point.y)) {
        const override = positionOverrides.get(point.y * projection.width + point.x);
        if (override) return override;
      }
      return positionAt(projection, point.x, point.y);
    },
    detailsAt(x, y) {
      const index = cellIndex(projection, x, y);
      const mask = reasonMasks[index]!;
      return {
        blocked: blocks[index] !== 0,
        risk: riskFromReasonMask(mask),
        costMultiplier: costs[index]!,
        reasons: reasonsFromMask(mask),
        sourceIds: sourcesFromMask(sourceMasks[index]!, sourceIds),
        depthM: Number.isFinite(depths[index]) ? depths[index]! : null,
      };
    },
    transitionDetails,
    refinementCandidateAt(x, y) {
      const index = cellIndex(projection, x, y);
      const blockMask = blocks[index]!;
      return mixedBaseCells[index] === 1
        && blockMask !== 0
        && (blockMask & ~BASE_BLOCK_MASK) === 0;
    },
  };

  function applyOfficialCorridor(corridor: RoutingCorridor): void {
    const publishedDepth = corridor.sweptDepthM ?? corridor.depthM;
    const areaGeometry = corridor.geometry.type === 'Polygon'
      || corridor.geometry.type === 'MultiPolygon';
    const constrainedArea = corridor.geometryRole === 'area' || areaGeometry;
    const hasPublishedWidth = corridor.widthM !== undefined && corridor.widthM > 0;
    const spatiallyBounded = constrainedArea || hasPublishedWidth;
    const depthSuitable = publishedDepth === undefined || publishedDepth >= requiredDepthM;
    const draughtSuitable = corridor.maxDraughtM === undefined
      || (corridor.harbourAccess
        ? input.vessel.draughtM <= corridor.maxDraughtM
        : requiredDepthM <= corridor.maxDraughtM);
    const widthSuitable = corridor.widthM === undefined || input.vessel.beamM <= corridor.widthM;
    const trusted = trustedSmallCraftRoute(corridor);
    const suitable = trusted || (depthSuitable && draughtSuitable && widthSuitable);
    const authoritativeClearance = publishedDepth !== undefined || corridor.maxDraughtM !== undefined;
    const bufferM = areaGeometry ? 0 : (corridor.widthM ?? 0) / 2;

    rasterizeGeometry(projection, corridor.geometry, bufferM, (index, rasterPoint) => {
      if (!suitable) {
        if (blocks[index] === 0) {
          costs[index] = Math.max(costs[index]!, ROUTING_COST_MULTIPLIERS.lowClearance);
          addReason(index, 'official_corridor_limit', corridor.source);
        }
        return;
      }

      if (trusted) trustPublishedRouteCell(index);

      const fullyInsidePublishedCorridor = corridor.harbourAccess || (areaGeometry
        ? cellFullyWithinGeometry(projection, index, corridor.geometry, 0)
        : hasPublishedWidth
          && cellFullyWithinGeometry(projection, index, corridor.geometry, corridor.widthM! / 2));
      const cellX = index % projection.width;
      const cellY = Math.floor(index / projection.width);
      const centreInsidePublishedCorridor = corridor.harbourAccess || !spatiallyBounded
        || geometryContainsPointExact(
          corridor.geometry,
          positionAt(projection, cellX, cellY),
          areaGeometry ? 0 : corridor.widthM! / 2,
          projection,
        );
      const representativePoint = positionOverrides.get(index) ?? rasterPoint;
      const harbourWaterCell = corridor.harbourAccess
        && routingWaterAt(input.water, representativePoint[0], representativePoint[1]) === true;
      const waterLandClearable = harbourWaterCell ? BLOCK_WATER_LAND : 0;
      if (spatiallyBounded && fullyInsidePublishedCorridor && authoritativeClearance
        && (blocks[index]! & BLOCK_WATER_LAND & ~waterLandClearable) === 0) {
        // Ametlik sügavus/väylä lubatud süvis võib üldistatud rastermudeli
        // madaliku või land-väärtuse asendada. Sadamakoridoris võib see avada
        // ka rannajoonega lõikuva jämeda lahtri, kuid ainult siis, kui
        // marsruudi täpne esinduspunkt on vektormaski järgi vesi.
        blocks[index] = blocks[index]!
          & ~(BLOCK_DEPTH_LAND | BLOCK_SHALLOW | waterLandClearable);
        clearReason(index, 'known_shallow', 'depth_unknown', 'land', 'low_clearance');
        if (publishedDepth !== undefined) depths[index] = publishedDepth;
        else if (corridor.harbourAccess) depths[index] = Number.NaN;
      }
      if (blocks[index] !== 0) return;
      if (!centreInsidePublishedCorridor) return;
      const knownDepth = corridor.harbourAccess
        ? publishedDepth
        : Number.isFinite(depths[index]) ? depths[index]! : publishedDepth;
      if (knownDepth !== undefined && knownDepth < requiredDepthM + 0.5) {
        costs[index] = Math.max(costs[index]!, ROUTING_COST_MULTIPLIERS.lowClearance);
        addReason(index, 'low_clearance', corridor.source);
      } else if ((reasonMasks[index]! & UNKNOWN_REASON_MASK) === 0) {
        costs[index] = Math.min(costs[index]!, ROUTING_COST_MULTIPLIERS.preferred);
      }
      addReason(index, 'official_corridor', corridor.source);
      if (corridor.harbourAccess) addReason(index, 'harbour_access', corridor.source);
    }, checkpoint);
  }

  function applyCommunityCorridor(corridor: RoutingCorridor): void {
    const area = corridor.geometryRole === 'area'
      || corridor.geometry.type === 'Polygon'
      || corridor.geometry.type === 'MultiPolygon';
    const bufferM = area
      ? projection.cellSizeM * Math.SQRT2 / 2
      : Math.max(projection.cellSizeM * Math.SQRT2 / 2, (corridor.widthM ?? 300) / 2);
    rasterizeGeometry(projection, corridor.geometry, bufferM, (index) => {
      if (trustedSmallCraftRoute(corridor)) {
        trustPublishedRouteCell(index);
      }
      if (blocks[index] !== 0) return;
      if (corridor.kind === 'traffic_lane') {
        const lanes = trafficCells.get(index) ?? [];
        if (!lanes.some((lane) => lane.id === corridor.id)) lanes.push(corridor);
        trafficCells.set(index, lanes);
        trafficCellMask[index] = 1;
        if (corridor.direction === 'unknown'
          || (corridor.direction === 'one_way' && corridor.directionDegrees === undefined)) {
          costs[index] = Math.max(costs[index]!, ROUTING_COST_MULTIPLIERS.warning);
          addReason(index, 'traffic_direction_unverified', corridor.source);
        }
        addReason(index, 'traffic_lane', corridor.source);
      } else {
        if ((reasonMasks[index]! & (UNKNOWN_REASON_MASK | CAUTION_REASON_MASK)) === 0) {
          costs[index] = Math.min(costs[index]!, ROUTING_COST_MULTIPLIERS.preferred);
        }
        addReason(index, 'recommended_route', corridor.source);
      }
    }, checkpoint);
  }

  function trustedSmallCraftRoute(corridor: RoutingCorridor): boolean {
    return isSmallCraftRoutingProfile(input.vessel)
      && corridor.geometryRole === 'centreline'
      && corridor.kind !== 'traffic_lane';
  }

  function trustPublishedRouteCell(index: number): void {
    blocks[index] = blocks[index]! & ~BASE_BLOCK_MASK;
    clearReason(index, ...TRUSTED_ROUTE_CLEARED_REASONS);
    costs[index] = Math.min(costs[index]!, ROUTING_COST_MULTIPLIERS.preferred);
  }

  function applyIncompleteOfficialSource(source: RoutingSourceMeta): void {
    if (source.status !== 'partial' && source.status !== 'unavailable') return;
    const coverage = source.source === 'transpordiamet-his'
      ? ([57, 20, 60.5, 29] satisfies BBox)
      : source.source === 'vaylavirasto-wfs'
        ? ([59.4, 19, 70.2, 31.7] satisfies BBox)
        : null;
    if (!coverage) return;
    rasterizeBbox(projection, intersectBbox(projection.bbox, coverage), (index) => {
      if (blocks[index] !== 0) return;
      costs[index] = Math.max(costs[index]!, ROUTING_COST_MULTIPLIERS.unknown);
      addReason(index, 'official_source_incomplete', source.source);
    }, checkpoint);
  }

  function applyRestriction(restriction: RoutingRestriction): void {
    if (restriction.kind === 'separation_zone') {
      rasterizeGeometry(projection, restriction.geometry, projection.cellSizeM * Math.SQRT2 / 2, (index) => {
        if (restriction.category === 'separation_zone') {
          blocks[index] = blocks[index]! | BLOCK_RESTRICTION;
        } else if (blocks[index] === 0) {
          costs[index] = Math.max(costs[index]!, ROUTING_COST_MULTIPLIERS.warning);
        }
        addReason(index, 'separation_zone', restriction.source);
      }, checkpoint);
      return;
    }

    if (restriction.kind === 'restricted_area') {
      const officialBlock = restriction.prohibited && restriction.source !== 'openstreetmap-overpass';
      rasterizeGeometry(projection, restriction.geometry, projection.cellSizeM * Math.SQRT2 / 2, (index) => {
        addReason(index, 'restricted_area', restriction.source);
        if (officialBlock) blocks[index] = blocks[index]! | BLOCK_RESTRICTION;
        else if (blocks[index] === 0) costs[index] = Math.max(costs[index]!, ROUTING_COST_MULTIPLIERS.warning);
      }, checkpoint);
      return;
    }

    const violates = (restriction.maxHeightM !== undefined && input.vessel.airDraughtM > restriction.maxHeightM)
      || (restriction.maxBeamM !== undefined && input.vessel.beamM > restriction.maxBeamM)
      || (restriction.maxDraughtM !== undefined && input.vessel.draughtM > restriction.maxDraughtM);
    const hasLimits = restriction.maxHeightM !== undefined
      || restriction.maxBeamM !== undefined
      || restriction.maxDraughtM !== undefined;
    const pointStructureBufferM = restriction.source === 'vaylavirasto-wfs'
      && restriction.kind === 'bridge'
      && (restriction.geometry.type === 'Point' || restriction.geometry.type === 'MultiPoint')
      ? OFFICIAL_POINT_STRUCTURE_BUFFER_M
      : 0;
    const bufferM = Math.max(
      projection.cellSizeM * Math.SQRT2 / 2,
      input.vessel.beamM / 2,
      pointStructureBufferM,
    );
    rasterizeGeometry(projection, restriction.geometry, bufferM, (index) => {
      if (violates) {
        blocks[index] = blocks[index]! | BLOCK_RESTRICTION;
        addReason(index, 'structure_clearance', restriction.source);
      } else {
        if (blocks[index] === 0) {
          costs[index] = Math.max(
            costs[index]!,
            hasLimits ? ROUTING_COST_MULTIPLIERS.lowClearance : ROUTING_COST_MULTIPLIERS.warning,
          );
        }
        addReason(index, hasLimits ? 'structure_clearance' : 'structure_unverified', restriction.source);
      }
    }, checkpoint);
  }

  function applyHazard(hazard: RoutingHazard): void {
    if (hazard.kind === 'physical_aid' && harbourBoundaryAidIds.has(hazard.id)) return;
    // Tühistatud/kasutusest väljas märk (HIS margi_olek != 0, Väylä
    // toimintatila != 1) ei pruugi enam vees olla: registrikirje ei ole
    // füüsiline keha ja NMA koondfailil põhinev kaardikiht teda ei näitagi.
    // Töötava märgi rikked katab eraldi aton_fault hoiatuskiht.
    if (hazard.kind === 'physical_aid' && hazard.operational === false) return;
    if (hazard.kind === 'physical_aid'
      && hazard.geometry.type === 'Point'
      && hazard.navigationRole?.startsWith('cardinal-')) {
      const [hazardLon, hazardLat] = hazard.geometry.coordinates;
      const rawGrid = coordinateToGrid(projection, hazardLon, hazardLat);
      const grid = { x: Math.round(rawGrid.x), y: Math.round(rawGrid.y) };
      if (grid.x >= 0 && grid.x < projection.width && grid.y >= 0 && grid.y < projection.height) {
        const index = grid.y * projection.width + grid.x;
        const entries = cardinalClearances.get(index) ?? [];
        entries.push({
          position: hazard.geometry.coordinates,
          radiusM: Math.max(CARDINAL_HARD_CLEARANCE_M, (hazard.sizeM ?? 0) / 2),
        });
        cardinalClearances.set(index, entries);
        // Tavalisel A*-sammul piisab ühest odavast maskikontrollist. ±2
        // katab naaberserva senise ±1 otsingupuhvri mõlema otspunkti suhtes.
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const x = grid.x + dx;
            const y = grid.y + dy;
            if (x >= 0 && x < projection.width && y >= 0 && y < projection.height) {
              cardinalTransitionMask[y * projection.width + x] = 1;
            }
          }
        }
      }
      rasterizeGeometry(projection, hazard.geometry, CARDINAL_INFLUENCE_M, (index, point) => {
        if (blocks[index] !== 0 || !cardinalWrongSide(
          hazard.navigationRole!,
          hazardLon,
          hazardLat,
          point,
          projection.metresPerLongitudeDegree,
        )) return;
        costs[index] = Math.max(costs[index]!, ROUTING_COST_MULTIPLIERS.warning);
        addReason(index, 'cardinal_wrong_side', hazard.source);
      }, checkpoint);
      // Kardinaalmärgi füüsilist 10 m vahet kontrollitakse täpselt liikumisserval.
      // Lahtri blokeerimine paisutaks selle pikal marsruudil ~100 meetrini.
      return;
    }
    const uncertaintyM = hazard.confidence === 'high' ? 10 : hazard.confidence === 'medium' ? 30 : 75;
    const exactRadiusM = input.vessel.beamM / 2 + Math.max(
      (hazard.sizeM ?? 0) / 2,
      uncertaintyM,
    );
    const radiusM = input.vessel.beamM / 2 + Math.max(
      (hazard.sizeM ?? 0) / 2,
      uncertaintyM,
      projection.cellSizeM * Math.SQRT2 / 2,
    );
    const safelySubmerged = hazard.kind !== 'physical_aid'
      && hazard.depthM !== undefined
      && hazard.depthM >= requiredDepthM;
    rasterizeGeometry(projection, hazard.geometry, radiusM, (index, rasterPoint) => {
      // Pika marsruudi jäme lahter ei tohi sulgeda kitsast ametlikult
      // tuletatud sadamakanalit ainult seetõttu, et kivi jääb lahtri nurka.
      // Koridori esinduspunkt peab siiski jääma ohu tegelikust puhvrist välja.
      const representativePoint = positionOverrides.get(index) ?? rasterPoint;
      if ((reasonMasks[index]! & REASON_BITS.harbour_access) !== 0
        && !geometryContainsPointExact(
          hazard.geometry,
          representativePoint,
          exactRadiusM,
          projection,
        )) return;
      if (safelySubmerged) {
        if (blocks[index] === 0) costs[index] = Math.max(costs[index]!, ROUTING_COST_MULTIPLIERS.lowClearance);
        addReason(index, 'submerged_hazard', hazard.source);
      } else {
        blocks[index] = blocks[index]! | BLOCK_HAZARD;
        addReason(index, 'hazard', hazard.source);
      }
    }, checkpoint);
  }

  function gridPosition(point: GridCoordinate): Position {
    if (Number.isInteger(point.x) && Number.isInteger(point.y)) {
      const override = positionOverrides.get(point.y * projection.width + point.x);
      if (override) return override;
    }
    return positionAt(projection, point.x, point.y);
  }

  function exactTransitionPosition(point: GridCoordinate): Position | null {
    // Hübriidotsingu valmisgraafi punkt kannab lisaks võrerakule algset
    // vektorkoordinaati. Kasutame seda ka lihtsustaja kordusvalideerimisel:
    // võreraku keskpunkt võiks muidu täpse 10 m puhvri ekslikult sulgeda.
    const exact = (point as GridCoordinate & { position?: unknown }).position;
    if (Array.isArray(exact)
      && exact.length === 2
      && Number.isFinite(exact[0])
      && Number.isFinite(exact[1])) {
      return [exact[0] as number, exact[1] as number];
    }
    return null;
  }

  function cardinalGridTransitionAllowed(from: GridCoordinate, to: GridCoordinate): boolean {
    if (cardinalClearances.size === 0) return true;
    if (Math.abs(to.x - from.x) <= 1 && Math.abs(to.y - from.y) <= 1) {
      const fromIndex = Math.round(from.y) * projection.width + Math.round(from.x);
      const toIndex = Math.round(to.y) * projection.width + Math.round(to.x);
      if (cardinalTransitionMask[fromIndex] === 0 && cardinalTransitionMask[toIndex] === 0) {
        return true;
      }
    }
    const minX = Math.max(0, Math.floor(Math.min(from.x, to.x)) - 1);
    const maxX = Math.min(projection.width - 1, Math.ceil(Math.max(from.x, to.x)) + 1);
    const minY = Math.max(0, Math.floor(Math.min(from.y, to.y)) - 1);
    const maxY = Math.min(projection.height - 1, Math.ceil(Math.max(from.y, to.y)) + 1);
    let fromPosition: Position | null = null;
    let toPosition: Position | null = null;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const clearances = cardinalClearances.get(y * projection.width + x);
        if (!clearances) continue;
        fromPosition ??= gridPosition(from);
        toPosition ??= gridPosition(to);
        for (const clearance of clearances) {
          if (distanceToSegmentM(
            clearance.position,
            fromPosition,
            toPosition,
            projection,
          ) <= clearance.radiusM) return false;
        }
      }
    }
    return true;
  }

  function cardinalTransitionAllowed(from: Position, to: Position): boolean {
    if (cardinalClearances.size === 0) return true;
    const fromGrid = coordinateToGrid(projection, from[0], from[1]);
    const toGrid = coordinateToGrid(projection, to[0], to[1]);
    return cardinalClearancesBetween(fromGrid, toGrid).every((clearance) =>
      distanceToSegmentM(clearance.position, from, to, projection) > clearance.radiusM);
  }

  function cardinalClearancesBetween(
    from: GridCoordinate,
    to: GridCoordinate,
  ): Array<{ position: Position; radiusM: number }> {
    const result: Array<{ position: Position; radiusM: number }> = [];
    const minX = Math.max(0, Math.floor(Math.min(from.x, to.x)) - 1);
    const maxX = Math.min(projection.width - 1, Math.ceil(Math.max(from.x, to.x)) + 1);
    const minY = Math.max(0, Math.floor(Math.min(from.y, to.y)) - 1);
    const maxY = Math.min(projection.height - 1, Math.ceil(Math.max(from.y, to.y)) + 1);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        for (const clearance of cardinalClearances.get(y * projection.width + x) ?? []) {
          result.push(clearance);
        }
      }
    }
    return result;
  }

  function transitionDetails(
    from: GridCoordinate,
    to: GridCoordinate,
    at: GridCoordinate = to,
  ): RoutingTransitionDetails {
    const x = Math.max(0, Math.min(projection.width - 1, Math.round(at.x)));
    const y = Math.max(0, Math.min(projection.height - 1, Math.round(at.y)));
    const lanes = trafficCells.get(cellIndex(projection, x, y)) ?? [];
    if (lanes.length === 0) {
      return { costMultiplier: 1, risk: 'clear', reasons: [], sourceIds: [] };
    }
    const fromPosition = positionAt(projection, from.x, from.y);
    const toPosition = positionAt(projection, to.x, to.y);
    const heading = movementBearing(fromPosition, toPosition, projection.metresPerLongitudeDegree);
    const classified = lanes.map((lane) => classifyTrafficMovement(lane, heading))
      .sort((left, right) => left.costMultiplier - right.costMultiplier
        || left.reasons.join(',').localeCompare(right.reasons.join(',')))[0]!;
    return classified;
  }

  function applyWarning(warning: RoutingWarning): void {
    const radiusM = Math.max(500, projection.cellSizeM * 2);
    rasterizeGeometry(projection, warning.geometry, radiusM, (index) => {
      // Informatiivne/tavapärane navigatsioonihoiatus peab marsruudil nähtav
      // olema, kuid ei tohi moodustada pika joone ümber kunstlikku seina.
      // Ainult otseselt kriitiline hoiatus või rikkis AToN mõjutab valikut.
      if (blocks[index] === 0 && warning.severity === 'critical') {
        costs[index] = Math.max(costs[index]!, ROUTING_COST_MULTIPLIERS.warning);
      } else if (blocks[index] === 0 && warning.kind === 'aton_fault') {
        costs[index] = Math.max(costs[index]!, ROUTING_COST_MULTIPLIERS.lowClearance);
      }
      addReason(
        index,
        warning.kind === 'aton_fault' ? 'aton_fault' : 'navigation_warning',
        warning.source,
      );
    }, checkpoint);
  }
}

function classifyTrafficMovement(
  lane: RoutingCorridor,
  heading: number,
): RoutingTransitionDetails {
  const sourceIds = [lane.source];
  if (lane.direction !== 'one_way') {
    return lane.direction === 'unknown'
      ? {
          costMultiplier: ROUTING_COST_MULTIPLIERS.warning,
          risk: 'caution',
          reasons: ['traffic_direction_unverified'],
          sourceIds,
        }
      : { costMultiplier: 1, risk: 'clear', reasons: [], sourceIds };
  }
  if (lane.directionDegrees === undefined) {
    return {
      costMultiplier: ROUTING_COST_MULTIPLIERS.warning,
      risk: 'caution',
      reasons: ['traffic_direction_unverified'],
      sourceIds,
    };
  }
  const difference = angularDifference(heading, lane.directionDegrees);
  if (difference <= 30) {
    return { costMultiplier: 1, risk: 'clear', reasons: [], sourceIds };
  }
  if (Math.abs(difference - 90) <= 20) {
    return {
      costMultiplier: 1,
      risk: 'caution',
      reasons: ['traffic_crossing'],
      sourceIds,
    };
  }
  return {
    costMultiplier: ROUTING_COST_MULTIPLIERS.warning,
    risk: 'caution',
    reasons: [difference >= 150 ? 'traffic_wrong_way' : 'traffic_direction_unverified'],
    sourceIds,
  };
}

function movementBearing(from: Position, to: Position, metresPerLongitudeDegree: number): number {
  const east = (to[0] - from[0]) * metresPerLongitudeDegree;
  const north = (to[1] - from[1]) * METRES_PER_LATITUDE_DEGREE;
  return (Math.atan2(east, north) * 180 / Math.PI + 360) % 360;
}

function angularDifference(left: number, right: number): number {
  const difference = Math.abs(((left - right + 540) % 360) - 180);
  return Math.min(180, difference);
}

function cardinalWrongSide(
  role: NonNullable<RoutingHazard['navigationRole']>,
  hazardLon: number,
  hazardLat: number,
  point: Position,
  metresPerLongitudeDegree: number,
): boolean {
  const east = (point[0] - hazardLon) * metresPerLongitudeDegree;
  const north = (point[1] - hazardLat) * METRES_PER_LATITUDE_DEGREE;
  if (role === 'cardinal-north') return north < 0;
  if (role === 'cardinal-east') return east < 0;
  if (role === 'cardinal-south') return north > 0;
  if (role === 'cardinal-west') return east > 0;
  return false;
}

export function createRoutingProjection(
  bbox: BBox,
  maxCells = DEFAULT_MAX_CELLS,
  minCellSizeM = MIN_CELL_SIZE_M,
): RoutingGridProjection {
  const [south, west, north, east] = bbox;
  if (!bbox.every(Number.isFinite) || south >= north || west >= east) {
    throw new RangeError('Routing bbox must be a finite [south, west, north, east] area');
  }
  if (!Number.isFinite(maxCells) || maxCells < 4 || !Number.isFinite(minCellSizeM) || minCellSizeM <= 0) {
    throw new RangeError('Routing grid limits must be positive');
  }
  const middleLatitude = (south + north) / 2;
  const metresPerLongitudeDegree = Math.max(1_000,
    METRES_PER_LATITUDE_DEGREE * Math.cos(middleLatitude * Math.PI / 180));
  const widthM = (east - west) * metresPerLongitudeDegree;
  const heightM = (north - south) * METRES_PER_LATITUDE_DEGREE;
  const cellSizeM = Math.max(minCellSizeM, Math.sqrt(widthM * heightM / maxCells));
  const width = Math.max(2, Math.ceil(widthM / cellSizeM));
  const height = Math.max(2, Math.ceil(heightM / cellSizeM));
  return {
    bbox: [...bbox],
    width,
    height,
    cellSizeM: Math.max(widthM / width, heightM / height),
    lonStep: (east - west) / width,
    latStep: (north - south) / height,
    metresPerLongitudeDegree,
  };
}

function collectSourceIds(sources: readonly RoutingSourceMeta[]): string[] {
  return [...new Set(['emodnet-depth', 'openfreemap-water', ...sources.map((source) => source.id)])];
}

function sourceBit(indexes: Map<string, number>, source: string): number {
  let index = indexes.get(source);
  if (index === undefined) {
    index = indexes.size;
    if (index >= 31) return 0;
    indexes.set(source, index);
  }
  return 2 ** index;
}

function sourcesFromMask(mask: number, sources: readonly string[]): string[] {
  return sources.filter((_source, index) => index < 31 && (mask & (2 ** index)) !== 0);
}

function reasonsFromMask(mask: number): RoutingReasonCode[] {
  return ROUTING_REASON_CODES.filter((reason) => (mask & REASON_BITS[reason]) !== 0);
}

function riskFromReasonMask(mask: number): RouteRisk {
  if ((mask & UNKNOWN_REASON_MASK) !== 0) return 'unknown';
  return (mask & CAUTION_REASON_MASK) !== 0 ? 'caution' : 'clear';
}

function cellIndex(projection: RoutingGridProjection, x: number, y: number): number {
  if (!Number.isInteger(x) || !Number.isInteger(y)
    || x < 0 || x >= projection.width || y < 0 || y >= projection.height) {
    throw new RangeError(`Routing cell ${x},${y} is outside the grid`);
  }
  return y * projection.width + x;
}

function positionAt(projection: RoutingGridProjection, x: number, y: number): Position {
  const [south, west, north] = projection.bbox;
  void south;
  return [west + (x + 0.5) * projection.lonStep, north - (y + 0.5) * projection.latStep];
}

/** Keskpunkt ning nelja serva ja nelja nurga lähedased proovipunktid. */
function cellSamplePositions(
  projection: RoutingGridProjection,
  x: number,
  y: number,
): Position[] {
  return CELL_SAMPLE_OFFSETS.flatMap((dy) =>
    CELL_SAMPLE_OFFSETS.map((dx) => positionAt(projection, x + dx, y + dy)));
}

function coordinateToGrid(
  projection: RoutingGridProjection,
  lon: number,
  lat: number,
): GridCoordinate {
  const [, west, north] = projection.bbox;
  return {
    x: (lon - west) / projection.lonStep - 0.5,
    y: (north - lat) / projection.latStep - 0.5,
  };
}

function rasterizeGeometry(
  projection: RoutingGridProjection,
  geometry: RoutingGeometry,
  bufferM: number,
  visit: (index: number, point: Position) => void,
  checkpoint: () => void = NOOP_CHECKPOINT,
): void {
  const [south, west, north, east] = routingGeometryBbox(geometry);
  const lonMargin = bufferM / projection.metresPerLongitudeDegree;
  const latMargin = bufferM / METRES_PER_LATITUDE_DEGREE;
  const bounds: BBox = [south - latMargin, west - lonMargin, north + latMargin, east + lonMargin];
  const cellHalfDiagonal = projection.cellSizeM * Math.SQRT2 / 2;
  rasterizeBbox(projection, bounds, (index, point) => {
    if (geometryContainsPoint(geometry, point, bufferM, projection, cellHalfDiagonal)) visit(index, point);
  }, checkpoint);
}

function rasterizeBbox(
  projection: RoutingGridProjection,
  bbox: BBox | null,
  visit: (index: number, point: Position) => void,
  checkpoint: () => void = NOOP_CHECKPOINT,
): void {
  if (!bbox) return;
  const [, west, north] = projection.bbox;
  const minX = Math.max(0, Math.floor((bbox[1] - west) / projection.lonStep));
  const maxX = Math.min(projection.width - 1, Math.ceil((bbox[3] - west) / projection.lonStep));
  const minY = Math.max(0, Math.floor((north - bbox[2]) / projection.latStep));
  const maxY = Math.min(projection.height - 1, Math.ceil((north - bbox[0]) / projection.latStep));
  for (let y = minY; y <= maxY; y++) {
    if ((y & 7) === 0) checkpoint();
    for (let x = minX; x <= maxX; x++) {
      visit(y * projection.width + x, positionAt(projection, x, y));
    }
  }
}

function geometryContainsPoint(
  geometry: RoutingGeometry,
  point: Position,
  bufferM: number,
  projection: RoutingGridProjection,
  cellHalfDiagonal: number,
): boolean {
  if ((geometry.type === 'Polygon' || geometry.type === 'MultiPolygon')
    && pointInRoutingGeometry(point, geometry)) return true;
  const effectiveBuffer = Math.max(bufferM, cellHalfDiagonal);
  if (geometry.type === 'Point') return distanceM(point, geometry.coordinates, projection) <= effectiveBuffer;
  if (geometry.type === 'MultiPoint') {
    return geometry.coordinates.some((candidate) => distanceM(point, candidate, projection) <= effectiveBuffer);
  }
  return geometryLines(geometry).some((line) => line.slice(1).some((to, index) =>
    distanceToSegmentM(point, line[index]!, to, projection) <= effectiveBuffer));
}

/**
 * Kontrollib, et kogu lahtri üheksa proovipunkti jääks avaldatud ala või
 * joone tegeliku laiuse sisse. Lahtri pooldiagonaali siin teadlikult ei lisata.
 */
function cellFullyWithinGeometry(
  projection: RoutingGridProjection,
  index: number,
  geometry: RoutingGeometry,
  bufferM: number,
): boolean {
  const x = index % projection.width;
  const y = Math.floor(index / projection.width);
  return cellSamplePositions(projection, x, y)
    .every((point) => geometryContainsPointExact(geometry, point, bufferM, projection));
}

function geometryContainsPointExact(
  geometry: RoutingGeometry,
  point: Position,
  bufferM: number,
  projection: RoutingGridProjection,
): boolean {
  if (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') {
    return pointInRoutingGeometry(point, geometry);
  }
  if (geometry.type === 'Point') return distanceM(point, geometry.coordinates, projection) <= bufferM;
  if (geometry.type === 'MultiPoint') {
    return geometry.coordinates.some((candidate) => distanceM(point, candidate, projection) <= bufferM);
  }
  return geometryLines(geometry).some((line) => line.slice(1).some((to, index) =>
    distanceToSegmentM(point, line[index]!, to, projection) <= bufferM));
}

function geometryLines(geometry: RoutingGeometry): Position[][] {
  switch (geometry.type) {
    case 'LineString': return [geometry.coordinates];
    case 'MultiLineString': return geometry.coordinates;
    case 'Polygon': return geometry.coordinates;
    case 'MultiPolygon': return geometry.coordinates.flat();
    default: return [];
  }
}

function distanceM(a: Position, b: Position, projection: RoutingGridProjection): number {
  return Math.hypot(
    (a[0] - b[0]) * projection.metresPerLongitudeDegree,
    (a[1] - b[1]) * METRES_PER_LATITUDE_DEGREE,
  );
}

function distanceToSegmentM(
  point: Position,
  a: Position,
  b: Position,
  projection: RoutingGridProjection,
): number {
  const px = (point[0] - a[0]) * projection.metresPerLongitudeDegree;
  const py = (point[1] - a[1]) * METRES_PER_LATITUDE_DEGREE;
  const bx = (b[0] - a[0]) * projection.metresPerLongitudeDegree;
  const by = (b[1] - a[1]) * METRES_PER_LATITUDE_DEGREE;
  const denominator = bx * bx + by * by;
  if (denominator === 0) return Math.hypot(px, py);
  const t = Math.max(0, Math.min(1, (px * bx + py * by) / denominator));
  return Math.hypot(px - t * bx, py - t * by);
}

function intersectBbox(a: BBox, b: BBox): BBox | null {
  const result: BBox = [
    Math.max(a[0], b[0]),
    Math.max(a[1], b[1]),
    Math.min(a[2], b[2]),
    Math.min(a[3], b[3]),
  ];
  return result[0] < result[2] && result[1] < result[3] ? result : null;
}
