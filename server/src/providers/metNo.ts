import type { ProviderCapabilities, TimeSeries, TimeStep, Variable } from '@seapro/shared';
import { cache } from '../cache.js';
import { config } from '../config.js';
import { fetchJson } from '../http.js';
import { round, type PointQuery, type WeatherProvider } from './types.js';

const LOCATION_URL = 'https://api.met.no/weatherapi/locationforecast/2.0/compact';
const OCEAN_URL = 'https://api.met.no/weatherapi/oceanforecast/2.0/complete';

/** MET Forecast GeoJSON — mõlemal otspunktil sama kuju. */
interface MetResponse {
  geometry?: { coordinates: [number, number, number?] };
  properties?: {
    meta?: { updated_at?: string };
    timeseries?: {
      time: string;
      data?: {
        instant?: { details?: Record<string, number> };
        next_1_hours?: { details?: Record<string, number> };
      };
    }[];
  };
}

/** met.no välja nimi -> meie muutuja. */
const INSTANT_MAP: Record<string, Variable> = {
  wind_speed: 'wind_speed',
  wind_speed_of_gust: 'wind_gust',
  wind_from_direction: 'wind_dir',
  air_temperature: 'air_temp',
  air_pressure_at_sea_level: 'pressure',
  relative_humidity: 'humidity',
  cloud_area_fraction: 'cloud_cover',
  // Ookeanivastuse väljad
  sea_surface_wave_height: 'wave_height',
  sea_surface_wave_from_direction: 'wave_dir',
  sea_water_temperature: 'sea_temp',
  sea_water_speed: 'current_speed',
  sea_water_to_direction: 'current_dir',
};

/**
 * MET Norway (Norra meteoroloogiainstituut).
 *
 * Kaks otspunkti: `locationforecast` (atmosfäär) ja `oceanforecast` (lained,
 * hoovused, veetemperatuur). Mõlemad katavad Läänemerd — kontrollitud
 * koordinaadil 59.0/23.5.
 *
 * Kaks asja, mis siin ERINEVAD teistest provideritest:
 *
 *  1. **User-Agent on kohustuslik.** met.no ToS nõuab tuvastatavat kontakti
 *     ja vastab anonüümsele või geneerilisele päringule 403-ga. Brauser ei
 *     saa User-Agenti seada, seega see provider EI SAA kunagi töötada otse
 *     frontendist — proxy pole mugavus, vaid tingimus.
 *
 *  2. **`Expires` päist tuleb austada.** ToS keelab andmete uuesti pärimise
 *     enne selle aja möödumist. Loeme päise vastusest ja seame vahemälu TTL-i
 *     selle järgi, mitte oma konfiguratsiooni järgi.
 */
export class MetNoProvider implements WeatherProvider {
  readonly caps: ProviderCapabilities = {
    id: 'met-no',
    label: 'MET Norway',
    kind: 'forecast',
    variables: [
      'wind_speed',
      'wind_gust',
      'wind_dir',
      'air_temp',
      'pressure',
      'humidity',
      'cloud_cover',
      'wave_height',
      'wave_dir',
      'sea_temp',
      'current_speed',
      'current_dir',
    ],
    supportsGrid: false,
    supportsStations: false,
    forecastHours: 9 * 24,
    attribution: 'MET Norway (NLOD / CC BY 4.0)',
    attributionUrl: 'https://api.met.no/',
    enabled: Boolean(config.contactEmail),
    disabledReason: config.contactEmail
      ? undefined
      : 'CONTACT_EMAIL puudub — met.no nõuab tuvastatavat kontakti',
  };

  async point(q: PointQuery): Promise<TimeSeries[]> {
    if (!this.caps.enabled) return [];

    // met.no ToS: ära küsi rohkem kui 4 komakohta — see raiskaks nende
    // vahemälu, sest lähestikused päringud annavad sama mudelilahtri.
    const lat = q.lat.toFixed(4);
    const lon = q.lon.toFixed(4);

    const [atmo, ocean] = await Promise.allSettled([
      this.#fetch(LOCATION_URL, lat, lon),
      this.#fetch(OCEAN_URL, lat, lon),
    ]);

    const atmoRes = atmo.status === 'fulfilled' ? atmo.value : null;
    const oceanRes = ocean.status === 'fulfilled' ? ocean.value : null;

    // Ookeanivastus puudub sisemaal — see on ootuspärane, mitte viga.
    if (!atmoRes && !oceanRes) {
      throw atmo.status === 'rejected' ? atmo.reason : new Error('met.no ei vastanud');
    }

    const steps = mergeTimeseries(atmoRes, oceanRes, q.hours);
    if (steps.length === 0) return [];

    const geometry = atmoRes?.geometry ?? oceanRes?.geometry;

    return [
      {
        providerId: this.caps.id,
        lat: geometry?.coordinates[1] ?? q.lat,
        lon: geometry?.coordinates[0] ?? q.lon,
        updatedAt: atmoRes?.properties?.meta?.updated_at ?? oceanRes?.properties?.meta?.updated_at,
        steps,
      },
    ];
  }

  async #fetch(url: string, lat: string, lon: string): Promise<MetResponse> {
    const full = `${url}?lat=${lat}&lon=${lon}`;
    const { value } = await cache.get(`metno:${full}`, config.ttl.metNo, async () => {
      const res = await fetchJson<MetResponse & { __expires?: string }>(full);
      return res;
    });
    return value;
  }
}

/**
 * Liidab atmosfääri- ja mereajarea üheks.
 *
 * met.no annab esimesed ~3 päeva tunnisammuga ja seejärel 6-tunnise sammuga.
 * Me EI interpoleeri vahepealseid tunde: hõredam samm on mudeli enda otsus ja
 * väljamõeldud vahepunktid annaksid graafikul vale täpsusmulje.
 */
function mergeTimeseries(
  atmo: MetResponse | null,
  ocean: MetResponse | null,
  hours: number,
): TimeStep[] {
  const byTime = new Map<string, TimeStep['values']>();
  const cutoff = Date.now() + hours * 3600_000;

  const absorb = (res: MetResponse | null): void => {
    for (const entry of res?.properties?.timeseries ?? []) {
      const stamp = new Date(entry.time).getTime();
      if (Number.isNaN(stamp) || stamp > cutoff) continue;

      const details = entry.data?.instant?.details;
      if (!details) continue;

      const target = byTime.get(entry.time) ?? {};
      for (const [key, value] of Object.entries(details)) {
        const mine = INSTANT_MAP[key];
        if (mine) target[mine] = round(value);
      }

      // Sademed on `next_1_hours` all, mitte hetkeväärtusena.
      const precip = entry.data?.next_1_hours?.details?.precipitation_amount;
      if (precip !== undefined) target.precipitation = round(precip);

      byTime.set(entry.time, target);
    }
  };

  absorb(atmo);
  absorb(ocean);

  return [...byTime.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([time, values]) => ({ time, values }));
}

export const metNo = new MetNoProvider();
