import type { BBox, NavigationWarning } from '@seapro/shared';
import { fetchNavigationWarningsWithMeta } from '../../navigation/arcgis.js';
import type { RoutingSourceMeta, RoutingWarning } from '../sourceTypes.js';
import { asRoutingGeometry, intersectBbox } from './common.js';

const SOURCE = 'transpordiamet-warnings' as const;
const COVERAGE: BBox = [57, 20, 60.5, 29];
const ATTRIBUTION = 'Transpordiamet, navigatsioonihoiatused';
const ATTRIBUTION_URL = 'https://gis.transpordiamet.ee/arcgis/rest/services/Navigatsioonihoiatused/Nav_hoiatused_avalik/FeatureServer';

export interface EstonianRoutingWarnings {
  warnings: RoutingWarning[];
  source: RoutingSourceMeta;
}

/** Lisab kehtivad vabatekstilised mereteated ettevaatuskihina, mitte keeluna. */
export async function loadEstonianRoutingWarnings(
  bbox: BBox,
  departureTime: string,
): Promise<EstonianRoutingWarnings> {
  const clipped = intersectBbox(bbox, COVERAGE);
  if (!clipped) {
    return { warnings: [], source: estonianWarningsSourceMeta('outside_coverage') };
  }
  try {
    const loaded = await fetchNavigationWarningsWithMeta(clipped);
    const fetchedAt = new Date(Date.now() - loaded.ageSeconds * 1000).toISOString();
    return {
      warnings: parseEstonianNavigationWarnings(
        loaded.warnings,
        fetchedAt,
        departureTime,
        loaded.stale,
      ),
      source: estonianWarningsSourceMeta(
        loaded.stale ? 'stale' : 'ok',
        fetchedAt,
        loaded.error,
        loaded.ageSeconds,
      ),
    };
  } catch (error) {
    return {
      warnings: [],
      source: estonianWarningsSourceMeta(
        'unavailable',
        new Date().toISOString(),
        error instanceof Error ? error.message : String(error),
      ),
    };
  }
}

export function parseEstonianNavigationWarnings(
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
    const description = warning.textEt ?? warning.textEn;
    const severity = /keelatud|suletud|oht|prohibited|closed|danger/i.test(
      `${warning.titleEt ?? ''} ${warning.titleEn ?? ''} ${description ?? ''}`,
    ) ? 'critical' : 'caution';
    return [{
      id: `transpordiamet-warnings:${warning.id}`,
      kind: 'navigation_warning',
      geometry,
      name: warning.titleEt ?? warning.titleEn
        ?? `Navigatsioonihoiatus ${warning.number ?? ''}`.trim(),
      description,
      severity,
      reportedAt: warning.validFrom,
      faultCode: warning.number === undefined ? undefined : String(warning.number),
      source: SOURCE,
      fetchedAt,
      stale,
    } satisfies RoutingWarning];
  });
}

export function estonianWarningsSourceMeta(
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
