import type { Variable } from '@seapro/shared';

/**
 * Värviskaalad valevärvi-kihi jaoks.
 *
 * Iga skaala on peatuste loend [väärtus, R, G, B, A]. Väärtused on ALATI
 * serveri SI-ühikus (m/s, m, °C, %, mm/h), mitte kasutaja kuvaühikus —
 * nii ei muutu kaardi värvid, kui kasutaja lülitab m/s -> sõlmed.
 */

export interface ColorStop {
  value: number;
  rgba: [number, number, number, number];
}

export interface ColorScale {
  variable: Variable;
  /** i18n võti legendi pealkirjaks. */
  labelKey: string;
  /** Ühik legendil (SI). */
  unit: string;
  stops: ColorStop[];
  /** Alla selle väärtuse ei joonista üldse (nt pilvitu taevas jääb läbipaistvaks). */
  transparentBelow?: number;
}

const s = (value: number, r: number, g: number, b: number, a = 255): ColorStop => ({
  value,
  rgba: [r, g, b, a],
});

export const COLOR_SCALES: Record<string, ColorScale> = {
  wind_speed: {
    variable: 'wind_speed',
    labelKey: 'var.wind_speed',
    unit: 'm/s',
    /**
     * Windfinderi palett.
     *
     * Varem oli siin Beauforti-põhine hele-sinisest lillani skaala. See oli
     * loogiline, aga kaardil kahvatu: Läänemere tavaline 2–7 m/s mahtus
     * mõne lähestikuse sinaka-rohelise tooni sisse ja tuulevälja muster ei
     * olnud pilguga loetav.
     *
     * Windfinderi skaala läheb LILLAST (0) läbi sinise, tsüaani, rohelise,
     * kollase ja oranži TUMEPUNASENI ning lõpeb magentaga. Kogu spekter
     * kulub ära juba nõrga tuule juures, seega väikesed erinevused paistavad
     * kohe välja. Väärtused on nende legendi sõlmeastmed teisendatuna m/s-i
     * (1 kt = 0.514444 m/s), värvid nende enda gradiendist loetud.
     *
     * Alfa hoiab peaaegu ühtlaselt kõrget taset — need toonid on juba
     * küllastunud ja varasem "nõrk tuul = kahvatu" reegel töötas skaala vastu.
     */
    stops: [
      s(0.0, 150, 0, 254, 190), //  0 kt
      s(1.54, 100, 0, 254, 195), //  3 kt
      s(3.6, 0, 50, 254, 200), //  7 kt
      s(5.66, 0, 150, 254, 205), // 11 kt
      s(7.72, 0, 230, 240, 210), // 15 kt
      s(9.77, 17, 212, 17, 215), // 19 kt
      s(11.83, 0, 250, 0, 220), // 23 kt
      s(13.89, 254, 254, 0, 225), // 27 kt
      s(15.95, 254, 200, 0, 228), // 31 kt
      s(18.01, 254, 150, 0, 231), // 35 kt
      s(20.06, 230, 100, 0, 234), // 39 kt
      s(22.12, 200, 50, 29, 237), // 43 kt
      s(24.18, 170, 0, 29, 240), // 47 kt — tumepunane
      s(26.24, 200, 0, 100, 243), // 51 kt
      s(27.27, 254, 0, 150, 246), // 53 kt
    ],
  },

  wave_height: {
    variable: 'wave_height',
    labelKey: 'var.wave_height',
    unit: 'm',
    stops: [
      s(0, 215, 240, 247, 190),
      s(0.25, 168, 220, 234, 200),
      s(0.5, 110, 200, 176, 205),
      s(1.0, 168, 207, 110, 215),
      s(1.5, 226, 201, 78, 220),
      s(2.0, 232, 137, 61, 230),
      s(3.0, 212, 74, 58, 240),
      s(4.0, 138, 43, 122, 245),
      s(6.0, 80, 25, 90, 250),
    ],
  },

  cloud_cover: {
    variable: 'cloud_cover',
    labelKey: 'var.cloud_cover',
    unit: '%',
    // Selge taevas jääb läbipaistvaks — muidu kataks kiht terve kaardi valgega.
    transparentBelow: 10,
    stops: [
      s(10, 255, 255, 255, 0),
      s(30, 245, 248, 250, 70),
      s(55, 226, 232, 238, 130),
      s(75, 198, 208, 218, 175),
      s(90, 165, 178, 190, 205),
      s(100, 132, 146, 160, 225),
    ],
  },

  precipitation: {
    variable: 'precipitation',
    labelKey: 'var.precipitation',
    unit: 'mm/h',
    transparentBelow: 0.05,
    stops: [
      s(0.05, 160, 220, 255, 90),
      s(0.5, 90, 175, 245, 160),
      s(1.5, 50, 130, 230, 200),
      s(4.0, 60, 200, 120, 215),
      s(8.0, 230, 200, 60, 230),
      s(16.0, 235, 120, 50, 240),
      s(32.0, 210, 50, 60, 250),
    ],
  },

  air_temp: {
    variable: 'air_temp',
    labelKey: 'var.air_temp',
    unit: '°C',
    stops: [
      s(-25, 60, 30, 110, 210),
      s(-15, 60, 80, 180, 210),
      s(-5, 90, 160, 220, 205),
      s(0, 170, 215, 235, 200),
      s(5, 150, 210, 175, 200),
      s(12, 170, 215, 110, 205),
      s(18, 235, 220, 95, 210),
      s(25, 235, 150, 60, 220),
      s(32, 215, 70, 60, 230),
    ],
  },

  sea_temp: {
    variable: 'sea_temp',
    labelKey: 'var.sea_temp',
    unit: '°C',
    stops: [
      s(-1, 40, 40, 120, 215),
      s(2, 60, 110, 190, 210),
      s(6, 90, 175, 215, 205),
      s(10, 110, 205, 180, 205),
      s(14, 165, 215, 120, 210),
      s(18, 235, 215, 95, 215),
      s(22, 235, 145, 65, 225),
      s(26, 210, 65, 60, 235),
    ],
  },

  pressure: {
    variable: 'pressure',
    labelKey: 'var.pressure',
    unit: 'hPa',
    stops: [
      s(960, 110, 50, 150, 200),
      s(980, 90, 110, 210, 195),
      s(1000, 150, 205, 225, 190),
      s(1013, 235, 240, 240, 180),
      s(1025, 235, 205, 110, 190),
      s(1040, 225, 120, 60, 200),
    ],
  },

  sea_level: {
    variable: 'sea_level',
    labelKey: 'var.sea_level',
    unit: 'm',
    stops: [
      s(-1.2, 90, 40, 130, 215),
      s(-0.6, 80, 120, 200, 205),
      s(-0.2, 165, 210, 230, 195),
      s(0, 240, 240, 235, 175),
      s(0.2, 200, 220, 150, 195),
      s(0.6, 235, 175, 80, 210),
      s(1.2, 205, 60, 60, 225),
    ],
  },

  current_speed: {
    variable: 'current_speed',
    labelKey: 'var.current_speed',
    unit: 'm/s',
    transparentBelow: 0.02,
    stops: [
      s(0.02, 200, 235, 240, 120),
      s(0.1, 140, 210, 220, 170),
      s(0.25, 110, 200, 160, 200),
      s(0.5, 200, 205, 95, 215),
      s(0.8, 230, 140, 65, 230),
      s(1.2, 205, 60, 70, 240),
    ],
  },

  visibility: {
    variable: 'visibility',
    labelKey: 'var.visibility',
    unit: 'm',
    // Hea nähtavus on läbipaistev; kiht hoiatab AINULT udu eest.
    stops: [
      s(0, 130, 30, 40, 245),
      s(500, 200, 70, 60, 235),
      s(1000, 235, 150, 70, 220),
      s(2000, 235, 215, 110, 195),
      s(5000, 200, 225, 205, 140),
      s(10000, 220, 235, 240, 60),
      s(20000, 255, 255, 255, 0),
    ],
  },
};

/** Muutujad, mille jaoks valevärvi-kiht on saadaval. */
export const SCALAR_FIELDS = Object.keys(COLOR_SCALES) as Variable[];

/** Lineaarne interpolatsioon skaalal. Väljaspool piire klammerdub otstesse. */
export function sampleScale(scale: ColorScale, value: number): [number, number, number, number] {
  const stops = scale.stops;
  if (scale.transparentBelow !== undefined && value < scale.transparentBelow) {
    return [0, 0, 0, 0];
  }

  const first = stops[0]!;
  const last = stops[stops.length - 1]!;
  if (value <= first.value) return first.rgba;
  if (value >= last.value) return last.rgba;

  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i]!;
    const b = stops[i + 1]!;
    if (value >= a.value && value <= b.value) {
      const t = (value - a.value) / (b.value - a.value);
      return [
        Math.round(a.rgba[0] + (b.rgba[0] - a.rgba[0]) * t),
        Math.round(a.rgba[1] + (b.rgba[1] - a.rgba[1]) * t),
        Math.round(a.rgba[2] + (b.rgba[2] - a.rgba[2]) * t),
        Math.round(a.rgba[3] + (b.rgba[3] - a.rgba[3]) * t),
      ];
    }
  }
  return last.rgba;
}

export function rgbaCss([r, g, b, a]: [number, number, number, number]): string {
  return `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`;
}
