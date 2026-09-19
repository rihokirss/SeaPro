import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Map as MapLibreMap, GeoJSONSource } from 'maplibre-gl';
import type { TrackedVessel, Vessel } from '@seapro/shared';
import { distanceMetres } from '@seapro/shared';
import { useVesselTracks, type TrackRange } from './vesselTracks';
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
const NO_VESSELS: Vessel[] = [];

/** One freshest report drives both the regular vessel layer and its selection. */
export function mergeVesselPositions(live: Vessel[], stored: TrackedVessel[]): TrackedVessel[] {
  const positions = new Map(stored.map(v => [v.mmsi, v]));
  for (const v of live) {
    const old = positions.get(v.mmsi);
    if (!old || Date.parse(v.timestamp) >= Date.parse(old.timestamp)) {
      positions.set(v.mmsi, { ...old, ...v, stale: Date.now() - Date.parse(v.timestamp) > 30 * 60000 });
    }
  }
  return [...positions.values()];
}

type TrackPosition = Pick<Vessel, 'lat' | 'lon' | 'timestamp'>;
/** Only actual AIS reports extend the displayed track; history remains unchanged. */
export function extendLiveTrack(segments: TrackPosition[][], reports: Vessel[]): TrackPosition[][] {
  const result = segments.map(segment => [...segment]);
  for (const report of [...reports].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))) {
    if (!Number.isFinite(Date.parse(report.timestamp))) continue;
    const last = result.at(-1)?.at(-1);
    const seconds = last ? (Date.parse(report.timestamp) - Date.parse(last.timestamp)) / 1000 : 0;
    if (last && seconds <= 0) continue;
    if (!last || seconds > 900 || distanceMetres(last, report) / seconds > 100 * 1852 / 3600) {
      result.push([report]);
    } else result.at(-1)!.push(report);
  }
  return result;
}

export function useVesselTracking(map: MapLibreMap | null, onFollow: () => void, liveVessels: Vessel[] = NO_VESSELS) {
  const [favorites, setFavorites] = useState(loadVesselFavorites),
    [storageError, setStorageError] = useState(false);
  const [open, setOpen] = useState(false),
    [selected, setSelected] = useState<VesselFavorite | null>(null),
    [following, setFollowing] = useState<number | null>(null);
  const [storedVessels, setVessels] = useState<TrackedVessel[]>([]);
  const [error, setError] = useState<string | null>(null);
  const tracks = useVesselTracks();
  const activeTracks = useMemo(() => Object.values(tracks.active), [tracks.active]);
  const candidate = selected ? tracks.results[selected.mmsi] : undefined;
  const result = candidate && candidate.entry === tracks.active[candidate.entry.vessel.mmsi] ? candidate : undefined;
  const track = result?.track ?? null;
  const range = selected ? tracks.active[selected.mmsi]?.range ?? null : null;
  const loading = result?.loading ?? false;
  const trackError = result?.error ?? null;
  const setRange = (range: TrackRange) => { if (selected) tracks.showTrack(selected, range); };
  const vessels = useMemo(() => mergeVesselPositions(liveVessels, storedVessels), [liveVessels, storedVessels]);
  const [liveTails, setLiveTails] = useState<Record<number, Vessel[]>>({});
  useEffect(() => {
    setLiveTails(old => {
      const next: Record<number, Vessel[]> = {};
      for (const entry of activeTracks) {
        if (!entry.range.live) continue;
        const v = vessels.find(v => v.mmsi === entry.vessel.mmsi);
        const tail = old[entry.vessel.mmsi] ?? [];
        next[entry.vessel.mmsi] = v && tail.at(-1)?.timestamp !== v.timestamp ? [...tail, v].slice(-512) : tail;
      }
      return next;
    });
  }, [activeTracks, vessels]);
  const displayedTracks = useMemo(() => activeTracks.map(entry => {
    const result = tracks.results[entry.vessel.mmsi];
    const track = result?.entry === entry ? result.track : null;
    const v = vessels.find(v => v.mmsi === entry.vessel.mmsi);
    const segments = track?.segments ?? [];
    const since = Date.now() - (Date.parse(entry.range.to) - Date.parse(entry.range.from));
    const reports = [...(liveTails[entry.vessel.mmsi] ?? []), ...(v ? [v] : [])].filter(v => Date.parse(v.timestamp) >= since);
    return { ...entry, segments: entry.range.live && track ? extendLiveTrack(segments, reports) : segments };
  }), [activeTracks, tracks.results, vessels, liveTails]);
  const mapVessels = useMemo(() => {
    const merged = new Map(vessels.map(v => [v.mmsi, v]));
    const result: Vessel[] = liveVessels.map(v => merged.get(v.mmsi) ?? v);
    for (const v of vessels) {
      if ((v.mmsi === following || tracks.active[v.mmsi]) && !result.some(item => item.mmsi === v.mmsi)) result.push(v);
    }
    return result;
  }, [vessels, liveVessels, following, tracks.active]);
  const followingRef = useRef(following);
  followingRef.current = following;
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
      if (action === 'favorite') toggleFavorite(v);
      if (action === 'follow') follow(v.mmsi);
      if (action === 'track') tracks.showTrack(v);
    },
    [follow, toggleFavorite, tracks.showTrack],
  );
  const ids = [
    ...new Set([
      ...favorites.map((v) => v.mmsi),
      ...activeTracks.map(entry => entry.vessel.mmsi),
      ...(selected ? [selected.mmsi] : []),
      ...(following ? [following] : []),
    ]),
  ].join(',');
  useEffect(() => {
    const wanted = new Set(ids.split(',').map(Number));
    const visible = liveVessels.filter(v => wanted.has(v.mmsi));
    if (visible.length) setVessels(current => mergeVesselPositions(visible, current));
  }, [ids, liveVessels]);
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
          setVessels(current => mergeVesselPositions(responses.flatMap(r => r.vessels), current)
            .filter(v => list.includes(String(v.mmsi))));
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
    if (!map) return;
    const v = vessels.find((v) => v.mmsi === following);
    if (v && !v.stale) map.easeTo({ center: [v.lon, v.lat], duration: 500 });
  }, [map, following, vessels, error]);
  useEffect(() => {
    if (!map || !track || tracks.fitMmsi.current !== selected?.mmsi) return;
    tracks.fitMmsi.current = null;
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
  }, [map, track, selected?.mmsi, tracks.fitMmsi]);
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
        features: displayedTracks.flatMap(entry => entry.segments.filter(segment => segment.length >= 2).map(segment => ({
          type: 'Feature' as const,
          properties: { mmsi: entry.vessel.mmsi, color: entry.color },
          geometry: { type: 'LineString' as const, coordinates: segment.map(p => [p.lon, p.lat]) },
        }))),
      };
      if (!map.getSource('ais-history')) map.addSource('ais-history', { type: 'geojson', data });
      else map.getSource<GeoJSONSource>('ais-history')!.setData(data);
      if (!map.getLayer('ais-history-line'))
        map.addLayer({
          id: 'ais-history-line',
          type: 'line',
          source: 'ais-history',
          paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-opacity': 0.85 },
        });
      const marker: GeoJSON.FeatureCollection = {
        type: 'FeatureCollection',
        features: vessels.filter(v => v.mmsi === following || tracks.active[v.mmsi]).map(v => ({
          type: 'Feature',
          properties: { mmsi: v.mmsi, stale: v.stale, color: tracks.active[v.mmsi]?.color ?? '#edb85e' },
          geometry: { type: 'Point', coordinates: [v.lon, v.lat] },
        })),
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
            'circle-stroke-color': ['case', ['get', 'stale'], '#999', ['get', 'color']],
          },
        });
    };
    render();
    map.on('style.load', render);
    return () => {
      map.off('style.load', render);
    };
  }, [map, displayedTracks, vessels, tracks.active, following]);
  const close = () => setOpen(false);
  const hideTrack = (mmsi = selected?.mmsi) => { if (mmsi) tracks.hideTrack(mmsi); };
  const select = (vessel: VesselFavorite) => { setSelected(vessel); setOpen(true); };

  return {
    activeTracks,
    trackResults: tracks.results,
    select,
    mapVessels,
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
