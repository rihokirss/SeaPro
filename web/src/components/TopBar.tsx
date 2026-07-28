import { useState } from 'react';
import { useI18n, LANGS, type Lang } from '../i18n';
import type { GeoState } from '../lib/geolocation';
import type { useFavorites } from '../lib/favorites';

interface Props {
  onOpenLayers(): void;
  geo: GeoState;
  favorites: ReturnType<typeof useFavorites>;
  onGoTo(lat: number, lon: number, zoom?: number): void;
}

/** Kompassiroos — logo asemel. Puhas SVG, ei vaja fonti ega pildifaili. */
function CompassRose() {
  return (
    <svg className="topbar__mark" viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="14" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.5" />
      <circle cx="16" cy="16" r="9.5" fill="none" stroke="currentColor" strokeWidth="0.8" opacity="0.3" />
      {/* Neli põhiharu, põhi täidetud — nagu merekaardi roosil */}
      <path d="M16 2.5 19 16 16 13.2 13 16Z" fill="currentColor" />
      <path d="M16 29.5 13 16 16 18.8 19 16Z" fill="currentColor" opacity="0.45" />
      <path d="M2.5 16 16 13 13.2 16 16 19Z" fill="currentColor" opacity="0.45" />
      <path d="M29.5 16 16 19 18.8 16 16 13Z" fill="currentColor" opacity="0.45" />
    </svg>
  );
}

export function TopBar({ onOpenLayers, geo, favorites, onGoTo }: Props) {
  const { t, lang, setLang } = useI18n();
  const [favOpen, setFavOpen] = useState(false);


  return (
    <header className="topbar">
      <div className="topbar__brand">
        <CompassRose />
        <div>
          <strong>{t('app.title')}</strong>
          <span>{t('app.subtitle')}</span>
        </div>
      </div>

      {/* "Minu asukoht" oli varem siin. Kolis alla paremasse nurka
          (`LocateButton` `.mapctl` virnas) — pöidla ulatusse. */}
      <div className="topbar__actions">
        <div className="topbar__fav">
          <button
            type="button"
            className={`icon-btn icon-btn--brass${favOpen ? ' is-active' : ''}`}
            onClick={() => setFavOpen((v) => !v)}
            title={t('action.favorites')}
            aria-label={t('action.favorites')}
            aria-expanded={favOpen}
          >
            ★
          </button>
          {favOpen ? (
            <div className="dropdown">
              {favorites.items.length === 0 ? (
                <p className="muted">{t('favorites.empty')}</p>
              ) : (
                <ul>
                  {favorites.items.map((f) => (
                    <li key={f.id}>
                      <button
                        type="button"
                        className="dropdown__item"
                        onClick={() => {
                          onGoTo(f.lat, f.lon);
                          setFavOpen(false);
                        }}
                      >
                        {f.name}
                        <span className="dropdown__coords">
                          {f.lat.toFixed(3)}° N, {f.lon.toFixed(3)}° E
                        </span>
                      </button>
                      <button
                        type="button"
                        className="dropdown__remove"
                        onClick={() => favorites.remove(f.id)}
                        aria-label={t('action.removeFavorite')}
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </div>

        <select
          className="lang-select"
          value={lang}
          onChange={(e) => setLang(e.target.value as Lang)}
          aria-label="Language"
        >
          {LANGS.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>

        <button
          type="button"
          className="icon-btn icon-btn--primary"
          onClick={onOpenLayers}
          title={t('action.layers')}
          aria-label={t('action.layers')}
        >
          ☰
        </button>
      </div>

      {geo.status === 'denied' || geo.status === 'insecure' ? (
        <p className="topbar__notice">
          {geo.status === 'insecure' ? t('location.insecure') : t('location.denied')}
        </p>
      ) : null}
    </header>
  );
}
