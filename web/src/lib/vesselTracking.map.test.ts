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

it('extends a live track after following stops, preserves it on errors, and keeps fixed ranges unchanged', async () => {
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
    expect(urls).toHaveLength(count + 1);
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

it('moves the vessel, ring and live track end together without waiting for a history refresh', async () => {
  const now = Date.now();
  const initial = { mmsi: 276779000, name: 'Ship', lat: 59, lon: 24, timestamp: new Date(now - 30000).toISOString(), source: 'digitraffic' as const };
  const next = { ...initial, lon: 24.001, timestamp: new Date(now).toISOString() };
  const data = new Map<string, any>();
  const map = {
    getStyle: () => ({}), on: vi.fn(), off: vi.fn(),
    getSource: (id: string) => data.has(id) ? { setData: (value: unknown) => data.set(id, value) } : undefined,
    addSource: (id: string, source: { data: unknown }) => data.set(id, source.data),
    getLayer: () => true, fitBounds: vi.fn(), easeTo: vi.fn(),
  };
  let historyRequests = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/track?')) {
      historyRequests++;
      return { ok: true, json: async () => ({ segments: [[initial]] }) };
    }
    return { ok: true, json: async () => ({ vessels: [{ ...initial, stale: false }] }) };
  }));
  const { result, rerender, unmount } = renderHook(({ live }) => useVesselTracking(map as unknown as MapLibreMap, () => {}, live), { initialProps: { live: [initial] } });
  await act(async () => { result.current.show(initial, 'track'); });
  await act(async () => { result.current.follow(initial.mmsi); });
  act(() => rerender({ live: [next] }));
  expect(result.current.mapVessels[0]?.lon).toBe(next.lon);
  expect(data.get('ais-tracked').features[0].geometry.coordinates).toEqual([next.lon, next.lat]);
  expect(data.get('ais-history').features[0].geometry.coordinates).toEqual([[initial.lon, initial.lat], [next.lon, next.lat]]);
  expect(map.easeTo).toHaveBeenLastCalledWith({ center: [next.lon, next.lat], duration: 500 });
  expect(historyRequests).toBe(1);
  // Leaving the viewport or receiving an older viewport snapshot cannot rewind it.
  act(() => rerender({ live: [] }));
  expect(result.current.mapVessels[0]?.lon).toBe(next.lon);
  act(() => rerender({ live: [initial] }));
  expect(result.current.mapVessels[0]?.lon).toBe(next.lon);
  expect(data.get('ais-tracked').features[0].geometry.coordinates).toEqual([next.lon, next.lat]);
  act(() => result.current.follow(null));
  expect(data.get('ais-tracked').features).toHaveLength(1);
  act(() => result.current.hideTrack());
  expect(data.get('ais-tracked').features).toHaveLength(0);
  expect(data.get('ais-history').features).toHaveLength(0);
  unmount();
});

it('keeps multiple colored tracks live without following and hides each independently', async () => {
  vi.useFakeTimers();
  const now = Date.now();
  const first = { mmsi: 276779000, name: 'First', lat: 59, lon: 24, timestamp: new Date(now - 30000).toISOString(), source: 'digitraffic' as const };
  const second = { ...first, mmsi: 230000002, name: 'Second', lon: 25 };
  const live = [first, second];
  const data = new Map<string, any>();
  const map = {
    getStyle: () => ({}), on: vi.fn(), off: vi.fn(),
    getSource: (id: string) => data.has(id) ? { setData: (value: unknown) => data.set(id, value) } : undefined,
    addSource: (id: string, source: { data: unknown }) => data.set(id, source.data),
    getLayer: () => true, fitBounds: vi.fn(), easeTo: vi.fn(),
  };
  const requests: number[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/track?')) {
      const mmsi = Number(url.split('/')[4]);
      requests.push(mmsi);
      const v = live.find(v => v.mmsi === mmsi)!;
      return { ok: true, json: async () => ({ segments: [[{ ...v, lon: v.lon - 0.001, timestamp: new Date(now - 60000).toISOString() }, v]] }) };
    }
    return { ok: true, json: async () => ({ vessels: live.map(v => ({ ...v, stale: false })) }) };
  }));
  const { result, rerender, unmount } = renderHook(({ live }) => useVesselTracking(map as unknown as MapLibreMap, () => {}, live), { initialProps: { live } });
  try {
    await act(async () => { result.current.show(first); });
    await act(async () => { result.current.show(second); });
    expect(result.current.activeTracks).toHaveLength(2);
    expect(result.current.following).toBeNull();
    const features = () => data.get('ais-history').features;
    expect(features()).toHaveLength(2);
    expect(new Set(features().map((f: any) => f.properties.color)).size).toBe(2);
    const newer = live.map(v => ({ ...v, lon: v.lon + 0.001, timestamp: new Date(now).toISOString() }));
    act(() => rerender({ live: newer }));
    for (const v of newer) {
      expect(features().find((f: any) => f.properties.mmsi === v.mmsi).geometry.coordinates.at(-1)).toEqual([v.lon, v.lat]);
    }
    act(() => result.current.close());
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(requests.filter(id => id === first.mmsi)).toHaveLength(2);
    expect(requests.filter(id => id === second.mmsi)).toHaveLength(2);
    act(() => result.current.hideTrack(first.mmsi));
    expect(features()).toHaveLength(1);
    expect(features()[0].properties.mmsi).toBe(second.mmsi);
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(requests.filter(id => id === first.mmsi)).toHaveLength(2);
    expect(requests.filter(id => id === second.mmsi)).toHaveLength(3);
    expect(data.get('ais-tracked').features).toHaveLength(1);
    act(() => result.current.hideTrack(second.mmsi));
    expect(features()).toHaveLength(0);
    expect(data.get('ais-tracked').features).toHaveLength(0);
  } finally { unmount(); vi.useRealTimers(); }
});
