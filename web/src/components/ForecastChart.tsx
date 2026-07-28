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

/**
 * Kui pikk aken graafikul korraga näha on.
 *
 * Terve viiepäevane prognoos ühel teljel surub tunnid nii kokku, et päevasest
 * käigust (hommikune vaikus, pärastlõunane tugevnemine) ei saa enam aru —
 * just see aga otsustab, kas välja minna.
 *
 * Aken algab valitud hetkest veidi VARASEMALT ja ulatub kaks ööpäeva ette:
 * minevik on kontekst, tulevik on see, mida vaadatakse. Seetõttu istub
 * "praegu" vasakus servas, mitte keskel.
 *
 * Kaugemale liigutakse LOHISTAMISEGA, mitte nuppudega — kaardirakenduses on
 * lohistamine niikuinii peamine žest ja nupud nõuaksid täpset sihtimist.
 */
const WINDOW_LEAD_HOURS = 4;
const WINDOW_HOURS = 48;

/** Iga allikas saab oma püsiva värvi, et graafik ja legend kokku langeksid. */
const SERIES_COLORS = ['#2f7fd1', '#e07a3c', '#3faa72', '#a05ccc', '#c94f6d', '#5f9ea0'];

const SPEED_VARS = new Set<Variable>(['wind_speed', 'wind_gust', 'current_speed']);

/**
 * Telgede font. uPlot joonistab teljed canvas'ele, seega CSS neid ei puuduta
 * ja font tuleb siin sõnaselgelt öelda — vaikimisi oleks see brauseri
 * canvas-font, mis ei sobi ülejäänud liidesega kokku.
 */
const AXIS_FONT = '500 11px Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/**
 * Telgede kirjavärv.
 *
 * uPlot joonistab teljed canvas'ele ja canvas EI TUNNE `currentColor`-it —
 * kehtetu väärtus jäetakse vaikselt vahele ja alles jääb canvas'e vaikimisi
 * must. Heledas režiimis polnud seda näha, tumedas jäid teljekirjad mustad
 * tumeda tausta peal ehk sisuliselt loetamatud.
 *
 * Funktsioonina antud värv arvutatakse iga joonistuse ajal uuesti, seega
 * järgib telg ka režiimivahetust — vt `matchMedia` kuulaja allpool.
 */
function axisColor(): string {
  const css = getComputedStyle(document.documentElement).getPropertyValue('--text-dim').trim();
  return css || '#9dbdd0';
}

export function ForecastChart({ series, variable, speedUnit, selectedTime, onPickTime }: Props) {
  // Aken liigub PÄEVA, mitte tunni kaupa — tunni kaupa uuesti ehitamine
  // tähendaks graafiku vilkumist iga liuguri sammu peale.
  const dayKey = new Date(selectedTime).setHours(0, 0, 0, 0);
  const host = useRef<HTMLDivElement>(null);
  /** Nähtav ajaaken. Ref, mitte state — lohistamine peab olema kaadrisünkroonne. */
  const win = useRef({ start: 0, span: WINDOW_HOURS * 3600, dataMin: 0, dataMax: 0 });
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

    // Aken algab valitud hetkest veidi varem; "praegu" jääb vasakusse serva.
    const anchor = Math.floor(selectedTimeRef.current.getTime() / 1000 / 3600) * 3600;
    const dataMin = times[0]!;
    const dataMax = times[times.length - 1]!;
    const span = WINDOW_HOURS * 3600;

    const clamp = (start: number): number =>
      Math.min(Math.max(start, dataMin), Math.max(dataMin, dataMax - span));

    win.current = { start: clamp(anchor - WINDOW_LEAD_HOURS * 3600), span, dataMin, dataMax };

    const opts: uPlot.Options = {
      width: el.clientWidth || 600,
      height: 190,
      // Mereilmas on huvi väärtuse kulgemises, mitte nullist alguses.
      scales: {
        x: {
          time: true,
          // Fikseeritud, lohistatav aken — vt WINDOW_HOURS ja pan-käsitlejat.
          range: () => [win.current.start, win.current.start + win.current.span] as [number, number],
        },
      },
      axes: [
        {
          grid: { show: true, stroke: 'rgba(120,140,155,0.18)' },
          stroke: () => axisColor(),
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
          font: AXIS_FONT,
        },
        {
          grid: { show: true, stroke: 'rgba(120,140,155,0.18)' },
          stroke: () => axisColor(),
          size: 44,
          font: AXIS_FONT,
        },
      ],
      series: [
        {
          label: t('chart.time'),
          // uPlot'i vaikimisi ajavorming on masinlik ("2026-07-31 6:00am").
          // Legendi esimene rida on täislaiuses (vt CSS), seega mahub siia
          // inimlik kuju: nädalapäev, kuupäev ja kellaaeg kohalikus vormingus.
          value: (_u, raw) =>
            raw == null
              ? '—'
              : new Date(raw * 1000).toLocaleString(lang === 'et' ? 'et-EE' : 'en-GB', {
                  weekday: 'short',
                  day: 'numeric',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                }),
        },
        ...usable.map((s, i) => {
          const samples = s.steps.filter((st) => st.values[variable] != null).length;
          /**
           * Punkte näitame AINULT siis, kui allikal on nii vähe mõõtmisi, et
           * joont ei tekigi — üks vaatlus (METOC, Ilmateenistus) jääks muidu
           * täiesti nähtamatuks.
           *
           * Igal pool mujal on nad ainult müra: jämedama sammuga allikad
           * (Windfinder, 3 h) joonistuvad `spanGaps` tõttu niikuinii ja
           * punktid tegid graafiku kirjuks.
           */
          const needsPoints = samples <= 2;

          return {
            label:
              s.modelId && s.modelId !== 'best_match'
                ? `${s.providerId} · ${s.modelId}`
                : s.providerId,
            stroke: SERIES_COLORS[i % SERIES_COLORS.length]!,
            width: 2,
            /**
             * Ühendame allika enda järjestikused mõõtmised.
             *
             * Varem oli siin `spanGaps: false` mõttega, et katkine rida ei
             * tohi sirge joonega üle augu valetada. Ühise ajateljega koos
             * tähendas see aga, et IGA jämedama sammuga allikas kadus täiesti
             * ära: Windfinder annab väärtuse iga 3 tunni tagant, seega kaks
             * kolmandikku telje punktidest olid tal null ja ühtki lõiku ei
             * joonistatud. METOC-il on üks vaatlus ja see jäi nähtamatuks
             * punktiks. Allika oma samm EI OLE auk, ja punktid näitavad,
             * kus tegelikud mõõtmised on.
             */
            spanGaps: true,
            points: { show: needsPoints, size: 8 },
          };
        }),
      ],
      legend: { show: true, live: true },
      cursor: {
        drag: { x: false, y: false },
        /**
         * `focus: { prox }` on SIHILIKULT välja jäetud.
         *
         * uPlot tuhmistab selle peale kõik seeriad peale lähima ja teeb sama
         * legendis. Mitme allika võrdlemise juures töötab see eesmärgi vastu:
         * graafik on siin just selleks, et mudeleid KÕRVUTI näha, ja hiire
         * väikseimgi liigutus vahetas, milline neist parajasti nähtav on.
         * Kursorijoon ja legendi väärtused ütlevad niikuinii, millisel ajal
         * ollakse — seeriate vilgutamine ei lisa sellele midagi.
         */
      },
      hooks: {
        setCursor: [
          (u) => {
            if (!onPick.current || u.cursor.idx == null) return;
          },
        ],
        ready: [
          (u) => {
            // Klõps valib aja — aga ainult siis, kui see polnud lohistamine.
            let downX: number | null = null;
            let dragged = false;

            u.over.addEventListener('click', () => {
              if (dragged) return;
              const idx = u.cursor.idx;
              if (idx == null || !onPick.current) return;
              const tv = times[idx];
              if (tv !== undefined) onPick.current(new Date(tv * 1000));
            });

            // --- Lohistamine ajas ---
            const onDown = (e: PointerEvent): void => {
              downX = e.clientX;
              dragged = false;
              u.over.setPointerCapture(e.pointerId);
              u.over.style.cursor = 'grabbing';
            };

            const onMove = (e: PointerEvent): void => {
              if (downX === null) return;
              const dx = e.clientX - downX;
              if (Math.abs(dx) > 3) dragged = true;
              downX = e.clientX;

              // Piksel -> sekund praeguse akna mastaabis.
              const secPerPx = win.current.span / u.bbox.width * devicePixelRatio;
              const next = win.current.start - dx * secPerPx;

              // Ära lase aknal andmetest välja libiseda.
              const maxStart = Math.max(win.current.dataMin, win.current.dataMax - win.current.span);
              win.current.start = Math.min(Math.max(next, win.current.dataMin), maxStart);

              u.setScale('x', {
                min: win.current.start,
                max: win.current.start + win.current.span,
              });
            };

            const onUp = (e: PointerEvent): void => {
              downX = null;
              u.over.style.cursor = 'grab';
              if (u.over.hasPointerCapture(e.pointerId)) u.over.releasePointerCapture(e.pointerId);
            };

            u.over.style.cursor = 'grab';
            u.over.style.touchAction = 'pan-y';
            u.over.addEventListener('pointerdown', onDown);
            u.over.addEventListener('pointermove', onMove);
            u.over.addEventListener('pointerup', onUp);
            u.over.addEventListener('pointercancel', onUp);
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

    // Teemavahetus muudab CSS-muutujaid, aga canvas jääb selliseks, nagu ta
    // joonistati — ilma selleta jääks graafik vahetuse hetkel eelmise teema
    // värvidesse kuni järgmise uuesti ehitamiseni.
    //
    // Kuulame `data-theme` atribuuti, mitte `prefers-color-scheme`-i: seadme
    // valik on ainult ÜKS teemamuutuse põhjus ja seadetes tehtud käsitsi
    // vahetus ei puuduta meediapäringut üldse.
    const themeWatch = new MutationObserver(() => {
      plot.current?.redraw(false, false);
    });
    themeWatch.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    return () => {
      observer.disconnect();
      themeWatch.disconnect();
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

  return (
    <div className="forecast-chart">
      <div ref={host} className="forecast-chart__plot" />
      <p className="forecast-chart__hint">{t('chart.dragHint')}</p>
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
