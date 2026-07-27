import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { TimeSeries, Variable } from '@seapro/shared';
import { convertSpeed } from '@seapro/shared';
import { useI18n } from '../i18n';
import { unitLabel, type SpeedUnit } from '../lib/units';
import { formatDay } from '../lib/time';

interface Props {
  series: TimeSeries[];
  variable: Variable;
  speedUnit: SpeedUnit;
  /** Vertikaaljoon valitud ajahetkel. */
  selectedTime: Date;
  onPickTime?(time: Date): void;
}

/**
 * Kui pikk aken graafikul korraga näha on.
 *
 * Terve viiepäevane prognoos ühel teljel surub tunnid nii kokku, et päevasest
 * käigust (hommikune vaikus, pärastlõunane tugevnemine) ei saa enam aru —
 * just see aga otsustab, kas välja minna. Aken katab valitud ööpäeva pluss
 * servad, ja nooltega liigutakse päev kaupa edasi.
 */
const WINDOW_LEAD_HOURS = 3;
const WINDOW_HOURS = 33;

/** Iga allikas saab oma püsiva värvi, et graafik ja legend kokku langeksid. */
const SERIES_COLORS = ['#2f7fd1', '#e07a3c', '#3faa72', '#a05ccc', '#c94f6d', '#5f9ea0'];

const SPEED_VARS = new Set<Variable>(['wind_speed', 'wind_gust', 'current_speed']);

export function ForecastChart({ series, variable, speedUnit, selectedTime, onPickTime }: Props) {
  // Aken liigub PÄEVA, mitte tunni kaupa — tunni kaupa uuesti ehitamine
  // tähendaks graafiku vilkumist iga liuguri sammu peale.
  const dayKey = new Date(selectedTime).setHours(0, 0, 0, 0);
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

    // Aken algab valitud päeva algusest (kohalikus ajas), veidi varem.
    const dayStart = new Date(selectedTimeRef.current);
    dayStart.setHours(0, 0, 0, 0);
    const winStart = dayStart.getTime() / 1000 - WINDOW_LEAD_HOURS * 3600;
    const winEnd = winStart + WINDOW_HOURS * 3600;

    const opts: uPlot.Options = {
      width: el.clientWidth || 600,
      height: 190,
      // Mereilmas on huvi väärtuse kulgemises, mitte nullist alguses.
      scales: {
        x: {
          time: true,
          // Fikseeritud aken, mitte kogu andmehulk — vt WINDOW_HOURS.
          range: () => [winStart, winEnd] as [number, number],
        },
      },
      axes: [
        {
          grid: { show: true, stroke: 'rgba(120,140,155,0.18)' },
          stroke: 'currentColor',
          // Mitmepäevasel teljel langevad kõik jaotused keskööle ja "00:00"
          // kordus ei ütle midagi — seal näitame kuupäeva, muidu kellaaega.
          values: (_u, splits) =>
            splits.map((v) => {
              const d = new Date(v * 1000);
              const locale = lang === 'et' ? 'et-EE' : 'en-GB';
              if (d.getHours() === 0 && d.getMinutes() === 0) {
                return d.toLocaleDateString(locale, { weekday: 'short', day: 'numeric' });
              }
              return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
            }),
        },
        {
          grid: { show: true, stroke: 'rgba(120,140,155,0.18)' },
          stroke: 'currentColor',
          size: 44,
        },
      ],
      series: [
        { label: t('chart.time') },
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
      plugins: [
        dayGridPlugin(),
        selectedTimePlugin(() => selectedTimeRef.current),
        legendFollowsSelectionPlugin(times, () => selectedTimeRef.current),
      ],
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, variable, speedUnit, lang, t, dayKey]);

  // Valitud aeg muutub tihti (liuguri lohistamine) — hoiame seda ref'is, et
  // graafikut ei ehitataks iga liuguri sammu peale uuesti.
  const selectedTimeRef = useRef(selectedTime);
  selectedTimeRef.current = selectedTime;
  useEffect(() => {
    plot.current?.redraw(false, false);
  }, [selectedTime]);

  const shiftDay = (days: number): void => {
    if (!onPickTime) return;
    onPickTime(new Date(selectedTime.getTime() + days * 24 * 3600_000));
  };

  return (
    <div className="forecast-chart">
      <div ref={host} className="forecast-chart__plot" />
      {onPickTime ? (
        <div className="forecast-chart__nav">
          <button type="button" onClick={() => shiftDay(-1)} aria-label={t('chart.prevDay')}>
            ‹
          </button>
          <span>{formatDay(selectedTime, lang)}</span>
          <button type="button" onClick={() => shiftDay(1)} aria-label={t('chart.nextDay')}>
            ›
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Legend näitab kursorita valitud hetke väärtusi.
 *
 * uPlot'i vaikimisi käitumine on, et kursori lahkumisel jääb legendi viimane
 * andmepunkt — ehk viie päeva pärast olev tuul. See on eksitav: kasutaja
 * vaatab legendi selleks, et näha, mis on VALITUD ajal, ja see aeg on
 * graafikul juba messingtähisega märgitud. Nüüd langevad tähis ja legend
 * kokku ka siis, kui hiirt graafikul pole.
 */
function legendFollowsSelectionPlugin(times: number[], getTime: () => Date): uPlot.Plugin {
  const indexFor = (): number => {
    const target = getTime().getTime() / 1000;
    let best = -1;
    let bestDiff = Infinity;
    for (let i = 0; i < times.length; i++) {
      const diff = Math.abs(times[i]! - target);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = i;
      }
    }
    return best;
  };

  const apply = (u: uPlot): void => {
    // Ainult siis, kui kursorit POLE — muidu võtaksime hiire alt info ära.
    if (u.cursor.idx != null) return;
    const idx = indexFor();
    if (idx >= 0) u.setLegend({ idx }, false);
  };

  return {
    hooks: {
      ready: [apply],
      setCursor: [apply],
      setScale: [apply],
      draw: [apply],
    },
  };
}

/**
 * Ööpäevade piirid vertikaalsete joontena.
 *
 * uPlot'i tavaline ruudustik järgib telje jaotusi, mis mitmepäevasel aknal
 * satuvad suvalistele tundidele. Keskööd on aga see, mille järgi prognoosi
 * loetakse ("homme hommikul"), seega joonistame need eraldi ja selgemalt.
 */
function dayGridPlugin(): uPlot.Plugin {
  return {
    hooks: {
      draw: (u) => {
        const [min, max] = u.scales.x!.min !== undefined && u.scales.x!.max !== undefined
          ? [u.scales.x!.min!, u.scales.x!.max!]
          : [0, 0];
        if (!min || !max) return;

        const ctx = u.ctx;
        ctx.save();
        ctx.strokeStyle = 'rgba(120,140,155,0.45)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);

        // Alusta esimesest keskööst akna sees ja liigu ööpäeva kaupa.
        const first = new Date(min * 1000);
        first.setHours(24, 0, 0, 0);

        for (let d = new Date(first); d.getTime() / 1000 <= max; d.setDate(d.getDate() + 1)) {
          const x = u.valToPos(d.getTime() / 1000, 'x', true);
          if (!Number.isFinite(x)) continue;
          ctx.beginPath();
          ctx.moveTo(x, u.bbox.top);
          ctx.lineTo(x, u.bbox.top + u.bbox.height);
          ctx.stroke();
        }
        ctx.restore();
      },
    },
  };
}

/**
 * Valitud ajahetke tähis.
 *
 * Varem oli see punakas joon, mis langes kokku andmeseeriate värvidega ja
 * kadus nende sekka ära. Nüüd on ta SELGELT teisest keelest: messingkollane,
 * katkendlik, kolmnurkse peaga ülal — see ei ole andmerida, vaid kursor, ja
 * peab ka nii välja nägema.
 */
function selectedTimePlugin(getTime: () => Date): uPlot.Plugin {
  return {
    hooks: {
      draw: (u) => {
        const ts = getTime().getTime() / 1000;
        const x = u.valToPos(ts, 'x', true);
        if (!Number.isFinite(x)) return;

        const top = u.bbox.top;
        const bottom = u.bbox.top + u.bbox.height;
        const ctx = u.ctx;

        ctx.save();

        // Katkendlik vars.
        ctx.strokeStyle = 'rgba(224, 169, 79, 0.95)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(x, top + 6);
        ctx.lineTo(x, bottom);
        ctx.stroke();

        // Kolmnurkne pea — annab tähisele suuna ja eristab ta ruudustikust.
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(224, 169, 79, 1)';
        ctx.beginPath();
        ctx.moveTo(x, top + 7);
        ctx.lineTo(x - 5, top);
        ctx.lineTo(x + 5, top);
        ctx.closePath();
        ctx.fill();

        ctx.restore();
      },
    },
  };
}
