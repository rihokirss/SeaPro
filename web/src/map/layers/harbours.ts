import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';
import type { Harbour } from '@seapro/shared';
import { HARBOUR_ICON, HARBOUR_ICON_BASIC } from '../icons';
import { insertBefore } from '../layerOrder';

const SOURCE_ID = 'harbours-src';
export const HARBOURS_LAYER = 'harbours';
export const HARBOURS_LABEL_LAYER = 'harbours-labels';

/**
 * Sadamate kiht.
 *
 * Markeri värv eristab kaht asja, mis kaatriga tulles kohe loevad: kas seal on
 * TEENUSED (elekter, septikutühjendus) või on tegu paljalt sildumiskohaga.
 * OSM-i `marina_no_facilities` ütleb sedasama sõnaselgelt.
 *
 * Nimed tulevad nähtavale alles lähivaates. Eesti rannikul on 300+ sadamat ja
 * madalal zoomil kataks tekst terve kaardi — sadam on siis niikuinii ainult
 * orientiir, mitte sihtkoht.
 */

function hasFacilities(h: Harbour): boolean {
  if (h.category === 'marina_no_facilities') return false;
  return Boolean(h.powerSupply || h.sanitaryDump || h.fuel || h.drinkingWater);
}

export function updateHarbours(map: MapLibreMap, list: Harbour[]): void {
  const features: Feature[] = list.map((h) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [h.lon, h.lat] },
    properties: {
      id: h.id,
      name: h.name,
      icon: hasFacilities(h) ? HARBOUR_ICON : HARBOUR_ICON_BASIC,
      category: h.category ?? '',
      phone: h.phone ?? '',
      website: h.website ?? '',
      operator: h.operator ?? '',
      // MapLibre'i omadused peavad olema lihttüübid; null tähendab "puudub".
      maxDraught: h.maxDraught ?? null,
      capacity: h.capacity ?? null,
      powerSupply: h.powerSupply ?? null,
      sanitaryDump: h.sanitaryDump ?? null,
      fuel: h.fuel ?? null,
      drinkingWater: h.drinkingWater ?? null,
      vhf: h.vhf ?? '',
      registryUrl: h.registryUrl ?? '',
      locode: h.locode ?? '',
    },
  }));

  const data: FeatureCollection = { type: 'FeatureCollection', features };

  const src = map.getSource<GeoJSONSource>(SOURCE_ID);
  if (src) src.setData(data);
  else map.addSource(SOURCE_ID, { type: 'geojson', data });

  if (!map.getLayer(HARBOURS_LAYER)) {
    map.addLayer(
      {
        id: HARBOURS_LAYER,
        type: 'symbol',
        source: SOURCE_ID,
        minzoom: 7,
        layout: {
          'icon-image': ['get', 'icon'],
          'icon-size': [
            'interpolate', ['linear'], ['zoom'],
            7, 0.7,
            11, 1,
            14, 1.25,
          ],
          /**
           * Sadam on PÜSIV orientiir ja ei tohi kaduda liikuvate objektide
           * pärast.
           *
           * Varem oli siin `icon-allow-overlap: false`. Tagajärg oli täpselt
           * vastupidine ootusele: zoomil 9 näidati 31 sadamat, zoomil 13
           * mitte ühtegi. Põhjus — laevanimede kiht (`vessels-labels`,
           * minzoom 11) asub kihijärjekorras eespool ja tema sildid võtsid
           * ruumi ära. Sadamaikoon andis neile viisakalt teed ja kadus.
           *
           * Laev liigub minuti pärast edasi, sadam jääb. Ikoon joonistatakse
           * nüüd alati; kokkupõrkeid haldab ainult SILT (`text-optional`).
           */
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
      },
      insertBefore(map, HARBOURS_LAYER),
    );
  }

  if (!map.getLayer(HARBOURS_LABEL_LAYER)) {
    map.addLayer(
      {
        id: HARBOURS_LABEL_LAYER,
        type: 'symbol',
        source: SOURCE_ID,
        minzoom: 10,
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Regular'],
          'text-size': 11,
          'text-offset': [0, 1.2],
          'text-anchor': 'top',
          'text-optional': true,
          'text-max-width': 10,
        },
        paint: {
          'text-color': '#12303f',
          'text-halo-color': 'rgba(255,255,255,0.92)',
          'text-halo-width': 1.4,
        },
      },
      insertBefore(map, HARBOURS_LABEL_LAYER),
    );
  }

  setHarboursVisible(map, true);
}

export function setHarboursVisible(map: MapLibreMap, visible: boolean): void {
  const v = visible ? 'visible' : 'none';
  for (const id of [HARBOURS_LAYER, HARBOURS_LABEL_LAYER]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
  }
}
