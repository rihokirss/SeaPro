import { describe, expect, it } from 'vitest';
import { TILE_N, coveringTiles } from '../src/providers/openMeteo.js';

/**
 * Võrepaanide testid.
 *
 * Need kaitsevad täpselt seda omadust, mille pärast võre üldse tehti: kaardi
 * nihutamine peab suurema osa punktidest vahemälust saama. Vana, vaatest
 * arvutatud võrgustik ei jaganud kahe kattuva vaate vahel ÜHTEGI koordinaati,
 * sest lahtrikeskmed liikusid koos vaatega. Kui see test katkeb, on
 * päringueelarve taas lekkima hakanud.
 */

const key = (t: { ti: number; tj: number }): string => `${t.ti}/${t.tj}`;

describe('coveringTiles', () => {
  it('annab kattuvatele vaadetele ühised paanid', () => {
    const spacing = 0.25;
    const a = coveringTiles([59.6, 24.4, 60.0, 25.4], spacing).map(key);
    // Sama ala, nihutatud ~5 km põhja ja itta.
    const b = coveringTiles([59.65, 24.5, 60.05, 25.5], spacing).map(key);

    const shared = a.filter((k) => b.includes(k));
    expect(shared.length).toBeGreaterThan(0);
    // Väike nihe ei tohi tervet välja uueks teha.
    expect(shared.length / b.length).toBeGreaterThanOrEqual(0.5);
  });

  it('annab identsele vaatele identsed paanid', () => {
    const bbox: [number, number, number, number] = [59.6, 24.4, 60.0, 25.4];
    expect(coveringTiles(bbox, 0.25).map(key)).toEqual(coveringTiles(bbox, 0.25).map(key));
  });

  it('ei sõltu sellest, kust vaade algab — indeksid on absoluutsed', () => {
    // Vaade, mis mahub tervenisti ühe paani sisse, peab andma sama paani
    // sõltumata sellest, kas ta on paani vasakus või paremas servas.
    const spacing = 0.25;
    const tileLat = TILE_N * spacing;
    const base = Math.floor(59.6 / tileLat) * tileLat;
    const vasak = coveringTiles([base + 0.01, 24.4, base + 0.02, 24.41], spacing).map(key);
    const parem = coveringTiles([base + 0.6, 24.4, base + 0.61, 24.41], spacing).map(key);
    expect(vasak).toEqual(parem);
  });

  it('katab kogu vaate', () => {
    const spacing = 0.25;
    const bbox: [number, number, number, number] = [59.6, 24.4, 60.0, 25.4];
    const tiles = coveringTiles(bbox, spacing);
    const tileLat = TILE_N * spacing;
    const tileLon = TILE_N * spacing * 2;

    const minLat = Math.min(...tiles.map((t) => t.ti * tileLat));
    const maxLat = Math.max(...tiles.map((t) => t.ti * tileLat + tileLat));
    const minLon = Math.min(...tiles.map((t) => t.tj * tileLon));
    const maxLon = Math.max(...tiles.map((t) => t.tj * tileLon + tileLon));

    expect(minLat).toBeLessThanOrEqual(bbox[0]);
    expect(maxLat).toBeGreaterThanOrEqual(bbox[2]);
    expect(minLon).toBeLessThanOrEqual(bbox[1]);
    expect(maxLon).toBeGreaterThanOrEqual(bbox[3]);
  });

  it('töötab ka negatiivsetel koordinaatidel', () => {
    // Math.floor käitub negatiivsete arvudega õigesti (ümardab allapoole),
    // aga see on kerge koht vea tegemiseks — lukusta ära.
    const tiles = coveringTiles([-0.1, -0.1, 0.1, 0.1], 0.25);
    expect(tiles.map(key)).toContain('-1/-1');
    expect(tiles.map(key)).toContain('0/0');
  });
});
