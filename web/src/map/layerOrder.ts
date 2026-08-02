import type { Map as MapLibreMap } from 'maplibre-gl';

/**
 * Kaardikihtide järjekord ühes kohas.
 *
 * MapLibre lisab uue kihi vaikimisi kõige PEALE. Kuna meie kihid tekivad
 * asünkroonselt (igaüks siis, kui ta andmed saabuvad), sõltuks järjekord
 * muidu sellest, milline päring juhtus enne lõppema — ja tulemus oli täpselt
 * see viga, mille pärast see fail sündis: poolläbipaistev tuuleväli maandus
 * laevade ja mõõtejaamade peale ning kattis need kinni.
 *
 * Nüüd ütleb iga kiht lisamisel, KUHU ta kuulub, ja `insertBefore` leiab
 * esimese juba olemasoleva kihi, mis peab jääma temast kõrgemale.
 *
 * Järjekord alt üles: taust ja kaardid -> ilmaväljad -> objektid -> oma asukoht.
 * Loogika: ilm on kontekst, objektid on info, oma asukoht on alati nähtav.
 */
export const LAYER_ORDER = [
  // Rasteraluskaardid ja overlay'd lisab MapView ise, need jäävad allapoole.
  'scalar-field',
  'wind-arrows',
  'place-labels',
  'place-labels-minor',
  'place-labels-islands',
  'official-fairways',
  'navigation-warning-areas',
  'navigation-warning-line-hit',
  'navigation-warning-lines',
  'navigation-warning-points',
  'wrecks',
  'wreck-labels',
  'navigation-aid-alerts',
  'navigation-aids',
  'navigation-aid-labels',
  'tracks-line',
  'vessel-hulls',
  'vessel-hulls-line',
  'vessels',
  'vessels-labels',
  // Ankrukohad sadamate ALL: neid on kordades rohkem ja sadam on tähtsam
  // orientiir — kattumisel peab peale jääma sadam.
  'anchorages',
  'anchorages-labels',
  'harbours',
  'harbours-labels',
  'stations-dots',
  'stations-labels',
  'own-position-accuracy',
  'own-position',
] as const;

export type LayerId = (typeof LAYER_ORDER)[number];

/**
 * Millise olemasoleva kihi ETTE tuleb `id` lisada, et järjekord säiliks.
 * Tagastab `undefined`, kui midagi kõrgemat pole veel olemas — siis läheb
 * kiht kõige peale, mis on õige.
 */
export function insertBefore(map: MapLibreMap, id: LayerId): string | undefined {
  const index = LAYER_ORDER.indexOf(id);
  if (index < 0) return undefined;

  for (let i = index + 1; i < LAYER_ORDER.length; i++) {
    const above = LAYER_ORDER[i]!;
    if (map.getLayer(above)) return above;
  }
  return undefined;
}
