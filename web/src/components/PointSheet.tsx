import { useMemo, useState } from 'react';
import type { PointResult, Variable } from '@seapro/shared';
import { degreesToCompass } from '@seapro/shared';
import { useI18n } from '../i18n';
import { formatValue, unitLabel, windColor, type SpeedUnit } from '../lib/units';
import { formatDay, formatTime } from '../lib/time';
import { ForecastChart } from './ForecastChart';

interface Props {
  open: boolean;
  onClose(): void;
  lat: number;
  lon: number;
  result: PointResult | null;
  loading: boolean;
  error: string | null;
  selectedTime: Date;
  onSelectTime(d: Date): void;
  speedUnit: SpeedUnit;
  isFavorite: boolean;
  onToggleFavorite(): void;
}

/** Read tabelis, selles järjekorras. Puuduvad muutujad jäetakse vahele. */
const ROWS: Variable[] = [
  'wind_speed',
  'wind_gust',
  'wind_dir',
  'wave_height',
  'wave_period',
  'wave_dir',
  'sea_temp',
  'air_temp',
  'pressure',
  'precipitation',
  'cloud_cover',
  'visibility',
  'sea_level',
  'current_speed',
];

/** Kiirnäidud paneeli ülaosas — mida kaatrimees vaatab esimesena. */
const READOUTS: Variable[] = ['wind_speed', 'wind_gust', 'wave_height', 'air_temp'];

/** Graafikul valitavad suurused. */
const CHARTABLE: Variable[] = [
  'wind_speed',
  'wave_height',
  'air_temp',
  'pressure',
  'sea_temp',
  'precipitation',
];

function findStep(result: PointResult, seriesIdx: number, time: Date) {
  const series = result.series[seriesIdx];
  if (!series) return null;
  const target = time.getTime();
  // Lähim samm, mitte täpne vaste — vaatlusandmed ei lange täistundidele.
  let best = null as (typeof series.steps)[number] | null;
  let bestDiff = Infinity;
  for (const step of series.steps) {
    const diff = Math.abs(new Date(step.time).getTime() - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = step;
    }
  }
  // Üle 3 h eemal olev väärtus pole enam "see hetk".
  return bestDiff <= 3 * 3600_000 ? best : null;
}

/**
 * Suured näidud valitud hetke kohta, esimese allika põhjal.
 * Eesmärk: kaatris tahad ühe pilguga tuult ja lainet, mitte tabelit lugeda.
 */
function ReadoutGrid({
  values,
  speedUnit,
}: {
  values: Partial<Record<Variable, number | null>>;
  speedUnit: SpeedUnit;
}) {
  const { t } = useI18n();
  const shown = READOUTS.filter((v) => values[v] != null);
  if (shown.length === 0) return null;

  const dir = values.wind_dir;

  return (
    <div className="readout-grid">
      {shown.map((v) => {
        const raw = values[v]!;
        const isWind = v === 'wind_speed' || v === 'wind_gust';
        return (
          <div className="readout" key={v}>
            {isWind ? (
              <span className="readout__accent" style={{ background: windColor(raw) }} />
            ) : null}
            <span className="readout__label">{t(`var.${v}`)}</span>
            <span className="readout__value">
              {formatValue(v, raw, speedUnit)}
              <span className="readout__unit">{unitLabel(v, speedUnit)}</span>
              {v === 'wind_speed' && dir != null ? (
                <span
                  className="readout__arrow"
                  /* Nool osutab sinna, KUHU tuul puhub — sama loogika mis kaardil. */
                  style={{ transform: `rotate(${(dir + 180) % 360}deg)` }}
                  title={`${Math.round(dir)}° ${degreesToCompass(dir)}`}
                >
                  ↑
                </span>
              ) : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function PointSheet({
  open,
  onClose,
  lat,
  lon,
  result,
  loading,
  error,
  selectedTime,
  onSelectTime,
  speedUnit,
  isFavorite,
  onToggleFavorite,
}: Props) {
  const { t, lang } = useI18n();
  const [chartVar, setChartVar] = useState<Variable>('wind_speed');
  const [tab, setTab] = useState<'chart' | 'table'>('chart');

  const columns = useMemo(() => {
    if (!result) return [];
    return result.series.map((s, i) => ({
      idx: i,
      label:
        s.modelId && s.modelId !== 'best_match'
          ? `${s.providerId}\n${s.modelId}`
          : s.providerId,
      step: findStep(result, i, selectedTime),
    }));
  }, [result, selectedTime]);

  const visibleRows = useMemo(() => {
    return ROWS.filter((v) => columns.some((c) => c.step?.values[v] != null));
  }, [columns]);

  const chartableHere = useMemo(() => {
    if (!result) return [];
    return CHARTABLE.filter((v) =>
      result.series.some((s) => s.steps.some((st) => st.values[v] != null)),
    );
  }, [result]);

  return (
    <div className={`sheet${open ? ' is-open' : ''}`} aria-hidden={!open}>
      <div className="sheet__grip" aria-hidden="true" />

      <header className="sheet__head">
        <div>
          <h2>{t('point.title')}</h2>
          <p className="sheet__coords">
            {lat.toFixed(4)}° N, {lon.toFixed(4)}° E · {formatDay(selectedTime, lang)}{' '}
            {formatTime(selectedTime, lang)}
          </p>
        </div>
        <div className="sheet__actions">
          <button
            type="button"
            className={`icon-btn${isFavorite ? ' is-active' : ''}`}
            onClick={onToggleFavorite}
            aria-label={isFavorite ? t('action.removeFavorite') : t('action.addFavorite')}
            title={isFavorite ? t('action.removeFavorite') : t('action.addFavorite')}
          >
            {isFavorite ? '★' : '☆'}
          </button>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t('action.close')}>
            ✕
          </button>
        </div>
      </header>

      <div className="sheet__body">
        {loading ? <div className="loading-bar" aria-label={t('point.loading')} /> : null}
        {error ? <p className="error">{error}</p> : null}

        {result?.errors.length ? (
          <ul className="source-errors">
            {result.errors.map((e) => (
              <li key={e.providerId} className={e.kind === 'parse' ? 'is-parse' : ''}>
                {e.kind === 'parse'
                  ? t('source.failedParse', { name: e.providerId })
                  : t('source.failed', { name: e.providerId })}
              </li>
            ))}
          </ul>
        ) : null}

        {result && result.series.length === 0 && !loading ? (
          <p className="muted">{t('point.noData')}</p>
        ) : null}

        {result && result.series.length > 0 ? (
          <>
            <ReadoutGrid
              values={columns[0]?.step?.values ?? {}}
              speedUnit={speedUnit}
            />

            <div className="tabs">
              <button
                type="button"
                className={`tab${tab === 'chart' ? ' is-active' : ''}`}
                onClick={() => setTab('chart')}
              >
                {t('point.chart')}
              </button>
              <button
                type="button"
                className={`tab${tab === 'table' ? ' is-active' : ''}`}
                onClick={() => setTab('table')}
              >
                {t('point.table')}
              </button>
            </div>

            {tab === 'chart' ? (
              <>
                <div className="chips chips--tight">
                  {chartableHere.map((v) => (
                    <button
                      key={v}
                      type="button"
                      className={`chip${chartVar === v ? ' is-active' : ''}`}
                      onClick={() => setChartVar(v)}
                    >
                      {t(`var.${v}`)}
                    </button>
                  ))}
                </div>
                <ForecastChart
                  series={result.series}
                  variable={chartVar}
                  speedUnit={speedUnit}
                  selectedTime={selectedTime}
                  onPickTime={onSelectTime}
                />
              </>
            ) : (
              <div className="table-scroll">
                <table className="compare">
                  <thead>
                    <tr>
                      <th />
                      {columns.map((c) => (
                        <th key={c.idx}>
                          {c.label.split('\n').map((line, i) => (
                            <span key={i} className={i === 1 ? 'sub' : ''}>
                              {line}
                            </span>
                          ))}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map((v) => (
                      <tr key={v}>
                        <th scope="row">
                          {t(`var.${v}`)}
                          <small>{unitLabel(v, speedUnit)}</small>
                        </th>
                        {columns.map((c) => {
                          const raw = c.step?.values[v];
                          const isWind = v === 'wind_speed' || v === 'wind_gust';
                          return (
                            <td
                              key={c.idx}
                              style={
                                isWind && raw != null
                                  ? { borderLeft: `3px solid ${windColor(raw)}` }
                                  : undefined
                              }
                            >
                              {formatValue(v, raw, speedUnit)}
                              {v === 'wind_dir' && raw != null ? null : null}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

export { degreesToCompass };
