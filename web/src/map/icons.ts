import type { Map as MapLibreMap } from 'maplibre-gl';

/**
 * Ikoonid genereeritakse jooksvalt canvas'ele, mitte ei laeta failidena —
 * null võrgupäringut ja teravad ka retina-ekraanil.
 *
 * Miks eelvärvitud variandid, mitte üks SDF-ikoon `icon-color`'iga:
 * MapLibre'i SDF ootab päris signed-distance-field'i, kus alfakanal kodeerib
 * kauguse servast. Tavalise kõva servaga bitmapi SDF-ina andmine renderdab
 * praktiliselt nähtamatu kujundi. Väike hulk eelvärvitud pilte on lihtsam,
 * kiirem ja käitub ennustatavalt.
 */

const DPR = 2;

interface Ctx {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

function makeCanvas(size: number): Ctx {
  const canvas = document.createElement('canvas');
  canvas.width = size * DPR;
  canvas.height = size * DPR;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(DPR, DPR);
  return { canvas, ctx };
}

function toImageData({ canvas }: Ctx): ImageData {
  return canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
}

/** Tume ääris hoiab kujundi loetavana nii heleda kui tumeda merepinna kohal. */
const OUTLINE = 'rgba(8, 26, 40, 0.85)';

/**
 * Tuulenool kahes variandis: tume ja hele, MÕLEMAD ilma ääriseta.
 *
 * Ääris tundus alguses ohutu valik — nool loeb siis igal taustal. Praktikas
 * teeb ta noole jämedaks ja häguseks, ja tihedas võrgus muutub pilt müraks.
 * Windfinderi lahendus on puhtam ja me võtame selle üle: nool on ühevärviline
 * ja terav, ning VARIANT valitakse tausta järgi — tume nool heleda merepinna
 * peal, hele nool tugeva värvivälja peal. Kumbki üksi ei kataks mõlemat
 * olukorda, aga kahe vahel valides pole äärist üldse vaja.
 *
 * Valiku teeb `windArrowIcon()` värvivälja heleduse põhjal.
 */
function windArrow(fill: string): ImageData {
  const size = 30;
  const c = makeCanvas(size);
  const { ctx } = c;
  const mid = size / 2;

  ctx.translate(mid, mid);
  ctx.beginPath();
  // Peenike vars + kompaktne nooleots.
  ctx.moveTo(0, -11);
  ctx.lineTo(4.2, -4.5);
  ctx.lineTo(1.25, -4.5);
  ctx.lineTo(1.25, 11);
  ctx.lineTo(-1.25, 11);
  ctx.lineTo(-1.25, -4.5);
  ctx.lineTo(-4.2, -4.5);
  ctx.closePath();

  ctx.fillStyle = fill;
  ctx.fill();

  return toImageData(c);
}

export const WIND_ARROW_DARK = 'wind-arrow-dark';
export const WIND_ARROW_LIGHT = 'wind-arrow-light';

/** Jaama/poi marker. Kuju kodeerib tüübi, värv värskuse. */
function stationMarker(kind: 'coastal' | 'offshore' | 'buoy', fill: string): ImageData {
  const size = 24;
  const c = makeCanvas(size);
  const { ctx } = c;
  const mid = size / 2;
  const r = 7;

  ctx.beginPath();
  if (kind === 'buoy') {
    // Poi = romb. Kuju eristab ka siis, kui värv on värskuse tõttu sama.
    ctx.moveTo(mid, mid - r - 1);
    ctx.lineTo(mid + r + 1, mid);
    ctx.lineTo(mid, mid + r + 1);
    ctx.lineTo(mid - r - 1, mid);
    ctx.closePath();
  } else if (kind === 'offshore') {
    ctx.rect(mid - r + 0.5, mid - r + 0.5, r * 2 - 1, r * 2 - 1);
  } else {
    ctx.arc(mid, mid, r, 0, Math.PI * 2);
  }

  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 0.8;
  ctx.stroke();

  return toImageData(c);
}

/** Liikuv laev — nool kursi suunas. */
function vesselArrow(fill: string): ImageData {
  const size = 24;
  const c = makeCanvas(size);
  const { ctx } = c;
  const mid = size / 2;

  ctx.translate(mid, mid);
  ctx.beginPath();
  ctx.moveTo(0, -9);
  ctx.lineTo(5.5, 8);
  ctx.lineTo(0, 4.5);
  ctx.lineTo(-5.5, 8);
  ctx.closePath();

  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 1.1;
  ctx.lineJoin = 'round';
  ctx.stroke();

  return toImageData(c);
}

/** Seisev laev — suunda pole mõtet näidata. */
function vesselDot(fill: string): ImageData {
  const size = 18;
  const c = makeCanvas(size);
  const { ctx } = c;
  const mid = size / 2;

  ctx.beginPath();
  ctx.arc(mid, mid, 5, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 1.4;
  ctx.stroke();

  return toImageData(c);
}

/** Jaama ikooninimi kuju ja värskuse järgi. */
export function stationIcon(kind: string, freshness: string): string {
  const shape = kind === 'buoy' || kind === 'offshore' ? kind : 'coastal';
  return `station-${shape}-${freshness}`;
}

/** Värskuse värvid — sama loogika mis METOC-i originaalportaalil. */
export const FRESHNESS_COLORS: Record<string, string> = {
  fresh: '#4fc98a',
  stale: '#e0a83f',
  old: '#e0603f',
  none: '#8a9aa6',
};

const VESSEL_COLORS: Record<string, string> = {
  default: '#c9d6df',
  cargo: '#8fb8d8',
  tanker: '#e0a83f',
  passenger: '#7fd0a8',
  fishing: '#d8a0d0',
  sailing: '#a8d8d0',
  fast: '#e08f7f',
};

export function registerIcons(map: MapLibreMap): void {
  const icons: Record<string, ImageData> = {
    [WIND_ARROW_DARK]: windArrow('#14293a'),
    [WIND_ARROW_LIGHT]: windArrow('#ffffff'),
  };

  for (const kind of ['coastal', 'offshore', 'buoy'] as const) {
    for (const [freshness, color] of Object.entries(FRESHNESS_COLORS)) {
      icons[`station-${kind}-${freshness}`] = stationMarker(kind, color);
    }
  }

  for (const [name, color] of Object.entries(VESSEL_COLORS)) {
    icons[`vessel-arrow-${name}`] = vesselArrow(color);
    icons[`vessel-dot-${name}`] = vesselDot(color);
  }

  for (const [name, data] of Object.entries(icons)) {
    if (map.hasImage(name)) continue;
    map.addImage(name, data, { pixelRatio: DPR });
  }
}

export { VESSEL_COLORS };
