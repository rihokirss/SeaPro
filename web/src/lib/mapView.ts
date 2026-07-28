const STORAGE_KEY = 'seapro.mapView';
const SCHEMA_VERSION = 1;

export interface SavedMapView {
  lat: number;
  lon: number;
  zoom: number;
}

interface Stored extends SavedMapView {
  version: number;
}

/**
 * Viimane kaardivaade.
 *
 * Ilma selleta viskas iga laadimine tagasi Läänemere ülevaatesse, ka siis kui
 * olid just ühte lahte sisse suuminud — kaatris tähendas see iga kord uuesti
 * kohale kerimist.
 *
 * Väärtused valideeritakse RANGELT. Vigane või võõras kirje localStorage'is
 * ei tohi anda tühja ookeanivaadet, mille põhjust kasutaja ei näe; sellisel
 * juhul kukume tagasi serveri vaikeväärtusele.
 */
export function loadMapView(): SavedMapView | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<Stored>;
    if (p.version !== SCHEMA_VERSION) return null;
    const { lat, lon, zoom } = p;
    if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) return null;
    if (typeof lon !== 'number' || !Number.isFinite(lon) || lon < -180 || lon > 180) return null;
    // Ülempiir on sama, mis kaardil endal (`maxZoom: 18`).
    if (typeof zoom !== 'number' || !Number.isFinite(zoom) || zoom < 0 || zoom > 18) return null;
    return { lat, lon, zoom };
  } catch {
    return null;
  }
}

export function saveMapView(view: SavedMapView): void {
  try {
    const payload: Stored = { version: SCHEMA_VERSION, ...view };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Privaatrežiim või täis kvoot — vaate mittesalvestumine ei tohi
    // kaardi liigutamist katki teha.
  }
}
