import type { RouteWaypoint } from '@seapro/shared';

const LEGACY_DEFAULT_NAMES = new Set(['Uus marsruut', 'New route']);

function waypointLabel(point: RouteWaypoint): string {
  const name = point.name?.trim();
  return name || `${point.lat.toFixed(3)}, ${point.lon.toFixed(3)}`;
}

/**
 * Annab marsruudile nime, mis jääb ka salvestatud marsruutide loendis
 * arusaadavaks. Otsingust/sadamast tulnud nimed on eelistatud, kaardilt või
 * GPS-ist valitud punktide puhul kasutame lühikesi koordinaate.
 */
export function suggestedRouteName(waypoints: RouteWaypoint[]): string {
  const start = waypoints[0];
  if (!start) return '';
  const end = waypoints.length >= 2 ? waypoints.at(-1) : undefined;
  return end ? `${waypointLabel(start)} – ${waypointLabel(end)}` : waypointLabel(start);
}

/** Kas nime võib otspunktide muutumisel turvaliselt uue soovitusega asendada. */
export function isAutomaticRouteName(name: string, waypoints: RouteWaypoint[]): boolean {
  const trimmed = name.trim();
  return trimmed === '' || LEGACY_DEFAULT_NAMES.has(trimmed) || trimmed === suggestedRouteName(waypoints);
}
