import type { BBox } from '@seapro/shared';
import type { Position } from './sourceTypes.js';

/**
 * Automaatmarsruudi v1 teenindusmask.
 *
 * See ei ole merepiiri ega jurisdiktsiooni kaart. Mask on tahtlikult
 * konservatiivne kaitse, mis hoiab otsingu Eesti ja Soome ametlike allikate
 * läheduses. Sellest väljapoole jääv ala on "teadmata", isegi kui EMODnet ja
 * OpenStreetMap suudavad seal aluskaardi kokku panna.
 */
const SERVICE_AREAS: readonly Position[][] = [
  // Eesti rannikumeri ja saarte ümbrus, sh Tallinna–Helsingi ühendusala.
  [
    [21.35, 57.45],
    [24.15, 57.45],
    [28.25, 57.75],
    [28.35, 59.65],
    [26.10, 59.90],
    [23.50, 59.85],
    [21.55, 59.35],
    [21.35, 57.45],
  ],
  // Soome laht ja Edela-Soome saarestik.
  [
    [18.75, 59.45],
    [28.45, 59.45],
    [28.45, 60.70],
    [25.80, 60.85],
    [23.25, 61.35],
    [20.35, 61.55],
    [18.75, 60.65],
    [18.75, 59.45],
  ],
  // Soome lääneranniku meretee Ahvenamaalt Botnia lahe põhjaossa.
  [
    [19.30, 60.25],
    [21.65, 60.05],
    [23.45, 61.35],
    [25.75, 64.80],
    [25.80, 66.10],
    [23.15, 66.20],
    [21.80, 64.20],
    [20.00, 62.10],
    [19.30, 60.25],
  ],
];

export const ROUTING_SERVICE_BBOX: BBox = [57.45, 18.75, 66.20, 28.45];

export function isWithinRoutingServiceArea(point: { lon: number; lat: number }): boolean {
  return isWithinRoutingServicePosition(point.lon, point.lat);
}

export function isWithinRoutingServicePosition(lon: number, lat: number): boolean {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;
  if (lat < ROUTING_SERVICE_BBOX[0] || lon < ROUTING_SERVICE_BBOX[1]
    || lat > ROUTING_SERVICE_BBOX[2] || lon > ROUTING_SERVICE_BBOX[3]) return false;
  return SERVICE_AREAS.some((ring) => pointInRing(lon, lat, ring));
}

function pointInRing(lon: number, lat: number, ring: readonly Position[]): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const a = ring[index]!;
    const b = ring[previous]!;
    if ((a[1] > lat) !== (b[1] > lat)
      && lon < (b[0] - a[0]) * (lat - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
