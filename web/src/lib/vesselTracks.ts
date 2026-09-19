import { useCallback, useEffect, useRef, useState } from 'react';
import type { VesselTrack } from '@seapro/shared';
import { getSessionId } from './session';

export interface TrackRange { from: string; to: string; live?: boolean }
interface TrackVessel { mmsi: number; name: string }
interface ActiveTrack { vessel: TrackVessel; range: TrackRange; color: string }
interface TrackResult { entry: ActiveTrack; track: VesselTrack | null; loading: boolean; error: string | null }
const COLORS = ['#edb85e', '#68cfff', '#e990dc', '#a6dd77', '#ff947d', '#b1a1ff'];

/** Independent requests and lifetimes: selecting one vessel never cancels another's track. */
export function useVesselTracks() {
  const [active, setActive] = useState<Record<number, ActiveTrack>>({});
  const [results, setResults] = useState<Record<number, TrackResult>>({});
  const jobs = useRef(new Map<number, { entry: ActiveTrack; stop: () => void }>());
  const fitMmsi = useRef<number | null>(null);
  const showTrack = useCallback((vessel: TrackVessel, range?: TrackRange) => {
    fitMmsi.current = vessel.mmsi;
    setActive(current => {
      if (current[vessel.mmsi] && !range) return current;
      const to = Date.now();
      return { ...current, [vessel.mmsi]: {
        vessel,
        range: range ?? { from: new Date(to - 86400000).toISOString(), to: new Date(to).toISOString(), live: true },
        color: current[vessel.mmsi]?.color ?? COLORS.find(color => !Object.values(current).some(t => t.color === color)) ?? COLORS[Object.keys(current).length % COLORS.length]!,
      } };
    });
  }, []);
  const hideTrack = useCallback((mmsi: number) => {
    jobs.current.get(mmsi)?.stop();
    jobs.current.delete(mmsi);
    setActive(current => { const next = { ...current }; delete next[mmsi]; return next; });
    setResults(current => { const next = { ...current }; delete next[mmsi]; return next; });
    if (fitMmsi.current === mmsi) fitMmsi.current = null;
  }, []);
  useEffect(() => {
    for (const [mmsi, job] of jobs.current) {
      if (active[mmsi] !== job.entry) { job.stop(); jobs.current.delete(mmsi); }
    }
    for (const entry of Object.values(active)) {
      const { vessel, range } = entry;
      if (jobs.current.has(vessel.mmsi)) continue;
      const controller = new AbortController();
      let busy = false;
      setResults(current => ({ ...current, [vessel.mmsi]: { entry, track: null, loading: true, error: null } }));
      const load = async () => {
        if (busy || controller.signal.aborted) return;
        busy = true;
        const to = range.live ? Date.now() : Date.parse(range.to);
        const duration = Date.parse(range.to) - Date.parse(range.from);
        const query = new URLSearchParams({ from: new Date(to - duration).toISOString(), to: new Date(to).toISOString() });
        try {
          const response = await fetch(`/api/ais/vessels/${vessel.mmsi}/track?${query}`, {
            signal: controller.signal, headers: { 'x-seapro-session': getSessionId() },
          });
          if (!response.ok) throw new Error('history.unavailable');
          const track: VesselTrack = await response.json();
          if (!controller.signal.aborted) setResults(current => ({ ...current, [vessel.mmsi]: { entry, track, loading: false, error: null } }));
        } catch {
          if (!controller.signal.aborted) setResults(current => ({ ...current, [vessel.mmsi]: {
            entry, track: current[vessel.mmsi]?.track ?? null, loading: false, error: 'history.unavailable',
          } }));
        } finally { busy = false; }
      };
      void load();
      const timer = range.live ? setInterval(() => void load(), 30000) : null;
      jobs.current.set(vessel.mmsi, { entry, stop: () => { controller.abort(); if (timer) clearInterval(timer); } });
    }
  }, [active]);
  useEffect(() => () => {
    for (const job of jobs.current.values()) job.stop();
    jobs.current.clear();
  }, []);
  return { active, results, showTrack, hideTrack, fitMmsi };
}
