import { useCallback, useEffect, useRef, useState } from 'react';

export interface Position {
  lat: number;
  lon: number;
  /** Meetrites. */
  accuracy: number;
  /** Kraadi, kui seade seda annab (liikumisel). */
  heading: number | null;
  /** m/s, kui seade seda annab. */
  speed: number | null;
  timestamp: number;
}

export type GeoStatus = 'idle' | 'locating' | 'ok' | 'denied' | 'unavailable' | 'insecure';

export interface GeoState {
  status: GeoStatus;
  position: Position | null;
  /** Küsib ühe värske asukoha ja annab selle kutsujale kaardi tsentreerimiseks. */
  request(onLocated?: (position: Position) => void): void;
  watching: boolean;
  startWatch(): void;
  stopWatch(): void;
}

/**
 * GPS-asukoht.
 *
 * Nupp on ühekordne käsklus, mitte jälgimisrežiim: küsime ühe värske ja suure
 * täpsusega asukoha ning jätame kaardi pärast tsentreerimist kasutaja juhtida.
 */
export function useGeolocation(): GeoState {
  const [status, setStatus] = useState<GeoStatus>('idle');
  const [position, setPosition] = useState<Position | null>(null);
  const [watching, setWatching] = useState(false);
  const watchId = useRef<number | null>(null);

  const fromBrowser = (pos: GeolocationPosition): Position => ({
    lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy,
    heading: Number.isFinite(pos.coords.heading) ? pos.coords.heading : null,
    speed: Number.isFinite(pos.coords.speed) ? pos.coords.speed : null,
    timestamp: pos.timestamp,
  });

  const locate = useCallback((opts: {
    onLocated?: (position: Position) => void;
    quiet?: boolean;
    maximumAge?: number;
  }) => {
    if (!('geolocation' in navigator)) {
      if (!opts.quiet) setStatus('unavailable');
      return;
    }
    // Brauserid keelavad geolocation'i ebaturvalisel päritolul. Ilma selle
    // kontrollita saaks kasutaja lihtsalt vaikiva timeout'i ja ei mõistaks, miks.
    if (!window.isSecureContext) {
      setStatus('insecure');
      return;
    }
    if (!opts.quiet) setStatus('locating');

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const next = fromBrowser(pos);
        setPosition(next);
        setStatus('ok');
        opts.onLocated?.(next);
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) setStatus('denied');
        else if (!opts.quiet) setStatus('unavailable');
      },
      {
        enableHighAccuracy: true,
        // Merel liigutakse aeglaselt; 10 s vana asukoht on täiesti kõlblik ja
        // säästab akut.
        maximumAge: opts.maximumAge ?? 10_000,
        timeout: 20_000,
      },
    );
  }, []);

  const request = useCallback((onLocated?: (position: Position) => void) => {
    locate({ onLocated });
  }, [locate]);

  const stopWatch = useCallback(() => {
    if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current);
    watchId.current = null; setWatching(false);
  }, []);

  const startWatch = useCallback(() => {
    if (watchId.current !== null || !('geolocation' in navigator) || !window.isSecureContext) return;
    setStatus('locating'); setWatching(true);
    watchId.current = navigator.geolocation.watchPosition(
      (pos) => { setPosition(fromBrowser(pos)); setStatus('ok'); },
      (err) => { if (err.code === err.PERMISSION_DENIED) setStatus('denied'); else setStatus('unavailable'); stopWatch(); },
      { enableHighAccuracy: true, maximumAge: 2_000, timeout: 20_000 },
    );
  }, [stopWatch]);

  /* Kui kasutaja on asukohaloa juba varem andnud, küsime ühe punkti vaikselt
     ette. See ei ava loaküsimust ega käivita jälgimisrežiimi, aga võimaldab
     nupul olemasoleva koordinaadi peale kohe liikuda nagu kaardirakendustes
     tavaks. Kuni minuti vanune brauseri cache sobib selleks esimeseks hüppeks;
     nupuvajutus värskendab punkti kohe suurema värskusnõudega taustal. */
  useEffect(() => {
    if (!('permissions' in navigator) || !window.isSecureContext) return;
    let cancelled = false;
    navigator.permissions
      .query({ name: 'geolocation' as PermissionName })
      .then((permission) => {
        if (cancelled) return;
        if (permission.state === 'granted') locate({ quiet: true, maximumAge: 60_000 });
        else if (permission.state === 'denied') setStatus('denied');
      })
      .catch(() => {
        // Vanem Safari: asukohta küsime alles nupuvajutusel.
      });
    return () => {
      cancelled = true;
    };
  }, [locate]);

  useEffect(() => stopWatch, [stopWatch]);

  return { status, position, request, watching, startWatch, stopWatch };
}
