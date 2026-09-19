// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { useVesselTracking } from './vesselTracking';

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

it('draws tracks while tiles are loading and restores layers after a style reload', async () => {
  let loaded = false;
  const listeners = new Map<string, Set<() => void>>();
  const sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>();
  const layers = new Map<string, unknown>();
  const map = {
    isStyleLoaded: () => false,
    getStyle: () => loaded ? { version: 8 } : undefined,
    on: (event: string, fn: () => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
    },
    off: (event: string, fn: () => void) => listeners.get(event)?.delete(fn),
    getSource: (id: string) => sources.get(id),
    addSource: (id: string) => sources.set(id, { setData: vi.fn() }),
    getLayer: (id: string) => layers.get(id),
    addLayer: (layer: { id: string }) => layers.set(layer.id, layer),
    fitBounds: vi.fn(),
  };
  const emit = (event: string) => act(() => { listeners.get(event)?.forEach(fn => fn()); });
  const segments = [[{ lon: 24, lat: 59 }, { lon: 24.01, lat: 59.01 }]];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: true, json: async () => url.includes('/track?') ? { segments } : { vessels: [] },
  })));
  const { result, unmount } = renderHook(() => useVesselTracking(map as unknown as MapLibreMap, () => {}));
  expect(sources.size).toBe(0);
  emit('style.load');
  loaded = true;
  emit('style.load');
  expect(layers.has('ais-history-line')).toBe(true);
  act(() => result.current.show({ mmsi: 276779000, name: 'Ship' }));
  await waitFor(() => expect(result.current.track?.segments).toEqual(segments));
  const update = sources.get('ais-history')!.setData;
  expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ features: [expect.objectContaining({
    geometry: { type: 'LineString', coordinates: [[24, 59], [24.01, 59.01]] },
  })] }));
  const calls = update.mock.calls.length;
  emit('idle');
  expect(update).toHaveBeenCalledTimes(calls);
  unmount();
  expect(listeners.get('style.load')?.size).toBe(0);
});

it('extends a followed live track, preserves it on errors, and stops on drag or a fixed range', async () => {
  vi.useFakeTimers();
  const listeners = new Map<string, Set<() => void>>();
  const map = {
    getStyle: () => undefined,
    on: (event: string, fn: () => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
    },
    off: (event: string, fn: () => void) => listeners.get(event)?.delete(fn),
    fitBounds: vi.fn(),
    easeTo: vi.fn(),
  };
  const ship = { mmsi: 276779000, name: 'Ship' };
  const urls: string[] = [];
  let fail = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/track?')) {
      urls.push(url);
      return { ok: !fail, json: async () => ({ segments: [[{ lon: 24, lat: 59 }, { lon: 24 + urls.length / 100, lat: 59 }]] }) };
    }
    return { ok: true, json: async () => ({ vessels: [{ ...ship, lon: 24, lat: 59, stale: false }] }) };
  }));
  const { result, unmount } = renderHook(() => useVesselTracking(map as unknown as MapLibreMap, () => {}));
  try {
    await act(async () => { result.current.show(ship, 'track'); });
    const initial = result.current.track;
    expect(initial).not.toBeNull();
    await act(async () => { result.current.show(ship, 'follow'); });
    expect(result.current.track).toBe(initial);
    const fits = map.fitBounds.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(urls).toHaveLength(2);
    const first = new URL(urls[0]!, 'http://test').searchParams;
    const second = new URL(urls[1]!, 'http://test').searchParams;
    expect(Date.parse(second.get('to')!) - Date.parse(first.get('to')!)).toBe(30000);
    expect(Date.parse(second.get('to')!) - Date.parse(second.get('from')!)).toBe(86400000);
    expect(result.current.track).not.toBe(initial);
    expect(map.fitBounds).toHaveBeenCalledTimes(fits);
    const current = result.current.track;
    fail = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(result.current.track).toBe(current);
    expect(result.current.trackError).toBe('history.unavailable');
    fail = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(result.current.trackError).toBeNull();
    act(() => { listeners.get('dragstart')?.forEach(fn => fn()); });
    const count = urls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(urls).toHaveLength(count);
    await act(async () => { result.current.follow(ship.mmsi); });
    await act(async () => { result.current.setRange({ from: first.get('from')!, to: first.get('to')! }); });
    const fixedCount = urls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(urls).toHaveLength(fixedCount);
    await act(async () => { result.current.show(ship, 'track'); });
    expect(result.current.following).toBe(ship.mmsi);
    act(() => result.current.hideTrack());
    const hiddenCount = urls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(urls).toHaveLength(hiddenCount);
    expect(result.current.track).toBeNull();
  } finally {
    unmount();
    vi.useRealTimers();
  }
});
