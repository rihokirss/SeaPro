import { describe, expect, it } from 'vitest';
import { snapPoint } from '../src/routes/api.js';

/**
 * Punktipäringu kleepimise testid.
 *
 * Kaitsevad sama asja mis `grid.test.ts` võrgustiku poolel: lähestikused
 * klikid peavad jagama vahemäluvõtit. Ilma kleepimiseta läks iga klikk oma
 * koordinaadiga otse päringusse ja sõi päringueelarvet, kuigi Open-Meteo
 * ümardas need niikuinii samasse mudeli lahtrisse.
 */

describe('snapPoint', () => {
  it('viib lähestikused klikid samale koordinaadile', () => {
    // Kaks klikki Tallinna lahel, ~300 m vahet.
    const a = snapPoint(59.4412, 24.7532);
    const b = snapPoint(59.4438, 24.7561);
    expect(a).toEqual(b);
  });

  it('ei nihuta punkti üle poole sammu', () => {
    for (const [lat, lon] of [
      [59.4412, 24.7532],
      [58.3776, 22.1234],
      [59.9999, 25.0499],
      [-33.8688, 151.2093],
    ] as const) {
      const s = snapPoint(lat, lon);
      expect(Math.abs(s.lat - lat)).toBeLessThanOrEqual(0.025 + 1e-9);
      expect(Math.abs(s.lon - lon)).toBeLessThanOrEqual(0.05 + 1e-9);
    }
  });

  it('hoiab eraldi mudelilahtrid lahus', () => {
    // ~11 km vahet — üle ICON-EU lahtri, ei tohi kokku kleepuda.
    expect(snapPoint(59.40, 24.75)).not.toEqual(snapPoint(59.50, 24.95));
  });

  it('on absoluutsel võrel, mitte vaatepõhine', () => {
    // Kleepimine peab sõltuma ainult koordinaadist, mitte kutsete järjekorrast.
    expect(snapPoint(59.4412, 24.7532)).toEqual(snapPoint(59.4412, 24.7532));
    expect(snapPoint(59.45, 24.8)).toEqual({ lat: 59.45, lon: 24.8 });
  });
});
