import type { GridFrame, Variable } from '@seapro/shared';

/**
 * Võrgustiku interpoleerimine kliendi poolel.
 *
 * Miks: Open-Meteo tasuta kasutus loeb iga võrgupunkti eraldi API-kutseks,
 * seega serverilt tuleb hõre võrk (8x8). Kaardil tahame aga tihedat noolevälja.
 * Kuna mudeli väli ongi pidev, on hõreda võrgu vahelt interpoleerimine
 * matemaatiliselt sama info — me ei leiuta andmeid juurde, vaid joonistame
 * sama välja tihedamalt.
 *
 * NB suundade kohta: suundi EI TOHI lineaarselt keskmistada. 350° ja 10°
 * keskmine on 180° (täpselt vastupidine suund), mitte 0°. Seetõttu
 * teisendame suuna+kiiruse u/v-komponentideks, interpoleerime need, ja
 * arvutame suuna tagasi.
 */

export interface Field {
  lats: number[];
  lons: number[];
  /** [rida][veerg], rida 0 = lõunapoolseim. */
  u: (number | null)[][];
  v: (number | null)[][];
  speed: (number | null)[][];
}

/** Ehitab tuulevälja u/v-komponentidena. Null, kui võrk pole regulaarne. */
export function buildWindField(frame: GridFrame | null): Field | null {
  if (!frame || frame.points.length < 4) return null;

  const lats = [...new Set(frame.points.map((p) => p.lat))].sort((a, b) => a - b);
  const lons = [...new Set(frame.points.map((p) => p.lon))].sort((a, b) => a - b);
  if (lats.length < 2 || lons.length < 2) return null;

  const latIdx = new Map(lats.map((v, i) => [v, i]));
  const lonIdx = new Map(lons.map((v, i) => [v, i]));

  const blank = (): (number | null)[][] =>
    Array.from({ length: lats.length }, () => Array.from({ length: lons.length }, () => null));

  const u = blank();
  const v = blank();
  const speed = blank();

  for (const p of frame.points) {
    const r = latIdx.get(p.lat);
    const c = lonIdx.get(p.lon);
    if (r === undefined || c === undefined) continue;

    const s = p.values.wind_speed;
    const d = p.values.wind_dir;
    if (s == null || d == null) continue;

    // Meteoroloogiline suund = KUST puhub. Teisendame vektoriks, mis osutab
    // sinna, kuhu õhk liigub.
    const rad = ((d + 180) % 360) * (Math.PI / 180);
    u[r]![c] = s * Math.sin(rad);
    v[r]![c] = s * Math.cos(rad);
    speed[r]![c] = s;
  }

  return { lats, lons, u, v, speed };
}

export interface WindSample {
  speed: number;
  /** Kraadi, KUHU tuul liigub — otse noole pööramiseks. */
  bearing: number;
}

/** Bilineaarne interpolatsioon antud punktis. Null, kui punkt jääb võrgust välja. */
export function sampleWind(field: Field, lat: number, lon: number): WindSample | null {
  const { lats, lons } = field;

  const r = bracket(lats, lat);
  const c = bracket(lons, lon);
  if (!r || !c) return null;

  const u = bilinear(field.u, r, c);
  const v = bilinear(field.v, r, c);
  if (u === null || v === null) return null;

  // Kiirust interpoleerime eraldi, mitte |u,v| kaudu: kui naaberpunktide
  // suunad on erinevad, annaks vektorsumma pikkus tegelikust nõrgema tuule.
  const speed = bilinear(field.speed, r, c);
  if (speed === null) return null;

  const bearing = (Math.atan2(u, v) * (180 / Math.PI) + 360) % 360;
  return { speed, bearing };
}

interface Bracket {
  i0: number;
  i1: number;
  t: number;
}

/** Leiab kaks ümbritsevat indeksit ja kaalu nende vahel. */
function bracket(axis: number[], value: number): Bracket | null {
  const first = axis[0]!;
  const last = axis[axis.length - 1]!;
  if (value < first || value > last) return null;

  for (let i = 0; i < axis.length - 1; i++) {
    const a = axis[i]!;
    const b = axis[i + 1]!;
    if (value >= a && value <= b) {
      const span = b - a;
      return { i0: i, i1: i + 1, t: span === 0 ? 0 : (value - a) / span };
    }
  }
  return { i0: axis.length - 1, i1: axis.length - 1, t: 0 };
}

function bilinear(cells: (number | null)[][], r: Bracket, c: Bracket): number | null {
  const v00 = cells[r.i0]?.[c.i0];
  const v01 = cells[r.i0]?.[c.i1];
  const v10 = cells[r.i1]?.[c.i0];
  const v11 = cells[r.i1]?.[c.i1];

  // Kui mõni nurk puudub (maismaa merevälja puhul), langeme lähima olemasoleva
  // väärtuse peale, et kiht ei tekitaks auke keset merd.
  const corners = [v00, v01, v10, v11].filter((x): x is number => x != null);
  if (corners.length === 0) return null;
  if (corners.length < 4) {
    return corners.reduce((a, b) => a + b, 0) / corners.length;
  }

  const top = v00! + (v01! - v00!) * c.t;
  const bottom = v10! + (v11! - v10!) * c.t;
  return top + (bottom - top) * r.t;
}

/**
 * Skalaarvälja (nt lainekõrgus, pilvisus) maatriks — sama loogika,
 * aga ilma suunata.
 */
export function buildScalarMatrix(
  frame: GridFrame | null,
  variable: Variable,
): { lats: number[]; lons: number[]; cells: (number | null)[][] } | null {
  if (!frame || frame.points.length === 0) return null;

  const lats = [...new Set(frame.points.map((p) => p.lat))].sort((a, b) => a - b);
  const lons = [...new Set(frame.points.map((p) => p.lon))].sort((a, b) => a - b);
  if (lats.length < 2 || lons.length < 2) return null;

  const latIdx = new Map(lats.map((v, i) => [v, i]));
  const lonIdx = new Map(lons.map((v, i) => [v, i]));

  const cells: (number | null)[][] = Array.from({ length: lats.length }, () =>
    Array.from({ length: lons.length }, () => null),
  );

  for (const p of frame.points) {
    const r = latIdx.get(p.lat);
    const c = lonIdx.get(p.lon);
    if (r === undefined || c === undefined) continue;
    cells[r]![c] = p.values[variable] ?? null;
  }

  return { lats, lons, cells };
}
