import { useEffect, useMemo, useState } from 'react';
import { ChartNoAxesColumnIncreasing, Check, ChevronDown } from 'lucide-react';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { TRAFFIC_PERIODS, TRAFFIC_TYPES, TRAFFIC_WORLD_CELLS, trafficWindow, type TrafficBounds, type TrafficDensity, type TrafficPeriod, type TrafficType } from '@seapro/shared';
import { api } from '../lib/api';
import { useI18n, localeTag } from '../i18n';
import { hideTrafficDensity, showTrafficDensity, TRAFFIC_COLORS } from '../map/layers/trafficDensity';

interface Props {
  map: MapLibreMap;
  bbox: TrafficBounds;
}

function covers(bounds: TrafficBounds, viewport: ReturnType<typeof trafficWindow>) {
  const region = trafficWindow(bounds, true);
  return region.factor === viewport.factor && region.left <= viewport.left && region.right >= viewport.right
    && region.top <= viewport.top && region.bottom >= viewport.bottom;
}

export function TrafficDensityLayer({ map, bbox }: Props) {
  const { t, lang } = useI18n();
  const [period, setPeriod] = useState<TrafficPeriod>(7);
  const [selected, select] = useState<TrafficType[]>([]);
  const [expanded, expand] = useState(() => window.innerWidth >= 760);
  const [attempt, retry] = useState(0);
  const viewport = useMemo(() => trafficWindow(bbox), [bbox]);
  const [requestBounds, setRequestBounds] = useState(bbox);
  if (!covers(requestBounds, viewport) && requestBounds !== bbox) setRequestBounds(bbox);
  const bounds = requestBounds.join(',');
  const key = period + '/' + bounds;
  const [response, setResponse] = useState<{ period: TrafficPeriod; bounds: TrafficBounds; data: TrafficDensity } | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const data = response?.period === period ? response.data : null;
  const failed = failedKey === key;

  useEffect(() => {
    const abort = new AbortController();
    api.trafficDensity(period, bounds, abort.signal).then(data => {
      if (!abort.signal.aborted) {
        setResponse({ period, bounds: requestBounds, data });
        setFailedKey(null);
      }
    }).catch(() => {
      if (!abort.signal.aborted) setFailedKey(key);
    });
    return () => abort.abort();
  }, [period, bounds, requestBounds, key, attempt]);

  useEffect(() => {
    if (data) showTrafficDensity(map, data, selected);
    else hideTrafficDensity(map);
  }, [map, data, selected]);
  useEffect(() => () => hideTrafficDensity(map), [map]);

  const ranking = useMemo(() => {
    const totals = TRAFFIC_TYPES.map(type => ({ type, metres: 0 }));
    if (!data) return totals;
    for (const cell of data.cells) {
      const y = cell.y * data.factor;
      if (y >= viewport.bottom || y + data.factor <= viewport.top) continue;
      // Offset eastwards from the left edge, including wrapped copies of the map.
      const dx = ((cell.x * data.factor - viewport.left) % TRAFFIC_WORLD_CELLS + TRAFFIC_WORLD_CELLS) % TRAFFIC_WORLD_CELLS;
      if (dx >= viewport.right - viewport.left && dx + data.factor <= TRAFFIC_WORLD_CELLS) continue;
      for (const row of totals) row.metres += cell.metres[row.type] ?? 0;
    }
    return totals.sort((a, b) => b.metres - a.metres);
  }, [data, viewport]);
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
  if (failed) status = t('density.error');
  else if (!data) status = t('density.loading');
  else if (!total && response?.bounds === requestBounds) status = t('density.empty');
  else if (filtered && !selectedMetres && response?.bounds === requestBounds) status = t('density.noMatches');
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
        {status && <p role="status">{status}</p>}
        {failed && <button type="button" className="chip" onClick={() => { setFailedKey(null); retry(n => n + 1); }}>{t('density.retry')}</button>}
        {data && <div className="density-card__ranking" role="group" aria-label={t('density.filter')} aria-busy={!failed && response?.bounds !== requestBounds}>
          <h3>{t(response?.bounds !== requestBounds ? 'density.loadedRank' : 'density.rank')}</h3>
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
