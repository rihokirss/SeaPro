import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useI18n } from '../i18n';
import { addHours, floorToHour, formatDay, formatTime, hoursBetween, isSameLocalDay } from '../lib/time';

interface Props {
  value: Date;
  onChange(next: Date): void;
  pastHours?: number;
  futureHours?: number;
  /** Mudeli nimi ja viimane uuendus — usaldusinfo, nagu Windfinderil. */
  modelLabel?: string;
  updatedAt?: string | null;
}

/** Tunnilaius, kui CSS-ist ei õnnestu lugeda (nt jsdom testis). */
const FALLBACK_HOUR_W = 13;

/**
 * Kui kaua pärast viimast kerimist loeme riba "kasutaja käes olevaks". Selle
 * aja jooksul ei kirjuta ükski väline muutus kerimiskohta üle — muidu tõmbaks
 * `value` -> `index` -> `scrollLeft` tagasiside hoo keset viset seisma.
 */
const SETTLE_MS = 220;

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/**
 * Ajalint.
 *
 * Lohistatav on RIBA ISE, mitte pöial: kellaajad ja päevad liiguvad fikseeritud
 * keskmärgi alt läbi, nagu häälestusskaala raadios. Varem oli siin natiivne
 * `input[type=range]` pluss eraldi päevasakkide rida ja sellel oli kolm häda:
 * 28 px pöial on märja käega paadis halb siht, päevasakid ei olnud rajaga
 * kohakuti (nad olid omaette nupud), ja pöidla geomeetria oli dubleeritud
 * CSS-i ja arvutatud nihke vahel. Lindil on kõik kolm korraga lahendatud —
 * puutesiht on kogu riba, päevad ON rajal, ja geomeetria on `index * hourW`.
 *
 * Kerimise teeb brauser ise (`overflow-x` + `scroll-snap`), mitte meie
 * pointer-matemaatika: nii tuleb hoog, puuteplaadi tugi ja naksamine täistunnile
 * tasuta ning ühelgi platvormil ei ole vaja seda järele teha.
 *
 * Ajarida on juba tervikuna laaditud, seega lindi liigutamine ei tekita ühtki
 * võrgupäringut; ainult kaardiväli tõmmatakse valitud tunni kohta ja seegi
 * tuleb enamasti vahemälust.
 */
export function TimeSlider({
  value,
  onChange,
  pastHours = 6,
  futureHours = 120,
  modelLabel,
  updatedAt,
}: Props) {
  const { t, lang } = useI18n();

  const origin = useMemo(() => addHours(floorToHour(), -pastHours), [pastHours]);
  const total = pastHours + futureHours;
  const index = clamp(hoursBetween(origin, value), 0, total);

  const step = useCallback(
    (delta: number) => {
      onChange(addHours(origin, clamp(index + delta, 0, total)));
    },
    [index, onChange, origin, total],
  );

  // Klaviatuur: nooled = ±1 h, Shift+nooled = ±6 h, Home = nüüd.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      if (e.key === 'ArrowRight') {
        step(e.shiftKey ? 6 : 1);
        e.preventDefault();
      } else if (e.key === 'ArrowLeft') {
        step(e.shiftKey ? -6 : -1);
        e.preventDefault();
      } else if (e.key === 'Home') {
        onChange(floorToHour());
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, onChange]);

  /**
   * `floorToHour()` annab iga renderi ajal UUE Date-objekti. Kuna lindi sisu
   * sõltub sellest useMemo kaudu, ehitataks see lohistamise ajal iga sammu
   * peale uuesti. Tund vahetub kord tunnis; siduda seda renderdusega pole vaja.
   */
  const now = useMemo(() => floorToHour(), [origin]);
  const isNow = value.getTime() === now.getTime();
  const nowIndex = clamp(hoursBetween(origin, now), 0, total);

  /**
   * Lindi lahtrid — üks iga tunni kohta.
   *
   * Sildistamise reegel: keskööl päeva nimi ja päevapiiri joon, iga kolmas
   * tund saab kellanumbri, ülejäänud ainult kriipsu. Tihedamalt ei mahu (13 px
   * lahter), hõredamalt kaob orientiir.
   */
  const cells = useMemo(() => {
    const out: {
      i: number;
      hour: number;
      time: string | null;
      day: string | null;
      night: boolean;
    }[] = [];
    for (let i = 0; i <= total; i++) {
      const d = addHours(origin, i);
      const hour = d.getHours();
      out.push({
        i,
        hour,
        time: hour % 3 === 0 ? String(hour).padStart(2, '0') : null,
        // Päevanimi tuleb keskööle; esimene lahter saab selle ka siis, kui
        // liugur algab keset päeva, muidu jääks riba algus nimetuks.
        day:
          hour === 0 || i === 0
            ? d.toLocaleDateString(lang === 'et' ? 'et-EE' : 'en-GB', {
                weekday: 'short',
                day: 'numeric',
              })
            : null,
        night: hour >= 21 || hour < 5,
      });
    }
    return out;
  }, [origin, total, lang]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const hourW = useRef(FALLBACK_HOUR_W);
  const indexRef = useRef(index);
  indexRef.current = index;
  const rafRef = useRef<number | null>(null);
  const lastScrollAt = useRef(0);

  /** Tunnilaius tuleb CSS-ist, sest see muutub meediapäringuga. */
  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const raw = parseFloat(getComputedStyle(el).getPropertyValue('--hour-w'));
    if (Number.isFinite(raw) && raw > 0) hourW.current = raw;
  }, []);

  /**
   * Kerimiskoht <-> indeks.
   *
   * Lindi ees ja taga on 50% laiused vahetükid, seega lahtri `i` kese satub
   * konteineri keskele täpselt siis, kui `scrollLeft = (i + 0.5) * hourW`.
   * Sellepärast on siin see pool tundi — see EI ole nihkeparandus, vaid
   * lahtri enda kese.
   */
  const scrollToIndex = useCallback((i: number) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = (i + 0.5) * hourW.current;
  }, []);

  const indexFromScroll = useCallback((): number => {
    const el = scrollRef.current;
    if (!el) return indexRef.current;
    return clamp(Math.round(el.scrollLeft / hourW.current - 0.5), 0, total);
  }, [total]);

  useLayoutEffect(() => {
    measure();
    scrollToIndex(indexRef.current);
    const onResize = (): void => {
      measure();
      scrollToIndex(indexRef.current);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [measure, scrollToIndex]);

  /**
   * Väljastpoolt tulnud aeg (NÜÜD-nupp, graafikult valik, lemmiku avamine)
   * kerib lindi kohale. Lipuga "ära kuula oma kirjutust" siin EI OLE vaja:
   * programmiline kerimine maandub täpselt sellel indeksil, mille peale me
   * niikuinii ei reageeriks. Küll on vaja kasutaja hoogu mitte katkestada —
   * seda hoiab SETTLE_MS.
   */
  useEffect(() => {
    if (performance.now() - lastScrollAt.current < SETTLE_MS) return;
    if (indexFromScroll() === index) return;
    scrollToIndex(index);
  }, [index, indexFromScroll, scrollToIndex]);

  const handleScroll = useCallback(() => {
    lastScrollAt.current = performance.now();
    if (rafRef.current !== null) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      const next = indexFromScroll();
      if (next !== indexRef.current) onChange(addHours(origin, next));
    });
  }, [indexFromScroll, onChange, origin]);

  useEffect(() => () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
  }, []);

  /**
   * Hiirega lohistamine.
   *
   * Puutel keriks brauser riba ise — sealt tuleb ka hoog. Hiirega EI keri:
   * hiirelohistus ei ole kerimisalal midagi, see valiks teksti. Nii et
   * puutepoole jätame brauserile ja hiire jaoks teeme lohistuse ise.
   */
  const drag = useRef<{ id: number; x: number; left: number } | null>(null);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse') return;
    const el = scrollRef.current;
    if (!el) return;
    drag.current = { id: e.pointerId, x: e.clientX, left: el.scrollLeft };
    el.setPointerCapture(e.pointerId);
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const el = scrollRef.current;
    if (!d || !el || d.id !== e.pointerId) return;
    el.scrollLeft = d.left - (e.clientX - d.x);
  }, []);

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      drag.current = null;
      scrollRef.current?.releasePointerCapture(e.pointerId);
      // Naksamine on scroll-snapi töö, aga see ei käivitu programmilise
      // kerimise järel igal platvormil — teeme selle ise ära.
      scrollToIndex(indexFromScroll());
    },
    [indexFromScroll, scrollToIndex],
  );

  /** Lauaarvutil on ratas püstine; ilma selleta ei teeks see ribal midagi. */
  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!el) return;
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (delta === 0) return;
    el.scrollLeft += delta;
  }, []);

  return (
    <div className="timebar" role="group" aria-label={t('time.selected')}>
      <div className="timebar__row">
        <div className="timebar__readout timebar__pod">
          <span className="timebar__time">{formatTime(value, lang)}</span>
          {/* Kuupäev oli varem päevasakkides. Sakke enam ei ole, seega peab
              näit ise ütlema, MIS päeva kell see on — muidu peaks kasutaja
              selle lindilt kokku lugema. */}
          <span className="timebar__date">{formatDay(value, lang)}</span>
        </div>

        <button
          type="button"
          className={`timebar__now timebar__pod${isNow ? ' is-active' : ''}`}
          onClick={() => onChange(floorToHour())}
          title={t('action.now')}
        >
          {t('action.now')}
        </button>

        {modelLabel || updatedAt ? (
          <div className="timebar__meta timebar__pod">
            {modelLabel ? <span className="timebar__model">{modelLabel}</span> : null}
            {updatedAt ? (
              <span className="timebar__updated">
                {t('station.updated')} {formatTime(updatedAt, lang)}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="timebar__ruler timebar__pod">
        <div
          className="timebar__scroll"
          ref={scrollRef}
          onScroll={handleScroll}
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          role="slider"
          tabIndex={0}
          aria-label={t('time.selected')}
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={index}
          aria-valuetext={`${formatDay(value, lang)} ${formatTime(value, lang)}`}
        >
          {/* Vahetükid, mitte polster: protsentpolster kerimiskonteineri
              lõpus jääb osal brauseritel arvestamata ja viimane tund ei
              jõuaks enam keskele. */}
          <div className="timebar__pad timebar__pad--start" aria-hidden="true" />
          {cells.map((c) => (
            <div
              key={c.i}
              className={
                'timebar__hour' +
                (c.day ? ' is-daystart' : '') +
                (c.night ? ' is-night' : '') +
                (c.i === nowIndex ? ' is-now' : '')
              }
            >
              {c.day ? <span className="timebar__daylabel">{c.day}</span> : null}
              {c.time ? <span className="timebar__hourlabel">{c.time}</span> : null}
            </div>
          ))}
          <div className="timebar__pad timebar__pad--end" aria-hidden="true" />
        </div>

        {/* Keskmärk seisab paigal, lint liigub. Ei püüa hiirt, muidu jääks ta
            lohistamise ette. */}
        <span className="timebar__needle" aria-hidden="true" />
      </div>
    </div>
  );
}
