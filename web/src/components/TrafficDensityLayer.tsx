import { useEffect, useMemo, useState } from 'react';
import { ChartNoAxesColumnIncreasing, Check, ChevronDown } from 'lucide-react';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { TRAFFIC_PERIODS, TRAFFIC_TYPES, TRAFFIC_WORLD_CELLS, type TrafficDensity, type TrafficPeriod, type TrafficType } from '@seapro/shared';
import { api } from '../lib/api';
import { useI18n, localeTag } from '../i18n';
import { hideTrafficDensity, showTrafficDensity, TRAFFIC_COLORS } from '../map/layers/trafficDensity';

interface Props {
  map: MapLibreMap;
  bbox: [number, number, number, number];
}

export function TrafficDensityLayer({ map, bbox }: Props) {
  const { t, lang } = useI18n();
  const [period, setPeriod] = useState<TrafficPeriod>(7);
  const [selected, select] = useState<TrafficType[]>([]);
  const [expanded, expand] = useState(() => window.innerWidth >= 760);
  const [attempt, retry] = useState(0);
  const [response, setResponse] = useState<{ key: string; period: TrafficPeriod; data: TrafficDensity | null } | null>(null);
  const bounds = bbox.map(n => n.toFixed(6)).join(',');
  const key = period + '/' + bounds;
  const current = response?.key === key ? response : null;
  const data = current?.data;
  const mapped = response?.period === period ? response.data : null;

  useEffect(() => {
    const abort = new AbortController();
    api.trafficDensity(period, bounds, abort.signal).then(data => {
      if (!abort.signal.aborted) setResponse({ key, period, data });
    }).catch(() => {
      if (!abort.signal.aborted) setResponse({ key, period, data: null });
    });
    return () => abort.abort();
  }, [period, bounds, key, attempt]);

  useEffect(() => {
    if (mapped) showTrafficDensity(map, mapped, selected);
    else hideTrafficDensity(map);
  }, [map, mapped, selected]);
  useEffect(() => () => hideTrafficDensity(map), [map]);

  const ranking = useMemo(() => {
    const totals = TRAFFIC_TYPES.map(type => ({ type, metres: 0 }));
    for (const cell of data?.cells ?? []) {
      for (const row of totals) row.metres += cell.metres[row.type] ?? 0;
    }
    return totals.sort((a, b) => b.metres - a.metres);
  }, [data]);
  const total = ranking.reduce((sum, row) => sum + row.metres, 0);
  const filtered = selected.length > 0;
  const selectedMetres = ranking.reduce((sum, row) => sum + (selected.includes(row.type) ? row.metres : 0), 0);
  const toggleType = (type: TrafficType) => select(previous => {
    const next = previous.includes(type) ? previous.filter(item => item !== type) : [...previous, type];
    return next.length === TRAFFIC_TYPES.length ? [] : next;
  });
  const locale = localeTag(lang);
  const date = (value: string) => new Date(value + 'T00:00:00Z').toLocaleDateString(locale, {
    month: 'short', day: 'numeric', year: period === 365 ? 'numeric' : undefined, timeZone: 'UTC',
  });
  const number = (metres: number) => (metres / 1852).toLocaleString(locale, { maximumFractionDigits: metres < 1852 ? 1 : 0 });
  const midLatitude = (bbox[0] + bbox[2]) / 2;
  const cellKm = data ? data.factor * 40075.017 / TRAFFIC_WORLD_CELLS * Math.cos(midLatitude * Math.PI / 180) : 0;
  const leader = ranking[0]!;
  let summary = total ? t('key.vessel.' + leader.type) + ' · ' + Math.round(leader.metres / total * 100) + '%' : t('density.ais');
  if (filtered) {
    summary = selected.length === 1 ? t('key.vessel.' + selected[0]) : t('density.selected', { n: selected.length });
    if (data) summary += ' · ' + number(selectedMetres) + ' NM';
  }
  let status: string | null = null;
  if (!current) status = t('density.loading');
  else if (!data) status = t('density.error');
  else if (!total) status = t('density.empty');
  else if (filtered && !selectedMetres) status = t('density.noMatches');
  return (
    <section className="density-card" aria-label={t('density.title')}>
      <button type="button" className="density-card__head" aria-expanded={expanded} onClick={() => expand(!expanded)}>
        <ChartNoAxesColumnIncreasing size={19} aria-hidden="true" />
        <span><strong>{t('density.title')}</strong><small>{summary}</small></span>
        <ChevronDown size={16} aria-hidden="true" className={expanded ? 'is-open' : ''} />
      </button>
      {expanded && <div className="density-card__body">
        <div className="chips density-card__periods" role="group" aria-label={t('density.period')}>
          {TRAFFIC_PERIODS.map(days => <button type="button" key={days} aria-pressed={period === days}
            className={'chip' + (period === days ? ' is-active' : '')} onClick={() => setPeriod(days)}>
            {t(days === 365 ? 'density.year' : days === 1 ? 'density.day' : 'density.days', { n: days })}
          </button>)}
        </div>
        {data?.from && data.to && <p className="density-card__dates">{date(data.from)}{data.from !== data.to && ' – ' + date(data.to)} · UTC
          {data.coveredDays < period && ' · ' + t('density.coverage', { n: data.coveredDays, days: period })}
          <br />{t('density.cellKm', { km: cellKm.toLocaleString(locale, { maximumFractionDigits: 1 }) })}
        </p>}
        {!status && <p>{t('density.hint')}</p>}
        {status && <p role="status">{status}</p>}
        {current && !data && <button type="button" className="chip" onClick={() => { setResponse(null); retry(n => n + 1); }}>{t('density.retry')}</button>}
        {data && <div className="density-card__ranking" role="group" aria-label={t('density.filter')}>
          <h3>{t('density.rank')}</h3>
          <button type="button" aria-pressed={!filtered} onClick={() => select([])}>
            <strong>{t('density.all')}</strong><span>{number(total)} NM</span>
          </button>
          {ranking.map(row => <button
            key={row.type} type="button" aria-pressed={selected.includes(row.type)}
            onClick={() => toggleType(row.type)}>
            <i style={{ background: TRAFFIC_COLORS[row.type] }} aria-hidden="true">
              {selected.includes(row.type) && <Check size={12} strokeWidth={3} />}
            </i>
            <span>{t('key.vessel.' + row.type)}</span><span>{number(row.metres)} NM</span>
          </button>)}
        </div>}
      </div>}
      {!expanded && status && <small className="density-card__status" role="status">{status}</small>}
    </section>
  );
}
