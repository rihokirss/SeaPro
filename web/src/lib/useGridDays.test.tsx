// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GridDayResult, Variable } from '@seapro/shared';
import { api } from './api';
import { useGridDays } from './useGridDays';

vi.mock('./api', async (original) => ({ ...await original<typeof import('./api')>(), api: { gridDay: vi.fn() } }));
const fetchDay = vi.mocked(api.gridDay);
const now = Date.parse('2026-09-18T12:00:00Z');
const params = {
  bbox: [59, 24, 60, 25] as [number, number, number, number],
  vars: ['wind_speed'] as Variable[], time: new Date(now), model: 'best_match',
};
function response(time: string, warning?: GridDayResult['warning']): GridDayResult {
  return {
    frames: [{ providerId: 'open-meteo', time, variables: ['wind_speed'], points: [{ lat: 59, lon: 24, values: { wind_speed: 5 } }] }],
    freshness: { fetchedAt: new Date(now).toISOString(), expiresAt: new Date(now + 3 * 3600_000).toISOString(), stale: Boolean(warning), partial: false },
    warning,
  };
}
beforeEach(() => { fetchDay.mockReset(); vi.spyOn(Date, 'now').mockReturnValue(now); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('retains a prefetched day warning when selecting that day', async () => {
  fetchDay.mockImplementation(async (q) => response(q.time, q.time.startsWith('2026-09-19') ? { kind: 'error' } : undefined));
  const { result, rerender } = renderHook((p) => useGridDays(p), { initialProps: params });
  await waitFor(() => expect(result.current.frames).toHaveLength(1));
  expect(result.current.notice).toBeNull();
  rerender({ ...params, time: new Date('2026-09-19T12:00:00Z') });
  expect(result.current.notice).toBe('error');
  await act(async () => {});
  expect(result.current.notice).toBe('error');
});

it('keeps layer results independent regardless of completion order', async () => {
  fetchDay.mockImplementation(async (q) => response(q.time, q.vars.includes('wave_height') ? { kind: 'error' } : undefined));
  const { result } = renderHook(() => ({ wind: useGridDays(params), waves: useGridDays({ ...params, vars: ['wave_height'] }) }));
  await waitFor(() => expect(result.current.waves.notice).toBe('error'));
  expect(result.current.wind.notice).toBeNull();
});

it('keeps the rate-limit reason when only part of the area is available', async () => {
  fetchDay.mockImplementation(async (q) => ({
    ...response(q.time, { kind: 'rate_limited', retryAfterSeconds: 600 }),
    freshness: {
      fetchedAt: new Date(now - 4 * 3600_000).toISOString(),
      expiresAt: new Date(now - 3600_000).toISOString(),
      stale: true,
      partial: true,
    },
  }));
  const { result } = renderHook(() => useGridDays(params));
  await waitFor(() => expect(result.current.notice).toBe('limited'));
});

it('refreshes expired entries on navigation, without background polling', async () => {
  fetchDay.mockImplementation(async (q) => response(q.time));
  const { result, rerender } = renderHook((p) => useGridDays(p), { initialProps: params });
  await waitFor(() => expect(result.current.frames).toHaveLength(1));
  expect(fetchDay).toHaveBeenCalledTimes(3);
  vi.mocked(Date.now).mockReturnValue(now + 4 * 3600_000);
  rerender({ ...params });
  expect(fetchDay).toHaveBeenCalledTimes(3);
  rerender({ ...params, time: new Date('2026-09-19T12:00:00Z') });
  await waitFor(() => expect(fetchDay).toHaveBeenCalledTimes(6));
});

it('ignores late responses after changing the area', async () => {
  let finish!: (value: GridDayResult) => void;
  fetchDay.mockImplementation((q) => q.bbox[0] === 59 ? new Promise((resolve) => { if (q.time.startsWith('2026-09-18')) finish = resolve; }) : Promise.resolve(response(q.time)));
  const { result, rerender } = renderHook((p) => useGridDays(p), { initialProps: params });
  rerender({ ...params, bbox: [58, 24, 59, 25] });
  await waitFor(() => expect(result.current.frames).toHaveLength(1));
  await act(async () => finish(response('2026-09-18T00:00:00Z', { kind: 'error' })));
  expect(result.current.notice).toBeNull();
});

it('preserves the old image on failure and clears the notice on a fresh area', async () => {
  fetchDay.mockImplementation(async (q) => response(q.time));
  const { result, rerender } = renderHook((p) => useGridDays(p), { initialProps: params });
  await waitFor(() => expect(result.current.frames).toHaveLength(1));
  fetchDay.mockRejectedValue(new Error('offline'));
  rerender({ ...params, bbox: [58, 24, 59, 25] });
  await waitFor(() => expect(result.current.notice).toBe('error'));
  expect(result.current.frames).toHaveLength(1);
  rerender(params);
  expect(result.current.notice).toBeNull();
});

it('hides a disabled layer warning immediately', async () => {
  fetchDay.mockRejectedValue(new Error('offline'));
  const { result, rerender } = renderHook((p) => useGridDays(p), { initialProps: params });
  await waitFor(() => expect(result.current.notice).toBe('error'));
  rerender({ ...params, vars: [] });
  expect(result.current.notice).toBeNull();
  expect(result.current.frames).toEqual([]);
});
