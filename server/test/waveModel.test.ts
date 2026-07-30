import { describe, expect, it } from 'vitest';
import { WAVE_VARIABLES, isWaveVariable, type Variable } from '@seapro/shared';
import { WAVE_MODELS } from '../src/providers/openMeteo.js';

/**
 * Lainemudeli testid.
 *
 * Kaitsevad kahte asja, mis mõlemad olid päris vead:
 *
 *  1. Atmosfäärimudeli ID ei tohi jõuda mere-API-ni. Mõõdetuna vastab see
 *     `models=icon_eu` peale 200-ga, aga iga väärtus on null — kiht kaob
 *     ekraanilt ILMA veateateta, mis on halvim võimalik ebaõnnestumine.
 *  2. Lainemudel ei tohi kehtida mittelaine-mereväljadele. EWAM ja GWAM on
 *     puhtad lainemudelid: meretemperatuur, veetase ja hoovused tulevad neist
 *     samuti nullina.
 */

describe('lainemuutujate loend', () => {
  it('sisaldab lainet ja ummiklainet, mitte muid mereväljasid', () => {
    for (const v of ['wave_height', 'wave_period', 'wave_dir', 'swell_height'] as Variable[]) {
      expect(isWaveVariable(v)).toBe(true);
    }
    // Need on samuti mere-API-st, aga lainemudel neid ei arvuta.
    for (const v of ['sea_temp', 'sea_level', 'current_speed', 'current_dir'] as Variable[]) {
      expect(isWaveVariable(v)).toBe(false);
    }
    // Ja atmosfäär pole kindlasti laine.
    expect(isWaveVariable('wind_speed')).toBe(false);
  });

  it('ei kattu atmosfäärimudelite ID-dega', () => {
    // Kui need komplektid kunagi kattuma hakkaks, muutuks "kumb mudel see on?"
    // mitmetimõistetavaks ja vaikne tühi kiht tuleks tagasi.
    const waveIds = new Set(WAVE_MODELS.map((m) => m.id));
    for (const id of ['metno_nordic', 'icon_eu', 'ecmwf_ifs025', 'gfs_seamless']) {
      expect(waveIds.has(id as never)).toBe(false);
    }
  });
});

describe('WAVE_MODELS', () => {
  it('alustab EWAM-iga — see on Läänemere vaikevalik', () => {
    // UI näitab aktiivsena loendi esimest, kui kasutaja pole valinud. Järjekord
    // ON seetõttu leping, mitte kosmeetika.
    expect(WAVE_MODELS[0]?.id).toBe('ewam');
  });

  it('pakub globaalset varianti, sest EWAM ei kata avaookeani', () => {
    expect(WAVE_MODELS.some((m) => m.id === 'best_match' || m.id === 'gwam')).toBe(true);
  });

  it('katab kõik lainemuutujad ühe loendina', () => {
    expect(WAVE_VARIABLES.length).toBeGreaterThan(0);
    expect(new Set(WAVE_VARIABLES).size).toBe(WAVE_VARIABLES.length);
  });
});
