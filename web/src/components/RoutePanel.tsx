import type { Route, RouteAnalysis } from '@seapro/shared';
import { degreesToCompass } from '@seapro/shared';
import { useI18n } from '../i18n';
import { formatValue, unitLabel, type SpeedUnit } from '../lib/units';

interface Props {
  open: boolean;
  route: Route;
  savedRoutes: Route[];
  analysis: RouteAnalysis | null;
  loading: boolean;
  error: string | null;
  editing: boolean;
  canUndo: boolean;
  canRedo: boolean;
  speedUnit: SpeedUnit;
  onClose(): void;
  onChange(route: Route): void;
  onNew(): void;
  onLoad(route: Route): void;
  onDelete(id: string): void;
  onStartEdit(): void;
  onFinishEdit(): void;
  onCancelEdit(): void;
  onUndo(): void;
  onRedo(): void;
  onDeleteLast(): void;
  onUseLocation(): void;
  onNavigate(): void;
}

function localInput(iso: string): string {
  const date = new Date(iso); const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function WeatherSparkline({ analysis, field, color }: { analysis: RouteAnalysis; field: 'wind_speed' | 'wave_height'; color: string }) {
  const values = analysis.samples.map((s) => s.values[field] ?? null);
  const present = values.filter((v): v is number => v !== null);
  if (present.length < 2) return <div className="route-chart__empty">—</div>;
  const max = Math.max(...present, 0.1);
  const points = values.map((v, i) => `${i / Math.max(1, values.length - 1) * 100},${36 - (v ?? 0) / max * 32}`).join(' ');
  return <svg className="route-chart" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true"><polyline points={points} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg>;
}

export function RoutePanel(props: Props) {
  const { t, lang } = useI18n();
  if (!props.open) return null;
  const setNumber = (key: 'speedKnots' | 'draughtM' | 'underKeelClearanceM' | 'fuelLitresPerHour', raw: string) => {
    const value = Number(raw); if (Number.isFinite(value)) props.onChange({ ...props.route, [key]: value, updatedAt: new Date().toISOString() });
  };
  const fmt = (iso: string) => new Date(iso).toLocaleString(lang === 'et' ? 'et-EE' : 'en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return (
    <aside className="route-panel" aria-label={t('route.title')}>
      <header className="route-panel__header"><h2>{t('route.title')}</h2><button className="icon-btn" onClick={props.onClose} aria-label={t('action.close')}>×</button></header>
      <div className="route-panel__toolbar">
        <button onClick={props.onNew}>{t('route.new')}</button>
        <select value={props.savedRoutes.some((r) => r.id === props.route.id) ? props.route.id : ''} onChange={(e) => { const found = props.savedRoutes.find((r) => r.id === e.target.value); if (found) props.onLoad(found); }} aria-label={t('route.saved')}>
          <option value="">{t('route.saved')}</option>{props.savedRoutes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        {props.savedRoutes.some((r) => r.id === props.route.id) ? <button className="danger-link" onClick={() => props.onDelete(props.route.id)}>{t('action.delete')}</button> : null}
      </div>
      <div className="route-form">
        <label>{t('route.name')}<input value={props.route.name} onChange={(e) => props.onChange({ ...props.route, name: e.target.value, updatedAt: new Date().toISOString() })} /></label>
        <label>{t('route.startTime')}<input type="datetime-local" value={localInput(props.route.startTime)} onChange={(e) => props.onChange({ ...props.route, startTime: new Date(e.target.value).toISOString(), updatedAt: new Date().toISOString() })} /></label>
        <div className="route-form__grid">
          <label>{t('route.speed')}<input type="number" min="0.1" step="0.1" value={props.route.speedKnots} onChange={(e) => setNumber('speedKnots', e.target.value)} /></label>
          <label>{t('route.fuelRate')}<input type="number" min="0" step="0.1" value={props.route.fuelLitresPerHour} onChange={(e) => setNumber('fuelLitresPerHour', e.target.value)} /></label>
          <label>{t('route.draught')}<input type="number" min="0" step="0.1" value={props.route.draughtM} onChange={(e) => setNumber('draughtM', e.target.value)} /></label>
          <label>{t('route.clearance')}<input type="number" min="0" step="0.1" value={props.route.underKeelClearanceM} onChange={(e) => setNumber('underKeelClearanceM', e.target.value)} /></label>
        </div>
      </div>
      <div className="route-edit-actions">
        {props.editing ? <>
          <button onClick={props.onUndo} disabled={!props.canUndo}>↶</button><button onClick={props.onRedo} disabled={!props.canRedo}>↷</button>
          <button onClick={props.onDeleteLast} disabled={!props.route.waypoints.length}>{t('route.deleteLast')}</button>
          <button onClick={props.onUseLocation}>{t('route.useLocation')}</button>
          <button onClick={props.onCancelEdit}>{t('action.cancel')}</button><button className="primary" onClick={props.onFinishEdit} disabled={props.route.waypoints.length < 2}>{t('action.done')}</button>
        </> : <button className="primary" onClick={props.onStartEdit}>{t('route.edit')}</button>}
      </div>
      {props.editing ? <p className="route-hint">{t('route.editHint')}</p> : null}
      {props.loading ? <p className="route-status">{t('route.analysing')}</p> : null}
      {props.error ? <p className="route-status is-error">{props.error}</p> : null}
      {props.analysis ? <section className="route-report">
        <div className="route-summary">
          <div><strong>{props.analysis.distanceNm.toFixed(1)}</strong><span>NM</span></div>
          <div><strong>{(props.analysis.durationSeconds / 3600).toFixed(1)}</strong><span>h</span></div>
          <div><strong>{props.analysis.estimatedFuelLitres.toFixed(1)}</strong><span>l</span></div>
          <div><strong>{fmt(props.analysis.arrivalTime)}</strong><span>{t('route.arrival')}</span></div>
        </div>
        {props.analysis.depthSegments.some((s) => s.risk === 'danger' || s.risk === 'caution') ? <p className="route-depth-alert">
          {t('route.depthAlert', { danger: props.analysis.depthSegments.filter((s) => s.risk === 'danger').length, caution: props.analysis.depthSegments.filter((s) => s.risk === 'caution').length })}
        </p> : null}
        {props.analysis.warnings.map((warning) => <p className="route-status is-error" key={warning}>{t(`route.warning.${warning}`)}</p>)}
        {props.analysis.restrictions.map((item) => <p className="route-depth-alert" key={`${item.kind}-${item.name}`}>{t('route.restriction', { name: item.name, depth: item.maxDraughtM.toFixed(1) })}</p>)}
        <div className="route-chart-block"><span>{t('route.wind')} ({unitLabel('wind_speed', props.speedUnit)})</span><WeatherSparkline analysis={props.analysis} field="wind_speed" color="#35a7d8" /></div>
        <div className="route-chart-block"><span>{t('route.waves')}</span><WeatherSparkline analysis={props.analysis} field="wave_height" color="#c88728" /></div>
        <div className="route-table-wrap"><table className="route-table"><thead><tr><th>{t('chart.time')}</th><th>NM</th><th>{t('route.wind')}</th><th>{t('route.waves')}</th><th>{t('route.depth')}</th></tr></thead><tbody>
          {props.analysis.samples.map((s, i) => <tr key={`${s.time}-${i}`} className={`risk-${s.depthRisk}`}><td>{fmt(s.time)}</td><td>{s.distanceNm.toFixed(1)}</td><td>{s.values.wind_speed == null ? '—' : `${formatValue('wind_speed', s.values.wind_speed, props.speedUnit)} ${unitLabel('wind_speed', props.speedUnit)} ${s.values.wind_dir == null ? '' : degreesToCompass(s.values.wind_dir)}`}</td><td>{s.values.wave_height == null ? '—' : `${s.values.wave_height.toFixed(1)} m`}</td><td>{s.depthM == null ? '—' : `${s.depthM.toFixed(1)} m`}</td></tr>)}
        </tbody></table></div>
        <p className="route-safety">{t('route.depthDisclaimer')}</p>
        <button className="primary route-navigate" onClick={props.onNavigate}>{t('route.navigate')}</button>
      </section> : null}
    </aside>
  );
}
