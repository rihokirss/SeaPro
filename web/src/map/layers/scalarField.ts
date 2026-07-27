import type { CanvasSource, Map as MapLibreMap } from 'maplibre-gl';
import type { GridFrame, Variable } from '@seapro/shared';
import { COLOR_SCALES, sampleScale, type ColorScale } from '../colorScales';

/**
 * Üldine valevärvi-väli.
 *
 * Töötab IGA skalaarsuurusega, millel on värviskaala: lainekõrgus, pilvisus,
 * sademed, temperatuur, õhurõhk, nähtavus, hoovus. Uue suuruse lisamiseks
 * piisab värviskaalast `colorScales.ts`-is — siia ei pea midagi lisama.
 *
 * Renderdus: joonistame võrgustiku väikesele canvas'ele (1 piksel = 1
 * võrgupunkt) ja laseme brauseril selle kaardile venitada. Sujuva ülemineku
 * annab canvas'e enda bilineaarne skaleerimine — see on kordades odavam kui
 * interpoleerida käsitsi täisekraani resolutsioonis.
 */

const SOURCE_ID = 'scalar-field-src';
const LAYER_ID = 'scalar-field';
/** Nooltekiht, mille alla väli kuulub. */
const WIND_ARROWS_LAYER = 'wind-arrows';

/** Kui palju servadest välja venitada, et kiht ei lõppeks järsult ekraani serval. */
const EDGE_PAD = 0.5;

interface FieldState {
  canvas: HTMLCanvasElement;
  variable: Variable;
}

let state: FieldState | null = null;

function ensureCanvas(): HTMLCanvasElement {
  if (!state) {
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 2;
    state = { canvas, variable: 'wave_height' };
  }
  return state.canvas;
}

/**
 * Kujundab võrgupunktide loendist regulaarse maatriksi.
 * Server tagastab punktid ridade kaupa, aga merepunktid võivad vahelt puududa
 * (maismaal pole lainekõrgust), seega taastame ruudustiku koordinaatide järgi.
 */
function toMatrix(frame: GridFrame, variable: Variable): {
  cells: (number | null)[][];
  lats: number[];
  lons: number[];
} | null {
  if (frame.points.length === 0) return null;

  const lats = [...new Set(frame.points.map((p) => p.lat))].sort((a, b) => a - b);
  const lons = [...new Set(frame.points.map((p) => p.lon))].sort((a, b) => a - b);
  if (lats.length < 2 || lons.length < 2) return null;

  const latIndex = new Map(lats.map((v, i) => [v, i]));
  const lonIndex = new Map(lons.map((v, i) => [v, i]));

  const cells: (number | null)[][] = Array.from({ length: lats.length }, () =>
    Array.from({ length: lons.length }, () => null),
  );

  for (const p of frame.points) {
    const r = latIndex.get(p.lat);
    const c = lonIndex.get(p.lon);
    if (r === undefined || c === undefined) continue;
    const v = p.values[variable];
    cells[r]![c] = v ?? null;
  }

  return { cells, lats, lons };
}

/**
 * Täidab tühjad lahtrid naabrite keskmisega.
 *
 * Vajalik, sest maismaapunktidel puudub lainekõrgus ja ilma täitmiseta tekiks
 * ranniku äärde must auk. Täidame ainult ühe sammu kaugusele — nii ei "leki"
 * lainekõrgus sisemaale, vaid pehmendab ainult rannajoont.
 */
function fillGaps(cells: (number | null)[][]): void {
  const rows = cells.length;
  const cols = cells[0]!.length;
  const original = cells.map((row) => [...row]);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (original[r]![c] !== null) continue;
      let sum = 0;
      let n = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const v = original[r + dr]?.[c + dc];
          if (v !== null && v !== undefined) {
            sum += v;
            n++;
          }
        }
      }
      if (n > 0) cells[r]![c] = sum / n;
    }
  }
}

export function updateScalarField(
  map: MapLibreMap,
  frame: GridFrame | null,
  variable: Variable | null,
): void {
  const scale: ColorScale | undefined = variable ? COLOR_SCALES[variable] : undefined;

  if (!frame || !variable || !scale) {
    hideScalarField(map);
    return;
  }

  const matrix = toMatrix(frame, variable);
  if (!matrix) {
    hideScalarField(map);
    return;
  }

  fillGaps(matrix.cells);

  const { cells, lats, lons } = matrix;
  const rows = lats.length;
  const cols = lons.length;

  const canvas = ensureCanvas();
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(cols, rows);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Canvas'e y-telg kasvab alla, laiuskraad üles — pöörame ridade järjekorra.
      const value = cells[rows - 1 - r]![c];
      const idx = (r * cols + c) * 4;
      if (value === null || value === undefined) {
        img.data[idx + 3] = 0;
        continue;
      }
      const [red, green, blue, alpha] = sampleScale(scale, value);
      img.data[idx] = red;
      img.data[idx + 1] = green;
      img.data[idx + 2] = blue;
      img.data[idx + 3] = alpha;
    }
  }
  ctx.putImageData(img, 0, 0);

  // Canvas'e pikslikeskmed asuvad võrgupunktides; katame poole sammu võrra
  // laiema ala, et kiht ulatuks servades lõpuni.
  const dLat = (lats[lats.length - 1]! - lats[0]!) / (rows - 1);
  const dLon = (lons[lons.length - 1]! - lons[0]!) / (cols - 1);
  const south = lats[0]! - dLat * EDGE_PAD;
  const north = lats[lats.length - 1]! + dLat * EDGE_PAD;
  const west = lons[0]! - dLon * EDGE_PAD;
  const east = lons[lons.length - 1]! + dLon * EDGE_PAD;

  const coordinates: [[number, number], [number, number], [number, number], [number, number]] = [
    [west, north],
    [east, north],
    [east, south],
    [west, south],
  ];

  const existing = map.getSource<CanvasSource>(SOURCE_ID);
  if (existing) {
    existing.setCoordinates(coordinates);
    // Canvas'e sisu muutus — MapLibre ei märka seda ise iga kaadri vahel.
    map.triggerRepaint();
  } else {
    if (existing) {
      if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
      map.removeSource(SOURCE_ID);
    }
    map.addSource(SOURCE_ID, {
      type: 'canvas',
      canvas,
      coordinates,
      // Väli muutub ainult siis, kui me ise uue kaadri joonistame.
      animate: false,
    });
  }

  if (!map.getLayer(LAYER_ID)) {
    // Väli peab jääma noolte ALLA: nool kannab suunda ja peab olema loetav
    // ka tugeva värvi peal. MapLibre lisab uue kihi vaikimisi kõige peale,
    // seega ütleme sõnaselgelt, kuhu.
    map.addLayer(
      {
      id: LAYER_ID,
      type: 'raster',
      source: SOURCE_ID,
      paint: {
        'raster-opacity': 0.75,
        // Sujuv üleminek võrgupunktide vahel; ilma selleta oleks kiht klotsidest.
        'raster-resampling': 'linear',
        'raster-fade-duration': 0,
      },
      },
      map.getLayer(WIND_ARROWS_LAYER) ? WIND_ARROWS_LAYER : undefined,
    );
  }
  map.setLayoutProperty(LAYER_ID, 'visibility', 'visible');
  if (state) state.variable = variable;
}

export function hideScalarField(map: MapLibreMap): void {
  if (map.getLayer(LAYER_ID)) {
    map.setLayoutProperty(LAYER_ID, 'visibility', 'none');
  }
}

export function setScalarFieldOpacity(map: MapLibreMap, opacity: number): void {
  if (map.getLayer(LAYER_ID)) {
    map.setPaintProperty(LAYER_ID, 'raster-opacity', opacity);
  }
}

export { SCALAR_FIELD_LAYER_ID };
const SCALAR_FIELD_LAYER_ID = LAYER_ID;
