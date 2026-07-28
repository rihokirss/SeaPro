import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import type { Variable } from '@seapro/shared';
import { sampleWind, type Field } from '../interpolate';
import { COLOR_SCALES } from '../colorScales';
import { WIND_ARROW_DARK, WIND_ARROW_LIGHT } from '../icons';
import { insertBefore } from '../layerOrder';

const SOURCE_ID = 'wind-arrows-src';
const LAYER_ID = 'wind-arrows';

/**
 * Tuulenoolte kiht.
 *
 * Tööjaotus kihtide vahel (Windfinderi lahendus, mis osutus õigeks):
 *   nool  -> SUUND, ühevärviline, õhuke ja terav
 *   väli  -> KIIRUS, pidev värvigradient
 * Kui mõlemad kannaksid kiirust, võitleksid nad sama info eest ja kaart
 * muutuks kirjuks.
 *
 * Nool on ÄÄRISETA. Ääris teeks ta igal taustal loetavaks, aga ka jämedaks ja
 * häguseks, ja tihedas võrgus muutuks pilt müraks. Selle asemel on kaks
 * valmisvarianti ja valik käib TAUSTA, mitte üksiku väärtuse järgi:
 * valevärvi-väli peal -> valge nool, paljas kaart -> tume nool.
 *
 * Nool osutab suunda, KUHU tuul puhub — kaardil loetakse seda kui õhu
 * liikumist. Numbriline suund paneelis jääb meteoroloogiliseks ("kust").
 *
 * Tihedus tuleb interpoleerimisest, mitte tihedamast API-päringust: server
 * annab hõreda võrgu (API-kutsete säästmiseks) ja me joonistame sellest
 * pideva välja tihedamalt. Vt `interpolate.ts`.
 */

/** Soovitud vahe noolte vahel ekraanipikslites. */
const ARROW_SPACING_PX = 62;

/** Ülempiir, et madalal zoomil ei tekiks kümneid tuhandeid sümboleid. */
const MAX_ARROWS = 900;

export interface ArrowGridOptions {
  /** Kaardi nähtav ala [lõuna, lääs, põhi, ida]. */
  bbox: [number, number, number, number];
  /** Kaardikonteineri suurus pikslites. */
  width: number;
  height: number;
  /**
   * Milline valevärvi-väli on all. Null = välja pole, taust on paljas kaart.
   * Nooleni jõuab siit ainult see, kas variandiks võtta tume või hele.
   */
  fieldVariable: Variable | null;
}

/**
 * Kas nool peab olema hele?
 *
 * Reegel on lihtne: valevärvi-väli peal -> valge nool, välja pole -> tume.
 *
 * Varem arvutati siin iga noole all oleva värvi tajutavat heledust (Rec. 709)
 * ja segati see alfa järgi kaardi taustaga. See oli mõttekas seni, kuni
 * skaalade alumine ots oli poolläbipaistev ja tegelik taust võis olla hele
 * merepind. Nüüd on kõik skaalad ühtlaselt küllastunud, seega arvutus andis
 * ainult ühe tulemuse — ja andis seda ebaühtlaselt: sama välja sees vahetus
 * noolte värv keset kaarti, mis luges rohkem veana kui infona.
 */
function needsLightArrow(variable: Variable | null): boolean {
  return variable !== null && COLOR_SCALES[variable] !== undefined;
}

/**
 * Ehitab ekraanitiheduse järgi ühtlase noolevõrgu ja võtab igast punktist
 * interpoleeritud tuule.
 */
function buildArrowFeatures(field: Field, opts: ArrowGridOptions) {
  const [south, west, north, east] = opts.bbox;

  const cols = Math.max(2, Math.round(opts.width / ARROW_SPACING_PX));
  const rows = Math.max(2, Math.round(opts.height / ARROW_SPACING_PX));

  const total = cols * rows;
  // Kui võrk läheks liiga suureks, hõrendame ühtlaselt mõlemas suunas.
  const thin = total > MAX_ARROWS ? Math.ceil(Math.sqrt(total / MAX_ARROWS)) : 1;

  const features = [];
  for (let r = 0; r < rows; r += thin) {
    for (let c = 0; c < cols; c += thin) {
      const lat = south + ((north - south) * (r + 0.5)) / rows;
      const lon = west + ((east - west) * (c + 0.5)) / cols;

      const sample = sampleWind(field, lat, lon);
      if (!sample) continue;

      features.push({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [lon, lat] },
        properties: {
          speed: sample.speed,
          bearing: sample.bearing,
          icon: needsLightArrow(opts.fieldVariable)
            ? WIND_ARROW_LIGHT
            : WIND_ARROW_DARK,
        },
      });
    }
  }
  return features;
}

export function updateWindArrows(
  map: MapLibreMap,
  field: Field | null,
  opts: ArrowGridOptions,
): void {
  const features = field ? buildArrowFeatures(field, opts) : [];
  const data = { type: 'FeatureCollection' as const, features };

  const src = map.getSource<GeoJSONSource>(SOURCE_ID);
  if (src) {
    src.setData(data);
  } else {
    map.addSource(SOURCE_ID, { type: 'geojson', data });
  }

  if (!map.getLayer(LAYER_ID)) {
    map.addLayer({
      id: LAYER_ID,
      type: 'symbol',
      source: SOURCE_ID,
      layout: {
        'icon-image': ['get', 'icon'],
        'icon-rotate': ['get', 'bearing'],
        'icon-rotation-alignment': 'map',
        // Väike kasv tuulega — tormi tajub perifeerse nägemisega, ilma et
        // nõrga tuule alad muutuksid mürarikkaks.
        'icon-size': [
          'interpolate', ['linear'], ['get', 'speed'],
          0, 0.62,
          8, 0.78,
          18, 0.95,
          30, 1.1,
        ],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'icon-padding': 0,
      },
      paint: {
        // Nõrk tuul veidi tuhmim: nii ei domineeri vaiksed alad pildil.
        'icon-opacity': [
          'interpolate', ['linear'], ['get', 'speed'],
          0, 0.75,
          6, 0.9,
          14, 1,
        ],
      },
    }, insertBefore(map, LAYER_ID));
  }
  map.setLayoutProperty(LAYER_ID, 'visibility', 'visible');
}

export function hideWindArrows(map: MapLibreMap): void {
  if (map.getLayer(LAYER_ID)) {
    map.setLayoutProperty(LAYER_ID, 'visibility', 'none');
  }
}

export { LAYER_ID as WIND_ARROWS_LAYER_ID };
