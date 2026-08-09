import type { Feature, FeatureCollection, Geometry } from 'geojson';
import type { FilterSpecification, GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import type { NavigationData } from '@seapro/shared';
import { insertBefore } from '../layerOrder';
import {
  fixedAidIconCategory,
  NAVIGATION_WARNING_ICON,
  TRAFFIC_DIRECTION_ICON,
  TRAFFIC_DIRECTION_WHITE_ICON,
  WRECK_ICON,
} from '../icons';
import { fairwayVisibleGeometries } from '../lineOverlap';

const SOURCE_ID = 'navigation-src';

export const TRAFFIC_SCHEME_AREAS_LAYER = 'traffic-scheme-areas';
export const TRAFFIC_SCHEME_LINES_LAYER = 'traffic-scheme-lines';
export const TRAFFIC_SCHEME_RECOMMENDED_LAYER = 'traffic-scheme-recommended';
export const TRAFFIC_SCHEME_ARROWS_LAYER = 'traffic-scheme-arrows';
export const FAIRWAYS_LAYER = 'official-fairways';
export const FAIRWAY_HIT_LAYER = 'official-fairways-hit';
export const WARNING_AREAS_LAYER = 'navigation-warning-areas';
export const WARNING_LINE_HIT_LAYER = 'navigation-warning-line-hit';
export const WARNING_LINES_LAYER = 'navigation-warning-lines';
export const WARNING_POINTS_LAYER = 'navigation-warning-points';
export const WRECKS_LAYER = 'wrecks';
export const WRECK_LABELS_LAYER = 'wreck-labels';
export const NAVIGATION_AID_HIT_LAYER = 'navigation-aid-hit';
export const NAVIGATION_AIDS_LAYER = 'navigation-aids';
export const NAVIGATION_AID_ALERTS_LAYER = 'navigation-aid-alerts';
export const NAVIGATION_AID_LABELS_LAYER = 'navigation-aid-labels';

export const NAVIGATION_CLICK_LAYERS = [
  WARNING_POINTS_LAYER,
  WARNING_LINE_HIT_LAYER,
  WARNING_AREAS_LAYER,
  WRECKS_LAYER,
  NAVIGATION_AID_HIT_LAYER,
  FAIRWAY_HIT_LAYER,
];

const NAVIGATION_LINE_COLOUR = '#a93ab4';

export interface NavigationVisibility {
  warnings: boolean;
  wrecks: boolean;
  aids: boolean;
  traffic: boolean;
  falseColors: boolean;
  official: boolean;
}

export function updateNavigation(map: MapLibreMap, data: NavigationData): void {
  const features: Feature[] = [];

  for (const warning of data.warnings) {
    features.push({
      type: 'Feature',
      geometry: warning.geometry as Geometry,
      properties: {
        featureKind: 'warning',
        id: warning.id,
        number: warning.number ?? null,
        source: warning.source ?? 'transpordiamet',
        titleEt: warning.titleEt ?? '',
        titleEn: warning.titleEn ?? '',
        titleFi: warning.titleFi ?? '',
        textEt: warning.textEt ?? '',
        textEn: warning.textEn ?? '',
        textFi: warning.textFi ?? '',
        areaEt: warning.areaEt ?? '',
        areaEn: warning.areaEn ?? '',
        areaFi: warning.areaFi ?? '',
        charts: warning.charts ?? '',
        publishedAt: warning.publishedAt ?? '',
        validFrom: warning.validFrom ?? '',
        validTo: warning.validTo ?? '',
        documentUrl: warning.documentUrl ?? '',
      },
    });
  }

  for (const wreck of data.wrecks) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [wreck.lon, wreck.lat] },
      properties: {
        featureKind: 'wreck',
        ...wreck,
        wreckDepthM: wreck.wreckDepthM ?? null,
        surroundingDepthM: wreck.surroundingDepthM ?? null,
        heightM: wreck.heightM ?? null,
        lengthM: wreck.lengthM ?? null,
        widthM: wreck.widthM ?? null,
      },
    });
  }

  for (const aid of data.aids) {
    const category = aid.category ?? (aid.virtual ? 'virtual' : 'unknown');
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [aid.lon, aid.lat] },
      properties: {
        featureKind: 'aid',
        ...aid,
        category,
        icon: `navigation-${fixedAidIconCategory(category, aid.markColours)}`,
        sources: aid.sources.join(','),
        official: aid.sources.some((source) => source !== 'ais'),
        virtual: aid.virtual ?? false,
        offPosition: aid.offPosition ?? false,
        mmsi: aid.mmsi ?? null,
        status: aid.status ?? null,
        atonType: aid.atonType ?? null,
        lightActive: aid.lightActive ?? null,
      },
    });
  }

  const visibleFairways = fairwayVisibleGeometries(data.fairways, data.trafficSchemes);
  for (const fairway of data.fairways) {
    const properties = {
      id: fairway.id,
      name: fairway.name,
      fairwayClass: fairway.fairwayClass ?? '',
      depthM: fairway.depthM ?? null,
      shipDraughtM: fairway.shipDraughtM ?? null,
      widthM: fairway.widthM ?? null,
      fairwayType: fairway.type ?? '',
    };
    // Täielik registrigeomeetria kuulub ainult läbipaistvasse klikikihti.
    features.push({
      type: 'Feature',
      geometry: fairway.geometry as Geometry,
      properties: {
        featureKind: 'fairway',
        ...properties,
      },
    });
    // Nähtavast joonest lõikame maha ainult OpenSeaMapiga kattuvad osad.
    const visibleGeometry = visibleFairways.get(fairway.id);
    if (visibleGeometry) features.push({
      type: 'Feature',
      geometry: visibleGeometry as Geometry,
      properties: {
        featureKind: 'fairway-visible',
        ...properties,
      },
    });
  }

  for (const scheme of data.trafficSchemes) {
    features.push({
      type: 'Feature',
      geometry: scheme.geometry as Geometry,
      properties: {
        featureKind: 'traffic-scheme',
        id: scheme.id,
        schemeKind: scheme.kind,
        name: scheme.name ?? '',
        orientation: scheme.orientation ?? null,
      },
    });
  }

  const collection: FeatureCollection = { type: 'FeatureCollection', features };
  const source = map.getSource<GeoJSONSource>(SOURCE_ID);
  if (source) source.setData(collection);
  else map.addSource(SOURCE_ID, {
    type: 'geojson',
    data: collection,
    attribution: '<a href="https://gis.transpordiamet.ee/arcgis/rest/services/Navigatsioonihoiatused/Nav_hoiatused_avalik/FeatureServer">Transpordiamet</a> · <a href="https://www.traficom.fi/en/maritime-transport-regulation-and-digitalisation/digitalisation-maritime-sector/e-navigation-and-s-100">Traficom</a> · <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
  });

  ensureLayers(map);
}

function ensureLayers(map: MapLibreMap): void {
  if (!map.getLayer(TRAFFIC_SCHEME_AREAS_LAYER)) {
    map.addLayer({
      id: TRAFFIC_SCHEME_AREAS_LAYER,
      type: 'fill',
      source: SOURCE_ID,
      filter: ['all',
        ['==', ['get', 'featureKind'], 'traffic-scheme'],
        ['==', ['geometry-type'], 'Polygon'],
      ],
      minzoom: 6,
      paint: {
        'fill-color': [
          'match', ['get', 'schemeKind'],
          'precautionary_area', '#d581ce',
          'inshore_traffic_zone', '#c596d8',
          '#b34ebc',
        ],
        'fill-opacity': 0.16,
      },
    }, insertBefore(map, TRAFFIC_SCHEME_AREAS_LAYER));
  }

  if (!map.getLayer(TRAFFIC_SCHEME_LINES_LAYER)) {
    map.addLayer({
      id: TRAFFIC_SCHEME_LINES_LAYER,
      type: 'line',
      source: SOURCE_ID,
      // Ühesuunalise raja joont ennast ei kuva: suunda näitab paks nool.
      // Alles jäävad skeemi päris piirid, eraldusjooned ja soovituslikud teed.
      filter: ['all',
        ['==', ['get', 'featureKind'], 'traffic-scheme'],
        ['match', ['get', 'schemeKind'],
          [
            'separation_lane',
            'recommended_traffic_lane',
            'traffic_lane',
            'recommended_track',
            'recommended_route_centreline',
          ], false,
          true,
        ],
      ],
      minzoom: 6,
      paint: {
        'line-color': NAVIGATION_LINE_COLOUR,
        'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1, 11, 1.8, 15, 2.5],
        'line-opacity': 0.82,
      },
    }, insertBefore(map, TRAFFIC_SCHEME_LINES_LAYER));
  }

  if (!map.getLayer(TRAFFIC_SCHEME_RECOMMENDED_LAYER)) {
    map.addLayer({
      id: TRAFFIC_SCHEME_RECOMMENDED_LAYER,
      type: 'line',
      source: SOURCE_ID,
      filter: ['all',
        ['==', ['get', 'featureKind'], 'traffic-scheme'],
        ['in', ['get', 'schemeKind'], ['literal', [
          'recommended_track',
          'recommended_route_centreline',
        ]]],
      ],
      minzoom: 6,
      paint: {
        'line-color': NAVIGATION_LINE_COLOUR,
        'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1, 11, 1.8, 15, 2.5],
        'line-opacity': 0.82,
        'line-dasharray': [3, 2],
      },
    }, insertBefore(map, TRAFFIC_SCHEME_RECOMMENDED_LAYER));
  }

  if (!map.getLayer(TRAFFIC_SCHEME_ARROWS_LAYER)) {
    map.addLayer({
      id: TRAFFIC_SCHEME_ARROWS_LAYER,
      type: 'symbol',
      source: SOURCE_ID,
      filter: ['all',
        ['==', ['get', 'featureKind'], 'traffic-scheme'],
        ['in', ['get', 'schemeKind'], ['literal', [
          'separation_lane',
          'recommended_traffic_lane',
          'traffic_lane',
        ]]],
        ['==', ['geometry-type'], 'LineString'],
      ],
      minzoom: 7,
      layout: {
        // Üks nool iga rajalõigu keskel. `line` + suur symbol-spacing jättis
        // lühikesed TSS-lõigud täiesti nooleta.
        'symbol-placement': 'line-center',
        'icon-image': TRAFFIC_DIRECTION_ICON,
        // Ülevaates väike ja hõre, lähisuumis merekaardi moodi suur ning paks.
        'icon-size': [
          'interpolate', ['linear'], ['zoom'],
          7, 0.32,
          10, 0.5,
          13, 0.75,
          16, 1,
        ],
        'icon-rotation-alignment': 'map',
        'icon-keep-upright': false,
        // Kõik rajanooled peavad alles jääma ka tihedas skeemis; suuruse
        // suumiskaala hoiab ülevaatepildi piisavalt hõredana.
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    }, insertBefore(map, TRAFFIC_SCHEME_ARROWS_LAYER));
  }

  if (!map.getLayer(FAIRWAYS_LAYER)) {
    map.addLayer({
      id: FAIRWAYS_LAYER,
      type: 'line',
      source: SOURCE_ID,
      filter: ['==', ['get', 'featureKind'], 'fairway-visible'],
      minzoom: 9,
      paint: {
        'line-color': NAVIGATION_LINE_COLOUR,
        'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1.5, 14, 3],
        'line-opacity': 0.75,
        'line-dasharray': [3, 2],
      },
    }, insertBefore(map, FAIRWAYS_LAYER));
  }

  if (!map.getLayer(FAIRWAY_HIT_LAYER)) {
    map.addLayer({
      id: FAIRWAY_HIT_LAYER,
      type: 'line',
      source: SOURCE_ID,
      filter: ['==', ['get', 'featureKind'], 'fairway'],
      minzoom: 9,
      paint: {
        // MapLibre'i hit-test kasutab line-width'i ega arvesta line-opacity't,
        // seega saab tabamisala olla päriselt nähtamatu. 1% alfaga 28 px joon
        // jäi valevärvide peal teise laevateena aimatavaks.
        'line-color': NAVIGATION_LINE_COLOUR,
        'line-opacity': 0,
        'line-width': 28,
      },
    }, insertBefore(map, FAIRWAY_HIT_LAYER));
  }

  if (!map.getLayer(WARNING_AREAS_LAYER)) {
    map.addLayer({
      id: WARNING_AREAS_LAYER,
      type: 'fill',
      source: SOURCE_ID,
      filter: ['all', ['==', ['get', 'featureKind'], 'warning'], ['==', ['geometry-type'], 'Polygon']],
      paint: {
        'fill-color': '#f1b51c',
        'fill-opacity': 0.2,
        'fill-outline-color': '#9b6500',
      },
    }, insertBefore(map, WARNING_AREAS_LAYER));
  }

  if (!map.getLayer(WARNING_LINES_LAYER)) {
    // Joone nähtav osa võib olla peen, kuid puuteseadmel peab selle ümber
    // olema piisavalt lai tabamisala. Peaaegu läbipaistev kiht jääb
    // queryRenderedFeatures/event-käsitlejale leitavaks ega muuda kaardipilti.
    map.addLayer({
      id: WARNING_LINE_HIT_LAYER,
      type: 'line',
      source: SOURCE_ID,
      filter: ['all', ['==', ['get', 'featureKind'], 'warning'], ['==', ['geometry-type'], 'LineString']],
      paint: {
        'line-color': 'rgba(216,138,0,0.01)',
        'line-width': 28,
      },
    }, insertBefore(map, WARNING_LINE_HIT_LAYER));

    map.addLayer({
      id: WARNING_LINES_LAYER,
      type: 'line',
      source: SOURCE_ID,
      filter: ['all', ['==', ['get', 'featureKind'], 'warning'], ['!=', ['geometry-type'], 'Point']],
      paint: {
        'line-color': '#d88a00',
        'line-width': 3,
        'line-dasharray': [2, 1.5],
      },
    }, insertBefore(map, WARNING_LINES_LAYER));
  }

  if (!map.getLayer(WARNING_POINTS_LAYER)) {
    map.addLayer({
      id: WARNING_POINTS_LAYER,
      type: 'symbol',
      source: SOURCE_ID,
      filter: ['all', ['==', ['get', 'featureKind'], 'warning'], ['==', ['geometry-type'], 'Point']],
      layout: {
        'icon-image': NAVIGATION_WARNING_ICON,
        'icon-size': [
          'interpolate', ['linear'], ['zoom'],
          7, 0.72,
          11, 0.92,
          15, 1.08,
        ],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    }, insertBefore(map, WARNING_POINTS_LAYER));
  }

  if (!map.getLayer(WRECKS_LAYER)) {
    map.addLayer({
      id: WRECKS_LAYER,
      type: 'symbol',
      source: SOURCE_ID,
      filter: ['==', ['get', 'featureKind'], 'wreck'],
      minzoom: 10,
      layout: {
        'icon-image': WRECK_ICON,
        'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.72, 14, 0.95, 17, 1.1],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    }, insertBefore(map, WRECKS_LAYER));
  }

  if (!map.getLayer(WRECK_LABELS_LAYER)) {
    map.addLayer({
      id: WRECK_LABELS_LAYER,
      type: 'symbol',
      source: SOURCE_ID,
      filter: ['==', ['get', 'featureKind'], 'wreck'],
      minzoom: 12,
      layout: {
        'text-field': ['get', 'name'],
        'text-font': ['Open Sans Regular'],
        'text-size': 10,
        'text-offset': [0, 1.55],
        'text-anchor': 'top',
        'text-optional': true,
      },
      paint: {
        'text-color': '#2e2140',
        'text-halo-color': 'rgba(255,255,255,0.9)',
        'text-halo-width': 1.2,
      },
    }, insertBefore(map, WRECK_LABELS_LAYER));
  }

  if (!map.getLayer(NAVIGATION_AID_ALERTS_LAYER)) {
    map.addLayer({
      id: NAVIGATION_AID_ALERTS_LAYER,
      type: 'circle',
      source: SOURCE_ID,
      filter: ['all', ['==', ['get', 'featureKind'], 'aid'], ['==', ['get', 'offPosition'], true]],
      minzoom: 10,
      paint: {
        'circle-radius': 12,
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': '#e5483f',
        'circle-stroke-width': 2.5,
      },
    }, insertBefore(map, NAVIGATION_AID_ALERTS_LAYER));
  }

  if (!map.getLayer(NAVIGATION_AID_HIT_LAYER)) {
    // Rasterkaardil oleva tingmärgi keskpunkt ja registri koordinaat võivad
    // mõne piksli võrra erineda. Eraldi läbipaistev tabamisala teeb kliki
    // andeksandvaks, ilma et joonistaks kaardile veel ühe nähtava märgi.
    map.addLayer({
      id: NAVIGATION_AID_HIT_LAYER,
      type: 'circle',
      source: SOURCE_ID,
      filter: ['==', ['get', 'featureKind'], 'aid'],
      minzoom: 10,
      paint: {
        // Nähtava tingmärgi `icon-anchor` on bottom: geograafiline punkt on
        // märgi jalas, märk ise ulatub sellest üles. Nihutame tabamisala sama
        // moodi üles, muidu oleks klikk aktiivne jalas, mitte märgi kehal.
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 15, 14, 18, 18, 21],
        'circle-translate': [0, -16],
        'circle-translate-anchor': 'viewport',
        'circle-color': 'rgba(0,0,0,0.01)',
      },
    }, insertBefore(map, NAVIGATION_AID_HIT_LAYER));
  }

  if (!map.getLayer(NAVIGATION_AIDS_LAYER)) {
    map.addLayer({
      id: NAVIGATION_AIDS_LAYER,
      type: 'symbol',
      source: SOURCE_ID,
      filter: ['==', ['get', 'featureKind'], 'aid'],
      minzoom: 10,
      layout: {
        'icon-image': ['get', 'icon'],
        // Navigatsioonimärgi koordinaat tähistab märgi jalga/asukohta vees,
        // mitte ikooni visuaalset keskpunkti.
        'icon-anchor': 'bottom',
        'icon-size': [
          'interpolate', ['linear'], ['zoom'],
          10, 0.9,
          13, 1.1,
          16, 1.3,
        ],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    }, insertBefore(map, NAVIGATION_AIDS_LAYER));
  }

  if (!map.getLayer(NAVIGATION_AID_LABELS_LAYER)) {
    map.addLayer({
      id: NAVIGATION_AID_LABELS_LAYER,
      type: 'symbol',
      source: SOURCE_ID,
      filter: ['==', ['get', 'featureKind'], 'aid'],
      minzoom: 12,
      layout: {
        'text-field': ['get', 'name'],
        'text-font': ['Open Sans Regular'],
        'text-size': 10,
        'text-offset': [0, 1.45],
        'text-anchor': 'top',
        'text-optional': true,
      },
      paint: {
        'text-color': '#183544',
        'text-halo-color': 'rgba(255,255,255,0.92)',
        'text-halo-width': 1.2,
      },
    }, insertBefore(map, NAVIGATION_AID_LABELS_LAYER));
  }
}

export function setNavigationVisibility(map: MapLibreMap, visibility: NavigationVisibility): void {
  setVisible(
    map,
    [WARNING_AREAS_LAYER, WARNING_LINE_HIT_LAYER, WARNING_LINES_LAYER, WARNING_POINTS_LAYER],
    visibility.warnings,
  );
  setVisible(map, [WRECKS_LAYER, WRECK_LABELS_LAYER], visibility.wrecks);
  setVisible(
    map,
    [
      TRAFFIC_SCHEME_AREAS_LAYER,
      TRAFFIC_SCHEME_LINES_LAYER,
      TRAFFIC_SCHEME_RECOMMENDED_LAYER,
      TRAFFIC_SCHEME_ARROWS_LAYER,
    ],
    visibility.traffic,
  );
  if (map.getLayer(TRAFFIC_SCHEME_AREAS_LAYER)) {
    map.setPaintProperty(
      TRAFFIC_SCHEME_AREAS_LAYER,
      'fill-color',
      visibility.falseColors
        ? '#ffffff'
        : [
            'match', ['get', 'schemeKind'],
            'precautionary_area', '#d581ce',
            'inshore_traffic_zone', '#c596d8',
            '#b34ebc',
          ],
    );
  }
  if (map.getLayer(TRAFFIC_SCHEME_ARROWS_LAYER)) {
    map.setLayoutProperty(
      TRAFFIC_SCHEME_ARROWS_LAYER,
      'icon-image',
      visibility.falseColors ? TRAFFIC_DIRECTION_WHITE_ICON : TRAFFIC_DIRECTION_ICON,
    );
  }
  if (map.getLayer(FAIRWAYS_LAYER)) {
    // Kui OpenSeaMapi jooned on väljas, peab nähtavale tulema registrijoone
    // täielik kuju. Kärbitud geomeetria on õige ainult koos dubletti katva
    // liiklusskeemikihiga.
    map.setFilter(
      FAIRWAYS_LAYER,
      ['==', ['get', 'featureKind'], visibility.traffic ? 'fairway-visible' : 'fairway'],
    );
  }

  // AIS AToN ja registrimärgid jagavad allikat. Registriobjektide lüliti
  // võib märgid sisse tuua ka siis, kui reaalaja AIS-märgid on väljas.
  setVisible(
    map,
    [NAVIGATION_AID_HIT_LAYER, NAVIGATION_AID_ALERTS_LAYER, NAVIGATION_AIDS_LAYER],
    visibility.aids || visibility.official,
  );
  // Nimi on kõigil navigatsioonimärkidel popupis. Kaardile eraldi tekstikihti
  // ei kuva, sõltumata riigist või registriallikast.
  setVisible(map, [NAVIGATION_AID_LABELS_LAYER], false);
  const kindFilter: FilterSpecification = ['==', ['get', 'featureKind'], 'aid'];
  const sourceFilter: FilterSpecification | null = visibility.aids && visibility.official
    ? null
    : visibility.aids
      ? ['in', 'ais', ['get', 'sources']]
      : ['==', ['get', 'official'], true];
  const visibleAidFilter: FilterSpecification = sourceFilter
    ? ['all', kindFilter, sourceFilter]
    : kindFilter;
  if (map.getLayer(NAVIGATION_AIDS_LAYER)) {
    map.setFilter(NAVIGATION_AIDS_LAYER, visibleAidFilter);
  }
  if (map.getLayer(NAVIGATION_AID_HIT_LAYER)) {
    map.setFilter(NAVIGATION_AID_HIT_LAYER, visibleAidFilter);
  }
  if (map.getLayer(NAVIGATION_AID_ALERTS_LAYER)) {
    const offPositionFilter: FilterSpecification = ['==', ['get', 'offPosition'], true];
    map.setFilter(
      NAVIGATION_AID_ALERTS_LAYER,
      sourceFilter
        ? ['all', kindFilter, sourceFilter, offPositionFilter]
        : ['all', kindFilter, offPositionFilter],
    );
  }
  setVisible(map, [FAIRWAYS_LAYER, FAIRWAY_HIT_LAYER], visibility.official);
}

function setVisible(map: MapLibreMap, layers: string[], visible: boolean): void {
  for (const layer of layers) {
    if (map.getLayer(layer)) map.setLayoutProperty(layer, 'visibility', visible ? 'visible' : 'none');
  }
}
