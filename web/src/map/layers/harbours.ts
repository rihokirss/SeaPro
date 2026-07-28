import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';
import type { Harbour } from '@seapro/shared';
import { ANCHORAGE_ICON, HARBOUR_ICON, HARBOUR_ICON_BASIC } from '../icons';
import { insertBefore } from '../layerOrder';

const SOURCE_ID = 'harbours-src';
export const HARBOURS_LAYER = 'harbours';
export const HARBOURS_LABEL_LAYER = 'harbours-labels';
export const ANCHORAGES_LAYER = 'anchorages';
export const ANCHORAGES_LABEL_LAYER = 'anchorages-labels';

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
      kind: h.kind,
      name: h.name,
      icon:
        h.kind === 'anchorage'
          ? ANCHORAGE_ICON
          : hasFacilities(h)
            ? HARBOUR_ICON
            : HARBOUR_ICON_BASIC,
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
      anchorageCategory: h.anchorageCategory ?? '',
      seabed: h.seabed ?? '',
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
        // Üks allikas, kaks kihti: nii tuleb mõlemad ühest Overpassi
        // päringust, aga kasutaja saab neid eraldi sisse-välja lülitada.
        filter: ['!=', ['get', 'kind'], 'anchorage'],
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
        filter: ['!=', ['get', 'kind'], 'anchorage'],
        minzoom: 10,
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Open Sans Regular'],
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

  if (!map.getLayer(ANCHORAGES_LAYER)) {
    map.addLayer(
      {
        id: ANCHORAGES_LAYER,
        type: 'symbol',
        source: SOURCE_ID,
        filter: ['==', ['get', 'kind'], 'anchorage'],
        /**
         * Ankrukoht tuleb nähtavale hiljem kui sadam (9 vs 7).
         *
         * Sadam on orientiir, mida vaadatakse kaugelt ("kuhu ma üldse lähen").
         * Ankrukoht on otsus, mis tehakse kohal olles ("kuhu ma siin lahes
         * jään") — ja neid on rannikul kordades rohkem kui sadamaid, seega
         * madalal zoomil oleks see lihtsalt punktimüra üle kogu Läänemere.
         */
        minzoom: 9,
        layout: {
          'icon-image': ['get', 'icon'],
          'icon-size': [
            'interpolate', ['linear'], ['zoom'],
            9, 0.7,
            12, 1,
            14, 1.15,
          ],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
      },
      insertBefore(map, ANCHORAGES_LAYER),
    );
  }

  if (!map.getLayer(ANCHORAGES_LABEL_LAYER)) {
    map.addLayer(
      {
        id: ANCHORAGES_LABEL_LAYER,
        type: 'symbol',
        source: SOURCE_ID,
        // Nimetuid on enamik — neile ei ole mõtet tühja silti joonistada.
        filter: ['all', ['==', ['get', 'kind'], 'anchorage'], ['!=', ['get', 'name'], '']],
        minzoom: 11,
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Open Sans Regular'],
          'text-size': 11,
          'text-offset': [0, 1.1],
          'text-anchor': 'top',
          'text-optional': true,
          'text-max-width': 10,
        },
        paint: {
          'text-color': '#14402f',
          'text-halo-color': 'rgba(255,255,255,0.92)',
          'text-halo-width': 1.4,
        },
      },
      insertBefore(map, ANCHORAGES_LABEL_LAYER),
    );
  }
}

export function setHarboursVisible(map: MapLibreMap, visible: boolean): void {
  setLayersVisible(map, [HARBOURS_LAYER, HARBOURS_LABEL_LAYER], visible);
}

export function setAnchoragesVisible(map: MapLibreMap, visible: boolean): void {
  setLayersVisible(map, [ANCHORAGES_LAYER, ANCHORAGES_LABEL_LAYER], visible);
}

function setLayersVisible(map: MapLibreMap, ids: string[], visible: boolean): void {
  const v = visible ? 'visible' : 'none';
  for (const id of ids) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
  }
}
