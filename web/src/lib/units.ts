import { convertSpeed, degreesToCompass, type SpeedUnit, type Variable } from '@seapro/shared';

export type { SpeedUnit };

export const SPEED_UNITS: SpeedUnit[] = ['ms', 'kn', 'bft', 'kmh'];

const STORAGE_KEY = 'seapro.speedUnit';

/** Vaikimisi m/s — nii on Eesti mereilmateated ja METOC-i portaal. */
export function loadSpeedUnit(): SpeedUnit {
  const saved = localStorage.getItem(STORAGE_KEY);
  return SPEED_UNITS.includes(saved as SpeedUnit) ? (saved as SpeedUnit) : 'ms';
}

export function saveSpeedUnit(unit: SpeedUnit): void {
  localStorage.setItem(STORAGE_KEY, unit);
}

const SPEED_VARIABLES: ReadonlySet<Variable> = new Set<Variable>([
  'wind_speed',
  'wind_gust',
  'current_speed',
]);

/**
 * Vormindab väärtuse kuvamiseks. Server annab alati SI-ühikus, siin
 * teisendame kasutaja eelistuse järgi.
 */
export function formatValue(
  variable: Variable,
  value: number | null | undefined,
  unit: SpeedUnit,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '–';

  if (SPEED_VARIABLES.has(variable)) {
    const converted = convertSpeed(value, unit);
    // Beaufort on täisarv; hoovus on aeglane ja vajab komakohta.
    if (unit === 'bft') return String(Math.round(converted));
    const decimals = variable === 'current_speed' ? 2 : converted >= 10 ? 0 : 1;
    return converted.toFixed(decimals);
  }

  switch (variable) {
    case 'wind_dir':
    case 'wave_dir':
    case 'swell_dir':
    case 'current_dir':
      return `${Math.round(value)}° ${degreesToCompass(value)}`;
    case 'wave_height':
    case 'wave_max_height':
    case 'swell_height':
    case 'sea_level':
      return value.toFixed(2);
    case 'wave_period':
    case 'swell_period':
      return value.toFixed(1);
    case 'air_temp':
    case 'sea_temp':
      return value.toFixed(1);
    case 'pressure':
      return value.toFixed(0);
    case 'humidity':
    case 'cloud_cover':
      return String(Math.round(value));
    case 'visibility':
      // Nähtavus tuleb meetrites, aga merel mõeldakse kilomeetrites.
      return value >= 1000 ? `${(value / 1000).toFixed(1)}` : String(Math.round(value));
    case 'precipitation':
      return value.toFixed(1);
    default:
      return value.toFixed(1);
  }
}

/** Ühiku silt kuvamiseks väärtuse järel. */
export function unitLabel(variable: Variable, unit: SpeedUnit): string {
  if (SPEED_VARIABLES.has(variable)) {
    switch (unit) {
      case 'ms': return 'm/s';
      case 'kn': return 'kn';
      case 'bft': return 'Bft';
      case 'kmh': return 'km/h';
    }
  }
  switch (variable) {
    case 'wind_dir':
    case 'wave_dir':
    case 'swell_dir':
    case 'current_dir':
      return '';
    case 'wave_height':
    case 'wave_max_height':
    case 'swell_height':
    case 'sea_level':
      return 'm';
    case 'wave_period':
    case 'swell_period':
      return 's';
    case 'air_temp':
    case 'sea_temp':
      return '°C';
    case 'pressure':
      return 'hPa';
    case 'humidity':
    case 'cloud_cover':
      return '%';
    case 'visibility':
      return 'km';
    case 'precipitation':
      return 'mm';
    default:
      return '';
  }
}

/**
 * Tuule värvid Beauforti astme järgi. Sama palett kasutusel nii
 * kaardikihil kui graafikul, et number ja värv tähendaksid alati sama.
 */
/**
 * Tuule värvid Beauforti astme järgi.
 *
 * Skaala algab küllastunud sinisest, mitte peaaegu valgest: nool joonistatakse
 * heleda merepinna peale ja liiga hele täide muudaks nõrga tuule noole
 * nähtamatuks — alles jääks ainult tume ääris. Küllastus kasvab koos tuulega,
 * nii et tormi näeb perifeerse nägemisega.
 */
const WIND_COLORS = [
  '#7fb8d8', // 0  vaikne
  '#5fa8d4', // 1
  '#4aa8c4', // 2
  '#3fb59c', // 3
  '#5cbf6a', // 4  mõõdukas
  '#a8c944', // 5
  '#e8b93c', // 6  tugev
  '#ef8f34', // 7
  '#e6612f', // 8  tormihoiatus
  '#d43535', // 9
  '#b8285f', // 10
  '#93267e', // 11
  '#66268f', // 12 orkaan
];

export function windColor(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '#9aa5ad';
  const bft = convertSpeed(ms, 'bft');
  return WIND_COLORS[Math.min(WIND_COLORS.length - 1, Math.max(0, Math.round(bft)))]!;
}

/** Lainekõrguse värvid — meetripõhised, sõltumatud tuuleskaalast. */
export function waveColor(m: number | null | undefined): string {
  if (m === null || m === undefined || !Number.isFinite(m)) return '#9aa5ad';
  if (m < 0.25) return '#d7f0f7';
  if (m < 0.5) return '#a8dcea';
  if (m < 1.0) return '#6ec8b0';
  if (m < 1.5) return '#a8cf6e';
  if (m < 2.0) return '#e2c94e';
  if (m < 3.0) return '#e8893d';
  if (m < 4.0) return '#d44a3a';
  return '#8a2b7a';
}

export { WIND_COLORS };
