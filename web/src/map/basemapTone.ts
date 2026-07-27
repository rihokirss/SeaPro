import type { Map as MapLibreMap } from 'maplibre-gl';
import { DEFAULT_BASE_ID, MUTED_BASE_ID } from './basemaps';

/**
 * Aluskaardi vahetus, kui valevärvi-väli on peal.
 *
 * Probleem: OSM on ise värviline — roheline mets, kollased teed, HELE vesi.
 * Selle peale pandud tuule- või lainegradient tekitab kaks võistlevat
 * värvisüsteemi ja kumbki ei loe korralikult.
 *
 * Esimene katse tuhmistas OSM-i `raster-saturation` ja `brightness`-iga.
 * See võttis värvi maha, aga VESI jäi heledaks — rasterkihil saab muuta
 * ainult tervikpilti ja vee eristamiseks pole seal midagi käepärast.
 * Kasutaja märkas seda kohe: "meri pole ikka tumedam".
 *
 * Lahendus on kasutada aluskaarti, mille vesi ONGI tume. CARTO tume stiil
 * annab täpselt selle, ilma võtmeta ja ilma kvoodita.
 *
 * MIDA ME EI PUUDUTA: merekaarti, navigatsioonimärke ega radarit. Nende
 * värv KANNAB TÄHENDUST — punane ja roheline poi, punane sajuala.
 */

/** Väike küllastuse langus tumedal kaardil, et väli oleks ainus värv. */
const DARK_SATURATION = -0.35;

export function setBasemapMuted(map: MapLibreMap, muted: boolean): void {
  const show = muted ? MUTED_BASE_ID : DEFAULT_BASE_ID;
  const hide = muted ? DEFAULT_BASE_ID : MUTED_BASE_ID;

  if (map.getLayer(show)) {
    map.setLayoutProperty(show, 'visibility', 'visible');
    map.setPaintProperty(show, 'raster-saturation', muted ? DARK_SATURATION : 0);
  }
  // Peidetud rasterkihi paane MapLibre ei tõmba, seega teine paanistik ei
  // maksa midagi seni, kuni teda ei näidata.
  if (map.getLayer(hide)) {
    map.setLayoutProperty(hide, 'visibility', 'none');
  }
}
