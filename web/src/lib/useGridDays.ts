import { useEffect, useReducer, useRef } from 'react';
import type { GridDayResult, GridFrame, Variable } from '@seapro/shared';
import { api, RateLimitedError } from './api';

const DAY_MS = 86_400_000;
const RETRY_MS = 60_000;
const MAX_ENTRIES = 6;
type Params = {
  bbox: [number, number, number, number] | null;
  vars: Variable[];
  time: Date;
  model: string;
  waveModel?: string;
};
interface GridEntry {
  result: GridDayResult;
  retryAt?: number;
}

function gridEntryDeadline(entry: GridEntry): number {
  return entry.retryAt ?? (Date.parse(entry.result.freshness?.expiresAt ?? '') || 0);
}

function gridEntryNotice(entry: GridEntry | undefined): 'missing' | 'stale' | 'error' | 'limited' | null {
  if (!entry) return null;
  if (entry.result.warning?.kind === 'rate_limited') return 'limited';
  if (entry.result.warning) return 'error';
  if (!entry.result.frames.some((frame) => frame.points.length)) return 'missing';
  if (entry.result.freshness?.partial) return 'missing';
  const freshness = entry.result.freshness;
  if (freshness && (freshness.stale || Date.parse(freshness.expiresAt) <= Date.now())) return 'stale';
  return null;
}

/** Cache sisaldab ka vastuse olekut. Laadimist käivitab ainult vaate muutus. */
export function useGridDays(params: Params): { frames: GridFrame[]; notice: ReturnType<typeof gridEntryNotice> } {
  const cache = useRef(new Map<string, GridEntry>());
  const lastGood = useRef<{ context: string; entry: GridEntry } | null>(null);
  const [revision, render] = useReducer((n: number) => n + 1, 0);
  const bboxKey = params.bbox?.map((n) => n.toFixed(3)).join(',') ?? '';
  const varsKey = params.vars.join(',');
  const day = params.time.toISOString().slice(0, 10);
  const context = `${params.model}|${params.waveModel ?? ''}|${varsKey}|${day}`;
  const selectedKey = `${bboxKey}|${context}`;
  const active = Boolean(bboxKey && varsKey);

  useEffect(() => {
    if (!active) { cache.current.clear(); lastGood.current = null; return; }
    const controller = new AbortController();
    const bbox = bboxKey.split(',').map(Number) as NonNullable<Params['bbox']>;
    const base = Date.parse(`${day}T00:00:00Z`);
    const wanted = [0, -1, 1].map((offset) => {
      const date = new Date(base + offset * DAY_MS).toISOString();
      const key = `${bboxKey}|${params.model}|${params.waveModel ?? ''}|${varsKey}|${date.slice(0, 10)}`;
      return { key, date };
    });
    const store = (key: string, entry: GridEntry) => {
      cache.current.delete(key);
      cache.current.set(key, entry);
      for (const old of cache.current.keys()) {
        if (cache.current.size <= MAX_ENTRIES) break;
        if (!wanted.some((item) => item.key === old)) cache.current.delete(old);
      }
      render();
    };
    for (const { key, date } of wanted) {
      const previous = cache.current.get(key);
      if (previous && gridEntryDeadline(previous) > Date.now()) continue;
      const width = window.innerWidth;
      void api.gridDay({
        bbox, vars: varsKey.split(',') as Variable[], time: date,
        steps: width < 480 ? 12 : width < 1024 ? 16 : 20,
        model: params.model === 'best_match' ? undefined : params.model,
        waveModel: params.waveModel,
      }, controller.signal).then((result) => {
        if (controller.signal.aborted) return;
        const unhealthy = result.warning || result.freshness?.stale
          || result.freshness?.partial || !result.frames.some((frame) => frame.points.length);
        store(key, {
          result,
          retryAt: unhealthy ? Date.now() + (result.warning?.kind === 'rate_limited'
            ? Math.max(60, result.warning.retryAfterSeconds) * 1000 : RETRY_MS) : undefined,
        });
      }).catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const fallback = previous ?? (key === selectedKey && lastGood.current?.context === context
          ? lastGood.current.entry : undefined);
        store(key, {
          result: {
            ...(fallback?.result ?? { frames: [] }),
            warning: error instanceof RateLimitedError
              ? { kind: 'rate_limited', retryAfterSeconds: error.retryAfterSeconds }
              : { kind: 'error' },
          },
          retryAt: Date.now() + (error instanceof RateLimitedError
            ? Math.max(60, error.retryAfterSeconds) * 1000 : RETRY_MS),
        });
      });
    }
    return () => controller.abort();
  }, [active, bboxKey, varsKey, day, params.model, params.waveModel, selectedKey, context]);

  // TTL-i täitumine muudab ainult kasutajale kuvatavat värskusolekut.
  // Võrgulaadimise efekt revision'ist ei sõltu, seega see taimer ei tekita
  // serveri- ega Open-Meteo päringut.
  useEffect(() => {
    if (!active) return;
    const expiresAt = Date.parse(
      cache.current.get(selectedKey)?.result.freshness?.expiresAt ?? '',
    );
    const wait = expiresAt - Date.now();
    if (!Number.isFinite(wait) || wait <= 0) return;
    const timer = window.setTimeout(render, wait);
    return () => window.clearTimeout(timer);
  }, [active, selectedKey, revision]);

  if (!active) return { frames: [], notice: null };
  const current = cache.current.get(selectedKey);
  if (current?.result.frames.some((frame) => frame.points.length)) {
    lastGood.current = { context, entry: current };
  }
  const entry = current ?? (lastGood.current?.context === context ? lastGood.current.entry : undefined);
  return { frames: entry?.result.frames ?? [], notice: gridEntryNotice(entry) };
}
