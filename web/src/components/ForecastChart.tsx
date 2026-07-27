import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { TimeSeries, Variable } from '@seapro/shared';
import { convertSpeed } from '@seapro/shared';
import { useI18n } from '../i18n';
import { unitLabel, type SpeedUnit } from '../lib/units';

interface Props {
  series: TimeSeries[];
  variable: Variable;
  speedUnit: SpeedUnit;
  /** Vertikaaljoon valitud ajahetkel. */
  selectedTime: Date;
  onPickTime?(time: Date): void;
}

/** Iga allikas saab oma püsiva värvi, et graafik ja legend kokku langeksid. */
const SERIES_COLORS = ['#2f7fd1', '#e07a3c', '#3faa72', '#a05ccc', '#c94f6d', '#5f9ea0'];

const SPEED_VARS = new Set<Variable>(['wind_speed', 'wind_gust', 'current_speed']);

export function ForecastChart({ series, variable, speedUnit, selectedTime, onPickTime }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const onPick = useRef(onPickTime);
  onPick.current = onPickTime;
  const { t, lang } = useI18n();

  useEffect(() => {
    const el = host.current;
    if (!el) return;

    const usable = series.filter((s) => s.steps.some((st) => st.values[variable] != null));
    if (usable.length === 0) {
      plot.current?.destroy();
      plot.current = null;
      el.innerHTML = '';
      return;
    }

    // Ühine ajatelg: kõik allikad ei anna samu tunde, seega liidame need kokku.
    const timeSet = new Set<number>();
    for (const s of usable) {
      for (const st of s.steps) timeSet.add(new Date(st.time).getTime() / 1000);
    }
    const times = [...timeSet].sort((a, b) => a - b);

    const convert = (v: number): number =>
      SPEED_VARS.has(variable) ? convertSpeed(v, speedUnit) : v;

    const data: uPlot.AlignedData = [
      times,
      ...usable.map((s) => {
        const byTime = new Map<number, number | null>();
        for (const st of s.steps) {
          const raw = st.values[variable];
          byTime.set(new Date(st.time).getTime() / 1000, raw == null ? null : convert(raw));
        }
        return times.map((tv) => byTime.get(tv) ?? null);
      }),
    ];

    const label = `${t(`var.${variable}`)} (${unitLabel(variable, speedUnit)})`;

    const opts: uPlot.Options = {
      width: el.clientWidth || 600,
      height: 190,
      // Mereilmas on huvi väärtuse kulgemises, mitte nullist alguses.
      scales: { x: { time: true } },
      axes: [
        {
          grid: { show: true, stroke: 'rgba(120,140,155,0.18)' },
          stroke: 'currentColor',
          values: (_u, splits) =>
            splits.map((v) =>
              new Date(v * 1000).toLocaleTimeString(lang === 'et' ? 'et-EE' : 'en-GB', {
                hour: '2-digit',
                minute: '2-digit',
              }),
            ),
        },
        {
          grid: { show: true, stroke: 'rgba(120,140,155,0.18)' },
          stroke: 'currentColor',
          size: 44,
        },
      ],
      series: [
        { label: 'aeg' },
        ...usable.map((s, i) => ({
          label: s.modelId && s.modelId !== 'best_match' ? `${s.providerId} · ${s.modelId}` : s.providerId,
          stroke: SERIES_COLORS[i % SERIES_COLORS.length]!,
          width: 2,
          // Katkendlikud read (puuduvad tunnid) jäävad katki, mitte ei valeta
          // sirge joonega üle augu.
          spanGaps: false,
          points: { show: false },
        })),
      ],
      legend: { show: true, live: true },
      cursor: {
        drag: { x: false, y: false },
        focus: { prox: 24 },
      },
      hooks: {
        setCursor: [
          (u) => {
            if (!onPick.current || u.cursor.idx == null) return;
          },
        ],
        ready: [
          (u) => {
            u.over.addEventListener('click', () => {
              const idx = u.cursor.idx;
              if (idx == null || !onPick.current) return;
              const tv = times[idx];
              if (tv !== undefined) onPick.current(new Date(tv * 1000));
            });
          },
        ],
      },
      plugins: [selectedTimePlugin(() => selectedTimeRef.current)],
      title: label,
    };

    plot.current?.destroy();
    el.innerHTML = '';
    plot.current = new uPlot(opts, data, el);

    const observer = new ResizeObserver(() => {
      plot.current?.setSize({ width: el.clientWidth, height: 190 });
    });
    observer.observe(el);

    return () => {
      observer.disconnect();
      plot.current?.destroy();
      plot.current = null;
    };
  }, [series, variable, speedUnit, lang, t]);

  // Valitud aeg muutub tihti (liuguri lohistamine) — hoiame seda ref'is, et
  // graafikut ei ehitataks iga liuguri sammu peale uuesti.
  const selectedTimeRef = useRef(selectedTime);
  selectedTimeRef.current = selectedTime;
  useEffect(() => {
    plot.current?.redraw(false, false);
  }, [selectedTime]);

  return <div ref={host} className="forecast-chart" />;
}

/** Joonistab vertikaalse joone valitud ajahetkele. */
function selectedTimePlugin(getTime: () => Date): uPlot.Plugin {
  return {
    hooks: {
      draw: (u) => {
        const ts = getTime().getTime() / 1000;
        const x = u.valToPos(ts, 'x', true);
        if (!Number.isFinite(x)) return;
        const ctx = u.ctx;
        ctx.save();
        ctx.strokeStyle = 'rgba(230,90,60,0.9)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, u.bbox.top);
        ctx.lineTo(x, u.bbox.top + u.bbox.height);
        ctx.stroke();
        ctx.restore();
      },
    },
  };
}
