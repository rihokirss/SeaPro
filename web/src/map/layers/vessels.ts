import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';
import type { Vessel } from '@seapro/shared';
import { insertBefore } from '../layerOrder';
import {
  MIN_HULL_LENGTH_PX,
  hullDimensions,
  hullPolygon,
  metersPerPixel,
} from './vesselShapes';

const ICON_SOURCE = 'vessels-src';
const HULL_SOURCE = 'vessel-hulls-src';

export const VESSELS_LAYER = 'vessels';
export const VESSELS_LABEL_LAYER = 'vessels-labels';
export const VESSEL_HULL_FILL = 'vessel-hulls';
export const VESSEL_HULL_LINE = 'vessel-hulls-line';

/** Kõik kihid, mida laevaklikk peab arvestama. */
export const VESSEL_LAYERS = [VESSEL_HULL_FILL, VESSELS_LAYER];

/**
 * AIS-laevade kiht kahes esitusviisis.
 *
 * **Lähivaates** joonistatakse laev päris kujuga: ristkülik kolmnurkse ninaga,
 * AIS-i mõõtmetes ja õigel kursil. Kaatrimehele on see otsene navigatsiooniinfo
 * — 300-meetrine konteinerlaev ja 12-meetrine kaater ei tohi kaardil ühesugused
 * välja näha, ja kere täidab tegelikult selle vee, mida ta täidab.
 *
 * **Kaugvaates** langeb sama laev alla mõne piksli ja kere muutuks täpiks, mis
 * ei kanna enam ei suunda ega suurust. Siis on ikoon nii loetavam kui odavam.
 * Piir on PIKSLITES (`MIN_HULL_LENGTH_PX`), mitte zoomitasemes: sama zoom
 * tähendab väikepaadile ja tankerile täiesti erinevat asja, seega otsus tehakse
 * laeva kaupa.
 *
 * Nool vs punkt otsustatakse SUUNA olemasolu, mitte kiiruse järgi. Seisva
 * laeva vööri suund (AIS heading) on päris info — laev on füüsiliselt kaid
 * pidi mingis suunas ja see loeb, kui sa tema kõrvale manööverdad. Punkt jääb
 * ainult neile, kelle suunda AIS ei anna.
 */

/** Miinimumkiirus sõlmedes, mille juures loeme laeva liikuvaks. */
const MOVING_SOG = 0.5;

/** AIS ship type -> värvivariant. Ainult tüübid, mis merel midagi tähendavad. */
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

/** Täidisvärvid kere jaoks — samad toonid mis ikoonidel. */
const HULL_COLORS: Record<string, string> = {
  default: '#c9d6df',
  cargo: '#8fb8d8',
  tanker: '#e0a83f',
  passenger: '#7fd0a8',
  fishing: '#d8a0d0',
  sailing: '#a8d8d0',
  fast: '#e08f7f',
};

function commonProps(v: Vessel, category: string, moving: boolean, hasHeading: boolean) {
  return {
    mmsi: v.mmsi,
    name: v.name ?? '',
    category,
    color: HULL_COLORS[category] ?? HULL_COLORS.default!,
    bearing: v.heading ?? v.cog ?? 0,
    sog: v.sog ?? null,
    cog: v.cog ?? null,
    heading: v.heading ?? null,
    navStat: v.navStat ?? null,
    destination: v.destination ?? '',
    shipType: v.shipType ?? null,
    callSign: v.callSign ?? '',
    imo: v.imo ?? null,
    timestamp: v.timestamp,
    source: v.source,
    moving,
    hasHeading,
  };
}

export function updateVessels(map: MapLibreMap, list: Vessel[], zoom: number): void {
  const hulls: Feature[] = [];
  const icons: Feature[] = [];

  for (const v of list) {
    const moving = (v.sog ?? 0) >= MOVING_SOG;
    // Vööri suund on parem kui kurss üle põhja: triivival või manööverdaval
    // laeval need erinevad ja vöör näitab, kuhu ta tegelikult osutab.
    const hasHeading = v.heading !== undefined || v.cog !== undefined;
    const category = vesselCategory(v.shipType);
    const props = commonProps(v, category, moving, hasHeading);

    const dims = hullDimensions(v);
    const lengthPx = dims.lengthM / metersPerPixel(zoom, v.lat);

    // Ainult päris mõõtmetega laevad saavad kere — oletatud 12 m kere
    // valetaks suurust ja seda pole kuidagi näha.
    if (dims.known && lengthPx >= MIN_HULL_LENGTH_PX) {
      hulls.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [hullPolygon(v, dims)] },
        properties: { ...props, lengthM: Math.round(dims.lengthM), beamM: Math.round(dims.beamM) },
      });
    } else {
      icons.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [v.lon, v.lat] },
        properties: {
          ...props,
          icon: hasHeading ? `vessel-arrow-${category}` : `vessel-dot-${category}`,
          lengthM: dims.known ? Math.round(dims.lengthM) : null,
          beamM: dims.known ? Math.round(dims.beamM) : null,
        },
      });
    }
  }

  setData(map, HULL_SOURCE, hulls);
  setData(map, ICON_SOURCE, icons);

  ensureHullLayers(map);
  ensureIconLayers(map);
  setVesselsVisible(map, true);
}

function setData(map: MapLibreMap, id: string, features: Feature[]): void {
  const data: FeatureCollection = { type: 'FeatureCollection', features };
  const src = map.getSource<GeoJSONSource>(id);
  if (src) src.setData(data);
  else map.addSource(id, { type: 'geojson', data });
}

function ensureHullLayers(map: MapLibreMap): void {
  if (!map.getLayer(VESSEL_HULL_FILL)) {
    map.addLayer({
      id: VESSEL_HULL_FILL,
      type: 'fill',
      source: HULL_SOURCE,
      paint: {
        'fill-color': ['get', 'color'],
        'fill-opacity': 0.75,
      },
    }, insertBefore(map, VESSEL_HULL_FILL));
  }
  if (!map.getLayer(VESSEL_HULL_LINE)) {
    map.addLayer({
      id: VESSEL_HULL_LINE,
      type: 'line',
      source: HULL_SOURCE,
      paint: {
        // Tume kontuur hoiab kere loetavana ka heleda merepinna peal.
        'line-color': 'rgba(8, 26, 40, 0.85)',
        'line-width': 1,
      },
    }, insertBefore(map, VESSEL_HULL_LINE));
  }
}

function ensureIconLayers(map: MapLibreMap): void {
  if (!map.getLayer(VESSELS_LAYER)) {
    map.addLayer({
      id: VESSELS_LAYER,
      type: 'symbol',
      source: ICON_SOURCE,
      // Madalal zoomil oleks Soome laht üleni laevu täis ja kaart kasutu.
      minzoom: 8,
      layout: {
        'icon-image': ['get', 'icon'],
        // Punktil pole suunda; nool pöörab alati, ka seisval laeval.
        'icon-rotate': ['case', ['get', 'hasHeading'], ['get', 'bearing'], 0],
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
    }, insertBefore(map, VESSELS_LAYER));
  }

  if (!map.getLayer(VESSELS_LABEL_LAYER)) {
    map.addLayer({
      id: VESSELS_LABEL_LAYER,
      type: 'symbol',
      source: ICON_SOURCE,
      // Nimed alles lähivaates — muidu katab tekst terve sadama.
      minzoom: 11,
      layout: {
        'text-field': ['get', 'name'],
        'text-font': ['Open Sans Regular'],
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
    }, insertBefore(map, VESSELS_LABEL_LAYER));
  }
}

export function setVesselsVisible(map: MapLibreMap, visible: boolean): void {
  const v = visible ? 'visible' : 'none';
  for (const id of [VESSELS_LAYER, VESSELS_LABEL_LAYER, VESSEL_HULL_FILL, VESSEL_HULL_LINE]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
  }
}
