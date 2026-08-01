import type { Variable } from '@seapro/shared';
import type { LayerState, WindDisplay } from '../components/LayerPanel';
import { SCALAR_FIELDS } from '../map/colorScales';

const STORAGE_KEY = 'seapro.layers';
const SCHEMA_VERSION = 1;
const OVERLAYS = new Set(['chart', 'seamark', 'bathymetry', 'radar']);
const WIND_DISPLAYS = new Set<WindDisplay>(['off', 'arrows', 'animated']);
const BOOLEAN_KEYS = [
  'stations',
  'vessels',
  'harbours',
  'anchorages',
  'placeLabels',
  'navigationWarnings',
  'navigationAids',
  'wrecks',
  'officialNavigation',
] as const satisfies readonly (keyof LayerState)[];

interface StoredLayerState extends Partial<LayerState> {
  version: number;
}

/**
 * Taastab viimase kihivaliku, jättes puuduva või vigase väärtuse vaikeolekusse.
 * Nii saavad uued kihid rakenduse uuendamisel oma uue vaikeväärtuse ega kao
 * vana localStorage'i kirje tõttu menüüst või kaardilt ära.
 */
export function loadLayerState(defaults: LayerState): LayerState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const saved = JSON.parse(raw) as StoredLayerState;
    if (saved.version !== SCHEMA_VERSION) return defaults;

    const next: LayerState = { ...defaults };
    if (Array.isArray(saved.overlays)) {
      next.overlays = [...new Set(saved.overlays.filter(
        (overlay): overlay is string => typeof overlay === 'string' && OVERLAYS.has(overlay),
      ))];
    }
    if (typeof saved.windDisplay === 'string' && WIND_DISPLAYS.has(saved.windDisplay as WindDisplay)) {
      next.windDisplay = saved.windDisplay as WindDisplay;
    }
    if (saved.scalarField === null || (
      typeof saved.scalarField === 'string'
      && SCALAR_FIELDS.includes(saved.scalarField as Variable)
    )) {
      next.scalarField = saved.scalarField as Variable | null;
    }
    for (const key of BOOLEAN_KEYS) {
      if (typeof saved[key] === 'boolean') next[key] = saved[key];
    }
    return next;
  } catch {
    return defaults;
  }
}

export function saveLayerState(layers: LayerState): void {
  try {
    const payload: StoredLayerState = { version: SCHEMA_VERSION, ...layers };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Privaatrežiim või täis kvoot ei tohi kihtide lülitamist takistada.
  }
}
