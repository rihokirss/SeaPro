import { useEffect, useRef, useState } from 'react';
import type { SearchResult } from '@seapro/shared';
import { useI18n } from '../i18n';
import { api } from '../lib/api';

interface Props {
  bbox?: [number, number, number, number];
  onGoTo(lat: number, lon: number, zoom?: number): void;
}

type Status = 'idle' | 'searching' | 'ready' | 'error';

export function SearchBox({ bbox, onGoTo }: Props): React.ReactElement {
  const { lang, t } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  // Pärast tulemuse valimist ei tohi kaardi liikumisest muutuv bbox sama nime
  // soovitusi uuesti avada. Lukk vabaneb alles kasutaja järgmise sisestusega.
  const suppressAutoSearch = useRef(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [status, setStatus] = useState<Status>('idle');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const closeOutside = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) {
        setOpen(false);
        setMobileOpen(false);
      }
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, []);

  useEffect(() => () => request.current?.abort(), []);

  const search = (value = query): void => {
    const q = value.trim();
    if (q.length < 2) {
      input.current?.focus();
      return;
    }
    request.current?.abort();
    const ac = new AbortController();
    request.current = ac;
    setStatus('searching');
    setOpen(true);
    setActive(-1);
    api.search({ q, lang, bbox }, ac.signal)
      .then(({ results: found }) => {
        setResults(found);
        setStatus('ready');
        setActive(found.length ? 0 : -1);
      })
      .catch(() => {
        if (ac.signal.aborted) return;
        setResults([]);
        setStatus('error');
      });
  };

  // Photon toetab prefiksiotsingut. Viivitus ootab ära loomuliku trükkimispausi
  // ja hoiab ära välispäringu iga klahvivajutuse kohta.
  useEffect(() => {
    if (suppressAutoSearch.current) return;
    const q = query.trim();
    if (q.length < 2) {
      request.current?.abort();
      setResults([]);
      setStatus('idle');
      setOpen(false);
      return;
    }
    const timer = window.setTimeout(() => search(q), 400);
    return () => window.clearTimeout(timer);
  }, [query, lang, bbox?.join(',')]);

  const choose = (result: SearchResult): void => {
    suppressAutoSearch.current = true;
    setQuery(result.name);
    setOpen(false);
    setMobileOpen(false);
    onGoTo(result.lat, result.lon, result.zoom);
  };

  const optionId = active >= 0 ? `search-result-${active}` : undefined;
  return (
    <div className={`search${mobileOpen ? ' is-mobile-open' : ''}`} ref={root}>
      <button
        type="button"
        className="search__toggle icon-btn"
        aria-label={t('search.open')}
        title={t('search.open')}
        onClick={() => {
          setMobileOpen(true);
          window.requestAnimationFrame(() => input.current?.focus());
        }}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m15.5 15.5 5 5" />
        </svg>
      </button>
      <form
        className="search__form"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          if (open && active >= 0 && status === 'ready') choose(results[active]!);
          else search();
        }}
      >
        <input
          ref={input}
          className="search__input"
          type="search"
          value={query}
          placeholder={t('search.placeholder')}
          aria-label={t('search.placeholder')}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls="search-results"
          aria-activedescendant={optionId}
          autoComplete="off"
          onFocus={() => {
            if (status !== 'idle') setOpen(true);
          }}
          onChange={(event) => {
            suppressAutoSearch.current = false;
            request.current?.abort();
            setQuery(event.target.value);
            setOpen(false);
            setActive(-1);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setOpen(false);
              setMobileOpen(false);
              event.currentTarget.blur();
            } else if (open && results.length && event.key === 'ArrowDown') {
              event.preventDefault();
              setActive((value) => (value + 1) % results.length);
            } else if (open && results.length && event.key === 'ArrowUp') {
              event.preventDefault();
              setActive((value) => (value <= 0 ? results.length - 1 : value - 1));
            }
          }}
        />
        <button
          className="search__submit"
          type="button"
          onClick={() => search()}
          disabled={query.trim().length < 2 || status === 'searching'}
          aria-label={t('search.submit')}
          title={t('search.submit')}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="10.5" cy="10.5" r="6.5" />
            <path d="m15.5 15.5 5 5" />
          </svg>
        </button>
      </form>

      {open ? (
        <div className="search__results" id="search-results" role="listbox" aria-label={t('search.results')}>
          {status === 'searching' ? <p className="search__state">{t('search.searching')}</p> : null}
          {status === 'error' ? <p className="search__state search__state--error">{t('search.error')}</p> : null}
          {status === 'ready' && results.length === 0 ? <p className="search__state">{t('search.noResults')}</p> : null}
          {status === 'ready' && results.length ? (
            <ul>
              {results.map((result, index) => (
                <li key={result.id}>
                  <button
                    id={`search-result-${index}`}
                    type="button"
                    role="option"
                    aria-selected={active === index}
                    className={active === index ? 'is-active' : ''}
                    onPointerMove={() => setActive(index)}
                    onClick={() => choose(result)}
                  >
                    <span className="search__kind" aria-hidden="true">
                      {result.kind === 'harbour' ? '⚓' : '⌖'}
                    </span>
                    <span className="search__label">
                      <strong>{result.name}</strong>
                      {result.subtitle ? <small>{result.subtitle}</small> : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="search__attribution">
            © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>
          </p>
        </div>
      ) : null}
    </div>
  );
}
