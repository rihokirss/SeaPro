import { LocalizedDateTimePicker } from './LocalizedDateTimePicker';
import { useEffect, useState } from 'react';
import { Star, X, Crosshair, Route } from 'lucide-react';
import { localeTag, useI18n } from '../i18n';
import type { useVesselTracking } from '../lib/vesselTracking';

function localInput(iso: string) {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
export function VesselHistoryPanel({ tracking: h }: { tracking: ReturnType<typeof useVesselTracking> }) {
  const { t, lang } = useI18n();
  const [from, setFrom] = useState(() => localInput(new Date(Date.now()-86400000).toISOString())),
    [to, setTo] = useState(() => localInput(new Date().toISOString()));
  useEffect(() => {
    if (h.range) {
      setFrom(localInput(h.range.from));
      setTo(localInput(h.range.to));
    }
  }, [h.range]);
  useEffect(() => {
    if (!h.open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') h.close();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [h.open, h.close]);
  if (!h.open) return null;
  const selected = h.selected,
    v = h.vessels.find((v) => v.mmsi === selected?.mmsi);
  const start = Date.parse(from),
    end = Date.parse(to),
    valid =
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      end > start &&
      end - start <= 7 * 86400000 &&
      end <= Date.now() + 60000;
  const preset = (hours: number) => {
    const end = Date.now();
    h.setRange({ from: new Date(end - hours * 3600000).toISOString(), to: new Date(end).toISOString(), live: true });
  };
  const date = (value: string) =>
    new Date(value).toLocaleString(localeTag(lang), { dateStyle: 'short', timeStyle: 'short' });
  return (
    <section className="vessel-history" aria-label={t('history.title')}>
      <header>
        <strong>{t('history.title')}</strong>
        <button type="button" onClick={h.close} aria-label={t('action.close')}>
          <X size={20} />
        </button>
      </header>
      {h.error || h.storageError ? (
        <p role="alert">{t(h.storageError ? 'history.storageError' : h.error!)}</p>
      ) : null}
      {selected ? (
        <>
          <h3>{v?.name || selected.name || selected.mmsi}</h3>
          <small>MMSI {selected.mmsi}</small>
          <div className="vessel-history__actions">
            <button
              type="button"
              onClick={() => h.toggleFavorite(selected)}
              aria-pressed={h.favorites.some((f) => f.mmsi === selected.mmsi)}
            >
              <Star size={16} />
              {t(
                h.favorites.some((f) => f.mmsi === selected.mmsi) ? 'history.unfavorite' : 'history.favorite',
              )}
            </button>
            <button
              type="button"
              onClick={() => h.follow(h.following === selected.mmsi ? null : selected.mmsi)}
              aria-pressed={h.following === selected.mmsi}
            >
              <Crosshair size={16} />
              {t(h.following === selected.mmsi ? 'history.stopFollow' : 'history.follow')}
            </button>
            <button type="button" onClick={() => preset(24)}>
              <Route size={16} />
              {t('history.track')}
            </button>
            {h.track ? (
              <button type="button" onClick={h.hideTrack}>
                {t('history.hideTrack')}
              </button>
            ) : null}
          </div>
          <p className="vessel-history__status">
            {v ? (
              <>
                {v.stale ? t('history.stale') : t('history.lastSeen')} · {date(v.timestamp)}
              </>
            ) : (
              t('history.noPosition')
            )}
          </p>
          <div className="vessel-history__presets">
            {[1, 6, 24, 168].map((hours) => (
              <button type="button" key={hours} onClick={() => preset(hours)}>
                {hours === 168 ? t('history.week') : `${hours} h`}
              </button>
            ))}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (valid) h.setRange({ from: new Date(start).toISOString(), to: new Date(end).toISOString() });
            }}
          >
            <label>
              {t('history.from')}
              <LocalizedDateTimePicker
                value={
                  Number.isFinite(start)
                    ? new Date(start).toISOString()
                    : new Date(Date.now() - 86400000).toISOString()
                }
                onChange={(value) => setFrom(localInput(value))}
                min={h.track?.availableFrom ?? undefined}
                max={new Date().toISOString()}
              />
            </label>
            <label>
              {t('history.to')}
              <LocalizedDateTimePicker
                value={Number.isFinite(end) ? new Date(end).toISOString() : new Date().toISOString()}
                onChange={(value) => setTo(localInput(value))}
                min={Number.isFinite(start) ? new Date(start).toISOString() : undefined}
                max={new Date().toISOString()}
              />
            </label>
            <small>{t('history.maxRange')}</small>
            <button type="submit" disabled={!valid || h.loading}>
              {t('history.show')}
            </button>
          </form>
          {h.loading ? <p role="status">{t('history.loading')}</p> : null}
          {h.trackError ? <p role="alert">{t(h.trackError)}</p> : null}
          {h.track ? (
            <>
              <p>
                {h.track.segments.length
                  ? t('history.points', { n: h.track.segments.reduce((n, s) => n + s.length, 0) })
                  : t('history.empty')}
              </p>
              {h.track.availableFrom ? (
                <small>
                  {t('history.available')}: {date(h.track.availableFrom)} – {date(h.track.availableTo!)}
                </small>
              ) : null}
              {h.track.gaps.length ? <p>{t('history.gaps')}</p> : null}
            </>
          ) : null}
        </>
      ) : null}
      <h3>{t('history.favorites')}</h3>
      {!h.favorites.length ? (
        <p>{t('history.noFavorites')}</p>
      ) : (
        <ul>
          {h.favorites.map((f) => {
            const live = h.vessels.find((v) => v.mmsi === f.mmsi);
            return (
              <li key={f.mmsi}>
                <button type="button" onClick={() => h.show(f)}>
                  <strong>{live?.name || f.name || f.mmsi}</strong>
                  <small>{live ? date(live.timestamp) : t('history.noPosition')}</small>
                </button>
                <button
                  type="button"
                  onClick={() => h.toggleFavorite(f)}
                  aria-label={`${t('history.unfavorite')} ${f.name}`}
                >
                  <X size={16} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <small>{t('history.localFavorites')}</small>
    </section>
  );
}
