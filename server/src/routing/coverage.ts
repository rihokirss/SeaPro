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

/**
 * Rea-kaupa teenindusmaski kontroll: proovilaiuskraadi kohta arvutame ringide
 * lõikepunktid üks kord ja iga proov maksab mõne võrdluse. Sama half-open
 * ray-cast nagu `pointInRing` (paaritu arv lõikeid punktist paremal = sees),
 * ring-ringilt eraldi, sest teenindusalad kattuvad osaliselt.
 */
export function serviceAreaRowSampler(lat: number): (lon: number) => boolean {
  if (!Number.isFinite(lat) || lat < ROUTING_SERVICE_BBOX[0] || lat > ROUTING_SERVICE_BBOX[2]) {
    return () => false;
  }
  const crossingsPerRing = SERVICE_AREAS.map((ring) => {
    const crossings: number[] = [];
    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
      const a = ring[index]!;
      const b = ring[previous]!;
      if ((a[1] > lat) !== (b[1] > lat)) {
        crossings.push((b[0] - a[0]) * (lat - a[1]) / (b[1] - a[1]) + a[0]);
      }
    }
    return crossings;
  }).filter((crossings) => crossings.length > 0);
  return (lon) => {
    if (lon < ROUTING_SERVICE_BBOX[1] || lon > ROUTING_SERVICE_BBOX[3]) return false;
    for (const crossings of crossingsPerRing) {
      let count = 0;
      for (const crossing of crossings) {
        if (lon < crossing) count++;
      }
      if ((count & 1) === 1) return true;
    }
    return false;
  };
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
