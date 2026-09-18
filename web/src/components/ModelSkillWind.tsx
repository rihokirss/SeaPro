import { useEffect, useRef, useState } from 'react';
import type { ModelSkillPoint, ModelSkillWindReport } from '@seapro/shared';
import { api } from '../lib/api';
import { useI18n } from '../i18n';
import { modelSkillColor } from './ModelSkillChart';

export function ModelSkillWind({ days, leadHours, points }: {
  days: 7 | 30 | 90; leadHours: 0 | 3 | 12 | 24 | 48; points: ModelSkillPoint[];
}) {
  const { t } = useI18n();
  const [point, setPoint] = useState('');
  const [report, setReport] = useState<ModelSkillWindReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [hidden, setHidden] = useState(new Set<string>());
  const [selected, setSelected] = useState(5);
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    if (!host.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(280, entry.contentRect.width));
    });
    observer.observe(host.current);
    return () => observer.disconnect();
  }, [report]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(false); setReport(null);
    api.modelSkillWind(days, leadHours, point || undefined, controller.signal)
      .then((next) => { if (!controller.signal.aborted) setReport(next); })
      .catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [days, leadHours, point]);

  const sources = report?.sources.filter((source) => !hidden.has(source.sourceId)) ?? [];
  const bins = report?.bins ?? [];
  const maxError = Math.max(1, Math.ceil(Math.max(0, ...bins.flatMap((bin) => bin.sources.filter((source) => !hidden.has(source.sourceId)).map((source) => source.mae)))));
  const maxSamples = Math.max(1, ...bins.map((bin) => bin.samples));
  const step = (width - 80) / 10;
  const x = (index: number) => 50 + index * step;
  const y = (mae: number) => 230 - mae / maxError * 200;
  const label = (bin: ModelSkillWindReport['bins'][number]) => bin.to === null ? `${bin.from}+` : `${bin.from}–${bin.to}`;
  const chosen = bins[selected];
  return <section className="model-skill-wind">
    <div className="model-skill-section-head"><div><h3>{t('modelSkill.wind.title')}</h3><p>{t('modelSkill.wind.hint')}</p></div></div>
    <label className="model-skill-wind__location">{t('modelSkill.point')}
      <select value={point} onChange={(event) => setPoint(event.target.value)}>
        <option value="">{t('modelSkill.wind.all')}</option>
        {points.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
    </label>
    {loading ? <div className="model-skill-state" role="status">{t('modelSkill.loading')}</div> : error ? <div role="alert">{t('modelSkill.error')}</div> : report ? <>
      <div className="model-skill-source-picker">
        {report.sources.map((source) => <label key={source.sourceId} style={{ '--source-color': modelSkillColor(source.sourceId) } as React.CSSProperties}>
          <input type="checkbox" checked={!hidden.has(source.sourceId)} onChange={() => setHidden((previous) => {
            const next = new Set(previous); if (next.has(source.sourceId)) next.delete(source.sourceId); else next.add(source.sourceId); return next;
          })} /><i />{source.label}
        </label>)}
      </div>
      {report.sources.length > 0 && sources.length === 0 ? <p>{t('modelSkill.selectModel')}</p> : null}
      {!bins.some((bin) => bin.samples > 0) ? <p>{t('modelSkill.wind.empty')}</p> : <>
        <div className="model-skill-wind__plot" ref={host}>
          <svg viewBox={`0 0 ${width} 325`} role="img" aria-label={t('modelSkill.wind.title')}>
            <text x="30" y="16" fill="currentColor">MAE · m/s</text>
            {[0, 1, 2, 3, 4].map((tick) => <g key={tick}>
              <line x1="40" x2={width - 12} y1={y(tick * maxError / 4)} y2={y(tick * maxError / 4)} stroke="currentColor" opacity="0.12" />
              <text x="32" y={y(tick * maxError / 4) + 4} textAnchor="end" fill="currentColor">{(tick * maxError / 4).toFixed(1)}</text>
            </g>)}
            <line x1={x(4.5)} x2={x(4.5)} y1="26" y2="286" stroke="currentColor" strokeDasharray="4 5" opacity="0.4" />
            <text x={x(4.5) + 5} y="24" fill="currentColor">10 m/s</text>
            <rect x={x(selected) - step / 2} y="30" width={step} height="258" fill="currentColor" opacity="0.05" />
            {sources.map((source) => {
              let path = ''; let connected = false;
              const dots = bins.map((bin, index) => {
                const value = bin.sources.find((item) => item.sourceId === source.sourceId);
                if (!value || bin.samples < 10) { connected = false; return null; }
                path += `${connected ? 'L' : 'M'}${x(index)},${y(value.mae)} `; connected = true;
                return <circle key={index} cx={x(index)} cy={y(value.mae)} r="3.5" fill={modelSkillColor(source.sourceId)} />;
              });
              return <g key={source.sourceId}><path d={path} fill="none" stroke={modelSkillColor(source.sourceId)} strokeWidth="2" />{dots}
                {bins.map((bin, index) => {
                  const value = bin.sources.find((item) => item.sourceId === source.sourceId);
                  return value && bin.samples < 10 ? <circle key={index} cx={x(index)} cy={y(value.mae)} r="4" fill="none" stroke={modelSkillColor(source.sourceId)} /> : null;
                })}
              </g>;
            })}
            {bins.map((bin, index) => <g key={bin.from}>
              <rect x={x(index) - step / 4} y={286 - bin.samples / maxSamples * 30} width={step / 2} height={bin.samples / maxSamples * 30} fill="currentColor" opacity="0.25" />
              {width >= 550 || index % 2 === 0 ? <text x={x(index)} y="303" textAnchor="middle" fill="currentColor">{label(bin)}</text> : null}
              <rect x={x(index) - step / 2} y="30" width={step} height="275" fill="transparent" onPointerMove={() => setSelected(index)} onClick={() => setSelected(index)} />
            </g>)}
            <text x={width / 2} y="323" textAnchor="middle" fill="currentColor">{t('modelSkill.wind.axis')}</text>
          </svg>
        </div>
        <p className="model-skill-wind__note">{t('modelSkill.wind.legend')}</p>
        <label className="model-skill-wind__location">{t('modelSkill.wind.range')}
          <select value={selected} onChange={(event) => setSelected(Number(event.target.value))}>{bins.map((bin, index) => <option key={bin.from} value={index}>{label(bin)} m/s</option>)}</select>
        </label>
        {chosen ? <div className="model-skill-wind__details" aria-live="polite">
          <p><strong>{label(chosen)} m/s</strong> · {chosen.samples} {t('modelSkill.samples')} · {chosen.stations} {t('modelSkill.stations')}{chosen.samples < 10 ? ` · ${t('modelSkill.insufficient')}` : ''}</p>
          <table><thead><tr><th>{t('modelSkill.models')}</th><th>MAE</th><th>{t('modelSkill.bias')}</th></tr></thead>
            <tbody>{sources.map((source) => {
              const value = chosen.sources.find((item) => item.sourceId === source.sourceId);
              return <tr key={source.sourceId}><td><i style={{ background: modelSkillColor(source.sourceId) }} />{source.label}</td><td>{value ? `${value.mae.toFixed(2)} m/s` : '—'}</td><td>{value ? `${value.bias > 0 ? '+' : ''}${value.bias.toFixed(2)} m/s` : '—'}</td></tr>;
            })}</tbody></table>
        </div> : null}
      </>}
      <p className="model-skill-wind__note">{t('modelSkill.wind.method')}</p>
    </> : null}
  </section>;
}
