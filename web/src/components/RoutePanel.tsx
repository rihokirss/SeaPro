import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { GripVertical, Play, Redo2, Settings2, Trash2, Undo2, X } from 'lucide-react';
import type { Route, RouteAnalysis, RouteWaypoint } from '@seapro/shared';
import { degreesToCompass, routeDistanceNm } from '@seapro/shared';
import { useI18n } from '../i18n';
import { formatValue, unitLabel, type SpeedUnit } from '../lib/units';

const LocalizedDateTimePicker = lazy(async () => {
  const module = await import('./LocalizedDateTimePicker');
  return { default: module.LocalizedDateTimePicker };
});

interface Props {
  open: boolean;
  route: Route;
  savedRoutes: Route[];
  analysis: RouteAnalysis | null;
  loading: boolean;
  error: string | null;
  editing: boolean;
  selectedWaypointId: string | null;
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
  onSelectWaypoint(id: string | null): void;
  onDeleteWaypoint(id: string): void;
  onPreviewWaypoints(waypoints: RouteWaypoint[]): void;
  onCommitReorder(previous: RouteWaypoint[]): void;
  onFocusWaypoint(point: RouteWaypoint): void;
  onUseLocation(): void;
  onNavigate(): void;
}

type SheetSnap = 'collapsed' | 'half' | 'expanded';
type SheetHeights = Record<SheetSnap, number>;

const SNAP_ORDER: SheetSnap[] = ['collapsed', 'half', 'expanded'];

function viewportHeight(): number {
  return window.visualViewport?.height ?? window.innerHeight;
}

function cssPixels(name: string): number {
  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(value) ? value : 0;
}

function sheetHeights(): SheetHeights {
  const viewport = viewportHeight();
  const collapsed = Math.min(viewport, 106 + cssPixels('--safe-bottom'));
  const half = Math.max(collapsed, viewport * 0.5);
  const expanded = Math.max(half, viewport - 72 - cssPixels('--safe-top'));
  return { collapsed, half, expanded };
}

function nearestSnap(height: number, heights: SheetHeights): SheetSnap {
  return SNAP_ORDER.reduce((best, snap) =>
    Math.abs(heights[snap] - height) < Math.abs(heights[best] - height) ? snap : best,
  'collapsed');
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
  const [sheetSnap, setSheetSnap] = useState<SheetSnap>('half');
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const [viewportTick, setViewportTick] = useState(0);
  const wasOpen = useRef(false);
  const wasEditing = useRef(false);
  const waypointList = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
    lastY: number;
    lastAt: number;
    velocity: number;
    moved: boolean;
  } | null>(null);
  const waypointDrag = useRef<{
    pointerId: number;
    startIndex: number;
    currentIndex: number;
    original: RouteWaypoint[];
  } | null>(null);

  useEffect(() => {
    const resize = (): void => setViewportTick((value) => value + 1);
    window.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      window.visualViewport?.removeEventListener('resize', resize);
    };
  }, []);

  useEffect(() => {
    if (props.open && !wasOpen.current) setSheetSnap(props.editing ? 'collapsed' : 'half');
    if (props.open && props.editing && !wasEditing.current) setSheetSnap('collapsed');
    if (props.open && !props.editing && wasEditing.current) setSheetSnap('half');
    wasOpen.current = props.open;
    wasEditing.current = props.editing;
  }, [props.open, props.editing]);

  useEffect(() => {
    if (!props.selectedWaypointId) return;
    waypointList.current?.querySelector<HTMLElement>(`[data-waypoint-id="${CSS.escape(props.selectedWaypointId)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [props.selectedWaypointId]);

  const heights = typeof window === 'undefined'
    ? { collapsed: 110, half: 400, expanded: 700 }
    : sheetHeights();
  void viewportTick;
  const currentHeight = dragHeight ?? heights[sheetSnap];
  const sheetStyle = { '--route-sheet-height': `${currentHeight}px` } as CSSProperties;

  const cycleSheet = (): void => {
    if (!window.matchMedia('(max-width: 700px)').matches) return;
    if (drag.current?.moved) { drag.current = null; return; }
    setSheetSnap((snap) => SNAP_ORDER[(SNAP_ORDER.indexOf(snap) + 1) % SNAP_ORDER.length]!);
  };

  const startSheetDrag = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (!window.matchMedia('(max-width: 700px)').matches) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId, startY: event.clientY, startHeight: currentHeight,
      lastY: event.clientY, lastAt: event.timeStamp, velocity: 0, moved: false,
    };
  };

  const moveSheet = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const elapsed = Math.max(1, event.timeStamp - state.lastAt);
    state.velocity = (state.lastY - event.clientY) / elapsed;
    state.lastY = event.clientY; state.lastAt = event.timeStamp;
    const next = Math.max(heights.collapsed, Math.min(heights.expanded, state.startHeight + state.startY - event.clientY));
    if (Math.abs(event.clientY - state.startY) > 5) state.moved = true;
    setDragHeight(next);
  };

  const finishSheetDrag = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    let target = nearestSnap(dragHeight ?? state.startHeight, heights);
    if (Math.abs(state.velocity) > 0.45) {
      const currentIndex = SNAP_ORDER.indexOf(target);
      target = SNAP_ORDER[Math.max(0, Math.min(SNAP_ORDER.length - 1, currentIndex + (state.velocity > 0 ? 1 : -1)))]!;
    }
    setSheetSnap(target); setDragHeight(null);
    // Jätame ref'i klikini alles, et lohistamise järel sünteetiline click
    // ei liigutaks sheet'i kohe veel ühe astme võrra.
    window.setTimeout(() => { drag.current = null; }, 0);
  };

  const selectWaypoint = (point: RouteWaypoint): void => {
    props.onSelectWaypoint(point.id);
    props.onFocusWaypoint(point);
  };

  const startWaypointDrag = (event: ReactPointerEvent<HTMLButtonElement>, index: number): void => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    waypointDrag.current = { pointerId: event.pointerId, startIndex: index, currentIndex: index, original: [...props.route.waypoints] };
    props.onSelectWaypoint(props.route.waypoints[index]?.id ?? null);
  };

  const moveWaypointRow = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const state = waypointDrag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const list = waypointList.current;
    if (list) {
      const bounds = list.getBoundingClientRect();
      if (event.clientY < bounds.top + 36) list.scrollTop -= 14;
      else if (event.clientY > bounds.bottom - 36) list.scrollTop += 14;
    }
    const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-waypoint-index]');
    const targetIndex = Number(row?.dataset.waypointIndex);
    if (!Number.isInteger(targetIndex) || targetIndex === state.currentIndex || targetIndex < 0 || targetIndex >= props.route.waypoints.length) return;
    const next = [...props.route.waypoints];
    const [moved] = next.splice(state.currentIndex, 1);
    if (!moved) return;
    next.splice(targetIndex, 0, moved);
    state.currentIndex = targetIndex;
    props.onPreviewWaypoints(next);
  };

  const finishWaypointDrag = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const state = waypointDrag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    waypointDrag.current = null;
    if (state.currentIndex !== state.startIndex) props.onCommitReorder(state.original);
  };

  if (!props.open) return null;
  const setNumber = (key: 'speedKnots' | 'draughtM' | 'underKeelClearanceM' | 'fuelLitresPerHour', raw: string) => {
    const value = Number(raw); if (Number.isFinite(value)) props.onChange({ ...props.route, [key]: value, updatedAt: new Date().toISOString() });
  };
  const fmt = (iso: string) => new Date(iso).toLocaleString(lang === 'et' ? 'et-EE' : 'en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const distanceNm = routeDistanceNm(props.route.waypoints);
  const selectedIndex = props.route.waypoints.findIndex((point) => point.id === props.selectedWaypointId);
  const selectedWaypoint = selectedIndex >= 0 ? props.route.waypoints[selectedIndex]! : null;
  return (
    <aside
      className={`route-panel snap-${sheetSnap}${props.editing ? ' is-editing' : ''}${dragHeight !== null ? ' is-dragging' : ''}`}
      style={sheetStyle}
      aria-label={t('route.title')}
    >
      <header className="route-panel__header">
        <button
          type="button"
          className="route-panel__drag-zone"
          onPointerDown={startSheetDrag}
          onPointerMove={moveSheet}
          onPointerUp={finishSheetDrag}
          onPointerCancel={finishSheetDrag}
          onClick={cycleSheet}
          aria-label={t('route.resizePanel')}
        >
          <span className="route-panel__grip" aria-hidden="true" />
          <span className="route-panel__titles"><strong>{t('route.title')}</strong><small>{props.route.name}</small></span>
        </button>
        {!props.editing && props.route.waypoints.length >= 2 ? (
          <button
            type="button"
            className="route-panel__navigate primary"
            onClick={props.onNavigate}
            disabled={props.loading || !props.analysis}
            title={props.loading ? t('route.analysing') : t('route.navigate')}
          >
            <Play size={16} fill="currentColor" aria-hidden="true" /> {props.loading ? t('route.analysingShort') : t('route.navigate')}
          </button>
        ) : null}
        <button className="icon-btn" onClick={() => { if (props.editing) props.onCancelEdit(); props.onClose(); }} aria-label={t('action.close')}><X size={21} aria-hidden="true" /></button>
      </header>

      <div className="route-mobile-compact" aria-label={t('route.edit')}>
        <div className="route-mobile-compact__status">
          <strong>{selectedWaypoint ? t('route.selectedPoint', { n: selectedIndex + 1 }) : t('route.pointCount', { n: props.route.waypoints.length })}</strong>
          <span>{selectedWaypoint ? `${selectedWaypoint.lat.toFixed(4)}, ${selectedWaypoint.lon.toFixed(4)}` : `${distanceNm.toFixed(1)} NM`}</span>
        </div>
        {props.editing ? <>
          <button onClick={props.onUndo} disabled={!props.canUndo} aria-label={t('action.undo')}><Undo2 size={20} aria-hidden="true" /></button>
          <button onClick={props.onRedo} disabled={!props.canRedo} aria-label={t('action.redo')}><Redo2 size={20} aria-hidden="true" /></button>
          <button className="route-delete-button" onClick={() => { if (selectedWaypoint) props.onDeleteWaypoint(selectedWaypoint.id); }} disabled={!selectedWaypoint} aria-label={t('route.deletePoint')}><Trash2 className="route-trash-icon" size={22} aria-hidden="true" /></button>
        </> : props.analysis ? <span className="route-mobile-compact__summary">{(props.analysis.durationSeconds / 3600).toFixed(1)} h · {props.analysis.estimatedFuelLitres.toFixed(1)} l</span> : null}
        <button onClick={() => setSheetSnap('half')} aria-label={t('route.details')}><Settings2 size={20} aria-hidden="true" /></button>
        {props.editing ? <button className="primary" onClick={props.onFinishEdit} disabled={props.route.waypoints.length < 2} title={props.route.waypoints.length < 2 ? t('route.needTwoPoints') : undefined}>{t('action.done')}</button> : null}
      </div>

      <div className="route-panel__content">
      <div className="route-panel__toolbar">
        <button onClick={props.onNew}>{t('route.new')}</button>
        <select value={props.savedRoutes.some((r) => r.id === props.route.id) ? props.route.id : ''} onChange={(e) => { const found = props.savedRoutes.find((r) => r.id === e.target.value); if (found) props.onLoad(found); }} aria-label={t('route.saved')}>
          <option value="">{t('route.saved')}</option>{props.savedRoutes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        {props.savedRoutes.some((r) => r.id === props.route.id) ? <button className="danger-link" onClick={() => props.onDelete(props.route.id)}>{t('action.delete')}</button> : null}
      </div>
      <div className="route-form">
        <label>{t('route.name')}<input value={props.route.name} onChange={(e) => props.onChange({ ...props.route, name: e.target.value, updatedAt: new Date().toISOString() })} /></label>
        <label>{t('route.startTime')}<Suspense fallback={<input className="route-date-input" value={new Date(props.route.startTime).toLocaleString(lang === 'et' ? 'et-EE' : 'en-GB')} readOnly aria-busy="true" />}>
          <LocalizedDateTimePicker value={props.route.startTime} onChange={(startTime) => props.onChange({ ...props.route, startTime, updatedAt: new Date().toISOString() })} />
        </Suspense></label>
        <div className="route-form__grid">
          <label>{t('route.speed')}<input type="number" min="0.1" step="0.1" value={props.route.speedKnots} onChange={(e) => setNumber('speedKnots', e.target.value)} /></label>
          <label>{t('route.fuelRate')}<input type="number" min="0" step="0.1" value={props.route.fuelLitresPerHour} onChange={(e) => setNumber('fuelLitresPerHour', e.target.value)} /></label>
          <label>{t('route.draught')}<input type="number" min="0" step="0.1" value={props.route.draughtM} onChange={(e) => setNumber('draughtM', e.target.value)} /></label>
          <label>{t('route.clearance')}<input type="number" min="0" step="0.1" value={props.route.underKeelClearanceM} onChange={(e) => setNumber('underKeelClearanceM', e.target.value)} /></label>
        </div>
      </div>
      <div className="route-edit-actions">
        {props.editing ? <>
          <button onClick={props.onUndo} disabled={!props.canUndo} aria-label={t('action.undo')}><Undo2 size={20} aria-hidden="true" /></button><button onClick={props.onRedo} disabled={!props.canRedo} aria-label={t('action.redo')}><Redo2 size={20} aria-hidden="true" /></button>
          <button onClick={() => { if (selectedWaypoint) props.onDeleteWaypoint(selectedWaypoint.id); }} disabled={!selectedWaypoint}>{t('route.deletePoint')}</button>
          <button onClick={props.onUseLocation}>{t('route.useLocation')}</button>
          <button onClick={props.onCancelEdit}>{t('action.cancel')}</button><button className="primary" onClick={props.onFinishEdit} disabled={props.route.waypoints.length < 2} title={props.route.waypoints.length < 2 ? t('route.needTwoPoints') : undefined}>{t('action.done')}</button>
        </> : <button className="primary" onClick={props.onStartEdit}>{t('route.edit')}</button>}
      </div>
      {props.editing && props.route.waypoints.length < 2 ? <p className="route-status is-error">{t('route.needTwoPoints')}</p> : null}
      {props.editing ? <section className="route-waypoints" aria-labelledby="route-waypoints-title">
        <div className="route-waypoints__heading">
          <strong id="route-waypoints-title">{t('route.waypoints')}</strong>
          <span>{t('route.reorderHint')}</span>
        </div>
        <div className="route-waypoints__list" ref={waypointList}>
          {props.route.waypoints.map((point, index) => {
            const selected = point.id === props.selectedWaypointId;
            const role = index === 0 ? t('route.startPoint') : index === props.route.waypoints.length - 1 ? t('route.finishPoint') : t('route.waypoint', { n: index + 1 });
            const badge = index === 0 ? 'A' : index === props.route.waypoints.length - 1 ? 'B' : String(index + 1);
            return <div
              key={point.id}
              className={`route-waypoint-row${selected ? ' is-selected' : ''}`}
              data-waypoint-index={index}
              data-waypoint-id={point.id}
            >
              <button type="button" className="route-waypoint-row__main" onClick={() => selectWaypoint(point)} aria-pressed={selected}>
                <span className={`route-waypoint-row__badge is-${index === 0 ? 'start' : index === props.route.waypoints.length - 1 ? 'finish' : 'middle'}`}>{badge}</span>
                <span className="route-waypoint-row__text"><strong>{point.name || role}</strong><small>{point.lat.toFixed(5)}, {point.lon.toFixed(5)}</small></span>
              </button>
              <button type="button" className="route-waypoint-row__delete" onClick={() => props.onDeleteWaypoint(point.id)} aria-label={`${t('route.deletePoint')}: ${role}`}><Trash2 className="route-trash-icon" size={22} aria-hidden="true" /></button>
              <button
                type="button"
                className="route-waypoint-row__handle"
                onPointerDown={(event) => startWaypointDrag(event, index)}
                onPointerMove={moveWaypointRow}
                onPointerUp={finishWaypointDrag}
                onPointerCancel={finishWaypointDrag}
                onClick={(event) => event.stopPropagation()}
                aria-label={`${t('route.reorderPoint')}: ${role}`}
              ><GripVertical size={22} aria-hidden="true" /></button>
            </div>;
          })}
          {props.route.waypoints.length === 0 ? <p className="route-waypoints__empty">{t('route.noPoints')}</p> : null}
        </div>
      </section> : null}
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
      </section> : null}
      </div>
    </aside>
  );
}
