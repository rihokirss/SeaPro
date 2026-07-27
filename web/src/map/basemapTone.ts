import type { Map as MapLibreMap } from 'maplibre-gl';
import { BASE_LAYERS } from './basemaps';

/**
 * Aluskaardi tuhmistamine, kui valevärvi-väli on peal.
 *
 * Probleem: OSM on ise värviline — roheline mets, kollased teed, sinine vesi.
 * Kui selle peale panna tuule või lainete värvigradient, võistlevad kaks
 * värvisüsteemi omavahel ja kumbki ei loe enam korralikult. Windfinderil on
 * aluskaart sellepärast peaaegu monokroomne.
 *
 * Lahendus MapLibre'is on odav: rasterkihil on `raster-saturation` ja
 * `raster-brightness-min`, mis töötavad GPU-s ega vaja teist paanikomplekti.
 *
 * MIDA ME EI TUHMISTA: merekaarti, navigatsioonimärke ega radarit. Nende
 * värv KANNAB TÄHENDUST — punane ja roheline poi, punane sajuala. Nende
 * halliks muutmine kaotaks infot, mitte ei vähendaks müra.
 */

/** Kui palju värvi maha võtta. -1 = täiesti hall. */
const MUTED_SATURATION = -0.9;

/**
 * Heledus tõstetakse ainult VEIDI.
 *
 * Esimene katse kasutas 0.42 mõttega, et kaart peab välja alt läbi paistma.
 * Tulemus oli, et RANNAJOON kadus — maa ja meri sulasid ühte helehalli
 * plekki. Mereäpis on rannajoon ainus asi, mille järgi kaardil orienteeruda,
 * ja see peab jääma nähtavaks ka siis, kui väli on peal.
 */
const MUTED_BRIGHTNESS_MIN = 0.08;

/** Kerge kontrastilangus võtab müra maha, ilma piirjooni kaotamata. */
const MUTED_CONTRAST = -0.1;

/**
 * Lülitab aluskaardi tuhmi ja tavalise vahel.
 *
 * Üleminek on animeeritud (`*-transition`), sest järsk hüpe värvilise ja halli
 * vahel kihi sisse-välja lülitamisel mõjub vealikult.
 */
export function setBasemapMuted(map: MapLibreMap, muted: boolean): void {
  for (const def of BASE_LAYERS) {
    if (!map.getLayer(def.id)) continue;

    map.setPaintProperty(def.id, 'raster-saturation', muted ? MUTED_SATURATION : 0);
    map.setPaintProperty(def.id, 'raster-brightness-min', muted ? MUTED_BRIGHTNESS_MIN : 0);
    map.setPaintProperty(def.id, 'raster-contrast', muted ? MUTED_CONTRAST : 0);

    map.setPaintProperty(def.id, 'raster-saturation-transition', { duration: 300 });
    map.setPaintProperty(def.id, 'raster-brightness-min-transition', { duration: 300 });
    map.setPaintProperty(def.id, 'raster-contrast-transition', { duration: 300 });
  }
}
