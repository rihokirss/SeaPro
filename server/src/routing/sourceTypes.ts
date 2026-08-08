import type { BBox } from '@seapro/shared';

export type RoutingSourceId =
  | 'transpordiamet-his'
  | 'transpordiamet-warnings'
  | 'vaylavirasto-wfs'
  | 'openstreetmap-overpass';

export type RoutingSourceStatus =
  | 'ok'
  | 'stale'
  | 'partial'
  | 'unavailable'
  | 'outside_coverage';

export interface RoutingSourceMeta {
  /** Sama kuju nagu avalikul RoutePlanSource'il; `source` on tüübitud alias. */
  id: RoutingSourceId;
  source: RoutingSourceId;
  status: RoutingSourceStatus;
  stale: boolean;
  /** Viimase eduka cache-kirje ligikaudne laadimisaeg. */
  fetchedAt: string;
  ageSeconds: number;
  coverage: 'complete' | 'partial' | 'missing';
  error?: string;
  tilesRequested: number;
  tilesLoaded: number;
  attribution: string;
  attributionUrl: string;
  errors?: string[];
}

export type Position = [number, number];

export type RoutingGeometry =
  | { type: 'Point'; coordinates: Position }
  | { type: 'MultiPoint'; coordinates: Position[] }
  | { type: 'LineString'; coordinates: Position[] }
  | { type: 'MultiLineString'; coordinates: Position[][] }
  | { type: 'Polygon'; coordinates: Position[][] }
  | { type: 'MultiPolygon'; coordinates: Position[][][] };

export interface RoutingFeatureSource {
  source: RoutingSourceId;
  /** Ligikaudne aeg, mil selle paani edukas vastus allikast saadi. */
  fetchedAt: string;
  stale: boolean;
}

interface RoutingFeatureBase extends RoutingFeatureSource {
  id: string;
  geometry: RoutingGeometry;
  name?: string;
  description?: string;
}

export type RoutingConfidence = 'high' | 'medium' | 'low';

export type RoutingAidRole =
  | 'lateral-port'
  | 'lateral-starboard'
  | 'other';

export interface RoutingHazard extends RoutingFeatureBase {
  kind: 'rock' | 'obstruction' | 'wreck' | 'physical_aid';
  /** Vähim teadaolev veesügavus objekti kohal, meetrites. */
  depthM?: number;
  /** Objekti suurim teadaolev horisontaalmõõt, meetrites. */
  sizeM?: number;
  /** Objekti kõrgus merepõhjast või märgi füüsiline kõrgus, meetrites. */
  heightM?: number;
  confidence: RoutingConfidence;
  surveyAreaId?: string;
  category?: string;
  waterLevelCode?: string;
  /** Külgmärgi roll võimaldab sadamakanali keskjoone tuletada märgipaari vahele. */
  navigationRole?: RoutingAidRole;
  operational?: boolean;
}

export interface RoutingCorridor extends RoutingFeatureBase {
  kind: 'fairway' | 'recommended' | 'traffic_lane';
  /** Ala või joone roll; võimaldab vältida sama faarvaatri topelt-eelistamist. */
  geometryRole?: 'area' | 'centreline';
  depthM?: number;
  sweptDepthM?: number;
  maxDraughtM?: number;
  widthM?: number;
  directionDegrees?: number;
  direction?: 'one_way' | 'two_way' | 'unknown';
  official: boolean;
  referenceLevel?: string;
  fairwayNumber?: string;
  category?: string;
  /** Kitsas tuletatud ühendus valitud sadamapunktist avaldatud laevateeni. */
  harbourAccess?: boolean;
  /** Märgid on koridori piirid, mitte keskjoonel olevad takistused. */
  boundaryAidIds?: string[];
  /** Kohustuslikud keskpunktid sadamast mere suunas. */
  waypoints?: Position[];
}

export interface RoutingHarbour extends RoutingFeatureBase {
  kind: 'harbour';
  maxDraughtM?: number;
  maxBeamM?: number;
  maxLengthM?: number;
  official: boolean;
}

interface RoutingRestrictionBase extends RoutingFeatureBase {
  kind: 'bridge' | 'restricted_area' | 'separation_zone' | 'lock';
}

export interface RoutingBridgeRestriction extends RoutingRestrictionBase {
  kind: 'bridge';
  maxHeightM?: number;
  maxBeamM?: number;
  maxLengthM?: number;
  maxDraughtM?: number;
  opens?: boolean;
  operation?: string;
}

export interface RoutingLockRestriction extends RoutingRestrictionBase {
  kind: 'lock';
  maxHeightM?: number;
  maxBeamM?: number;
  maxLengthM?: number;
  maxDraughtM?: number;
  operation?: string;
}

export interface RoutingAreaRestriction extends RoutingRestrictionBase {
  kind: 'restricted_area';
  rule?: string;
  ruleCodes?: string[];
  /** Tõene ainult üldise mootorlaeva liikluskeelu korral, mitte nt lainekeelu puhul. */
  prohibited: boolean;
  /** Kiiruspiir SI-ühikus; Soome lähteväärtus teisendatakse km/h-st. */
  speedLimitMps?: number;
  exception?: string;
  schedule?: string;
  validFrom?: string;
  validTo?: string;
}

export interface RoutingSeparationZone extends RoutingRestrictionBase {
  kind: 'separation_zone';
  category?: string;
  directionDegrees?: number;
}

export type RoutingRestriction =
  | RoutingBridgeRestriction
  | RoutingLockRestriction
  | RoutingAreaRestriction
  | RoutingSeparationZone;

export interface RoutingWarning extends RoutingFeatureBase {
  kind: 'aton_fault' | 'navigation_warning';
  severity: 'caution' | 'critical';
  reportedAt?: string;
  aidNumber?: string;
  faultCode?: string;
  fairwayClass?: string;
}

export interface RoutingSurveyArea extends RoutingFeatureBase {
  geometry: Extract<RoutingGeometry, { type: 'Polygon' | 'MultiPolygon' }>;
  ihoS44Category?: string;
  surveyedAt?: string;
  processedAt?: string;
  minDepthM?: number;
  maxDepthM?: number;
  statusCode?: string;
}

export interface RoutingVectorData {
  bbox: BBox;
  hazards: RoutingHazard[];
  corridors: RoutingCorridor[];
  restrictions: RoutingRestriction[];
  warnings: RoutingWarning[];
  surveyAreas: RoutingSurveyArea[];
  harbours?: RoutingHarbour[];
  sources: RoutingSourceMeta[];
}
