import { useMemo, useState } from 'react';
import { ChevronUp, Star, X } from 'lucide-react';
import type { PointResult, Variable } from '@seapro/shared';
import { degreesToCompass } from '@seapro/shared';
import { useI18n } from '../i18n';
import { formatValue, unitLabel, windColor, type SpeedUnit } from '../lib/units';
import { formatDay, formatTime } from '../lib/time';
import { ForecastChart } from './ForecastChart';
import { ForecastHeatmap } from './ForecastHeatmap';

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
  /** Kas paneel on täies mahus lahti. Olekut hoiab App, sest ka kaardi
   *  nupuvirn peab teadma, kas tal on vaja paneeli eest kõrvale põigata. */
  expanded: boolean;
  onExpandedChange(v: boolean): void;
}

/** Kiirnäidud paneeli ülaosas — mida kaatrimees vaatab esimesena. */
const READOUTS: Variable[] = ['wind_speed', 'wind_gust', 'wave_height', 'air_temp'];

/** Mobiili ruutvaates kuvatavad kuus põhinäitu. */
const PEEK_READOUTS: Variable[] = [
  'wind_speed',
  'wind_gust',
  'wave_height',
  'air_temp',
  'precipitation',
  'wind_dir',
];

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

function PeekReadouts({
  values,
  speedUnit,
}: {
  values: Partial<Record<Variable, number | null>>;
  speedUnit: SpeedUnit;
}) {
  const { t } = useI18n();

  return (
    <span className="sheet__peek-grid">
      {PEEK_READOUTS.map((variable) => {
        const raw = values[variable];
        const isWind = variable === 'wind_speed' || variable === 'wind_gust';
        return (
          <span className="sheet__peek-metric" key={variable}>
            <span className="sheet__peek-label">{t(`var.${variable}`)}</span>
            <span
              className="sheet__peek-value"
              style={isWind && raw != null ? { color: windColor(raw) } : undefined}
            >
              {variable === 'wind_dir' ? (
                raw != null ? (
                  <span
                    className="sheet__peek-arrow"
                    style={{ transform: `rotate(${(raw + 180) % 360}deg)` }}
                    title={`${Math.round(raw)}° ${degreesToCompass(raw)}`}
                  >
                    ↑
                  </span>
                ) : '–'
              ) : (
                <>
                  {formatValue(variable, raw, speedUnit)}
                  {raw != null ? (
                    <span className="sheet__peek-unit">{unitLabel(variable, speedUnit)}</span>
                  ) : null}
                </>
              )}
            </span>
          </span>
        );
      })}
    </span>
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
  expanded,
  onExpandedChange,
}: Props) {
  const { t, lang } = useI18n();
  const [chartVar, setChartVar] = useState<Variable>('wind_speed');
  const [tab, setTab] = useState<'chart' | 'heatmap'>('chart');

  const columns = useMemo(() => {
    if (!result) return [];
    return result.series.map((s, i) => ({
      idx: i,
      step: findStep(result, i, selectedTime),
    }));
  }, [result, selectedTime]);

  const chartableHere = useMemo(() => {
    if (!result) return [];
    return CHARTABLE.filter((v) =>
      result.series.some((s) => s.steps.some((st) => st.values[v] != null)),
    );
  }, [result]);

  /*
   * Paneel avaneb KOKKUPANDULT.
   *
   * Klikk kaardil avas varem kohe terve paneeli, mis kattis pool ekraanist —
   * ka siis, kui tahtsid lihtsalt teada, kui tugev tuul seal on. Nüüd tuleb
   * esmalt kitsas riba tuule ja lainega; graafik, tabel ja allikad avanevad
   * alles siis, kui riba peale vajutad.
   */
  const peek = columns[0]?.step?.values ?? {};

  if (!expanded) {
    return (
      <div className={`sheet is-peek${open ? ' is-open' : ''}`} aria-hidden={!open}>
        <div className="sheet__grip" aria-hidden="true" />
        <div className="sheet__peek-row">
          <button
            type="button"
            className="sheet__peek"
            onClick={() => onExpandedChange(true)}
            aria-expanded={false}
            aria-label={t('point.expand')}
          >
            <span className="sheet__peek-desktop">
              <span className="sheet__peek-coords">
                {lat.toFixed(2)}° {lon.toFixed(2)}°
              </span>

              {loading ? (
                <span className="sheet__peek-loading">{t('point.loading')}</span>
              ) : (
                <span className="sheet__peek-values">
                  {peek.wind_speed != null ? (
                    <span style={{ color: windColor(peek.wind_speed) }}>
                      {formatValue('wind_speed', peek.wind_speed, speedUnit)}{' '}
                      {unitLabel('wind_speed', speedUnit)}
                      {peek.wind_dir != null ? ` ${degreesToCompass(peek.wind_dir)}` : ''}
                    </span>
                  ) : null}
                  {peek.wave_height != null ? (
                    <span>
                      {formatValue('wave_height', peek.wave_height, speedUnit)}{' '}
                      {unitLabel('wave_height', speedUnit)}
                    </span>
                  ) : null}
                </span>
              )}

              <ChevronUp className="sheet__peek-chevron" size={20} aria-hidden="true" />
            </span>

            <span className="sheet__peek-mobile">
              <span className="sheet__peek-title">{t('point.title')}</span>
              <span className="sheet__peek-expand-hint" aria-hidden="true">
                <ChevronUp size={14} />
                {t('point.expand')}
              </span>
              {loading ? (
                <span className="sheet__peek-loading">{t('point.loading')}</span>
              ) : error ? (
                <span className="sheet__peek-loading">{error}</span>
              ) : (
                <PeekReadouts values={peek} speedUnit={speedUnit} />
              )}
            </span>
          </button>

          {/* Eraldi nupp, mitte riba sees: nupp nupu sees ei ole lubatud.
              Kaardiklikk ei sulge enam midagi, seega peab sulgemine olema
              siin nähtaval. */}
          <button
            type="button"
            className="sheet__peek-close"
            onClick={onClose}
            aria-label={t('action.close')}
          >
            <X size={21} aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`sheet is-expanded${open ? ' is-open' : ''}`} aria-hidden={!open}>
      <button
        type="button"
        className="sheet__grip"
        onClick={() => onExpandedChange(false)}
        aria-label={t('point.collapse')}
      />

      <header className="sheet__head">
        <div>
          <h2>{t('point.title')}</h2>
          {/* Koordinaat ja aeg eraldi ridadel: ühel real murdus rida kitsal
              paneelil suvalisest kohast ja kuupäev sattus koordinaadi keskele. */}
          <p className="sheet__coords">
            {lat.toFixed(4)}° N, {lon.toFixed(4)}° E
          </p>
          <p className="sheet__when">
            {formatDay(selectedTime, lang)} {formatTime(selectedTime, lang)}
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
            <Star size={20} fill={isFavorite ? 'currentColor' : 'none'} aria-hidden="true" />
          </button>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t('action.close')}>
            <X size={21} aria-hidden="true" />
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
                className={`tab${tab === 'heatmap' ? ' is-active' : ''}`}
                onClick={() => setTab('heatmap')}
              >
                {t('point.heatmap')}
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
              <ForecastHeatmap
                series={result.series}
                speedUnit={speedUnit}
                selectedTime={selectedTime}
                onSelectTime={onSelectTime}
              />
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

export { degreesToCompass };
