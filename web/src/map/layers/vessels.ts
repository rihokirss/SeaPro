import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import type { Vessel } from '@seapro/shared';

const SOURCE_ID = 'vessels-src';
export const VESSELS_LAYER = 'vessels';
export const VESSELS_LABEL_LAYER = 'vessels-labels';

/**
 * AIS-laevade kiht.
 *
 * Liikuv laev on nool kursi suunas, seisev laev on punkt — sest seisva laeva
 * puhul on nooleots pelgalt müra ja sadamas tekitaks kümme nool eri suunas
 * segase pildi. Piir on 0.5 sõlme: alla selle on AIS-i kurss niikuinii müra.
 *
 * Värv tuleb laevatüübist. Ainult need tüübid, mis kaatrimehele midagi
 * tähendavad (kas ta peab teed andma, kas see on kalur või lõbusõidulaev) —
 * ülejäänud jäävad neutraalseks.
 */

/** Miinimumkiirus sõlmedes, mille juures loeme laeva liikuvaks. */
const MOVING_SOG = 0.5;

/**
 * AIS ship type -> ikooni värvivariant.
 * Vahemikud AIS-i standardist (ITU-R M.1371).
 */
function vesselCategory(shipType: number | undefined): string {
  if (shipType === undefined) return 'default';
  if (shipType >= 30 && shipType <= 32) return 'fishing';
  if (shipType >= 36 && shipType <= 37) return 'sailing';
  if (shipType >= 40 && shipType <= 49) return 'fast';
  if (shipType >= 60 && shipType <= 69) return 'passenger';
  if (shipType >= 70 && shipType <= 79) return 'cargo';
  if (shipType >= 80 && shipType <= 89) return 'tanker';
  return 'default';
}

export function updateVessels(map: MapLibreMap, list: Vessel[]): void {
  const features = list.map((v) => {
    const moving = (v.sog ?? 0) >= MOVING_SOG;
    const category = vesselCategory(v.shipType);
    return {
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [v.lon, v.lat] },
      properties: {
        mmsi: v.mmsi,
        name: v.name ?? '',
        icon: moving ? `vessel-arrow-${category}` : `vessel-dot-${category}`,
        // Eelista tegelikku vööri suunda; puudumisel kurss üle põhja.
        bearing: v.heading ?? v.cog ?? 0,
        sog: v.sog ?? null,
        cog: v.cog ?? null,
        destination: v.destination ?? '',
        source: v.source,
        moving,
      },
    };
  });

  const data = { type: 'FeatureCollection' as const, features };

  const src = map.getSource<GeoJSONSource>(SOURCE_ID);
  if (src) {
    src.setData(data);
  } else {
    map.addSource(SOURCE_ID, { type: 'geojson', data });
  }

  if (!map.getLayer(VESSELS_LAYER)) {
    map.addLayer({
      id: VESSELS_LAYER,
      type: 'symbol',
      source: SOURCE_ID,
      // Madalal zoomil oleks Soome laht üleni laevu täis ja kaart kasutu.
      minzoom: 8,
      layout: {
        'icon-image': ['get', 'icon'],
        // Seisev laev ei pöördu — punktil pole suunda.
        'icon-rotate': ['case', ['get', 'moving'], ['get', 'bearing'], 0],
        'icon-rotation-alignment': 'map',
        'icon-size': [
          'interpolate', ['linear'], ['zoom'],
          8, 0.6,
          12, 0.9,
          15, 1.1,
        ],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    });
  }

  if (!map.getLayer(VESSELS_LABEL_LAYER)) {
    map.addLayer({
      id: VESSELS_LABEL_LAYER,
      type: 'symbol',
      source: SOURCE_ID,
      // Nimed alles lähivaates — muidu katab tekst terve sadama.
      minzoom: 11,
      layout: {
        'text-field': ['get', 'name'],
        'text-font': ['Noto Sans Regular'],
        'text-size': 11,
        'text-offset': [0, 1.1],
        'text-anchor': 'top',
        'text-optional': true,
        'text-max-width': 9,
      },
      paint: {
        'text-color': '#12303f',
        'text-halo-color': 'rgba(255,255,255,0.9)',
        'text-halo-width': 1.4,
      },
    });
  }

  setVesselsVisible(map, true);
}

export function setVesselsVisible(map: MapLibreMap, visible: boolean): void {
  const v = visible ? 'visible' : 'none';
  for (const id of [VESSELS_LAYER, VESSELS_LABEL_LAYER]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
  }
}
