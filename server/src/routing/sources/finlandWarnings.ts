import type { BBox, NavigationWarning } from '@seapro/shared';
import { fetchFinnishNavigationWarningsWithMeta } from '../../navigation/traficomWarnings.js';
import type { RoutingSourceMeta, RoutingWarning } from '../sourceTypes.js';
import { asRoutingGeometry, intersectBbox } from './common.js';

const SOURCE = 'traficom-warnings' as const;
const COVERAGE: BBox = [59.4, 19.0, 70.2, 31.7];
const ATTRIBUTION = 'Traficom / Fintraffic, navigational warnings';
const ATTRIBUTION_URL = 'https://julkinen.traficom.fi/inspirepalvelu/avoin/wfs';

export interface FinnishRoutingWarnings {
  warnings: RoutingWarning[];
  source: RoutingSourceMeta;
}

/** Lisab Traficomi kehtivad merivaroitused marsruudi ettevaatuskihti. */
export async function loadFinnishRoutingWarnings(
  bbox: BBox,
  departureTime: string,
): Promise<FinnishRoutingWarnings> {
  const clipped = intersectBbox(bbox, COVERAGE);
  if (!clipped) {
    return { warnings: [], source: finnishWarningsSourceMeta('outside_coverage') };
  }

  try {
    const loaded = await fetchFinnishNavigationWarningsWithMeta(clipped);
    const fetchedAt = new Date(Date.now() - loaded.ageSeconds * 1000).toISOString();
    return {
      warnings: parseFinnishNavigationWarnings(
        loaded.warnings,
        fetchedAt,
        departureTime,
        loaded.stale,
      ),
      source: finnishWarningsSourceMeta(
        loaded.stale ? 'stale' : 'ok',
        fetchedAt,
        loaded.error,
        loaded.ageSeconds,
      ),
    };
  } catch (error) {
    return {
      warnings: [],
      source: finnishWarningsSourceMeta(
        'unavailable',
        new Date().toISOString(),
        error instanceof Error ? error.message : String(error),
      ),
    };
  }
}

export function parseFinnishNavigationWarnings(
  warnings: NavigationWarning[],
  fetchedAt: string,
  departureTime: string,
  stale = false,
): RoutingWarning[] {
  const departureMs = new Date(departureTime).getTime();
  return warnings.flatMap((warning) => {
    const validFromMs = warning.validFrom ? new Date(warning.validFrom).getTime() : Number.NaN;
    const validToMs = warning.validTo ? new Date(warning.validTo).getTime() : Number.NaN;
    if (Number.isFinite(departureMs)
      && ((Number.isFinite(validFromMs) && validFromMs > departureMs)
        || (Number.isFinite(validToMs) && validToMs < departureMs))) return [];

    const geometry = asRoutingGeometry(warning.geometry);
    if (!geometry) return [];
    const description = warning.textEn ?? warning.textFi ?? warning.textEt;
    const searchable = [
      warning.titleEt,
      warning.titleEn,
      warning.titleFi,
      warning.textEt,
      warning.textEn,
      warning.textFi,
    ].filter(Boolean).join(' ');
    const severity = /keelatud|suletud|oht|prohibited|closed|danger|kielletty|suljettu|vaara/i
      .test(searchable)
      ? 'critical'
      : 'caution';

    return [{
      id: `traficom-warnings:${warning.id}`,
      kind: 'navigation_warning',
      geometry,
      name: warning.titleEn ?? warning.titleFi ?? warning.titleEt
        ?? `Navigational warning ${warning.number ?? ''}`.trim(),
      description,
      severity,
      reportedAt: warning.publishedAt ?? warning.validFrom,
      faultCode: warning.number === undefined ? undefined : String(warning.number),
      source: SOURCE,
      fetchedAt,
      stale,
    } satisfies RoutingWarning];
  });
}

export function finnishWarningsSourceMeta(
  status: RoutingSourceMeta['status'],
  fetchedAt = new Date().toISOString(),
  error?: string,
  ageSeconds = 0,
): RoutingSourceMeta {
  return {
    id: SOURCE,
    source: SOURCE,
    status,
    stale: status === 'stale',
    fetchedAt,
    ageSeconds,
    coverage: status === 'unavailable' ? 'missing' : 'complete',
    ...(error ? { error, errors: [error] } : {}),
    tilesRequested: status === 'outside_coverage' ? 0 : 1,
    tilesLoaded: status === 'ok' || status === 'stale' ? 1 : 0,
    attribution: ATTRIBUTION,
    attributionUrl: ATTRIBUTION_URL,
  };
}
