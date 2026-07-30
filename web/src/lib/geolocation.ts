import { useCallback, useState } from 'react';

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

  const request = useCallback((onLocated?: (position: Position) => void) => {
    if (!('geolocation' in navigator)) {
      setStatus('unavailable');
      return;
    }
    // Brauserid keelavad geolocation'i ebaturvalisel päritolul. Ilma selle
    // kontrollita saaks kasutaja lihtsalt vaikiva timeout'i ja ei mõistaks, miks.
    if (!window.isSecureContext) {
      setStatus('insecure');
      return;
    }
    setStatus('locating');

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const next: Position = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          heading: Number.isFinite(pos.coords.heading) ? pos.coords.heading : null,
          speed: Number.isFinite(pos.coords.speed) ? pos.coords.speed : null,
          timestamp: pos.timestamp,
        };
        setPosition(next);
        setStatus('ok');
        onLocated?.(next);
      },
      (err) => {
        setStatus(err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable');
      },
      {
        enableHighAccuracy: true,
        // Merel liigutakse aeglaselt; 10 s vana asukoht on täiesti kõlblik ja
        // säästab akut.
        maximumAge: 10_000,
        timeout: 20_000,
      },
    );
  }, []);

  return { status, position, request };
}
