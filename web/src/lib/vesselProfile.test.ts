import { describe, expect, it } from 'vitest';
import type { Route } from '@seapro/shared';
import {
  DEFAULT_VESSEL_PROFILE,
  applyVesselProfile,
  loadVesselProfile,
  normalizeVesselProfile,
  saveVesselProfile,
} from './vesselProfile';

function route(): Route {
  return {
    id: 'r', name: 'Route', waypoints: [], startTime: '2026-08-08T12:00:00Z',
    speedKnots: 4, fuelLitresPerHour: 3, draughtM: 1, underKeelClearanceM: 0.3,
    beamM: 2, airDraughtM: 3,
    createdAt: '2026-08-08T12:00:00Z', updatedAt: '2026-08-08T12:00:00Z',
  };
}

describe('vessel profile', () => {
  it('keeps valid dimensions and a valid home harbour', () => {
    expect(normalizeVesselProfile({
      name: '  Merehunt  ', speedKnots: 8, fuelLitresPerHour: 12,
      draughtM: 1.5, underKeelClearanceM: 0.7, beamM: 3.4, airDraughtM: 4.2,
      homeHarbour: { id: 'N1', name: ' Pirita sadam ', lat: 59.47, lon: 24.82 },
    })).toEqual({
      name: 'Merehunt', speedKnots: 8, fuelLitresPerHour: 12,
      draughtM: 1.5, underKeelClearanceM: 0.7, beamM: 3.4, airDraughtM: 4.2,
      homeHarbour: { id: 'N1', name: 'Pirita sadam', lat: 59.47, lon: 24.82 },
    });
  });

  it('replaces corrupt required values and drops invalid optional values', () => {
    expect(normalizeVesselProfile({ speedKnots: -1, beamM: 0, homeHarbour: { name: 'X', lat: 200, lon: 24 } }))
      .toEqual(DEFAULT_VESSEL_PROFILE);
  });

  it('persists and loads the normalized profile', () => {
    let stored: string | null = null;
    const storage = {
      getItem: () => stored,
      setItem: (_key: string, value: string) => { stored = value; },
    };
    saveVesselProfile({ ...DEFAULT_VESSEL_PROFILE, name: '  Boat ', beamM: 3 }, storage);
    expect(loadVesselProfile(storage)).toMatchObject({ name: 'Boat', beamM: 3 });
  });

  it('applies the profile and removes dimensions that are no longer configured', () => {
    expect(applyVesselProfile(route(), { ...DEFAULT_VESSEL_PROFILE, speedKnots: 9 }))
      .toMatchObject({ speedKnots: 9, fuelLitresPerHour: 5, draughtM: 1.2, underKeelClearanceM: 0.5 });
    expect(applyVesselProfile(route(), DEFAULT_VESSEL_PROFILE)).not.toHaveProperty('beamM');
    expect(applyVesselProfile(route(), DEFAULT_VESSEL_PROFILE)).not.toHaveProperty('airDraughtM');
  });
});
