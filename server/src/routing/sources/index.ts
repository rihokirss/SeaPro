import type { BBox } from '@seapro/shared';
import type { RoutingSourceId, RoutingSourceMeta, RoutingVectorData } from '../sourceTypes.js';
import { loadEstonianRoutingData } from './estonia.js';
import { loadEstonianRoutingWarnings } from './estoniaWarnings.js';
import { loadFinnishRoutingWarnings } from './finlandWarnings.js';
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
  finnishWarningsSourceMeta,
  loadFinnishRoutingWarnings,
  parseFinnishNavigationWarnings,
  type FinnishRoutingWarnings,
} from './finlandWarnings.js';
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
  onPhase?: (name: string, ms: number) => void,
): Promise<RoutingVectorData> {
  if (!bbox.every(Number.isFinite) || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) {
    throw new Error('Routing bbox peab olema [lõuna, lääs, põhi, ida] ja positiivse pindalaga');
  }
  if (!Number.isFinite(new Date(departureTime).getTime())) {
    throw new Error('departureTime peab olema kehtiv ISO 8601 aeg');
  }

  // Iga allika kõva ajaeelarve: rippuv väline teenus (nt Overpassi ummik)
  // ei tohi süüa kogu plaani tähtaega. Üle eelarve läheb allikas osalise
  // katte režiimi — otsing muudab vastava ala tundmatuks, mitte ei sure —
  // ja mahajäänud päring jookseb taustal lõpuni ning soojendab cache'i
  // järgmiseks katseks.
  const [estonia, estonianWarnings, finland, finnishWarnings, osm] = await Promise.all([
    timedSource('transpordiamet_his', () => withSourceBudget(loadEstonianRoutingData(bbox), () => ({
      hazards: [], corridors: [], surveyAreas: [], harbours: [],
      source: budgetExceededMeta('transpordiamet-his',
        'Transpordiamet, Hüdrograafia infosüsteem',
        'https://gis.transpordiamet.ee/arcgis/rest/services/Nutimeri/HIS/MapServer'),
    })), onPhase),
    timedSource('transpordiamet_warnings', () => withSourceBudget(
      loadEstonianRoutingWarnings(bbox, departureTime), () => ({
        warnings: [],
        source: budgetExceededMeta('transpordiamet-warnings',
          'Transpordiamet, navigatsioonihoiatused',
          'https://gis.transpordiamet.ee/arcgis/rest/services/Navigatsioonihoiatused/Nav_hoiatused_avalik/FeatureServer'),
      })), onPhase),
    timedSource('vaylavirasto_wfs', () => withSourceBudget(
      loadFinnishRoutingData(bbox, departureTime), () => ({
        hazards: [], corridors: [], restrictions: [], warnings: [],
        source: budgetExceededMeta('vaylavirasto-wfs',
          'Väylävirasto avoin WFS', 'https://vayla.fi/vaylista/aineistot/avoindata'),
      })), onPhase),
    timedSource('traficom_warnings', () => withSourceBudget(
      loadFinnishRoutingWarnings(bbox, departureTime), () => ({
        warnings: [],
        source: budgetExceededMeta('traficom-warnings',
          'Traficom / Fintraffic, navigational warnings',
          'https://julkinen.traficom.fi/inspirepalvelu/avoin/wfs'),
      })), onPhase),
    timedSource('openstreetmap_overpass', () => withSourceBudget(loadOsmRoutingData(bbox), () => ({
      hazards: [], corridors: [], restrictions: [], harbours: [],
      source: budgetExceededMeta('openstreetmap-overpass',
        '© OpenStreetMap contributors / OpenSeaMap seamarks',
        'https://www.openstreetmap.org/copyright'),
    })), onPhase),
  ]);

  return {
    bbox: [...bbox],
    hazards: sortById([...estonia.hazards, ...finland.hazards, ...osm.hazards]),
    corridors: sortById([...estonia.corridors, ...finland.corridors, ...osm.corridors]),
    restrictions: sortById([...finland.restrictions, ...osm.restrictions]),
    warnings: sortById([
      ...estonianWarnings.warnings,
      ...finland.warnings,
      ...finnishWarnings.warnings,
    ]),
    surveyAreas: sortById(estonia.surveyAreas),
    harbours: sortById([...estonia.harbours, ...osm.harbours]),
    sources: [
      estonia.source,
      estonianWarnings.source,
      finland.source,
      finnishWarnings.source,
      osm.source,
    ],
  };
}

async function timedSource<T>(
  name: string,
  loader: () => Promise<T>,
  onPhase?: (name: string, ms: number) => void,
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await loader();
  } finally {
    onPhase?.(name, performance.now() - startedAt);
  }
}

function sortById<T extends { id: string }>(items: T[]): T[] {
  return items.sort((a, b) => a.id.localeCompare(b.id));
}

const SOURCE_BUDGET_MS = 40_000;

function withSourceBudget<T>(promise: Promise<T>, fallback: () => T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback()), SOURCE_BUDGET_MS);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(fallback());
      });
  });
}

function budgetExceededMeta(
  source: RoutingSourceId,
  attribution: string,
  attributionUrl: string,
): RoutingSourceMeta {
  return {
    id: source,
    source,
    status: 'unavailable',
    stale: false,
    fetchedAt: new Date().toISOString(),
    ageSeconds: 0,
    coverage: 'missing',
    error: `Allika ajaeelarve (${SOURCE_BUDGET_MS / 1000} s) sai täis`,
    tilesRequested: 1,
    tilesLoaded: 0,
    attribution,
    attributionUrl,
  };
}
