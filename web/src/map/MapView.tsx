import { useEffect, useRef, useState } from 'react';
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { OVERLAY_LAYERS, baseStyle, type RasterLayerDef } from './basemaps';
import { addColorBase } from './colorBase';
import { addDarkBase } from './darkBase';
import { registerIcons } from './icons';
import { LAYER_ORDER } from './layerOrder';
import { addPlaceLabels } from './layers/placeLabels';
import type { Position } from '../lib/geolocation';

export interface MapViewProps {
  center: [number, number];
  zoom: number;
  /** Millised overlay-kihid on sisse lülitatud. */
  activeOverlays: string[];
  ownPosition: Position | null;
  onReady(map: MapLibreMap): void;
  onMoveEnd(bbox: [number, number, number, number], zoom: number): void;
  onPick(lat: number, lon: number): void;
}


/**
 * Suurim täpsus (meetrites), mille juures täpsusringi veel joonistame.
 * Päris GPS annab merel 5–30 m; kui number on suurem, on tegu Wi-Fi/IP
 * hinnanguga ja ring oleks eksitav mürakera üle poole kaardist.
 */
const ACCURACY_RING_MAX_M = 1000;

/** Web Mercatori resolutsioon: meetrit piksli kohta ekvaatoril zoomil 0. */
const EQUATOR_M_PER_PX = 156543.03392;

/**
 * Raadiuse konstant, millest MapLibre saab pikslid: raadius_px = unit * 2^zoom.
 * Laiuskraadi kokkusurumine arvestatakse siin ära, sest MapLibre'i avaldistes
 * pole koosinust.
 */
function accuracyRadiusUnit(accuracyM: number, lat: number): number {
  const metersPerPxAtZoom0 = EQUATOR_M_PER_PX * Math.cos((lat * Math.PI) / 180);
  return accuracyM / metersPerPxAtZoom0;
}

function addRaster(map: MapLibreMap, def: RasterLayerDef, beforeId?: string): void {
  const sourceId = `src-${def.id}`;
  if (!map.getSource(sourceId)) {
    map.addSource(sourceId, {
      type: 'raster',
      tiles: def.tiles,
      tileSize: def.tileSize ?? 256,
      attribution: def.attribution,
      ...(def.minzoom !== undefined ? { minzoom: def.minzoom } : {}),
      ...(def.maxzoom !== undefined ? { maxzoom: def.maxzoom } : {}),
      ...(def.bounds ? { bounds: def.bounds } : {}),
    });
  }
  if (!map.getLayer(def.id)) {
    map.addLayer(
      {
        id: def.id,
        type: 'raster',
        source: sourceId,
        paint: { 'raster-opacity': def.opacity ?? 1 },
      },
      beforeId,
    );
  }
}

export function MapView({
  center,
  zoom,
  activeOverlays,
  ownPosition,
  onReady,
  onMoveEnd,
  onPick,
}: MapViewProps): React.ReactElement {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [styleReady, setStyleReady] = useState(false);
  // Hoiame callback'id ref'is, et kaarti ei ehitataks iga renderi peale uuesti.
  const cb = useRef({ onReady, onMoveEnd, onPick });
  cb.current = { onReady, onMoveEnd, onPick };

  useEffect(() => {
    if (!container.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: container.current,
      style: baseStyle(),
      center: [center[1], center[0]],
      zoom,
      attributionControl: false,
      // Kaatris on kaardi pööramine kogemata liiga lihtne ja segav.
      pitchWithRotate: false,
      dragRotate: false,
      touchPitch: false,
      maxZoom: 18,
      minZoom: 3,
    });
    mapRef.current = map;

    // Arendusrežiimis anna kaart konsoolile KOHE, mitte alles pärast kihtide
    // loomist — muidu pole kaardi enda käivitusprobleeme kuidagi uurida.
    if (import.meta.env.DEV) {
      (window as unknown as { seaproMap?: MapLibreMap }).seaproMap = map;
    }

    map.on('error', (e) => {
      // MapLibre'i vaikimisi käitumine on vead alla neelata. Kaardikihtide
      // ja allikate vead on siin ainus koht, kus nad üldse nähtavaks saavad.
      console.error('[SeaPro] MapLibre:', e.error?.message ?? e);
    });

    map.touchZoomRotate.disableRotation();

    // Atribuudirida (OSM, OpenSeaMap, MET jt) üleval paremal, mitte all.
    // All paremas nurgas on nüüd nupuvirn ja punktiprognoosi paneel; kokku
    // oli seal kolm asja ühe koha peal. Litsentsid nõuavad nähtavust, mitte
    // kindlat nurka — kokkupakitult on see ⓘ, mis avaneb puudutusel.
    map.addControl(
      new maplibregl.AttributionControl({ compact: true }),
      'top-right',
    );
    map.addControl(
      new maplibregl.ScaleControl({ maxWidth: 120, unit: 'nautical' }),
      'bottom-left',
    );
    map.addControl(
      new maplibregl.NavigationControl({ showCompass: false, visualizePitch: false }),
      'top-right',
    );

    const initLayers = (): void => {
      registerIcons(map);
      // Mõlemad aluskaardid on vektorstiilid ja mõlemad lisatakse KOHE, aga
      // nähtav on korraga ainult üks. Nii on vahetus hetkeline ega nõua kihi
      // ehitamist lennult, ja järjekord on paigas enne andmekihte.
      // Peidetud kihtide paane MapLibre ei tõmba, seega teine ei maksa midagi.
      addColorBase(map);
      addDarkBase(map);
      addPlaceLabels(map);
      // Oma asukoha allikas luuakse kohe, et kiht oleks õiges järjekorras
      // olemas ka enne esimest GPS-fixi.
      map.addSource('own-position', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'own-position-accuracy',
        type: 'circle',
        source: 'own-position',
        // Näita täpsusringi ainult siis, kui see midagi ütleb.
        // IP-põhine asukoht annab täpsuseks kümneid kilomeetreid ja selline
        // ring kataks poole kaardist, ilma et kasutaja sellest midagi võidaks.
        filter: ['<', ['get', 'accuracy'], ACCURACY_RING_MAX_M],
        paint: {
          // Meetrid -> pikslid: 1 px = 156543.034 * cos(lat) / 2^zoom meetrit.
          // Laiuskraadist sõltuv osa on juba `radiusUnit`-i sisse arvutatud,
          // siin jääb ainult zoomi kordaja 2^zoom.
          //
          // MapLibre nõuab, et ['zoom'] esineks AINULT interpolate/step
          // avaldise tipptasemel — `['*', x, ['^', 2, ['zoom']]]` visatakse
          // vaikselt kõrvale ja terve kiht jääb lisamata. Eksponentsiaalne
          // interpolatsioon alusega 2 annab täpselt sama tulemuse legaalselt.
          'circle-radius': [
            'interpolate', ['exponential', 2], ['zoom'],
            0, ['get', 'radiusUnit'],
            22, ['*', ['get', 'radiusUnit'], 4194304],
          ],
          'circle-color': '#3fb6d8',
          'circle-opacity': 0.14,
          'circle-stroke-color': '#3fb6d8',
          'circle-stroke-width': 1,
          'circle-stroke-opacity': 0.45,
        },
      });
      map.addLayer({
        id: 'own-position',
        type: 'circle',
        source: 'own-position',
        paint: {
          'circle-radius': 7,
          'circle-color': '#2f7fd1',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 3,
        },
      });

      setStyleReady(true);
      cb.current.onReady(map);
      emitMove(map);
    };

    const emitMove = (m: MapLibreMap): void => {
      const b = m.getBounds();
      cb.current.onMoveEnd(
        [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()],
        m.getZoom(),
      );
    };

    map.on('load', () => {
      // MapLibre neelab `load` käsitleja erandid vaikselt alla. Ilma selle
      // püüdmiseta jääb rakendus poolikuks — aluskaart on ekraanil, aga
      // andmekihte ei tule kunagi ja konsool vaikib. Üks vale avaldis
      // paint-reeglis maksis täpselt selle diagnoosimise.
      try {
        initLayers();
      } catch (err) {
        console.error('[SeaPro] kaardikihtide loomine ebaõnnestus:', err);
        // Anna rakendusele siiski teada, et kaart on olemas — parem
        // osaliselt töötav kaart kui täiesti tühi ekraan.
        setStyleReady(true);
        cb.current.onReady(map);
        emitMove(map);
      }
    });

    map.on('moveend', () => emitMove(map));

    map.on('click', (e) => {
      // Kui klikk tabas mõnda andmekihti (jaam, laev), tegeleb sellega
      // vastav kihi enda käsitleja — siin ei tohi punktipaneeli avada.
      const hits = map.queryRenderedFeatures(e.point, {
        layers: LAYER_ORDER.filter((id) => map.getLayer(id)),
      });
      if (hits.length > 0) return;
      cb.current.onPick(e.lngLat.lat, e.lngLat.lng);
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // Ehitame kaardi täpselt korra; center/zoom on ainult algväärtused.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Overlay-kihtide sisse/välja lülitamine.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady) return;

    for (const def of OVERLAY_LAYERS) {
      const wanted = activeOverlays.includes(def.id);
      const exists = Boolean(map.getLayer(def.id));

      if (wanted && !exists) {
        // Lisa esimese andmekihi ETTE, et andmed jääksid alati peale.
        const before = LAYER_ORDER.find((id) => map.getLayer(id));
        addRaster(map, def, before);
      } else if (!wanted && exists) {
        map.removeLayer(def.id);
      }
    }
  }, [activeOverlays, styleReady]);

  // Oma asukoha marker.
  useEffect(() => {
    const map = mapRef.current;
    if (!styleReady) return;
    const src = map?.getSource<GeoJSONSource>('own-position');
    if (!map || !src) return;

    src.setData({
      type: 'FeatureCollection',
      features: ownPosition
        ? [
            {
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [ownPosition.lon, ownPosition.lat] },
              properties: {
                accuracy: ownPosition.accuracy,
                radiusUnit: accuracyRadiusUnit(ownPosition.accuracy, ownPosition.lat),
              },
            },
          ]
        : [],
    });
  }, [ownPosition, styleReady]);

  return <div ref={container} className="map-container" />;
}
