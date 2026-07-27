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
  /** Käivitab asukoha jälgimise ja tsentreerib kaardi (kasutaja vajutas nuppu). */
  request(): void;
  /** Kas kasutaja on selle sessiooni jooksul asukohta selgesõnaliselt küsinud. */
  followMe: boolean;
  setFollowMe(v: boolean): void;
}

/**
 * GPS-asukoht.
 *
 * Kaks olulist asja kaatri jaoks:
 *  1. `watchPosition`, mitte `getCurrentPosition` — asukoht uueneb liikudes
 *     ise, ilma et kasutaja peaks nuppu vajutama.
 *  2. `enableHighAccuracy: true` — telefonis tähendab see päris GPS-i, mitte
 *     mobiilimasti asukohta. Merel on mastipõhine asukoht kasutu.
 *
 * Käivitusel proovime asukohta saada kohe, KUI luba on juba antud. Nii avaneb
 * rakendus järgmisel korral otse kasutaja asukohas, ilma lubade dialoogita.
 */
export function useGeolocation(): GeoState {
  const [status, setStatus] = useState<GeoStatus>('idle');
  const [position, setPosition] = useState<Position | null>(null);
  const [followMe, setFollowMe] = useState(false);
  const watchId = useRef<number | null>(null);

  const start = useCallback(() => {
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
    if (watchId.current !== null) return;

    setStatus((s) => (s === 'ok' ? s : 'locating'));

    watchId.current = navigator.geolocation.watchPosition(
      (pos) => {
        setPosition({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          heading: Number.isFinite(pos.coords.heading) ? pos.coords.heading : null,
          speed: Number.isFinite(pos.coords.speed) ? pos.coords.speed : null,
          timestamp: pos.timestamp,
        });
        setStatus('ok');
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

  const request = useCallback(() => {
    setFollowMe(true);
    start();
  }, [start]);

  // Kui luba on juba antud, alusta jälgimist kohe — ilma dialoogi näitamata.
  useEffect(() => {
    if (!('permissions' in navigator) || !window.isSecureContext) return;
    let cancelled = false;
    navigator.permissions
      .query({ name: 'geolocation' as PermissionName })
      .then((res) => {
        if (cancelled) return;
        if (res.state === 'granted') {
          setFollowMe(true);
          start();
        } else if (res.state === 'denied') {
          setStatus('denied');
        }
      })
      .catch(() => {
        // Permissions API puudub (vanem Safari) — ootame kasutaja nupuvajutust.
      });
    return () => {
      cancelled = true;
    };
  }, [start]);

  useEffect(() => {
    return () => {
      if (watchId.current !== null) {
        navigator.geolocation.clearWatch(watchId.current);
        watchId.current = null;
      }
    };
  }, []);

  return { status, position, request, followMe, setFollowMe };
}
