import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Search } from 'lucide-react';
import type { SearchResult } from '@seapro/shared';
import { useI18n } from '../i18n';
import { api } from '../lib/api';

interface Props {
  placeholder: string;
  initialQuery?: string;
  filter?: (result: SearchResult) => boolean;
  onFocus?: () => void;
  onChoose(result: SearchResult): void;
}

export function SearchPicker({ placeholder, initialQuery = '', filter, onFocus, onChoose }: Props) {
  const { lang, t } = useI18n();
  const request = useRef<AbortController | null>(null);
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');

  useEffect(() => () => request.current?.abort(), []);

  const search = (): void => {
    const q = query.trim();
    if (q.length < 2) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setStatus('loading');
    api.search({ q, lang }, controller.signal).then(({ results: found }) => {
      setResults(found.filter((result) => filter?.(result) ?? true).slice(0, 5));
      setStatus('ready');
    }).catch(() => {
      if (controller.signal.aborted) return;
      setResults([]);
      setStatus('error');
    });
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    search();
  };

  return <div className="route-endpoint-search">
    <div className="route-endpoint-search__controls" role="search">
      <input
        type="search"
        value={query}
        onChange={(event) => { setQuery(event.target.value); setResults([]); setStatus('idle'); }}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        placeholder={placeholder}
        aria-label={placeholder}
      />
      <button type="button" onClick={search} disabled={query.trim().length < 2 || status === 'loading'} aria-label={t('search.submit')}>
        <Search size={18} aria-hidden="true" />
      </button>
    </div>
    {status === 'loading' ? <p className="route-endpoint-search__state">{t('search.searching')}</p> : null}
    {status === 'error' ? <p className="route-endpoint-search__state is-error">{t('search.error')}</p> : null}
    {status === 'ready' && results.length === 0 ? <p className="route-endpoint-search__state">{t('search.noResults')}</p> : null}
    {results.length ? <ul>
      {results.map((result) => <li key={result.id}><button type="button" onClick={() => {
        onChoose(result);
        setQuery(result.name);
        setResults([]);
        setStatus('idle');
      }}>
        <span><strong>{result.name}</strong>{result.subtitle ? <small>{result.subtitle}</small> : null}</span>
      </button></li>)}
    </ul> : null}
  </div>;
}
