import { useState } from 'react';
import { Menu, Pencil, Route, Star, Trash2 } from 'lucide-react';
import { useI18n } from '../i18n';
import type { GeoState } from '../lib/geolocation';
import type { useFavorites } from '../lib/favorites';
import { SearchBox } from './SearchBox';

interface Props {
  onOpenLayers(): void;
  geo: GeoState;
  favorites: ReturnType<typeof useFavorites>;
  onGoTo(lat: number, lon: number, zoom?: number): void;
  bbox?: [number, number, number, number];
  onOpenRoutes(): void;
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

export function TopBar({ onOpenLayers, onOpenRoutes, geo, favorites, onGoTo, bbox }: Props) {
  const { t } = useI18n();
  const [favOpen, setFavOpen] = useState(false);

  /*
   * Lemmiku ümbernimetamine.
   *
   * `Favorite.name` ja `favorites.rename()` olid juba olemas, aga mitte
   * kusagil kasutuses — lemmik salvestati koordinaadiga nimeks ja jäigi
   * selleks. "59.44, 24.76" ei ütle nädala pärast midagi, "Kodusadam" ütleb.
   */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const commitRename = (id: string): void => {
    if (editingId !== id) return; // Enter juba salvestas; blur ei tohi korrata.
    setEditingId(null);
    const name = draft.trim();
    if (name) favorites.rename(id, name);
  };


  return (
    <header className="topbar">
      <div className="topbar__brand">
        <CompassRose />
        <div>
          <strong>{t('app.title')}</strong>
          <span>{t('app.subtitle')}</span>
        </div>
      </div>

      <SearchBox bbox={bbox} onGoTo={onGoTo} />

      {/* "Minu asukoht" oli varem siin. Kolis alla paremasse nurka
          (`LocateButton` `.mapctl` virnas) — pöidla ulatusse. */}
      <div className="topbar__actions">
        <button type="button" className="icon-btn icon-btn--brass" onClick={onOpenRoutes} title={t('route.title')} aria-label={t('route.title')}>
          <Route size={20} aria-hidden="true" />
        </button>
        <div className="topbar__fav">
          <button
            type="button"
            className={`icon-btn icon-btn--brass${favOpen ? ' is-active' : ''}`}
            onClick={() => setFavOpen((v) => !v)}
            title={t('action.favorites')}
            aria-label={t('action.favorites')}
            aria-expanded={favOpen}
          >
            <Star size={20} fill="currentColor" aria-hidden="true" />
          </button>
          {favOpen ? (
            <div className="dropdown">
              {favorites.items.length === 0 ? (
                <p className="muted">{t('favorites.empty')}</p>
              ) : (
                <ul>
                  {favorites.items.map((f) => (
                    <li key={f.id}>
                      {editingId === f.id ? (
                        <input
                          className="dropdown__rename"
                          value={draft}
                          autoFocus
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitRename(f.id);
                            if (e.key === 'Escape') setEditingId(null);
                          }}
                          onBlur={() => commitRename(f.id)}
                          aria-label={t('action.renameFavorite')}
                        />
                      ) : (
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
                      )}
                      <button
                        type="button"
                        className="dropdown__edit"
                        onClick={() => {
                          setEditingId(f.id);
                          setDraft(f.name);
                        }}
                        aria-label={t('action.renameFavorite')}
                        title={t('action.renameFavorite')}
                      >
                        <Pencil size={17} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="dropdown__remove"
                        onClick={() => favorites.remove(f.id)}
                        aria-label={t('action.removeFavorite')}
                      >
                        <Trash2 size={18} aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </div>

        <button
          type="button"
          className="icon-btn icon-btn--primary"
          onClick={onOpenLayers}
          title={t('action.layers')}
          aria-label={t('action.layers')}
        >
          <Menu size={21} aria-hidden="true" />
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
