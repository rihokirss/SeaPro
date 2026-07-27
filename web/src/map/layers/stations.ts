import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import type { StationReading, Variable } from '@seapro/shared';
import { freshnessOf } from '@seapro/shared';
import { stationIcon } from '../icons';
import { insertBefore } from '../layerOrder';
import { convertSpeed } from '@seapro/shared';
import type { SpeedUnit } from '../../lib/units';

const SOURCE_ID = 'stations-src';
export const STATIONS_LAYER = 'stations-dots';
export const STATIONS_LABEL_LAYER = 'stations-labels';

/**
 * Mõõtejaamade ja poide kiht.
 *
 * Markeri KUJU näitab tüüpi (ring = rannikujaam, ruut = avameri, romb = poi),
 * VÄRV näitab andmete vanust — sama loogika mis METOC-i originaalportaalil
 * (värske / üle 5 h / üle 24 h). Kaks kanalit on siin sihilikult: värvipimeda
 * kasutaja jaoks jääb tüüp kuju kaudu loetavaks ja päikese käes on kuju
 * usaldusväärsem signaal kui värvitoon.
 *
 * Markeri kõrval kuvatakse põhinäit numbrina — nii ei pea igale jaamale
 * eraldi klõpsama, et näha, kas seal puhub 3 või 15 m/s.
 */

export interface StationLayerOptions {
  /** Milline väärtus markeri kõrval numbrina kuvada. */
  labelVariable: Variable;
  speedUnit: SpeedUnit;
}

const SPEED_VARS = new Set<Variable>(['wind_speed', 'wind_gust', 'current_speed']);

function labelFor(
  reading: StationReading,
  opts: StationLayerOptions,
): string {
  const raw = reading.values[opts.labelVariable];
  if (raw == null) return '';

  if (SPEED_VARS.has(opts.labelVariable)) {
    const v = convertSpeed(raw, opts.speedUnit);
    return opts.speedUnit === 'bft' ? String(Math.round(v)) : v.toFixed(v >= 10 ? 0 : 1);
  }
  if (opts.labelVariable === 'wave_height') return raw.toFixed(1);
  return String(Math.round(raw));
}

export function updateStations(
  map: MapLibreMap,
  readings: StationReading[],
  opts: StationLayerOptions,
): void {
  const features = readings.map((r) => {
    const freshness = freshnessOf(r.ageSeconds);
    return {
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.lon, r.lat] },
      properties: {
        id: `${r.providerId}:${r.id}`,
        providerId: r.providerId,
        name: r.name,
        kind: r.kind,
        freshness,
        icon: stationIcon(r.kind, freshness),
        label: labelFor(r, opts),
        // Kogu näit läheb kaasa, et popup ei vajaks uut päringut.
        values: JSON.stringify(r.values),
        observedAt: r.observedAt ?? '',
        ageSeconds: r.ageSeconds ?? -1,
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

  if (!map.getLayer(STATIONS_LAYER)) {
    map.addLayer({
      id: STATIONS_LAYER,
      type: 'symbol',
      source: SOURCE_ID,
      layout: {
        'icon-image': ['get', 'icon'],
        'icon-size': [
          'interpolate', ['linear'], ['zoom'],
          5, 0.55,
          9, 0.8,
          13, 1,
        ],
        // Jaamad on püsivad orientiirid — nad ei tohi tuulenoolte tõttu kaduda.
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    }, insertBefore(map, STATIONS_LAYER));
  }

  if (!map.getLayer(STATIONS_LABEL_LAYER)) {
    map.addLayer({
      id: STATIONS_LABEL_LAYER,
      type: 'symbol',
      source: SOURCE_ID,
      // Numbrid ilmuvad alles siis, kui jaamad pole enam kobaras — madalal
      // zoomil kattuksid nad üksteisega loetamatuks.
      minzoom: 7,
      layout: {
        'text-field': ['get', 'label'],
        'text-font': ['Noto Sans Bold'],
        'text-size': [
          'interpolate', ['linear'], ['zoom'],
          7, 11,
          12, 14,
        ],
        'text-offset': [0, -1.5],
        'text-anchor': 'bottom',
        'text-allow-overlap': false,
        'text-ignore-placement': false,
        'text-optional': true,
      },
      paint: {
        'text-color': '#0b2333',
        // Valge halo hoiab numbri loetavana igal taustal.
        'text-halo-color': 'rgba(255,255,255,0.95)',
        'text-halo-width': 1.6,
      },
    }, insertBefore(map, STATIONS_LABEL_LAYER));
  }

  setStationsVisible(map, true);
}

export function setStationsVisible(map: MapLibreMap, visible: boolean): void {
  const v = visible ? 'visible' : 'none';
  for (const id of [STATIONS_LAYER, STATIONS_LABEL_LAYER]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
  }
}
