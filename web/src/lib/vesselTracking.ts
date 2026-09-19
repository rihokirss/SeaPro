import { useCallback, useEffect, useRef, useState } from 'react';
import type { Map as MapLibreMap, GeoJSONSource } from 'maplibre-gl';
import type { TrackedVessel, VesselTrack } from '@seapro/shared';
import { getSessionId } from './session';

export interface VesselFavorite {
  mmsi: number;
  name: string;
}
const KEY = 'seapro.vessel-favorites';
export function loadVesselFavorites(): VesselFavorite[] {
  try {
    const d = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (d?.version !== 1 || !Array.isArray(d.items)) return [];
    return [
      ...new Map<number, VesselFavorite>(
        d.items
          .filter(
            (x: any) =>
              Number.isInteger(x.mmsi) && x.mmsi > 0 && x.mmsi <= 999999999 && typeof x.name === 'string',
          )
          .slice(0, 100)
          .map(
            (x: VesselFavorite) =>
              [x.mmsi, { mmsi: x.mmsi, name: x.name.slice(0, 100) }] as [number, VesselFavorite],
          ),
      ).values(),
    ];
  } catch {
    return [];
  }
}
async function request<T>(url: string, signal: AbortSignal): Promise<T> {
  const r = await fetch(url, { signal, headers: { 'x-seapro-session': getSessionId() } });
  if (!r.ok) throw new Error('history.unavailable');
  return r.json();
}
export function useVesselTracking(map: MapLibreMap | null, onFollow: () => void) {
  const [favorites, setFavorites] = useState(loadVesselFavorites),
    [storageError, setStorageError] = useState(false);
  const [open, setOpen] = useState(false),
    [selected, setSelected] = useState<VesselFavorite | null>(null),
    [following, setFollowing] = useState<number | null>(null);
  const [vessels, setVessels] = useState<TrackedVessel[]>([]),
    [error, setError] = useState<string | null>(null),
    [trackError, setTrackError] = useState<string | null>(null);
  const [track, setTrack] = useState<VesselTrack | null>(null),
    [loading, setLoading] = useState(false);
  const [range, setRange] = useState<{ from: string; to: string; live?: boolean } | null>(null);
  const trackController = useRef<AbortController | null>(null);
  const followingRef = useRef(following);
  followingRef.current = following;
  const fitTrack = useRef(false);
  const callback = useRef(onFollow);
  callback.current = onFollow;
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ version: 1, items: favorites }));
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  }, [favorites]);
  const toggleFavorite = useCallback(
    (v: VesselFavorite) =>
      setFavorites((current) =>
        current.some((x) => x.mmsi === v.mmsi)
          ? current.filter((x) => x.mmsi !== v.mmsi)
          : current.length < 100
            ? [...current, v]
            : current,
      ),
    [],
  );
  const follow = useCallback((mmsi: number | null) => {
    if (mmsi) callback.current();
    setFollowing(mmsi);
  }, []);
  const show = useCallback(
    (v: VesselFavorite, action: 'track' | 'follow' | 'favorite' = 'track') => {
      setSelected(v);
      setOpen(true);
      if (selected?.mmsi !== v.mmsi) {
        setTrack(null);
        setRange(null);
        setTrackError(null);
        setLoading(false);
        trackController.current?.abort();
        follow(null);
      }
      if (action === 'favorite') toggleFavorite(v);
      if (action === 'follow') follow(v.mmsi);
      if (action === 'track') {
        const to = Date.now();
        setRange({ from: new Date(to - 86400000).toISOString(), to: new Date(to).toISOString(), live: true });
      }
    },
    [follow, toggleFavorite, selected?.mmsi],
  );
  const ids = [
    ...new Set([
      ...favorites.map((v) => v.mmsi),
      ...(selected ? [selected.mmsi] : []),
      ...(following ? [following] : []),
    ]),
  ].join(',');
  useEffect(() => {
    if (!ids) {
      setVessels([]);
      return;
    }
    const controller = new AbortController();
    let busy = false;
    const load = async () => {
      if (busy) return;
      busy = true;
      try {
        const list = ids.split(',');
        const responses = await Promise.all(
          Array.from({ length: Math.ceil(list.length / 100) }, (_, i) =>
            request<{ vessels: TrackedVessel[] }>(
              `/api/ais/vessels?mmsi=${list.slice(i * 100, (i + 1) * 100).join(',')}`,
              controller.signal,
            ),
          ),
        );
        if (!controller.signal.aborted) {
          setVessels(responses.flatMap((r) => r.vessels));
          setError(null);
        }
      } catch {
        if (!controller.signal.aborted) setError('history.unavailable');
      } finally {
        busy = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 30000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [ids]);
  useEffect(() => {
    if (!selected || !range) return;
    const controller = new AbortController();
    trackController.current = controller;
    setLoading(true);
    setTrackError(null);
    setTrack(null);
    fitTrack.current = true;
    let busy = false;
    const load = async (refresh = false) => {
      if (busy || controller.signal.aborted) return;
      busy = true;
      const to = refresh ? Date.now() : Date.parse(range.to);
      const duration = Date.parse(range.to) - Date.parse(range.from);
      const query = { from: new Date(to - duration).toISOString(), to: new Date(to).toISOString() };
      try {
        const data = await request<VesselTrack>(
          `/api/ais/vessels/${selected.mmsi}/track?${new URLSearchParams(query)}`,
          controller.signal,
        );
        if (!controller.signal.aborted) {
          setTrack(data);
          setTrackError(null);
        }
      } catch {
        if (!controller.signal.aborted) setTrackError('history.unavailable');
      } finally {
        busy = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    const timer = setInterval(() => {
      if (range.live && followingRef.current === selected.mmsi) void load(true);
    }, 30000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [selected?.mmsi, range]);
  useEffect(() => {
    if (!map) return;
    const v = vessels.find((v) => v.mmsi === following);
    if (v && !v.stale && !error) map.easeTo({ center: [v.lon, v.lat], duration: 500 });
  }, [map, following, vessels, error]);
  useEffect(() => {
    if (!map || !track || !fitTrack.current) return;
    fitTrack.current = false;
    if (followingRef.current) return;
    const points = track.segments.flat();
    if (!points.length) return;
    const west = Math.min(...points.map((p) => p.lon)),
      east = Math.max(...points.map((p) => p.lon)),
      south = Math.min(...points.map((p) => p.lat)),
      north = Math.max(...points.map((p) => p.lat));
    map.fitBounds(
      [
        [west, south],
        [east, north],
      ],
      { padding: 70, maxZoom: 14, duration: 500 },
    );
  }, [map, track]);
  useEffect(() => {
    if (!map) return;
    const stop = () => setFollowing(null);
    map.on('dragstart', stop);
    return () => {
      map.off('dragstart', stop);
    };
  }, [map]);
  useEffect(() => {
    if (!map) return;
    const render = () => {
      // isStyleLoaded also waits for every source/tile. Only the style itself
      // must exist to add layers or update our GeoJSON during map loading.
      if (!map.getStyle()) return;
      const data: GeoJSON.FeatureCollection = {
        type: 'FeatureCollection',
        features:
          track?.segments
            .filter((s) => s.length >= 2)
            .map((s) => ({
              type: 'Feature',
              properties: {},
              geometry: { type: 'LineString', coordinates: s.map((p) => [p.lon, p.lat]) },
            })) ?? [],
      };
      if (!map.getSource('ais-history')) map.addSource('ais-history', { type: 'geojson', data });
      else map.getSource<GeoJSONSource>('ais-history')!.setData(data);
      if (!map.getLayer('ais-history-line'))
        map.addLayer({
          id: 'ais-history-line',
          type: 'line',
          source: 'ais-history',
          paint: { 'line-color': '#edb85e', 'line-width': 3, 'line-opacity': 0.85 },
        });
      const selectedVessel = vessels.find((v) => v.mmsi === selected?.mmsi || v.mmsi === following);
      const marker: GeoJSON.FeatureCollection = {
        type: 'FeatureCollection',
        features: selectedVessel
          ? [
              {
                type: 'Feature',
                properties: { stale: selectedVessel.stale },
                geometry: { type: 'Point', coordinates: [selectedVessel.lon, selectedVessel.lat] },
              },
            ]
          : [],
      };
      if (!map.getSource('ais-tracked')) map.addSource('ais-tracked', { type: 'geojson', data: marker });
      else map.getSource<GeoJSONSource>('ais-tracked')!.setData(marker);
      if (!map.getLayer('ais-tracked-marker'))
        map.addLayer({
          id: 'ais-tracked-marker',
          type: 'circle',
          source: 'ais-tracked',
          paint: {
            'circle-radius': 10,
            'circle-color': 'transparent',
            'circle-stroke-width': 3,
            'circle-stroke-color': ['case', ['get', 'stale'], '#999', '#edb85e'],
          },
        });
    };
    render();
    map.on('style.load', render);
    return () => {
      map.off('style.load', render);
    };
  }, [map, track, vessels, selected, following]);
  const close = () => setOpen(false);
  const hideTrack = () => {
    trackController.current?.abort();
    setTrack(null);
    setRange(null);
    setLoading(false);
  };
  return {
    hideTrack,
    favorites,
    storageError,
    open,
    setOpen,
    selected,
    following,
    vessels,
    error,
    trackError,
    track,
    loading,
    range,
    setRange,
    toggleFavorite,
    follow,
    show,
    close,
  };
}
