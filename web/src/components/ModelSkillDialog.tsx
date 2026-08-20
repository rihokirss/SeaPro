import { useEffect, useMemo, useRef, useState } from 'react';
import type { ModelSkillReport, ModelSkillSeriesReport, ModelSkillSourceStats } from '@seapro/shared';
import { BarChart3, CalendarDays, ChevronRight, CircleHelp, Clock3, Database, MapPin, Trophy, X } from 'lucide-react';
import { localeTag, useI18n } from '../i18n';
import { api } from '../lib/api';
import { modelSkillColor, ModelSkillChart, type ModelSkillMetric } from './ModelSkillChart';

type Days = 7 | 30 | 90;
type LeadHours = 0 | 3 | 12 | 24 | 48;
type Tab = 'overview' | 'points';

const PERIODS: Days[] = [7, 30, 90];
const LEADS: LeadHours[] = [0, 3, 12, 24, 48];

interface Props {
  open: boolean;
  onClose(): void;
  returnFocus?: HTMLElement | null;
}

export function ModelSkillLauncher({ onOpen }: { onOpen(trigger: HTMLButtonElement): void }) {
  const { t } = useI18n();
  return (
    <section className="panel__section model-skill-launcher">
      <button type="button" onClick={(event) => onOpen(event.currentTarget)}>
        <span className="model-skill-launcher__icon"><BarChart3 size={20} aria-hidden="true" /></span>
        <span><strong>{t('modelSkill.title')}</strong><small>{t('modelSkill.launchHint')}</small></span>
        <ChevronRight size={19} aria-hidden="true" />
      </button>
    </section>
  );
}

export function ModelSkillDialog({ open, onClose, returnFocus }: Props) {
  const { t, lang } = useI18n();
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const helpRef = useRef<HTMLDetailsElement>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [days, setDays] = useState<Days>(30);
  const [leadHours, setLeadHours] = useState<LeadHours>(24);
  const [pointId, setPointId] = useState('tallinnamadal');
  const [metric, setMetric] = useState<ModelSkillMetric>('speed');
  const [report, setReport] = useState<ModelSkillReport | null>(null);
  const [pointReport, setPointReport] = useState<ModelSkillReport | null>(null);
  const [series, setSeries] = useState<ModelSkillSeriesReport | null>(null);
  const [selectedSources, setSelectedSources] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [pointLoading, setPointLoading] = useState(false);
  const [error, setError] = useState(false);
  const [pointError, setPointError] = useState(false);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (helpRef.current?.open) {
          helpRef.current.open = false;
          helpRef.current.querySelector<HTMLElement>('summary')?.focus();
          return;
        }
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), select:not([disabled]), summary, [href], [tabindex]:not([tabindex="-1"])',
      )];
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (helpRef.current?.open && !helpRef.current.contains(event.target as Node)) {
        helpRef.current.open = false;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
      document.body.style.overflow = previousOverflow;
      returnFocus?.focus();
    };
  }, [onClose, open, returnFocus]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    api.modelSkill(days, leadHours, undefined, controller.signal)
      .then((next) => {
        setReport(next);
        setSelectedSources((current) => current.size > 0
          ? current
          : new Set(next.sources.filter((source) => source.samples > 0).map((source) => source.sourceId)));
      })
      .catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [days, leadHours, open]);

  useEffect(() => {
    if (!open || tab !== 'points') return;
    const controller = new AbortController();
    setPointLoading(true);
    setPointError(false);
    Promise.all([
      api.modelSkill(days, leadHours, pointId, controller.signal),
      api.modelSkillSeries(days, leadHours, pointId, controller.signal),
    ])
      .then(([nextReport, nextSeries]) => {
        setPointReport(nextReport);
        setSeries(nextSeries);
      })
      .catch(() => { if (!controller.signal.aborted) setPointError(true); })
      .finally(() => { if (!controller.signal.aborted) setPointLoading(false); });
    return () => controller.abort();
  }, [days, leadHours, open, pointId, tab]);

  const sourcesWithData = report?.sources.filter((source) => source.samples > 0) ?? [];
  const pointSourcesWithData = pointReport?.sources.filter((source) => source.samples > 0) ?? [];
  const best = sourcesWithData.find((source) => source.rankingEligible);
  const comparisonCount = Math.max(0, ...sourcesWithData.map((source) => source.samples));
  const maxMae = Math.max(1, ...sourcesWithData.map((source) => source.windSpeedMae ?? 0));
  const visibleSeries = useMemo(() => series?.sources.filter((source) => selectedSources.has(source.sourceId)) ?? [], [selectedSources, series]);

  if (!open) return null;

  return (
    <div className="model-skill-dialog__backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} className="model-skill-dialog" role="dialog" aria-modal="true" aria-labelledby="model-skill-title">
        <header className="model-skill-dialog__head">
          <div className="model-skill-dialog__title">
            <span><BarChart3 size={23} aria-hidden="true" /></span>
            <div><strong id="model-skill-title">{t('modelSkill.title')}</strong><small>{t('modelSkill.hint')}</small></div>
          </div>
          <div className="model-skill-dialog__head-actions">
            <details ref={helpRef} className="model-skill-help">
              <summary aria-label={t('modelSkill.help.open')}><CircleHelp size={20} aria-hidden="true" /></summary>
              <div className="model-skill-help__popover">
                <strong>{t('modelSkill.help.title')}</strong>
                <dl>
                  <div><dt>{t('modelSkill.mae')}</dt><dd>{t('modelSkill.help.mae')}</dd></div>
                  <div><dt>{t('modelSkill.bias')}</dt><dd>{t('modelSkill.help.bias')}</dd></div>
                  <div><dt>{t('modelSkill.coverage')}</dt><dd>{t('modelSkill.help.coverage')}</dd></div>
                </dl>
                <p><code>+3 / −3 m/s</code> → {t('modelSkill.help.example')}</p>
              </div>
            </details>
            <button ref={closeRef} type="button" className="icon-btn" onClick={onClose} aria-label={t('action.close')}><X size={21} aria-hidden="true" /></button>
          </div>
        </header>

        <div className="model-skill-dialog__toolbar">
          <div className="model-skill-tabs" role="tablist" aria-label={t('modelSkill.view')}>
            {(['overview', 'points'] as Tab[]).map((value) => (
              <button key={value} type="button" role="tab" aria-selected={tab === value} className={tab === value ? 'is-active' : ''} onClick={() => setTab(value)}>
                {t(`modelSkill.tab.${value}`)}
              </button>
            ))}
          </div>
          <div className="model-skill-filters">
            <span><CalendarDays size={16} aria-hidden="true" />{PERIODS.map((period) => <button key={period} type="button" className={days === period ? 'is-active' : ''} onClick={() => setDays(period)}>{t('modelSkill.days', { days: period })}</button>)}</span>
            <span><Clock3 size={16} aria-hidden="true" />{LEADS.map((lead) => <button key={lead} type="button" className={leadHours === lead ? 'is-active' : ''} onClick={() => setLeadHours(lead)}>{t(`modelSkill.lead.${lead}`)}</button>)}</span>
          </div>
        </div>

        <div className="model-skill-dialog__body">
          {tab === 'overview' ? (
            <>
              <Status loading={loading} error={error} empty={!loading && !error && sourcesWithData.length === 0} leadHours={leadHours} />
              {!error && sourcesWithData.length > 0 ? <>
                <div className="model-skill-summary">
                  <article className="is-highlight"><Trophy size={19} aria-hidden="true" /><span><small>{t('modelSkill.summary.best')}</small><strong>{best?.label ?? t('modelSkill.insufficient')}</strong></span></article>
                  <article><Database size={19} aria-hidden="true" /><span><small>{t('modelSkill.summary.comparisons')}</small><strong>{comparisonCount}</strong></span></article>
                  <article><CalendarDays size={19} aria-hidden="true" /><span><small>{t('modelSkill.summary.since')}</small><strong>{formatDate(report?.collectionStartedAt, lang)}</strong></span></article>
                  <article><Clock3 size={19} aria-hidden="true" /><span><small>{t('modelSkill.summary.updated')}</small><strong>{formatDateTime(report?.lastObservationAt, lang)}</strong></span></article>
                </div>

                <section className="model-skill-ranking" aria-labelledby="model-skill-ranking-title">
                  <div className="model-skill-section-head"><div><h3 id="model-skill-ranking-title">{t('modelSkill.ranking')}</h3><p>{t('modelSkill.rankingHint')}</p></div><strong>{t('modelSkill.mae')} · m/s</strong></div>
                  <ol>{sourcesWithData.map((source, index) => (
                    <li key={source.sourceId}>
                      <span className="model-skill-ranking__place">{index + 1}</span>
                      <span className="model-skill-ranking__name">{source.label}{source.sourceId === best?.sourceId ? <em>{t('modelSkill.best')}</em> : null}</span>
                      <span className="model-skill-ranking__bar"><i style={{ width: `${Math.max(3, ((source.windSpeedMae ?? 0) / maxMae) * 100)}%`, background: modelSkillColor(source.sourceId) }} /></span>
                      <strong>{formatMetric(source.windSpeedMae, ' m/s')}</strong>
                    </li>
                  ))}</ol>
                </section>

                <div className="model-skill-cards">{sourcesWithData.map((source) => (
                  <SourceCard key={source.sourceId} source={source} color={modelSkillColor(source.sourceId)} best={source.sourceId === best?.sourceId} />
                ))}</div>
              </> : null}
            </>
          ) : (
            <>
              <div className="model-skill-point-controls">
                <label><MapPin size={17} aria-hidden="true" /><span>{t('modelSkill.point')}</span><select value={pointId} onChange={(event) => setPointId(event.target.value)}>
                  <optgroup label={t('modelSkill.country.EE')}>{report?.points.filter((point) => point.country === 'EE').map((point) => <option key={point.id} value={point.id}>{point.name}</option>)}</optgroup>
                  <optgroup label={t('modelSkill.country.FI')}>{report?.points.filter((point) => point.country === 'FI').map((point) => <option key={point.id} value={point.id}>{point.name}</option>)}</optgroup>
                </select></label>
                <div className="model-skill-metric" role="group" aria-label={t('modelSkill.metric')}>
                  {(['speed', 'gust'] as ModelSkillMetric[]).map((value) => <button key={value} type="button" className={metric === value ? 'is-active' : ''} onClick={() => setMetric(value)}>{t(`modelSkill.metric.${value}`)}</button>)}
                </div>
              </div>
              <Status loading={pointLoading} error={pointError} empty={!pointLoading && !pointError && pointSourcesWithData.length === 0} leadHours={leadHours} />
              {!pointError && pointSourcesWithData.length > 0 ? <>
                <div className="model-skill-source-picker" aria-label={t('modelSkill.models')}>
                  {pointSourcesWithData.map((source) => <label key={source.sourceId} style={{ '--source-color': modelSkillColor(source.sourceId) } as React.CSSProperties}>
                    <input type="checkbox" checked={selectedSources.has(source.sourceId)} onChange={() => setSelectedSources((current) => {
                      const next = new Set(current);
                      if (next.has(source.sourceId)) next.delete(source.sourceId); else next.add(source.sourceId);
                      return next;
                    })} />
                    <i aria-hidden="true" />{source.label}
                  </label>)}
                </div>
                <ModelSkillChart sources={visibleSeries} metric={metric} lang={lang} observationLabel={t('modelSkill.observation')} emptyLabel={t('modelSkill.selectModel')} />
                <div className="model-skill-cards is-point">{pointSourcesWithData.map((source) => (
                  <SourceCard key={source.sourceId} source={source} color={modelSkillColor(source.sourceId)} best={source.rankingEligible && source.sourceId === pointSourcesWithData.find((item) => item.rankingEligible)?.sourceId} />
                ))}</div>
              </> : null}
            </>
          )}
        </div>
      </section>
    </div>
  );
}

function Status({ loading, error, empty, leadHours }: { loading: boolean; error: boolean; empty: boolean; leadHours: LeadHours }) {
  const { t } = useI18n();
  if (loading) return <div className="model-skill-state" role="status"><span className="model-skill-spinner" />{t('modelSkill.loading')}</div>;
  if (error) return <div className="model-skill-state is-error" role="alert">{t('modelSkill.error')}</div>;
  if (empty) return <div className="model-skill-state"><Database size={23} aria-hidden="true" /><strong>{t('modelSkill.collectingTitle')}</strong><span>{t('modelSkill.collecting', { hours: leadHours })}</span></div>;
  return null;
}

function SourceCard({ source, color, best }: { source: ModelSkillSourceStats; color: string; best: boolean }) {
  const { t } = useI18n();
  return <article className="model-skill-card" style={{ '--source-color': color } as React.CSSProperties}>
    <header><i aria-hidden="true" /><strong>{source.label}</strong>{best ? <em>{t('modelSkill.best')}</em> : null}</header>
    <dl>
      <div><dt>{t('modelSkill.mae')}</dt><dd>{formatMetric(source.windSpeedMae, ' m/s')}</dd></div>
      <div><dt>{t('modelSkill.bias')}</dt><dd>{signed(source.windSpeedBias)}</dd></div>
      <div><dt>{t('modelSkill.coverage')}</dt><dd>{Math.round(source.coverage * 100)}%</dd></div>
    </dl>
    {!source.rankingEligible ? <p>{t('modelSkill.notRanked')}</p> : null}
    <details><summary>{t('modelSkill.technical')}</summary><dl>
      <div><dt>RMSE</dt><dd>{formatMetric(source.windSpeedRmse, ' m/s')}</dd></div>
      <div><dt>{t('modelSkill.gustMae')}</dt><dd>{formatMetric(source.windGustMae, ' m/s')}</dd></div>
      <div><dt>{t('modelSkill.direction')}</dt><dd>{formatMetric(source.windDirectionMae, '°', 0)}</dd></div>
      <div><dt>{t('modelSkill.samples')}</dt><dd>{source.samples}</dd></div>
      <div><dt>{t('modelSkill.stations')}</dt><dd>{source.stations}</dd></div>
      {source.averageLocationDistanceKm !== null ? <div className="is-wide"><dt>{t('modelSkill.spotDistanceLabel')}</dt><dd>{source.averageLocationDistanceKm.toFixed(1)} km</dd></div> : null}
    </dl></details>
  </article>;
}

function signed(value: number | null): string {
  if (value === null) return '—';
  return `${value > 0 ? '+' : ''}${value.toFixed(2)} m/s`;
}

function formatMetric(value: number | null, suffix: string, decimals = 2): string {
  return value === null ? '—' : `${value.toFixed(decimals)}${suffix}`;
}

function formatDate(value: string | null | undefined, lang: 'et' | 'en' | 'fi'): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString(localeTag(lang), { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatDateTime(value: string | null | undefined, lang: 'et' | 'en' | 'fi'): string {
  if (!value) return '—';
  return new Date(value).toLocaleString(localeTag(lang), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
