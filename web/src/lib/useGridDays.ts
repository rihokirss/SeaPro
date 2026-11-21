import { useEffect, useMemo, useReducer, useRef } from 'react';
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
  previousForecast?: boolean;
}

function gridEntryDeadline(entry: GridEntry): number {
  return entry.retryAt ?? (Date.parse(entry.result.freshness?.expiresAt ?? '') || 0);
}

/** Ajaliugurile lähim kaader juba mälus olevast ööpäevast. */
function frameAt(frames: GridFrame[], time: Date): GridFrame | null {
  if (frames.length === 0) return null;
  const target = new Date(time).setMinutes(0, 0, 0);
  let best: GridFrame | null = null;
  let bestDiff = Infinity;
  for (const f of frames) {
    const diff = Math.abs(new Date(f.time).getTime() - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = f;
    }
  }
  return best;
}

/** Cache sisaldab ka vastuse olekut. Laadimist käivitab ainult vaate muutus. */
export function useGridDays(params: Params) {
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
            ? Math.max(1, result.warning.retryAfterSeconds) * 1000 : RETRY_MS) : undefined,
        });
      }).catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const fallback = previous ?? (key === selectedKey && lastGood.current?.context === context
          ? lastGood.current.entry : undefined);
        store(key, {
          result: {
            ...(fallback?.result ?? { frames: [] }),
            warning: error instanceof RateLimitedError
              ? { kind: 'rate_limited', retryAfterSeconds: error.retryAfterSeconds, localBudget: error.localBudget }
              : { kind: 'error' },
          },
          previousForecast: Boolean(fallback),
          retryAt: Date.now() + (error instanceof RateLimitedError
            ? Math.max(1, error.retryAfterSeconds) * 1000 : RETRY_MS),
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
    const entry = cache.current.get(selectedKey);
    if (!entry) return;
    const wait = gridEntryDeadline(entry) - Date.now();
    if (!Number.isFinite(wait) || wait <= 0) return;
    const timer = window.setTimeout(render, wait);
    return () => window.clearTimeout(timer);
  }, [active, selectedKey, revision]);

  const current = active ? cache.current.get(selectedKey) : undefined;
  if (current?.result.frames.some((frame) => frame.points.length)) {
    lastGood.current = { context, entry: current };
  }
  const entry = current ?? (active && lastGood.current?.context === context ? lastGood.current.entry : undefined);
  const frames = entry?.result.frames;
  const frame = useMemo(() => frames ? frameAt(frames, params.time) : null, [frames, params.time]);
  const warning = current?.result.warning;
  const limited = warning?.kind === 'rate_limited' && (current?.retryAt ?? 0) > Date.now();
  let reason: 'budget' | 'limited' | 'error' | null = null;
  if (limited) reason = warning.localBudget ? 'budget' : 'limited';
  if (warning?.kind === 'error') reason = 'error';
  const freshness = entry?.result.freshness;
  let coverage: 'unavailable' | 'missing' | 'stale' | null = null;
  if (entry) {
    if (!frame?.points.length) coverage = 'unavailable';
    else if (freshness?.partial) coverage = 'missing';
    else if (!current || entry.previousForecast || freshness?.stale
      || Date.parse(freshness?.expiresAt ?? '') <= Date.now()) coverage = 'stale';
  }
  return { frames: frames ?? [], frame, limited, notice: reason ?? coverage, detail: reason ? coverage : null };
}
