import type { BBox, ExerciseArea } from '@seapro/shared';
import { EXERCISE_AREAS_URL, fetchExerciseAreasWithMeta } from '../../navigation/estoniaSupplemental.js';
import { routingGeometryBbox } from '../sourceGeometry.js';
import type { RoutingRestriction, RoutingSourceMeta, RoutingWarning } from '../sourceTypes.js';

export const EXERCISE_AREA_NOTICE = 'Püsiv laskeala. Aktiivsus ja võimalikud liikumispiirangud tuleb kontrollida kehtivatest navigatsioonihoiatustest.';

export async function loadEstonianExerciseAreas(bbox: BBox): Promise<{
  areas: ExerciseArea[]; warnings: RoutingWarning[]; source: RoutingSourceMeta;
}> {
  const source: RoutingSourceMeta = {
    id: 'transpordiamet-exercise-areas', source: 'transpordiamet-exercise-areas',
    status: 'outside_coverage', stale: false, fetchedAt: new Date().toISOString(), ageSeconds: 0,
    coverage: 'complete', tilesRequested: 0, tilesLoaded: 0,
    attribution: 'Transpordiamet, laskealad', attributionUrl: EXERCISE_AREAS_URL,
  };
  if (bbox[2] < 57 || bbox[0] > 60.5 || bbox[3] < 20 || bbox[1] > 29) return { areas: [], warnings: [], source };
  source.tilesRequested = 1;
  try {
    const snapshot = await fetchExerciseAreasWithMeta(bbox);
    source.status = snapshot.stale ? 'stale' : 'ok';
    source.stale = snapshot.stale;
    source.fetchedAt = new Date(snapshot.storedAt).toISOString();
    source.ageSeconds = Math.max(0, (Date.now() - snapshot.storedAt) / 1000);
    source.tilesLoaded = 1;
    return { areas: snapshot.value, source, warnings: snapshot.value.map((area) => ({
      id: area.id, geometry: area.geometry, name: `Laskeala ${area.name}`, description: EXERCISE_AREA_NOTICE,
      kind: 'exercise_area', severity: 'caution', source: source.source,
      fetchedAt: source.fetchedAt, stale: snapshot.stale,
    })) };
  } catch (error) {
    return { areas: [], warnings: [], source: { ...source, status: 'unavailable', coverage: 'missing',
      error: error instanceof Error ? error.message : String(error) } };
  }
}

/** Asendame üksnes sama harjutusala OSM-koopia; selgesõnalised keelud säilivad. */
export function preferOfficialExerciseAreas(restrictions: RoutingRestriction[], areas: ExerciseArea[]): RoutingRestriction[] {
  return restrictions.filter((restriction) => {
    if (restriction.source !== 'openstreetmap-overpass' || restriction.kind !== 'restricted_area'
      || restriction.prohibited || !/military|firing|exercise|laske|harjutus/i.test(`${restriction.rule} ${restriction.name}`)) return true;
    const box = routingGeometryBbox(restriction.geometry);
    return !areas.some((area) => {
      const official = routingGeometryBbox(area.geometry);
      const intersection = Math.max(0, Math.min(box[2], official[2]) - Math.max(box[0], official[0]))
        * Math.max(0, Math.min(box[3], official[3]) - Math.max(box[1], official[1]));
      const union = (box[2] - box[0]) * (box[3] - box[1])
        + (official[2] - official[0]) * (official[3] - official[1]) - intersection;
      const sameName = normalize(restriction.name ?? '') === normalize(area.name);
      const sameGeometry = JSON.stringify(restriction.geometry) === JSON.stringify(area.geometry);
      return sameGeometry || (sameName && union > 0 && intersection / union >= 0.8);
    });
  });
}

function normalize(name: string): string {
  return name.toLowerCase().replace(/laskeala|harjutusala|military|firing|exercise|area/g, '').replace(/[^a-z0-9]/g, '');
}
