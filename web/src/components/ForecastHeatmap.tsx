import { useEffect, useRef, type CSSProperties } from 'react';
import type { TimeSeries, Variable } from '@seapro/shared';
import { useI18n } from '../i18n';
import { COLOR_SCALES, sampleScale } from '../map/colorScales';
import { formatValue, unitLabel, type SpeedUnit } from '../lib/units';

interface Props {
  series: TimeSeries[];
  speedUnit: SpeedUnit;
  selectedTime: Date;
  onSelectTime(time: Date): void;
}

const ROWS: Variable[] = [
  'wind_speed',
  'wind_gust',
  'wind_dir',
  'wave_height',
  'wave_max_height',
  'wave_period',
  'wave_dir',
  'air_temp',
  'precipitation',
  'cloud_cover',
  'pressure',
  'visibility',
  'sea_temp',
  'sea_level',
  'current_speed',
  'current_dir',
];

const SCALE_FOR: Partial<Record<Variable, Variable>> = {
  wind_speed: 'wind_speed',
  wind_gust: 'wind_speed',
  wave_height: 'wave_height',
  wave_max_height: 'wave_height',
  air_temp: 'air_temp',
  precipitation: 'precipitation',
  cloud_cover: 'cloud_cover',
  pressure: 'pressure',
  visibility: 'visibility',
  sea_temp: 'sea_temp',
  sea_level: 'sea_level',
  current_speed: 'current_speed',
};

const DIRECTION_ROWS = new Set<Variable>(['wind_dir', 'wave_dir', 'current_dir']);

function cellStyle(variable: Variable, value: number | null | undefined): CSSProperties | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;

  if (DIRECTION_ROWS.has(variable)) {
    return { color: 'var(--accent)' };
  }

  if (variable === 'wave_period') {
    const lightness = Math.max(28, 62 - Math.min(18, value) * 1.9);
    return { background: `hsl(194 62% ${lightness}%)`, color: lightness > 52 ? '#071923' : '#fff' };
  }

  const scaleVariable = SCALE_FOR[variable];
  const scale = scaleVariable ? COLOR_SCALES[scaleVariable] : undefined;
  if (!scale) return undefined;
  const [r, g, b, a] = sampleScale(scale, value);
  if (a === 0) return undefined;
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return {
    background: `rgba(${r}, ${g}, ${b}, ${Math.max(0.72, a / 255).toFixed(3)})`,
    color: luminance > 165 ? '#071923' : '#fff',
  };
}

function directionArrow(value: number): React.ReactElement {
  return (
    <span
      className="heatmap__arrow"
      style={{ transform: `rotate(${(value + 180) % 360}deg)` }}
      aria-hidden="true"
    >
      ↑
    </span>
  );
}

export function ForecastHeatmap({ series, speedUnit, selectedTime, onSelectTime }: Props) {
  const { t, lang } = useI18n();
  const scrollHost = useRef<HTMLDivElement>(null);
  const openMeteo = series
    .filter((item) => item.providerId === 'open-meteo')
    .sort((a, b) => b.steps.length - a.steps.length)[0];
  const selectedMs = selectedTime.getTime();
  const selectedIndex = openMeteo?.steps.reduce(
    (best, step, index) => {
      const diff = Math.abs(new Date(step.time).getTime() - selectedMs);
      return diff < best.diff ? { index, diff } : best;
    },
    { index: -1, diff: Infinity },
  ).index ?? -1;

  useEffect(() => {
    const host = scrollHost.current;
    if (!host || selectedIndex < 0) return;
    const target = host.querySelector<HTMLElement>(`[data-time-index="${selectedIndex}"]`);
    if (!target) return;
    const labelWidth = 108;
    const available = Math.max(0, host.clientWidth - labelWidth);
    host.scrollTo({
      left: Math.max(0, target.offsetLeft - labelWidth - (available - target.offsetWidth) / 2),
      behavior: 'smooth',
    });
  }, [selectedIndex]);

  if (!openMeteo) return <p className="muted">{t('point.noData')}</p>;

  const rows = ROWS.filter((variable) =>
    openMeteo.steps.some((step) => step.values[variable] != null),
  );
  const locale = lang === 'et' ? 'et-EE' : 'en-GB';

  return (
    <div className="heatmap">
      <div className="heatmap__source">
        <strong>Open-Meteo</strong>
        {openMeteo.modelId && openMeteo.modelId !== 'best_match' ? (
          <span>{openMeteo.modelId}</span>
        ) : null}
      </div>
      <div className="heatmap__scroll" ref={scrollHost}>
        <table className="heatmap__table">
          <thead>
            <tr>
              <th className="heatmap__corner" scope="col">{t('chart.time')}</th>
              {openMeteo.steps.map((step, index) => {
                const time = new Date(step.time);
                const showDate = index === 0 || time.getHours() === 0;
                return (
                  <th
                    className={index === selectedIndex ? 'is-selected' : ''}
                    data-time-index={index}
                    key={step.time}
                    scope="col"
                  >
                    <span className="heatmap__date">
                      {showDate
                        ? time.toLocaleDateString(locale, { weekday: 'short', day: 'numeric' })
                        : '\u00a0'}
                    </span>
                    <span className="heatmap__time">
                      {String(time.getHours()).padStart(2, '0')}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((variable) => (
              <tr key={variable}>
                <th scope="row">
                  <span>{t(`var.${variable}`)}</span>
                  <small>{unitLabel(variable, speedUnit)}</small>
                </th>
                {openMeteo.steps.map((step, index) => {
                  const raw = step.values[variable];
                  const time = new Date(step.time);
                  return (
                    <td className={index === selectedIndex ? 'is-selected' : ''} key={step.time}>
                      <button
                        type="button"
                        className="heatmap__cell"
                        style={cellStyle(variable, raw)}
                        onClick={() => onSelectTime(time)}
                        aria-label={`${t(`var.${variable}`)}, ${formatValue(variable, raw, speedUnit)}, ${time.toLocaleString(locale)}`}
                      >
                        {raw != null && DIRECTION_ROWS.has(variable)
                          ? directionArrow(raw)
                          : formatValue(variable, raw, speedUnit)}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
