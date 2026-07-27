import type { Track, TrackSummary } from '@seapro/shared';

/**
 * Kaatri radade liides.
 *
 * IMPLEMENTATSIOONE VEEL POLE — see fail on sihilikult ette valmistatud, et
 * hilisem lisamine ei nõuaks ülejäänud süsteemi muutmist. `/api/tracks`
 * marsruut, kaardi kihigrupp ja frontendi tüübid on juba olemas ja ootavad
 * ainult allikat.
 *
 * Kaks realistlikku teed, kumbki sobib selle liidese taha:
 *
 * 1. **GPX / GeoJSON import.** C-MAP Embark ekspordib GPX-i, nagu ka enamik
 *    plotereid ja navigatsiooniäppe. See töötab kindlasti ja ei sõltu ühestki
 *    välisest API-st. Sobib ajalooliste radade jaoks.
 *
 * 2. **Traccar.** Avatud lähtekoodiga serverirakendus + tasuta Traccar Client
 *    äpp telefonis; REST + WebSocket asukohtade ja ajaloo jaoks. Annab
 *    REAALAJAS positsiooni, mitte ainult salvestatud raja. Kuna SeaPro server
 *    on niikuinii ise majutatud, on see märksa realistlikum kui C-MAP, millel
 *    avalikku arendajaliidest ei ole.
 *
 * C-MAP-i enda API-adapter saab lisanduda samamoodi, KUI nad avaliku
 * liidese avaldavad. Praegu seda ei ole — vt docs/data-sources.md.
 */
export interface TrackProvider {
  readonly id: string;
  readonly label: string;

  /** Saadaolevad rajad ilma punktideta — nimekirja jaoks. */
  list(): Promise<TrackSummary[]>;

  /** Üks rada koos punktidega. */
  get(id: string): Promise<Track | null>;

  /**
   * Reaalajas positsioonivoog, kui allikas seda toetab (Traccar toetab,
   * GPX-import loomulikult mitte).
   */
  live?(): AsyncIterable<{ trackId: string; lat: number; lon: number; time: string }>;
}

/** Registreeritud rajaallikad. Praegu tühi — vt faili päist. */
export const trackProviders: TrackProvider[] = [];
