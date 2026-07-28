import type { Map as MapLibreMap } from 'maplibre-gl';
import { setColorBaseVisible } from './colorBase';
import { setDarkBaseVisible } from './darkBase';

/**
 * Aluskaardi vahetus, kui valevärvi-väli on peal.
 *
 * Probleem: OSM on ise värviline — roheline mets, kollased teed, HELE vesi.
 * Selle peale pandud tuule- või lainegradient tekitab kaks võistlevat
 * värvisüsteemi ja kumbki ei loe korralikult.
 *
 * Kolm katset, selles järjekorras:
 *
 *  1. OSM tuhmiks `raster-saturation` ja `brightness`-iga. Värv kadus, aga
 *     VESI jäi heledaks — rasterkihil saab muuta ainult tervikpilti.
 *  2. Valmis tume paanistik (CARTO `dark_nolabels`). Seal on asi hoopis
 *     tagurpidi: mõõdetult meri 38, maa 11 ehk vesi on maast HELEDAM.
 *     Esri Dark Gray Canvas annab õige suuna (meri 35, maa 70), aga on
 *     üldistatud — sadamaakvatooriume, muule ja kaisid seal pole.
 *  3. Ise kokku pandud VEKTORSTIIL. Vesi on vektorkaardil oma kihina olemas,
 *     seega saab talle värvi otse määrata ja kogu OSM-i detail jääb alles.
 *     Vt `darkBase.ts`.
 *
 * MIDA ME EI PUUDUTA: merekaarti, navigatsioonimärke ega radarit. Nende
 * värv KANNAB TÄHENDUST — punane ja roheline poi, punane sajuala.
 */

export function setBasemapMuted(map: MapLibreMap, muted: boolean): void {
  setDarkBaseVisible(map, muted);
  setColorBaseVisible(map, !muted);
}
