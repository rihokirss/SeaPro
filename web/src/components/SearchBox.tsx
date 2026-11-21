import { useEffect, useRef, useState } from 'react';
import { Anchor, MapPin, Search, Ship } from 'lucide-react';
import type { SearchResult, TrackedVessel, VesselSearchResult } from '@seapro/shared';
import { localeTag, useI18n } from '../i18n';
import { api } from '../lib/api';

interface Props {
  bbox?: [number, number, number, number];
  onVessel(vessel: TrackedVessel): void;
  onGoTo(lat: number, lon: number, zoom?: number): void;
}

type Status = 'idle' | 'searching' | 'ready' | 'error';

export function SearchBox({ bbox, onGoTo, onVessel }: Props): React.ReactElement {
  const { lang, t } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  // Pärast tulemuse valimist ei tohi kaardi liikumisest muutuv bbox sama nime
  // soovitusi uuesti avada. Lukk vabaneb alles kasutaja järgmise sisestusega.
  const suppressAutoSearch = useRef(false);
  const [scope, setScope] = useState<'places' | 'vessels'>('places');
  const [historyAvailable, setHistoryAvailable] = useState(true);
  const timer = useRef<number | undefined>(undefined);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<(SearchResult | VesselSearchResult)[]>([]);
  const [status, setStatus] = useState<Status>('idle');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const closeOutside = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) {
        window.clearTimeout(timer.current);
        suppressAutoSearch.current = true;
        setStatus(previous => previous === 'searching' ? 'idle' : previous);
        request.current?.abort();
        setOpen(false);
        setMobileOpen(false);
      }
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, []);

  useEffect(() => () => request.current?.abort(), []);

  const search = (value = query): void => {
    window.clearTimeout(timer.current);
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
    const response = scope === 'vessels' ? api.searchVessels(q, ac.signal) : api.search({ q, lang, bbox }, ac.signal);
    response
      .then(data => {
        if (ac.signal.aborted) return;
        const found = data.results;
        setHistoryAvailable(!('historyAvailable' in data) || data.historyAvailable);
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
    timer.current = window.setTimeout(() => search(q), 400);
    return () => window.clearTimeout(timer.current);
  }, [query, lang, scope, scope === 'places' ? bbox?.join(',') : undefined]);

  const choose = (result: SearchResult | VesselSearchResult): void => {
    window.clearTimeout(timer.current);
    request.current?.abort();
    suppressAutoSearch.current = true;
    setQuery(result.name);
    setOpen(false);
    setMobileOpen(false);
    if (result.kind === 'vessel') onVessel(result.vessel);
    else onGoTo(result.lat, result.lon, result.zoom);
  };

  const placeholder = t(scope === 'places' ? 'search.placeholder' : 'search.vesselPlaceholder');
  const optionId = open && active >= 0 ? `search-result-${active}` : undefined;
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
        <Search size={20} aria-hidden="true" />
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
        <div className="search__scope" role="radiogroup" aria-label={t('search.scope')}>
          {(['places', 'vessels'] as const).map(value => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={scope === value}
              aria-label={t(`search.${value}`)}
              title={t(`search.${value}`)}
              className={scope === value ? 'is-active' : ''}
              onClick={() => {
                input.current?.focus();
                if (scope === value) return;
                request.current?.abort();
                window.clearTimeout(timer.current);
                suppressAutoSearch.current = false;
                setScope(value);
                setResults([]);
                setActive(-1);
                setStatus('idle');
                setOpen(false);
              }}
            >
              {value === 'places' ? <MapPin size={18} aria-hidden="true" /> : <Ship size={18} aria-hidden="true" />}
            </button>
          ))}
        </div>
        <input
          ref={input}
          className="search__input"
          type="search"
          value={query}
          placeholder={placeholder}
          aria-label={placeholder}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls="search-results"
          aria-activedescendant={optionId}
          maxLength={scope === 'vessels' ? 100 : undefined}
          autoComplete="off"
          onFocus={() => {
            if (status !== 'idle') setOpen(true);
          }}
          onChange={(event) => {
            suppressAutoSearch.current = false;
            request.current?.abort();
            setStatus('idle');
            setQuery(event.target.value);
            setOpen(false);
            setActive(-1);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              window.clearTimeout(timer.current);
              request.current?.abort();
              suppressAutoSearch.current = true;
              setStatus(previous => previous === 'searching' ? 'idle' : previous);
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
          <Search size={20} aria-hidden="true" />
        </button>
      </form>

      {open ? (
        <div className="search__results" id="search-results" role="listbox" aria-label={t('search.results')}>
          {status === 'searching' ? <p className="search__state">{t('search.searching')}</p> : null}
          {status === 'error' ? <p className="search__state search__state--error">{t('search.error')}</p> : null}
          {status === 'ready' && historyAvailable && results.length === 0 ? <p className="search__state">{t('search.noResults')}</p> : null}
          {status === 'ready' && !historyAvailable ? <p className="search__state">{t('search.historyUnavailable')}</p> : null}
          {status === 'ready' && results.length ? (
            <ul>
              {results.map((result, index) => (
                <li key={result.kind === 'vessel' ? result.vessel.mmsi : result.id}>
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
                      {scope === 'vessels' ? <Ship size={18} /> : result.kind === 'harbour' ? <Anchor size={18} /> : <MapPin size={18} />}
                    </span>
                    <span className="search__label">
                      <strong>{result.name}</strong>
                      <small>{result.kind === 'vessel'
                        ? `MMSI ${result.vessel.mmsi} · ${t('search.lastReport')} ${new Date(result.vessel.timestamp).toLocaleString(localeTag(lang), { dateStyle: 'short', timeStyle: 'short' })}`
                        : result.subtitle}</small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {scope === 'places' ? <p className="search__attribution">
            © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>
          </p> : null}
        </div>
      ) : null}
    </div>
  );
}
