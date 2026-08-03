import type { RadarTimeline } from '@seapro/shared';
import { cache } from './cache.js';
import { fetchText } from './http.js';

const CAPABILITIES_URL =
  'https://ilmgs.envir.ee/geoserver/ilm/wms?' +
  'SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0';
const HISTORY_MS = 12 * 3600_000;

function layerTimeValues(xml: string, layerName: string): string[] {
  const marker = new RegExp(`<Name>\\s*(?:ilm:)?${layerName}\\s*</Name>`, 'i').exec(xml);
  if (marker?.index === undefined) throw new Error(`Radarikihi ${layerName} kirjeldus puudub`);
  const end = xml.indexOf('</Layer>', marker.index);
  const block = xml.slice(marker.index, end < 0 ? undefined : end);
  const dimension = /<Dimension\b[^>]*name=["']time["'][^>]*>([^<]+)<\/Dimension>/i.exec(block);
  if (!dimension?.[1]) throw new Error(`Radarikihi ${layerName} ajad puuduvad`);

  return [...new Set(dimension[1].split(',').map((value) => value.trim()))]
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort((a, b) => Date.parse(a) - Date.parse(b));
}

/** Eksporditud eraldi, et teenuse formaadimuutust saaks fixture'iga testida. */
export function parseRadarTimeline(xml: string): RadarTimeline {
  const allObservations = layerTimeValues(xml, 'cmp_cap');
  const allNowcasts = layerTimeValues(xml, 'nowcasting');
  const latestObservation = allObservations.at(-1) ?? null;
  const latestObservationMs = latestObservation ? Date.parse(latestObservation) : 0;
  const observations = allObservations.filter(
    (time) => Date.parse(time) >= latestObservationMs - HISTORY_MS,
  );
  // `nowcasting` sisaldab ka sisendvaatlusi. Kliendile saadame ainult päris
  // tulevikukaadrid, et ta ei nimetaks vaatlust ekslikult prognoosiks.
  const forecasts = allNowcasts.filter((time) => Date.parse(time) > latestObservationMs);

  return {
    observations,
    forecasts,
    latestObservation,
    latestForecast: forecasts.at(-1) ?? null,
  };
}

export async function fetchRadarTimeline(): Promise<RadarTimeline> {
  const result = await cache.get('radar:timeline:v1', 60, async () =>
    parseRadarTimeline(await fetchText(CAPABILITIES_URL)),
  );
  return result.value;
}
