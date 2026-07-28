import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseInfoWindow } from '../src/providers/metocTaltech.js';
import { parseWebTxt } from '../src/providers/lainepoiss.js';
import { parseObservations } from '../src/providers/ilmateenistus.js';
import { parseForecastPage } from '../src/providers/windfinder.js';

/**
 * Parserite lepingutestid.
 *
 * Fixture'id on PÄRIS vastused, mis on salvestatud faili — nii jooksevad
 * testid ilma võrguta ja kontrollivad täpselt seda kuju, mida allikas
 * tegelikult saatis. Elutestid (`npm run test:live`) käivad allikate vastu
 * eraldi ja tabavad kuju muutumise.
 *
 * Rõhk on ÜHIKUTEL ja SENTINELITEL, sest just need on kohad, kus viga ei ole
 * ilmne: 43 cm veetase näeb 43 meetrina välja täiesti usutav, kuni keegi
 * kaardile vaatab.
 */

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (name: string): string => readFileSync(join(fixtures, name), 'utf8');

describe('METOC infowindow', () => {
  const parsed = parseInfoWindow(read('metoc-infowindow.html'));

  it('loeb tuule kiiruse ja iilid ühest reast', () => {
    expect(parsed.values.wind_speed).toBeTypeOf('number');
    expect(parsed.values.wind_gust).toBeTypeOf('number');
    // Iil ei saa olla keskmisest tuulest nõrgem.
    expect(parsed.values.wind_gust!).toBeGreaterThanOrEqual(parsed.values.wind_speed!);
  });

  it('teisendab veetaseme sentimeetritest meetriteks', () => {
    const level = parsed.values.sea_level;
    expect(level).toBeTypeOf('number');
    // Läänemere veetase püsib ±1.5 m piires. Kui teisendus puuduks, oleks
    // siin kümneid meetreid.
    expect(Math.abs(level!)).toBeLessThan(2);
  });

  it('teisendab Eesti kohaliku aja UTC-sse', () => {
    expect(parsed.observedAt).toBeTypeOf('string');
    const t = new Date(parsed.observedAt!);
    expect(Number.isNaN(t.getTime())).toBe(false);
    // Fixture on salvestatud minevikus, aga mitte ammu enne 2020.
    expect(t.getUTCFullYear()).toBeGreaterThan(2020);
  });

  it('viskab vea, kui tabelit pole', () => {
    expect(() => parseInfoWindow('<html><body>Midagi muud</body></html>')).toThrow(/struktuur/i);
  });
});

describe('LainePoiss web.txt', () => {
  const samples = parseWebTxt(read('lainepoiss-web.txt'));

  it('parsib read ja jätab positsiooni andmereast', () => {
    expect(samples.length).toBeGreaterThan(0);
    const last = samples.at(-1)!;
    // Poi asub Eesti vetes; kui veerud oleksid nihkes, satuks ta mujale.
    expect(last.lat).toBeGreaterThan(57);
    expect(last.lat).toBeLessThan(60.5);
    expect(last.lon).toBeGreaterThan(20);
    expect(last.lon).toBeLessThan(29);
  });

  it('annab usutava lainekõrguse', () => {
    for (const s of samples) {
      if (s.hs === null) continue;
      expect(s.hs).toBeGreaterThanOrEqual(0);
      // Läänemere rekord on alla 9 m; suurem number tähendaks veeruvahetust.
      expect(s.hs).toBeLessThan(10);
    }
  });

  it('talub NaN väärtusi ilma reast loobumata', () => {
    const withNaN = '2026-07-27 15:09:47 58.0879364 21.8949699 0.570 NaN 3.300 227 NaN 3.67';
    const out = parseWebTxt(withNaN);
    expect(out).toHaveLength(1);
    expect(out[0]!.hs).toBe(0.57);
    expect(out[0]!.hmax).toBeNull();
    // Kui tipusuund puudub, langeme keskmisele; siin on mõlemad olemas/puudu.
    expect(out[0]!.dir).toBe(227);
  });

  it('viskab kõrvale tulevikus olevad ajatemplid', () => {
    // Päris andmetest leitud: üks poi raporteeris kuupäeva aastal 2226.
    const corrupt = '2226-04-05 12:39:15 57.7139 23.5573 0.520 NaN 3.200 180 NaN 3.9';
    expect(() => parseWebTxt(corrupt)).toThrow();
  });

  it('jätab vale veergude arvuga read vahele, aga ei kuku kokku', () => {
    const mixed = [
      'katkine rida',
      '2026-07-27 15:09:47 58.0879364 21.8949699 0.570 0.9 3.300 227 230 3.67',
    ].join('\n');
    const out = parseWebTxt(mixed);
    expect(out).toHaveLength(1);
  });
});

describe('Ilmateenistus observations', () => {
  // Fixture on kärbitud, seega sulgeme viimase poolikud elemendid.
  const xml = `${read('ilmateenistus-partial.xml')}</observations>`;
  const parsed = parseObservations(xml);

  it('leiab jaamad koordinaatidega', () => {
    expect(parsed.stations.length).toBeGreaterThan(3);
    for (const s of parsed.stations) {
      expect(s.lat).toBeGreaterThan(57);
      expect(s.lat).toBeLessThan(60.5);
    }
  });

  it('teisendab nähtavuse kilomeetritest meetriteks', () => {
    const withVis = parsed.stations.find((s) => s.values.visibility != null);
    expect(withVis).toBeDefined();
    // Hea nähtavus on kümneid kilomeetreid ehk kümneid TUHANDEID meetreid.
    // Ilma teisenduseta oleks siin 20–40, mis tähendaks paksu udu.
    expect(withVis!.values.visibility!).toBeGreaterThan(1000);
  });

  it('viskab vea, kui ühtki jaama pole', () => {
    expect(() => parseObservations('<observations></observations>')).toThrow(/kuju muutus/i);
  });
});

describe('Windfinder prognoosileht', () => {
  const html = read('windfinder-forecast.html');
  // Fikseeritud vaatlushetk: fixture'i kuupäevad on 27.–28. juuli 2026 ja
  // aasta tuletatakse nende lähedusest. Päris kellaajaga muutuks test
  // aasta pärast katkiseks.
  const steps = parseForecastPage(html, new Date('2026-07-28T14:00:00Z'));

  it('leiab tunniveerud hašitud klassinimede tagant', () => {
    expect(steps.length).toBeGreaterThan(4);
  });

  it('annab tuule m/s-is, mitte lehe algühikus', () => {
    for (const step of steps) {
      const v = step.values.wind_speed;
      if (v == null) continue;
      expect(v).toBeGreaterThanOrEqual(0);
      // Kui sõlmed jääksid teisendamata, ületaks osa väärtusi selle piiri.
      expect(v).toBeLessThan(45);
    }
  });

  it('loeb suuna nooleikooni alt-atribuudist', () => {
    const withDir = steps.find((s) => s.values.wind_dir != null);
    expect(withDir).toBeDefined();
    expect(withDir!.values.wind_dir!).toBeGreaterThanOrEqual(0);
    expect(withDir!.values.wind_dir!).toBeLessThanOrEqual(360);
  });

  it('viskab valju vea, kui lehe struktuur muutub', () => {
    expect(() => parseForecastPage('<html><body>uus disain</body></html>')).toThrow(
      /struktuur muutus/i,
    );
  });

  /*
   * Ajatelg tuli varem vaatlushetkest, mitte lehelt: esimene veerg sai alati
   * sildi "praegu". Leht algab aga päeva esimesest veerust (00h kohalikku
   * aega), ka siis kui see on minevikus — 28.07.2026 andis see 17 tunni nihke.
   * Väärtused olid õiged, aga rippusid vale aja küljes ja graafikul teiste
   * allikate kõrval oli Windfinderi seeria nihkes.
   */
  describe('ajatelg', () => {
    it('ei sõltu vaatlushetkest', () => {
      const hommik = parseForecastPage(html, new Date('2026-07-28T02:00:00Z'));
      const õhtu = parseForecastPage(html, new Date('2026-07-28T23:00:00Z'));
      expect(hommik.map((s) => s.time)).toEqual(õhtu.map((s) => s.time));
    });

    it('ankurdub lehe kuupäevale ja spoti ajavööndile', () => {
      // Fixture on Europe/Tallinn ja algab veerust "00h" 27. juulil.
      // Suveajal on nihe +3, seega esimene samm on eelmise päeva 21:00Z.
      expect(steps[0]!.time).toBe('2026-07-26T21:00:00.000Z');
    });

    it('annab rangelt kasvava 3-tunnise sammu', () => {
      for (let i = 1; i < steps.length; i++) {
        const vahe = Date.parse(steps[i]!.time) - Date.parse(steps[i - 1]!.time);
        expect(vahe).toBe(3 * 3600_000);
      }
    });
  });
});
