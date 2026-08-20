import { useEffect, useRef } from 'react';
import type { ModelSkillSeriesSource } from '@seapro/shared';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { localeTag, type Lang } from '../i18n';

export type ModelSkillMetric = 'speed' | 'gust';

const COLORS = ['#2f7fd1', '#e07a3c', '#3faa72', '#a05ccc', '#c94f6d', '#5f9ea0'];
const SOURCE_IDS = ['open-meteo:best_match', 'open-meteo:metno_nordic', 'open-meteo:icon_eu', 'open-meteo:ecmwf_ifs025', 'open-meteo:gfs_seamless', 'windfinder'];
const AXIS_FONT = '500 11px Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

interface Props {
  sources: ModelSkillSeriesSource[];
  metric: ModelSkillMetric;
  lang: Lang;
  observationLabel: string;
  emptyLabel: string;
}

export function ModelSkillChart({ sources, metric, lang, observationLabel, emptyLabel }: Props) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    element.innerHTML = '';
    const usable = sources.filter((source) => source.entries.some((entry) => forecastValue(entry, metric) !== null));
    if (usable.length === 0) return;

    const times = [...new Set(usable.flatMap((source) => source.entries.map((entry) => new Date(entry.validAt).getTime() / 1000)))].sort((a, b) => a - b);
    const observed = new Map<number, number | null>();
    for (const source of usable) for (const entry of source.entries) {
      const time = new Date(entry.validAt).getTime() / 1000;
      if (!observed.has(time)) observed.set(time, observationValue(entry, metric));
    }
    const data: uPlot.AlignedData = [
      times,
      times.map((time) => observed.get(time) ?? null),
      ...usable.map((source) => {
        const values = new Map(source.entries.map((entry) => [new Date(entry.validAt).getTime() / 1000, forecastValue(entry, metric)]));
        return times.map((time) => values.get(time) ?? null);
      }),
    ];
    const axisColor = (): string => getComputedStyle(document.documentElement).getPropertyValue('--text-dim').trim() || '#668397';
    const singleTime = times.length === 1 ? times[0]! : null;
    const options: uPlot.Options = {
      width: element.clientWidth || 760,
      height: 300,
      scales: {
        x: {
          time: true,
          // Üksainus värske võrdlus ei tohi panna uPloti telge suvaliselt
          // kuude peale venitama. Näitame selle ümber selget 24 h akent.
          range: singleTime === null ? undefined : () => [singleTime - 12 * 3600, singleTime + 12 * 3600],
        },
      },
      axes: [
        {
          stroke: axisColor,
          font: AXIS_FONT,
          grid: { stroke: 'rgba(120,140,155,.16)' },
          values: (plot, splits) => {
            const scale = plot.scales.x;
            const span = (scale?.max ?? 0) - (scale?.min ?? 0);
            return splits.map((time) => {
              const date = new Date(time * 1000);
              return span <= 2 * 24 * 3600
                ? date.toLocaleTimeString(localeTag(lang), { hour: '2-digit', minute: '2-digit' })
                : date.toLocaleDateString(localeTag(lang), { day: 'numeric', month: 'short' });
            });
          },
        },
        { stroke: axisColor, font: AXIS_FONT, size: 48, grid: { stroke: 'rgba(120,140,155,.16)' }, label: 'm/s', labelSize: 12 },
      ],
      series: [
        { label: '' },
        { label: observationLabel, stroke: axisColor, width: 3, points: { show: true, size: 5 } },
        ...usable.map((source) => ({ label: source.label, stroke: modelSkillColor(source.sourceId), width: 2, spanGaps: false, points: { show: true, size: 4 } })),
      ],
      legend: { show: true, live: true },
      cursor: { drag: { x: true, y: false, setScale: true } },
    };
    const plot = new uPlot(options, data, element);
    const observer = new ResizeObserver(() => plot.setSize({ width: element.clientWidth || 760, height: 300 }));
    observer.observe(element);
    return () => { observer.disconnect(); plot.destroy(); };
  }, [lang, metric, observationLabel, sources]);

  if (sources.length === 0) return <div className="model-skill-chart is-empty">{emptyLabel}</div>;
  return <div className="model-skill-chart" ref={host} />;
}

export function modelSkillColor(sourceId: string): string {
  const index = SOURCE_IDS.indexOf(sourceId);
  return COLORS[(index < 0 ? 0 : index) % COLORS.length]!;
}

function forecastValue(entry: ModelSkillSeriesSource['entries'][number], metric: ModelSkillMetric): number | null {
  return metric === 'speed' ? entry.forecastWindSpeed : entry.forecastWindGust;
}

function observationValue(entry: ModelSkillSeriesSource['entries'][number], metric: ModelSkillMetric): number | null {
  return metric === 'speed' ? entry.observedWindSpeed : entry.observedWindGust;
}
