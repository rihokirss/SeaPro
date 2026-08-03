import { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, Map as MapLibreMap, RasterTileSource } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre 6 otsib tööprotsessi faili oma mooduli URL-i kõrvalt
// (`./maplibre-gl-worker.mjs`). Vite ei näe seda staatiliselt ega emiteeri
// faili, seega jääks build'is 404 ja kaart ei renderdaks midagi. Laseme Vitel
// tööprotsessi ise pakendada ja anname valmis URL-i MapLibre'ile.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import {
  OVERLAY_LAYERS,
  baseStyle,
  overlayIsActive,
  type RadarFrame,
  type RasterLayerDef,
} from './basemaps';
import { addColorBase } from './colorBase';
import { addDarkBase } from './darkBase';
import { registerIcons } from './icons';
import { LAYER_ORDER } from './layerOrder';
import { addPlaceLabels } from './layers/placeLabels';
import type { Position } from '../lib/geolocation';
import type { DepthRiskSegment, RouteWaypoint, TrackPoint } from '@seapro/shared';
import { addRouteLayers, ROUTE_LINE_LAYER, ROUTE_WAYPOINT_LAYER, updateRouteLayers } from './layers/route';

export interface MapViewProps {
  center: [number, number];
  zoom: number;
  /** Millised overlay-kihid on sisse lülitatud. */
  activeOverlays: string[];
  radarFrame: RadarFrame;
  ownPosition: Position | null;
  routeWaypoints: RouteWaypoint[];
  routeSegments: DepthRiskSegment[];
  trackPoints: TrackPoint[];
  routeEditing: boolean;
  onReady(map: MapLibreMap): void;
  onMoveEnd(bbox: [number, number, number, number], zoom: number): void;
  onPick(lat: number, lon: number): void;
  onRouteMove(index: number, lat: number, lon: number): void;
  onRouteMoveStart(): void;
  onRouteInsert(index: number, lat: number, lon: number): void;
  onUserMove(): void;
}


/**
 * Suurim täpsus (meetrites), mille juures täpsusringi veel joonistame.
 * Päris GPS annab merel 5–30 m; kui number on suurem, on tegu Wi-Fi/IP
 * hinnanguga ja ring oleks eksitav mürakera üle poole kaardist.
 */
const ACCURACY_RING_MAX_M = 1000;
const DEPTH_CONTOUR_MIN_ZOOM = 7;
const DEPTH_SAMPLE_MIN_ZOOM = 12;
const EMPTY_FEATURE_COLLECTION: FeatureCollection = { type: 'FeatureCollection', features: [] };

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

/** EMODneti WFS-i GeoJSON kuvatakse päris vektorina, mitte rasterpildina. */
function addDepthContours(map: MapLibreMap, beforeId?: string): void {
  if (!map.getSource('src-depth-contours')) {
    map.addSource('src-depth-contours', {
      type: 'geojson',
      data: EMPTY_FEATURE_COLLECTION,
      attribution: '<a href="https://emodnet.ec.europa.eu/">EMODnet Bathymetry (CC BY 4.0)</a>',
    });
  }
  if (!map.getLayer('depth-contours')) {
    map.addLayer({
      id: 'depth-contours',
      type: 'line',
      source: 'src-depth-contours',
      minzoom: DEPTH_CONTOUR_MIN_ZOOM,
      layout: {
        'line-join': 'round',
        'line-cap': 'round',
      },
      paint: {
        'line-color': '#0878a8',
        'line-opacity': 0.82,
        'line-width': [
          'interpolate', ['linear'], ['zoom'],
          DEPTH_CONTOUR_MIN_ZOOM, 0.8,
          14, 1.6,
        ],
      },
    }, beforeId);
  }
  if (!map.getLayer('depth-contour-labels')) {
    map.addLayer({
      id: 'depth-contour-labels',
      type: 'symbol',
      source: 'src-depth-contours',
      minzoom: DEPTH_CONTOUR_MIN_ZOOM,
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 350,
        'text-field': ['concat', ['to-string', ['get', 'elevation']], ' m'],
        'text-font': ['Open Sans Regular'],
        'text-size': 11,
        'text-keep-upright': true,
      },
      paint: {
        'text-color': '#075f86',
        'text-halo-color': 'rgba(235, 247, 251, 0.95)',
        'text-halo-width': 1.5,
      },
    }, beforeId);
  }
  if (!map.getSource('src-depth-samples')) {
    map.addSource('src-depth-samples', {
      type: 'geojson',
      data: EMPTY_FEATURE_COLLECTION,
      attribution: '<a href="https://emodnet.ec.europa.eu/">EMODnet DTM</a>',
    });
  }
  if (!map.getLayer('depth-sample-labels')) {
    map.addLayer({
      id: 'depth-sample-labels',
      type: 'symbol',
      source: 'src-depth-samples',
      minzoom: DEPTH_SAMPLE_MIN_ZOOM,
      layout: {
        'text-field': ['get', 'depthLabel'],
        'text-font': ['Open Sans Regular'],
        'text-size': [
          'interpolate', ['linear'], ['zoom'],
          DEPTH_SAMPLE_MIN_ZOOM, 10,
          16, 12,
        ],
        'text-allow-overlap': false,
      },
      paint: {
        'text-color': '#174d67',
        'text-halo-color': 'rgba(238, 248, 251, 0.92)',
        'text-halo-width': 1.25,
      },
    }, beforeId);
  }
}

export function MapView({
  center,
  zoom,
  activeOverlays,
  radarFrame,
  ownPosition,
  routeWaypoints,
  routeSegments,
  trackPoints,
  routeEditing,
  onReady,
  onMoveEnd,
  onPick,
  onRouteMove,
  onRouteMoveStart,
  onRouteInsert,
  onUserMove,
}: MapViewProps): React.ReactElement {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [styleReady, setStyleReady] = useState(false);
  // Hoiame callback'id ref'is, et kaarti ei ehitataks iga renderi peale uuesti.
  const cb = useRef({ onReady, onMoveEnd, onPick, onRouteMove, onRouteMoveStart, onRouteInsert, onUserMove });
  cb.current = { onReady, onMoveEnd, onPick, onRouteMove, onRouteMoveStart, onRouteInsert, onUserMove };
  const routeEditingRef = useRef(routeEditing);
  routeEditingRef.current = routeEditing;

  useEffect(() => {
    if (!container.current || mapRef.current) return;

    maplibregl.setWorkerUrl(maplibreWorkerUrl);

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
      addRouteLayers(map);
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
    map.on('dragstart', () => cb.current.onUserMove());

    let draggedWaypoint: number | null = null;
    const beginWaypointDrag = (e: maplibregl.MapLayerMouseEvent | maplibregl.MapLayerTouchEvent): void => {
      if (!routeEditingRef.current) return;
      const index = Number(e.features?.[0]?.properties?.index);
      if (!Number.isInteger(index)) return;
      e.preventDefault(); cb.current.onRouteMoveStart(); draggedWaypoint = index; map.dragPan.disable();
    };
    map.on('mousedown', ROUTE_WAYPOINT_LAYER, beginWaypointDrag);
    map.on('touchstart', ROUTE_WAYPOINT_LAYER, beginWaypointDrag);
    const moveWaypoint = (e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent): void => {
      if (draggedWaypoint === null) return;
      cb.current.onRouteMove(draggedWaypoint, e.lngLat.lat, e.lngLat.lng);
    };
    map.on('mousemove', moveWaypoint);
    map.on('touchmove', moveWaypoint);
    const endWaypointDrag = (): void => { if (draggedWaypoint !== null) { draggedWaypoint = null; map.dragPan.enable(); } };
    map.on('mouseup', endWaypointDrag); map.on('touchend', endWaypointDrag);
    map.on('click', ROUTE_LINE_LAYER, (e) => {
      if (!routeEditingRef.current) return;
      const index = Number(e.features?.[0]?.properties?.segmentIndex);
      if (Number.isInteger(index)) cb.current.onRouteInsert(index + 1, e.lngLat.lat, e.lngLat.lng);
    });

    map.on('click', (e) => {
      // Kui klikk tabas mõnda andmekihti (jaam, laev), tegeleb sellega
      // vastav kihi enda käsitleja — siin ei tohi punktipaneeli avada.
      if (routeEditingRef.current) {
        const routeHit = map.queryRenderedFeatures(e.point, { layers: [ROUTE_WAYPOINT_LAYER, ROUTE_LINE_LAYER] });
        if (routeHit.length === 0) cb.current.onPick(e.lngLat.lat, e.lngLat.lng);
        return;
      }
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
      const wanted = overlayIsActive(def.id, activeOverlays);
      const effectiveDef = def.id === 'radar' ? radarFrame.def : def;
      const exists = Boolean(map.getLayer(def.id));

      if (wanted && effectiveDef) {
        // Sama radariallikas vahetab ajaliuguri liikumisel URL-i. `setTiles`
        // tühjendab vanad paanid ja paneb MapLibre'i valitud WMS kaadrit küsima.
        if (def.id === 'radar') {
          map.getSource<RasterTileSource>(`src-${def.id}`)?.setTiles(effectiveDef.tiles);
        }
      }

      if (wanted && effectiveDef && !exists) {
        // Lisa esimese andmekihi ETTE, et andmed jääksid alati peale.
        const before = LAYER_ORDER.find((id) => map.getLayer(id));
        addRaster(map, effectiveDef, before);
      } else if ((!wanted || !effectiveDef) && exists) {
        map.removeLayer(def.id);
      }
    }
  }, [activeOverlays, radarFrame, styleReady]);

  // Samasügavusjooned: nähtava ala WFS-päring ja GeoJSON-i vektorkuva.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady) return;

    const wanted = activeOverlays.includes('depth-details');
    if (!wanted) {
      if (map.getLayer('depth-sample-labels')) map.removeLayer('depth-sample-labels');
      if (map.getLayer('depth-contour-labels')) map.removeLayer('depth-contour-labels');
      if (map.getLayer('depth-contours')) map.removeLayer('depth-contours');
      return;
    }

    const before = LAYER_ORDER.find((id) => map.getLayer(id));
    addDepthContours(map, before);

    let controller: AbortController | null = null;
    const refresh = (): void => {
      const source = map.getSource<GeoJSONSource>('src-depth-contours');
      const sampleSource = map.getSource<GeoJSONSource>('src-depth-samples');
      if (!source || !sampleSource) return;
      if (map.getZoom() < DEPTH_CONTOUR_MIN_ZOOM) {
        source.setData(EMPTY_FEATURE_COLLECTION);
        sampleSource.setData(EMPTY_FEATURE_COLLECTION);
        return;
      }

      const bounds = map.getBounds();
      const bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]
        .map((value) => value.toFixed(5))
        .join(',');
      controller?.abort();
      controller = new AbortController();
      const zoom = Math.floor(map.getZoom());
      fetch(
        `/api/depth-contours?bbox=${encodeURIComponent(bbox)}&zoom=${zoom}`,
        { signal: controller.signal },
      )
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return await response.json() as FeatureCollection;
        })
        .then((data) => source.setData(data))
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === 'AbortError') return;
          console.error('[SeaPro] samasügavusjoonte laadimine ebaõnnestus:', error);
        });

      if (map.getZoom() < DEPTH_SAMPLE_MIN_ZOOM) {
        sampleSource.setData(EMPTY_FEATURE_COLLECTION);
      } else {
        fetch(
          `/api/depth-samples?bbox=${encodeURIComponent(bbox)}&zoom=${zoom}`,
          { signal: controller.signal },
        )
          .then(async (response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return await response.json() as FeatureCollection;
          })
          .then((data) => sampleSource.setData(data))
          .catch((error: unknown) => {
            if (error instanceof DOMException && error.name === 'AbortError') return;
            console.error('[SeaPro] mudelsügavuste laadimine ebaõnnestus:', error);
          });
      }
    };

    refresh();
    map.on('moveend', refresh);
    return () => {
      controller?.abort();
      map.off('moveend', refresh);
    };
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

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady) return;
    updateRouteLayers(map, routeWaypoints, routeSegments, trackPoints, routeEditing);
    map.getCanvas().style.cursor = routeEditing ? 'crosshair' : '';
  }, [routeWaypoints, routeSegments, trackPoints, routeEditing, styleReady]);

  return <div ref={container} className="map-container" />;
}
