import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useI18n } from '../i18n';
import {
  addHours,
  floorToHour,
  formatTime,
  hoursBetween,
  isSameLocalDay,
} from '../lib/time';

interface Props {
  value: Date;
  onChange(next: Date): void;
  pastHours?: number;
  futureHours?: number;
  /** Mudeli nimi ja viimane uuendus — usaldusinfo, nagu Windfinderil. */
  modelLabel?: string;
  updatedAt?: string | null;
}

/**
 * Ajaliugur.
 *
 * Ülemine rida = peene sammuga tunniliugur, alumine = päevasakid kiireks
 * hüppeks. See jaotus on Windfinderilt: päevad on see, mille järgi plaanid
 * ("laupäeval"), tunnid see, mille järgi otsustad ("kas hommikul või õhtul").
 * Ainult ühest neist ei piisa — pikk tunniliugur muudab "ülehomme" otsimise
 * täpsustööks.
 *
 * Eraldi −/+ tunninuppe ei ole: liugur ise on kiirem ja täpsem ning kaks
 * nuppu sõid ribalt laiust, mida liugur paremini ära kasutab. Täpne
 * tunnikaupa liikumine on alles klaviatuuril (nooled, Shift+nooled, Home).
 *
 * Ajarida on juba tervikuna laaditud, seega liuguri liigutamine ei tekita
 * ühtki võrgupäringut; ainult kaardiväli tõmmatakse valitud tunni kohta ja
 * seegi tuleb enamasti vahemälust.
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
  const index = Math.min(total, Math.max(0, hoursBetween(origin, value)));

  const step = useCallback(
    (delta: number) => {
      const next = Math.min(total, Math.max(0, index + delta));
      onChange(addHours(origin, next));
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

  const now = floorToHour();
  const isNow = value.getTime() === now.getTime();

  /** Päevasakid — üks nupp iga ööpäeva kohta liuguri ulatuses. */
  const days = useMemo(() => {
    const out: { key: string; label: string; index: number; isToday: boolean }[] = [];
    let cursor = new Date(origin);
    cursor.setHours(0, 0, 0, 0);

    for (let d = 0; d < 9; d++) {
      const dayStart = new Date(cursor);
      dayStart.setDate(cursor.getDate() + d);
      const offset = hoursBetween(origin, dayStart);
      if (offset > total) break;

      // Tänase puhul hüppa praegusele tunnile, mitte keskööle — kasutaja
      // tahab "täna" all näha praegust olukorda.
      const isToday = isSameLocalDay(dayStart, now);
      const targetIndex = isToday ? hoursBetween(origin, now) : Math.max(0, offset + 12);

      out.push({
        key: dayStart.toISOString(),
        label: isToday
          ? t('time.today')
          : dayStart.toLocaleDateString(lang === 'et' ? 'et-EE' : 'en-GB', {
              weekday: 'short',
              day: 'numeric',
            }),
        index: Math.min(total, Math.max(0, targetIndex)),
        isToday,
      });
    }
    return out;
  }, [origin, total, now, t, lang]);

  const activeDay = useMemo(() => {
    for (let i = days.length - 1; i >= 0; i--) {
      const dayDate = addHours(origin, days[i]!.index);
      if (isSameLocalDay(dayDate, value)) return days[i]!.key;
    }
    return null;
  }, [days, origin, value]);

  const trackRef = useRef<HTMLInputElement>(null);

  return (
    <div className="timebar" role="group" aria-label={t('time.selected')}>
      {/* Üks rida: näit vasakul, liugur keskel, usaldusinfo paremal. Kolme
          rea asemel üks — riba jääb madalaks, ilma et ükski puuteala kahaneks. */}
      <div className="timebar__top">
        <div className="timebar__readout">
          <span className="timebar__time">{formatTime(value, lang)}</span>
          {isNow ? <span className="timebar__badge">{t('time.now')}</span> : null}
        </div>

        <div className="timebar__track-wrap">
          <input
            ref={trackRef}
            className="timebar__track"
            type="range"
            min={0}
            max={total}
            step={1}
            value={index}
            onChange={(e) => onChange(addHours(origin, Number(e.target.value)))}
            aria-label={t('time.selected')}
            aria-valuetext={formatTime(value, lang)}
          />
          {/* Messingviip "praegu" kohal — püsiv orientiir liugurile. */}
          <span
            className="timebar__nowmark"
            style={{ left: `${(pastHours / total) * 100}%` }}
            aria-hidden="true"
          />
        </div>

        {modelLabel || updatedAt ? (
          <div className="timebar__meta">
            {modelLabel ? <span className="timebar__model">{modelLabel}</span> : null}
            {updatedAt ? (
              <span className="timebar__updated">
                {t('station.updated')} {formatTime(updatedAt, lang)}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="timebar__days">
        <button
          type="button"
          className={`timebar__day timebar__day--now${isNow ? ' is-active' : ''}`}
          onClick={() => onChange(floorToHour())}
          title={t('action.now')}
        >
          {t('action.now')}
        </button>
        {days.map((d) => (
          <button
            key={d.key}
            type="button"
            className={`timebar__day${activeDay === d.key && !isNow ? ' is-active' : ''}`}
            onClick={() => onChange(addHours(origin, d.index))}
          >
            {d.label}
          </button>
        ))}
      </div>
    </div>
  );
}
