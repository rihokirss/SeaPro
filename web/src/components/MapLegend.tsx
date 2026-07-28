import type { Variable } from '@seapro/shared';
import { convertSpeed } from '@seapro/shared';
import { useI18n } from '../i18n';
import { COLOR_SCALES, sampleScale } from '../map/colorScales';
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
 * Number on TRÜKITUD värvi peale, mitte selle kõrvale: nii kaob eraldi
 * numbrituleba ja legend läheb poole kitsamaks. Sama põhimõte on
 * Windfinderil ja see töötab, sest värviplokk ise on juba piisavalt
 * suur, et number sinna mahuks.
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
  const title = t(scale.labelKey);

  // Astmed tulevad otse värviskaala peatustest — nii langevad legendi piirid
  // ja kaardi värviüleminekud alati kokku.
  const stops = [...scale.stops].reverse();
  const shown = stops.map((stop) => (isSpeed ? convertSpeed(stop.value, speedUnit) : stop.value));

  // Kümnendkohti täpselt nii palju, et astmed jääksid eristatavaks — tuulel
  // tähendab see alati täisarve. Komakoht on müra, kui sellest midagi ei sõltu.
  const decimals = fewestDecimals(shown);

  return (
    <div className="legend" aria-label={title} title={title}>
      <div className="legend__unit">{unit}</div>
      <ul className="legend__scale">
        {stops.map((stop, i) => {
          // Legendil kasutame läbipaistmatut värvi: kaardil kasvab alfa koos
          // tugevusega (nõrk tuul ei tohi kaarti katta), aga legendil teeks
          // see ülemised astmed loetamatuks kahvatuks.
          const [r, g, b, a] = sampleScale(scale, stop.value);

          // Alfa 0 on erand ja seda EI TOHI läbipaistmatuks teha. Selline
          // peatus ei ole värv, vaid lävend: alla selle ei joonistata midagi.
          // Pilvisuse 10% on tehniliselt valge, ja valge on samal skaalal
          // "üleni pilves" — täpselt vastupidine sellele, mida ta tähendab.
          // Tühi lahter ütleb sama asja ilma valetamata.
          if (a === 0) {
            return (
              <li key={stop.value} className="legend__step is-empty">
                {format(shown[i]!, decimals)}
              </li>
            );
          }

          return (
            <li
              key={stop.value}
              className={`legend__step${isDark(r, g, b) ? ' is-dark' : ''}`}
              style={{ background: `rgb(${r},${g},${b})` }}
            >
              {format(shown[i]!, decimals)}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Suured väärtused (nähtavus meetrites) lühendame, muidu läheb legend laiaks. */
function format(v: number, decimals: number): string {
  if (Math.abs(v) >= 10000) return `${Math.round(v / 1000)}k`;
  return v.toFixed(decimals);
}

/** Vähim kümnendkohtade arv, mille juures kõik astmed jäävad erinevaks. */
function fewestDecimals(values: number[]): number {
  for (let d = 0; d <= 2; d++) {
    const seen = new Set(values.map((v) => v.toFixed(d)));
    if (seen.size === values.length) return d;
  }
  return 2;
}

/**
 * Kas taust on nii tume, et number peab olema hele?
 * Tajutav heledus (Rec. 709) — pelk RGB-keskmine eksib rohelisel ja sinisel.
 */
function isDark(r: number, g: number, b: number): boolean {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.58;
}
