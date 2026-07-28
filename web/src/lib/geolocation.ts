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
  /** Lõpetab jälgimise ja jätab valiku meelde. */
  stop(): void;
  /** Kas kasutaja on asukoha jälgimise sisse lülitanud. */
  followMe: boolean;
  setFollowMe(v: boolean): void;
}

const STORAGE_KEY = 'seapro.followMe';

/**
 * Kas asukoha jälgimine oli eelmisel korral sees.
 *
 * Vaikimisi EI OLE. Varem käivitus jälgimine ise kohe, kui brauseriluba oli
 * olemas — telefonis tähendas see, et rakendus võttis igal avamisel GPS-i
 * tööle ja tiris kaardi kasutaja juurde, ka siis, kui too tahtis lihtsalt
 * Läänemerd vaadata. Luba "jah, tohib küsida" ei ole sama mis "jälgi mind
 * alati".
 */
function loadFollowMe(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    // Privaatrežiim või keelatud salvestus — vaikeväärtus on niikuinii "väljas".
    return false;
  }
}

function saveFollowMe(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
  } catch {
    // Meeldejätmine on mugavus, mitte tingimus — vaikimisi ei tohi kukkuda.
  }
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
 * Käivitusel jätkame jälgimist ainult siis, kui kasutaja ise on selle varem
 * sisse lülitanud (`seapro.followMe`) JA luba on olemas — siis ei näe ta ka
 * lubade dialoogi uuesti. Muidu ootame nupuvajutust.
 */
export function useGeolocation(): GeoState {
  const [status, setStatus] = useState<GeoStatus>('idle');
  const [position, setPosition] = useState<Position | null>(null);
  const [followMe, setFollowMeState] = useState(loadFollowMe);
  const watchId = useRef<number | null>(null);

  /** Iga muutus läheb ka salvestusse — valik peab üle avamise püsima. */
  const setFollowMe = useCallback((on: boolean) => {
    setFollowMeState(on);
    saveFollowMe(on);
  }, []);

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

  /**
   * Lõpetab jälgimise.
   *
   * `clearWatch` on siin oluline ka aku pärast: `enableHighAccuracy` hoiab
   * telefonis GPS-i vastuvõtjat töös ja "väljas" peab tähendama päriselt
   * väljas, mitte ainult seda, et kaart enam ei tsentreeri.
   */
  const stopWatching = useCallback(() => {
    if (watchId.current !== null) {
      navigator.geolocation.clearWatch(watchId.current);
      watchId.current = null;
    }
    setStatus((s) => (s === 'ok' || s === 'locating' ? 'idle' : s));
  }, []);

  const request = useCallback(() => {
    setFollowMe(true);
    start();
  }, [start, setFollowMe]);

  const stop = useCallback(() => {
    setFollowMe(false);
    stopWatching();
  }, [setFollowMe, stopWatching]);

  // Jätkame jälgimist ainult siis, kui kasutaja ise on selle sisse lülitanud.
  // Luba üksi ei piisa: "tohib küsida" ei ole sama mis "jälgi mind alati".
  useEffect(() => {
    if (!('permissions' in navigator) || !window.isSecureContext) return;
    let cancelled = false;
    navigator.permissions
      .query({ name: 'geolocation' as PermissionName })
      .then((res) => {
        if (cancelled) return;
        if (res.state === 'granted') {
          if (loadFollowMe()) start();
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

  return { status, position, request, stop, followMe, setFollowMe };
}
