import type { Variable } from '@seapro/shared';
import { convertSpeed } from '@seapro/shared';
import { useI18n } from '../i18n';
import { COLOR_SCALES, rgbaCss, sampleScale } from '../map/colorScales';
import { unitLabel, type SpeedUnit } from '../lib/units';

interface Props {
  variable: Variable | null;
  speedUnit: SpeedUnit;
}

const SPEED_VARS = new Set<Variable>(['wind_speed', 'current_speed']);

/**
 * Vertikaalne astmeline legend kaardi vasakus servas.
 *
 * Vertikaalne, sest see ei võta ekraani laiusest midagi ära ja püsib
 * ka telefonis loetav. Astmeline, sest merel mõeldakse lävendites
 * ("üle 12 m/s ma välja ei lähe"), mitte pidevas gradiendis — astmed
 * teevad lävendi kaardilt otse loetavaks.
 *
 * Väärtused kuvatakse kasutaja valitud ühikus, kuigi värvid on alati
 * seotud SI-väärtusega — nii ei muutu kaardi pilt ühiku vahetamisel.
 */
export function MapLegend({ variable, speedUnit }: Props) {
  const { t } = useI18n();
  if (!variable) return null;

  const scale = COLOR_SCALES[variable];
  if (!scale) return null;

  const isSpeed = SPEED_VARS.has(variable);
  const unit = isSpeed ? unitLabel(variable, speedUnit) : scale.unit;

  // Astmed tulevad otse värviskaala peatustest — nii langevad legendi piirid
  // ja kaardi värviüleminekud alati kokku.
  const stops = [...scale.stops].reverse();

  return (
    <div className="legend" aria-label={t(scale.labelKey)}>
      <div className="legend__unit">{unit}</div>
      <ul className="legend__scale">
        {stops.map((stop) => {
          const shown = isSpeed ? convertSpeed(stop.value, speedUnit) : stop.value;
          return (
            <li key={stop.value} className="legend__step">
              <span
                className="legend__swatch"
                style={{ background: rgbaCss(sampleScale(scale, stop.value)) }}
                aria-hidden="true"
              />
              <span className="legend__value">{formatTick(shown)}</span>
            </li>
          );
        })}
      </ul>
      <div className="legend__title">{t(scale.labelKey)}</div>
    </div>
  );
}

function formatTick(v: number): string {
  if (Math.abs(v) >= 10000) return `${Math.round(v / 1000)}k`;
  if (Number.isInteger(v)) return String(v);
  if (Math.abs(v) >= 10) return String(Math.round(v));
  return v.toFixed(1).replace(/\.0$/, '');
}
