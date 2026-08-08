import type { Route } from '@seapro/shared';
import { distanceMetres } from '@seapro/shared';

const ROUTE_ENTRY_REACHED_M = 50;

/**
 * Automaatmarsruut algab planeerija poolt läbitavale veele kleebitud punktist.
 * Kui GPS pole veel saabunud või laev on sellest üle 50 m eemal, juhatame
 * esmalt sinna; käsitsi marsruut alustab endiselt esimesest järgmisest punktist.
 */
export function initialNavigationWaypointIndex(
  route: Route,
  position: { lat: number; lon: number } | null,
): number {
  const automaticWaypoints = route.plan?.navigationWaypoints;
  if (!automaticWaypoints || automaticWaypoints.length < 2) return 1;
  if (!position) return 0;
  return distanceMetres(position, automaticWaypoints[0]!) > ROUTE_ENTRY_REACHED_M ? 0 : 1;
}

export function navigationWaypointReached(
  index: number,
  position: { lat: number; lon: number },
  target: { lat: number; lon: number },
  progress: number,
): boolean {
  if (distanceMetres(position, target) <= ROUTE_ENTRY_REACHED_M) return true;
  // Punkt 0 on tee sissepääs, mitte eelneva marsruudilõigu lõpp. Selle puhul
  // ei saa lõigu progressi kasutada (eelmine ja sihtpunkt oleksid samad).
  return index > 0 && progress >= 1;
}
