import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import type { Variable } from '@seapro/shared';
import { sampleWind, type Field } from '../interpolate';
import { COLOR_SCALES, sampleScale } from '../colorScales';
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
 * häguseks, ja tihedas võrgus muutuks pilt müraks. Selle asemel valime iga
 * noole jaoks tumeda või heleda variandi selle järgi, kui tume on värviväli
 * TEMA ALL: hele merepind saab tumeda noole, tugeva tuule tume väli heleda.
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
   * Milline valevärvi-väli on all. Null = välja pole, taust on hele kaart.
   * Nooleni jõuab siit ainult see, kas variandiks võtta tume või hele.
   */
  fieldVariable: Variable | null;
}

/**
 * Kas noole all olev väli on nii tume, et nool peab olema hele?
 *
 * Arvestame nii värvi tajutavat heledust (Rec. 709) kui ALFAT: nõrga tuule
 * korral on väli peaaegu läbipaistev ja tegelik taust on hele merepind,
 * olenemata sellest, mis värv skaalal kirjas on.
 */
function needsLightArrow(variable: Variable | null, speed: number): boolean {
  if (!variable) return false;
  const scale = COLOR_SCALES[variable];
  if (!scale) return false;

  // Väli joonistatakse tuulekiiruse järgi; muude väljade puhul ei tea me
  // siin nende väärtust ja jääme tumeda noole juurde, mis on heleda kaardi
  // peal ohutum valik.
  if (variable !== 'wind_speed') return false;

  const [r, g, b, a] = sampleScale(scale, speed);
  const alpha = a / 255;
  if (alpha < 0.5) return false;

  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  // Segame välja värvi heleda merepinnaga tema alfa võrra.
  const effective = luminance * alpha + 0.82 * (1 - alpha);
  return effective < 0.5;
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
          icon: needsLightArrow(opts.fieldVariable, sample.speed)
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
