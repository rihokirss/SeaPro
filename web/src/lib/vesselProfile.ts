import type { Route } from '@seapro/shared';

const STORAGE_KEY = 'seapro.vesselProfile.v1';

export interface HomeHarbour {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

/** Marsruutideülene aluse eelseadistus. */
export interface VesselProfile {
  name: string;
  speedKnots: number;
  fuelLitresPerHour: number;
  draughtM: number;
  underKeelClearanceM: number;
  beamM?: number;
  airDraughtM?: number;
  homeHarbour?: HomeHarbour;
}

export const DEFAULT_VESSEL_PROFILE: VesselProfile = {
  name: '',
  speedKnots: 6,
  fuelLitresPerHour: 5,
  draughtM: 1.2,
  underKeelClearanceM: 0.5,
};

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function finiteInRange(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(number) && number >= min && number <= max ? number : fallback;
}

function optionalFiniteInRange(value: unknown, min: number, max: number): number | undefined {
  const number = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(number) && number >= min && number <= max ? number : undefined;
}

function normalizeHomeHarbour(value: unknown): HomeHarbour | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Partial<HomeHarbour>;
  const name = typeof item.name === 'string' ? item.name.trim().slice(0, 160) : '';
  const id = typeof item.id === 'string' ? item.id.trim().slice(0, 160) : '';
  if (!name || !Number.isFinite(item.lat) || !Number.isFinite(item.lon)
    || item.lat! < -90 || item.lat! > 90 || item.lon! < -180 || item.lon! > 180) return undefined;
  return { id: id || `${item.lat},${item.lon}`, name, lat: item.lat!, lon: item.lon! };
}

/** Puhastab nii vormist kui ka vanast localStorage'ist tulevad väärtused. */
export function normalizeVesselProfile(value: unknown): VesselProfile {
  const item = value && typeof value === 'object' ? value as Partial<VesselProfile> : {};
  const profile: VesselProfile = {
    name: typeof item.name === 'string' ? item.name.trim().slice(0, 100) : '',
    speedKnots: finiteInRange(item.speedKnots, DEFAULT_VESSEL_PROFILE.speedKnots, 0.1, 100),
    fuelLitresPerHour: finiteInRange(item.fuelLitresPerHour, DEFAULT_VESSEL_PROFILE.fuelLitresPerHour, 0, 10_000),
    draughtM: finiteInRange(item.draughtM, DEFAULT_VESSEL_PROFILE.draughtM, 0, 50),
    underKeelClearanceM: finiteInRange(item.underKeelClearanceM, DEFAULT_VESSEL_PROFILE.underKeelClearanceM, 0, 20),
  };
  const beamM = optionalFiniteInRange(item.beamM, 0.1, 100);
  const airDraughtM = optionalFiniteInRange(item.airDraughtM, 0.1, 100);
  const homeHarbour = normalizeHomeHarbour(item.homeHarbour);
  if (beamM !== undefined) profile.beamM = beamM;
  if (airDraughtM !== undefined) profile.airDraughtM = airDraughtM;
  if (homeHarbour) profile.homeHarbour = homeHarbour;
  return profile;
}

function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadVesselProfile(storage: StorageLike | null = browserStorage()): VesselProfile {
  if (!storage) return { ...DEFAULT_VESSEL_PROFILE };
  try {
    const raw = storage.getItem(STORAGE_KEY);
    return raw ? normalizeVesselProfile(JSON.parse(raw)) : { ...DEFAULT_VESSEL_PROFILE };
  } catch {
    return { ...DEFAULT_VESSEL_PROFILE };
  }
}

export function saveVesselProfile(profile: VesselProfile, storage: StorageLike | null = browserStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(normalizeVesselProfile(profile)));
  } catch {
    // Privaatrežiim või täis salvestusruum ei tohi marsruutimist peatada.
  }
}

/** Kopeerib aktiivse aluse mõõdud marsruudile/API snapshot'i jaoks. */
export function applyVesselProfile(route: Route, profile: VesselProfile): Route {
  const normalized = normalizeVesselProfile(profile);
  const next: Route = {
    ...route,
    speedKnots: normalized.speedKnots,
    fuelLitresPerHour: normalized.fuelLitresPerHour,
    draughtM: normalized.draughtM,
    underKeelClearanceM: normalized.underKeelClearanceM,
  };
  if (normalized.beamM === undefined) delete next.beamM;
  else next.beamM = normalized.beamM;
  if (normalized.airDraughtM === undefined) delete next.airDraughtM;
  else next.airDraughtM = normalized.airDraughtM;
  return next;
}
