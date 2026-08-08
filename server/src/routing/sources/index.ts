import type { BBox } from '@seapro/shared';
import type { RoutingVectorData } from '../sourceTypes.js';
import { loadEstonianRoutingData } from './estonia.js';
import { loadEstonianRoutingWarnings } from './estoniaWarnings.js';
import { loadFinnishRoutingData } from './finland.js';
import { loadOsmRoutingData } from './osm.js';

export type {
  Position,
  RoutingAreaRestriction,
  RoutingBridgeRestriction,
  RoutingConfidence,
  RoutingCorridor,
  RoutingFeatureSource,
  RoutingGeometry,
  RoutingHarbour,
  RoutingHazard,
  RoutingLockRestriction,
  RoutingRestriction,
  RoutingSeparationZone,
  RoutingSourceId,
  RoutingSourceMeta,
  RoutingSourceStatus,
  RoutingSurveyArea,
  RoutingVectorData,
  RoutingWarning,
} from '../sourceTypes.js';

export { pointInRoutingGeometry, routingGeometryBbox, routingGeometryIntersectsBbox } from '../sourceGeometry.js';
export {
  loadEstonianRoutingData,
  parseEstonianRoutingData,
  type EstonianRoutingCollections,
  type EstonianRoutingData,
} from './estonia.js';
export {
  loadEstonianRoutingWarnings,
  parseEstonianNavigationWarnings,
  type EstonianRoutingWarnings,
} from './estoniaWarnings.js';
export {
  loadFinnishRoutingData,
  parseFinnishRoutingData,
  type FinnishRoutingCollections,
  type FinnishRoutingData,
} from './finland.js';
export {
  loadOsmRoutingData,
  parseOsmRoutingData,
  type OsmRoutingData,
  type OverpassRoutingResponse,
} from './osm.js';

/** Laadib ühe snapshot'i jaoks kõik masinloetavad ametlikud ja OSM-vektorkihid. */
export async function loadRoutingVectorData(
  bbox: BBox,
  departureTime: string,
): Promise<RoutingVectorData> {
  if (!bbox.every(Number.isFinite) || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) {
    throw new Error('Routing bbox peab olema [lõuna, lääs, põhi, ida] ja positiivse pindalaga');
  }
  if (!Number.isFinite(new Date(departureTime).getTime())) {
    throw new Error('departureTime peab olema kehtiv ISO 8601 aeg');
  }

  const [estonia, estonianWarnings, finland, osm] = await Promise.all([
    loadEstonianRoutingData(bbox),
    loadEstonianRoutingWarnings(bbox, departureTime),
    loadFinnishRoutingData(bbox, departureTime),
    loadOsmRoutingData(bbox),
  ]);

  return {
    bbox: [...bbox],
    hazards: sortById([...estonia.hazards, ...finland.hazards, ...osm.hazards]),
    corridors: sortById([...estonia.corridors, ...finland.corridors, ...osm.corridors]),
    restrictions: sortById([...finland.restrictions, ...osm.restrictions]),
    warnings: sortById([...estonianWarnings.warnings, ...finland.warnings]),
    surveyAreas: sortById(estonia.surveyAreas),
    harbours: sortById([...estonia.harbours, ...osm.harbours]),
    sources: [estonia.source, estonianWarnings.source, finland.source, osm.source],
  };
}

function sortById<T extends { id: string }>(items: T[]): T[] {
  return items.sort((a, b) => a.id.localeCompare(b.id));
}
