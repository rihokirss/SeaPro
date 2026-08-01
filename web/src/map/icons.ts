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

/**
 * Jaama/poi marker. Kuju kodeerib tüübi, värv andmete vanuse.
 *
 * ÜKS puhas valge ring ja pehme vari — mitte valge ja tume ääris üksteise
 * peal. Kaks joont sama serva peal segunevad määrdunud halliks, sest
 * antialias segab need omavahel; tulemus näeb välja nagu kehvasti trükitud
 * ikoon. Vari teeb sama töö (eraldab markeri taustast) ilma teist joont
 * lisamata.
 */
function stationMarker(kind: 'coastal' | 'offshore' | 'buoy', fill: string): ImageData {
  const size = 26;
  const c = makeCanvas(size);
  const { ctx } = c;
  const mid = size / 2;
  const r = 7;

  const trace = (): void => {
    ctx.beginPath();
    if (kind === 'buoy') {
      // Poi = romb. Kuju eristab ka siis, kui värv on värskuse tõttu sama.
      ctx.moveTo(mid, mid - r - 1);
      ctx.lineTo(mid + r + 1, mid);
      ctx.lineTo(mid, mid + r + 1);
      ctx.lineTo(mid - r - 1, mid);
      ctx.closePath();
    } else if (kind === 'offshore') {
      // Ümarad nurgad — terav ruut mõjub kaardil karmimalt kui vaja.
      roundRect(ctx, mid - r, mid - r, r * 2, r * 2, 2.5);
    } else {
      ctx.arc(mid, mid, r, 0, Math.PI * 2);
    }
  };

  ctx.save();
  ctx.shadowColor = 'rgba(6, 22, 34, 0.45)';
  ctx.shadowBlur = 3;
  ctx.shadowOffsetY = 1;

  // Valge rõngas joonistatakse ALLA laia joonena; vari langeb tema servale,
  // mitte värvilisele kettale, nii et üleminek jääb puhas.
  trace();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.restore();

  trace();
  ctx.fillStyle = fill;
  ctx.fill();

  return toImageData(c);
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/*
 * Laevamärkide suurus.
 *
 * Suurendatud ~25%: eelmine mõõt kadus tuulenoolte ja jaamamärkide vahele ära,
 * eriti keskmisel zoomil, kus laev on veel ikoon ja mitte veel mõõtkavas kere.
 *
 * Suurendus käib RASTERDUSE, mitte kihi `icon-size` kaudu. Ikoon lisatakse
 * `pixelRatio: DPR`-iga, seega `size` ongi ekraanisuurus pikslites ja suurem
 * lõuend annab suurema märgi ilma venitamiseta. `icon-size` kordaja tõstmine
 * oleks sama bittkaardi üles skaleerinud ja märgi häguseks teinud.
 */
const VESSEL_ARROW_SIZE = 32;
const VESSEL_DOT_SIZE = 25;

/** Laev, mille suund on teada — nool. Üks õhuke tume kontuur, mitte kaks. */
function vesselArrow(fill: string): ImageData {
  const size = VESSEL_ARROW_SIZE;
  const c = makeCanvas(size);
  const { ctx } = c;
  const mid = size / 2;

  ctx.translate(mid, mid);
  const trace = (): void => {
    ctx.beginPath();
    ctx.moveTo(0, -11);
    ctx.lineTo(6.8, 9.8);
    ctx.lineTo(0, 5.5);
    ctx.lineTo(-6.8, 9.8);
    ctx.closePath();
  };

  ctx.save();
  ctx.shadowColor = 'rgba(6, 22, 34, 0.4)';
  ctx.shadowBlur = 3;
  ctx.shadowOffsetY = 1;
  trace();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();

  trace();
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 1.2;
  ctx.lineJoin = 'round';
  ctx.stroke();

  return toImageData(c);
}

/** Laev, mille suunda AIS ei anna — punkt, sest nooleots valetaks suunda. */
function vesselDot(fill: string): ImageData {
  const size = VESSEL_DOT_SIZE;
  const c = makeCanvas(size);
  const { ctx } = c;
  const mid = size / 2;

  ctx.save();
  ctx.shadowColor = 'rgba(6, 22, 34, 0.4)';
  ctx.shadowBlur = 3;
  ctx.shadowOffsetY = 1;
  ctx.beginPath();
  ctx.arc(mid, mid, 6.2, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();

  ctx.beginPath();
  ctx.arc(mid, mid, 6.2, 0, Math.PI * 2);
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 1.4;
  ctx.stroke();

  return toImageData(c);
}

/**
 * Sadama marker — ankur ringi sees.
 *
 * Ankur on merekaardil sadama universaalne märk, seega ei pea seda õppima.
 * Ring ümber eristab teda OpenSeaMapi ankrualade märkidest, mis on samuti
 * ankrukujulised, aga ilma raamita.
 */
function harbourMarker(fill: string, radius = 9.5): ImageData {
  const size = 30;
  const c = makeCanvas(size);
  const { ctx } = c;
  const mid = size / 2;

  ctx.save();
  ctx.shadowColor = 'rgba(6, 22, 34, 0.45)';
  ctx.shadowBlur = 3;
  ctx.shadowOffsetY = 1;
  ctx.beginPath();
  ctx.arc(mid, mid, radius, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();

  ctx.beginPath();
  ctx.arc(mid, mid, radius, 0, Math.PI * 2);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.8;
  ctx.stroke();

  // Ankur: rõngas, vars, põikpuu ja käpad.
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.7;
  ctx.lineCap = 'round';

  ctx.beginPath();
  ctx.arc(mid, mid - 5, 1.9, 0, Math.PI * 2);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(mid, mid - 3.1);
  ctx.lineTo(mid, mid + 5.5);
  ctx.moveTo(mid - 3.6, mid - 1.2);
  ctx.lineTo(mid + 3.6, mid - 1.2);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(mid - 4.3, mid + 2.2);
  ctx.quadraticCurveTo(mid - 3.8, mid + 5.7, mid, mid + 5.7);
  ctx.quadraticCurveTo(mid + 3.8, mid + 5.7, mid + 4.3, mid + 2.2);
  ctx.stroke();

  return toImageData(c);
}

export const HARBOUR_ICON = 'harbour';
export const HARBOUR_ICON_BASIC = 'harbour-basic';
export const ANCHORAGE_ICON = 'anchorage';

/**
 * Markerivärvid.
 *
 * Sadamad on sinised (teenustega tumedam, ilma tuhmim), ankrukoht roheline ja
 * väiksem. Värv, mitte kuju, sest ankur ON mõlemal õige märk — vahe on selles,
 * mida koht pakub: sadamas on kai ja teenused, ankrukohas ainult varju.
 */
export const HARBOUR_COLORS = {
  full: '#2f7fd1',
  basic: '#7a93a5',
  anchorage: '#3f9e6e',
} as const;

export const NAVIGATION_AID_CATEGORIES = [
  'lateral-port', 'lateral-starboard',
  'cardinal-north', 'cardinal-east', 'cardinal-south', 'cardinal-west',
  'isolated-danger', 'safe-water', 'special',
  'lighthouse', 'leading', 'beacon', 'virtual', 'unknown',
] as const;

/** Kompaktne IALA-laadne tingmärk klikitava registrikihi jaoks. */
function navigationAidMarker(category: string): ImageData {
  const size = 32;
  const c = makeCanvas(size);
  const { ctx } = c;
  const mid = size / 2;

  ctx.save();
  ctx.translate(mid, mid);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const stroke = (color = '#102b3a', width = 1.2): void => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  };
  const triangle = (cy: number, up: boolean): void => {
    ctx.beginPath();
    ctx.moveTo(0, cy + (up ? -3 : 3));
    ctx.lineTo(-3.2, cy + (up ? 2 : -2));
    ctx.lineTo(3.2, cy + (up ? 2 : -2));
    ctx.closePath();
    ctx.fillStyle = '#111';
    ctx.fill();
  };

  if (category === 'lateral-port') {
    ctx.fillStyle = '#df3f45';
    ctx.fillRect(-4.5, -5, 9, 15);
    ctx.strokeRect(-4.5, -5, 9, 15);
    stroke();
  } else if (category === 'lateral-starboard') {
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(6, 10);
    ctx.lineTo(-6, 10);
    ctx.closePath();
    ctx.fillStyle = '#2b9b62';
    ctx.fill();
    stroke();
  } else if (category.startsWith('cardinal-')) {
    const direction = category.slice('cardinal-'.length);
    // Kollase/musta keha ribade suund järgib kardinaali tüüpi; topimärgi
    // kaks kolmnurka kannavad sama infot ka värvipimedale kasutajale.
    const bodyTop = 1;
    const bodyHeight = 11;
    ctx.fillStyle = direction === 'east' ? '#111' : '#f1cc35';
    ctx.fillRect(-4, bodyTop, 8, bodyHeight);
    if (direction === 'north') {
      ctx.fillStyle = '#111';
      ctx.fillRect(-4, bodyTop, 8, 4);
    } else if (direction === 'south') {
      ctx.fillStyle = '#111';
      ctx.fillRect(-4, bodyTop + bodyHeight - 4, 8, 4);
    } else if (direction === 'east') {
      // Ida: must–kollane–must.
      ctx.fillStyle = '#f1cc35';
      ctx.fillRect(-4, bodyTop + 3.5, 8, 4);
    } else {
      // Lääs: kollane–must–kollane.
      ctx.fillStyle = '#111';
      ctx.fillRect(-4, bodyTop + 3.5, 8, 4);
    }
    ctx.strokeRect(-4, bodyTop, 8, bodyHeight);
    stroke();
    // Kaks topimärki ja keha ei tohi väiksel ekraanil kokku sulada.
    triangle(-9, direction === 'north' || direction === 'east');
    triangle(-4, direction === 'north' || direction === 'west');
  } else if (category === 'isolated-danger') {
    ctx.fillStyle = '#111';
    ctx.fillRect(-3.5, 2, 7, 10);
    ctx.fillStyle = '#df3f45';
    ctx.fillRect(-3.5, 5.5, 7, 3);
    ctx.beginPath(); ctx.arc(0, -10, 2.1, 0, Math.PI * 2); ctx.fillStyle = '#111'; ctx.fill();
    ctx.beginPath(); ctx.arc(0, -5, 2.1, 0, Math.PI * 2); ctx.fill();
  } else if (category === 'safe-water') {
    ctx.save();
    ctx.beginPath(); ctx.arc(0, 1, 6, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = '#fff'; ctx.fillRect(-6, -5, 12, 12);
    ctx.fillStyle = '#df3f45';
    ctx.fillRect(-6, -5, 3, 12); ctx.fillRect(0, -5, 3, 12);
    ctx.restore();
    ctx.beginPath(); ctx.arc(0, 1, 6, 0, Math.PI * 2); stroke();
    ctx.beginPath(); ctx.arc(0, -7, 2.3, 0, Math.PI * 2); ctx.fillStyle = '#df3f45'; ctx.fill();
  } else if (category === 'special') {
    ctx.beginPath();
    ctx.moveTo(0, -2); ctx.lineTo(5.5, 4); ctx.lineTo(0, 11); ctx.lineTo(-5.5, 4); ctx.closePath();
    ctx.fillStyle = '#f0c62d'; ctx.fill(); stroke();
    ctx.beginPath(); ctx.moveTo(-4, -11); ctx.lineTo(4, -6); ctx.moveTo(4, -11); ctx.lineTo(-4, -6); stroke('#9a6d00', 1.8);
  } else if (category === 'lighthouse') {
    ctx.beginPath(); ctx.moveTo(-4.5, 7); ctx.lineTo(-2.5, -3); ctx.lineTo(2.5, -3); ctx.lineTo(4.5, 7); ctx.closePath();
    ctx.fillStyle = '#344b59'; ctx.fill(); stroke();
    ctx.beginPath(); ctx.arc(0, -5.5, 3, 0, Math.PI * 2); ctx.fillStyle = '#f0c62d'; ctx.fill(); stroke();
    ctx.beginPath(); ctx.moveTo(-8, -5.5); ctx.lineTo(-5, -5.5); ctx.moveTo(5, -5.5); ctx.lineTo(8, -5.5); stroke('#c78d00', 1.5);
  } else if (category === 'leading') {
    ctx.fillStyle = '#fff'; ctx.fillRect(-4.5, -6, 9, 13); ctx.strokeRect(-4.5, -6, 9, 13); stroke();
    ctx.fillStyle = '#df3f45'; ctx.fillRect(-4.5, -1, 9, 3);
  } else if (category === 'virtual') {
    ctx.setLineDash([2, 2]);
    ctx.beginPath(); ctx.arc(0, 0, 7, 0, Math.PI * 2); stroke('#238cae', 2);
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(0, 0, 2, 0, Math.PI * 2); ctx.fillStyle = '#238cae'; ctx.fill();
  } else {
    ctx.beginPath(); ctx.arc(0, 0, 5.5, 0, Math.PI * 2);
    ctx.fillStyle = category === 'beacon' ? '#607d8b' : '#4b9bb4'; ctx.fill(); stroke();
    ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(0, 8); stroke('#102b3a', 1.4);
  }

  ctx.restore();
  return toImageData(c);
}

export const NAVIGATION_WARNING_ICON = 'navigation-warning';

/** Hoiatus on ohukolmnurk, mitte järjekordne värviline kaardipunkt. */
function navigationWarningMarker(): ImageData {
  const size = 36;
  const c = makeCanvas(size);
  const { ctx } = c;

  const triangle = (inset: number): void => {
    const top = 3 + inset;
    const left = 2.5 + inset;
    const right = size - 2.5 - inset;
    const bottom = size - 4 - inset;
    ctx.beginPath();
    ctx.moveTo(size / 2, top);
    ctx.quadraticCurveTo(size / 2 + 1.5, top, size / 2 + 3, top + 3);
    ctx.lineTo(right, bottom - 3);
    ctx.quadraticCurveTo(right + 1, bottom, right - 3, bottom);
    ctx.lineTo(left + 3, bottom);
    ctx.quadraticCurveTo(left - 1, bottom, left, bottom - 3);
    ctx.lineTo(size / 2 - 3, top + 3);
    ctx.quadraticCurveTo(size / 2 - 1.5, top, size / 2, top);
    ctx.closePath();
  };

  ctx.save();
  ctx.shadowColor = 'rgba(6,22,34,.5)';
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 1;
  triangle(2.2);
  ctx.fillStyle = '#f1b51c';
  ctx.fill();
  ctx.strokeStyle = '#6d4700';
  ctx.lineWidth = 1.4;
  ctx.stroke();
  ctx.restore();

  ctx.strokeStyle = '#31240b';
  ctx.lineWidth = 3.2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(size / 2, 12);
  ctx.lineTo(size / 2, 21);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(size / 2, 26, 1.8, 0, Math.PI * 2);
  ctx.fillStyle = '#31240b';
  ctx.fill();

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
  pleasure: '#65b9d2',
  fast: '#e08f7f',
};

export function registerIcons(map: MapLibreMap): void {
  const icons: Record<string, ImageData> = {
    [WIND_ARROW_DARK]: windArrow('#14293a'),
    [WIND_ARROW_LIGHT]: windArrow('#ffffff'),
    [HARBOUR_ICON]: harbourMarker(HARBOUR_COLORS.full),
    [HARBOUR_ICON_BASIC]: harbourMarker(HARBOUR_COLORS.basic),
    // Väiksem raadius: ankrukohti on rannikul palju ja sadamaga sama suur
    // marker upuks nendega kokku ning varjaks kaardi ära.
    [ANCHORAGE_ICON]: harbourMarker(HARBOUR_COLORS.anchorage, 7.5),
    [NAVIGATION_WARNING_ICON]: navigationWarningMarker(),
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

  for (const category of NAVIGATION_AID_CATEGORIES) {
    icons[`navigation-${category}`] = navigationAidMarker(category);
  }

  for (const [name, data] of Object.entries(icons)) {
    if (map.hasImage(name)) continue;
    map.addImage(name, data, { pixelRatio: DPR });
  }
}

export { VESSEL_COLORS };
