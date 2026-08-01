import maplibregl, { type Map as MapLibreMap, type MapGeoJSONFeature } from 'maplibre-gl';
import type { Variable } from '@seapro/shared';
import { degreesToCompass } from '@seapro/shared';
import type { Translate } from '../i18n';
import { formatValue, unitLabel, type SpeedUnit } from '../lib/units';
import { STATIONS_LAYER } from './layers/stations';
import { VESSEL_LAYERS } from './layers/vessels';
import { navilyUrl } from '../lib/navily';
import { ANCHORAGES_LAYER, HARBOURS_LAYER } from './layers/harbours';

/**
 * Kaardimarkerite popupid.
 *
 * Jaamade ja laevade andmed on juba kihi omadustes olemas — popup ei tee
 * ühtki uut päringut. See on merel oluline: nõrga levi korral peab markerile
 * vajutamine andma vastuse kohe, mitte laadimisindikaatori.
 *
 * HTML koostatakse siin käsitsi, mitte Reactiga, sest MapLibre'i popup elab
 * väljaspool Reacti puud. Kõik kasutajalt või allikast tulev tekst käib
 * `escapeHtml` alt läbi — laevanimed tulevad AIS-ist ja ei ole usaldusväärsed.
 */

export interface PopupContext {
  t: Translate;
  speedUnit: SpeedUnit;
  lang: string;
}

let popup: maplibregl.Popup | null = null;

/**
 * Millise objekti popup praegu lahti on. Vajalik selleks, et samale markerile
 * teist korda klõpsamine popupi SULGEKS, mitte ei avaks sama sisu uuesti —
 * see on tavapärane ootus ja ilma selleta pole markeril sulgemisnupu kõrval
 * muud viisi kinni panna.
 */
let openFeatureId: string | null = null;

/**
 * Hover-vihje: ainult nimi ja tüüp, mitte kogu näit.
 *
 * Eraldi popupist, sest tal on teine ülesanne. Klikk küsib "mis siin on?" ja
 * väärib tabelit; hover küsib "mis see märk on?" ja väärib ühte rida. Kui
 * hover näitaks sama tabelit, hüppaks kaardil ringi liikudes pidevalt suur
 * paneel ette.
 *
 * Puuteseadmetel hover't pole ja seal jääbki ainult klikk — see on õige,
 * mitte puudus.
 */
let hoverTip: maplibregl.Popup | null = null;

export function registerPopups(map: MapLibreMap, getContext: () => PopupContext): void {
  const show = (featureId: string, lngLat: maplibregl.LngLatLike, html: string): boolean => {
    // Sama objekt teist korda = sulge.
    if (popup?.isOpen() && openFeatureId === featureId) {
      closePopup();
      return false;
    }

    popup?.remove();
    openFeatureId = featureId;
    popup = new maplibregl.Popup({
      closeButton: true,
      closeOnClick: true,
      /**
       * Ülempiir, mitte fikseeritud laius.
       *
       * 280 px oli liiga kitsas: pikk operaatori nimi või teenuste loend ei
       * mahtunud ridadesse ära ja tekst jooksis popupist VÄLJA (read olid
       * `nowrap`). Nüüd kast kasvab kuni ekraani lubatud piirini ja sisu
       * murrab ridu — vt `.popup__table` CSS-is.
       *
       * Piir on ekraanist sõltuv, sest telefonis oleks 340 px juba peaaegu
       * terve laius ja popup kataks selle koha, mille kohta ta räägib.
       */
      maxWidth: `min(340px, calc(100vw - 32px))`,
      offset: 14,
    })
      .setLngLat(lngLat)
      .setHTML(html)
      .addTo(map);

    // Kui kasutaja sulgeb popupi nupust või mujale klõpsates, peab ka meie
    // arvestus nullima — muidu nõuaks järgmine klõps sama markeri peal kahte
    // vajutust.
    popup.on('close', () => {
      openFeatureId = null;
    });

    return true;
  };

  map.on('click', STATIONS_LAYER, (e) => {
    const f = e.features?.[0];
    if (!f) return;
    // Ära lase klikil ka punktipaneeli avada — jaam ON juba vastus.
    e.originalEvent.stopPropagation();
    const id = `station:${String(f.properties?.id ?? '')}`;
    if (show(id, coordsOf(f, e.lngLat), stationHtml(f, getContext()))) {
      hoverTip?.remove();
    }
  });

  for (const layer of VESSEL_LAYERS) {
    map.on('click', layer, (e) => {
      const f = e.features?.[0];
      if (!f) return;
      e.originalEvent.stopPropagation();
      const id = `vessel:${String(f.properties?.mmsi ?? '')}`;
      if (show(id, e.lngLat, vesselHtml(f, getContext()))) {
        hoverTip?.remove();
      }
    });
  }

  // Sama käsitleja mõlemale: popup ise otsustab sisu `kind` järgi.
  for (const layer of [HARBOURS_LAYER, ANCHORAGES_LAYER]) {
    map.on('click', layer, (e) => {
      const f = e.features?.[0];
      if (!f) return;
      e.originalEvent.stopPropagation();
      const id = `harbour:${String(f.properties?.id ?? '')}`;
      if (show(id, coordsOf(f, e.lngLat), harbourHtml(f, getContext()))) {
        hoverTip?.remove();
      }
    });
  }

  // Kursor ja hover-vihje.
  for (const layer of [STATIONS_LAYER, HARBOURS_LAYER, ANCHORAGES_LAYER, ...VESSEL_LAYERS]) {
    map.on('mousemove', layer, (e) => {
      map.getCanvas().style.cursor = 'pointer';

      const f = e.features?.[0];
      if (!f) return;
      // Kui klikipopup on juba lahti, ei hakka vihje sellega võistlema.
      if (popup?.isOpen()) return;

      const html =
        layer === STATIONS_LAYER
          ? stationTipHtml(f, getContext())
          : layer === HARBOURS_LAYER || layer === ANCHORAGES_LAYER
            ? harbourTipHtml(f, getContext())
            : vesselTipHtml(f, getContext());

      if (!hoverTip) {
        hoverTip = new maplibregl.Popup({
          closeButton: false,
          closeOnClick: false,
          className: 'tip',
          offset: 12,
        });
      }
      hoverTip.setLngLat(coordsOf(f, e.lngLat)).setHTML(html).addTo(map);
    });

    map.on('mouseleave', layer, () => {
      map.getCanvas().style.cursor = '';
      hoverTip?.remove();
    });
  }
}

/**
 * Vihje ühine kuju.
 *
 * Kolm objektitüüpi (jaam, sadam, laev) said varem igaüks oma paigutuse ja
 * tulemus oli ebaühtlane: kord oli number nime taga, kord silt selle all, ja
 * silt ei olnud oma väärtuse kõrval. Nüüd on struktuur alati sama:
 *
 *   NIMI                 <- paks, esimene rida
 *   silt  väärtus ühik   <- paar, mis kuulub kokku
 *   lisainfo             <- valikuline, tuhmim
 *
 * Silt ja väärtus samal real on siin oluline: "3.8 m" ilma sildita ei ütle,
 * kas see on süvis, lainekõrgus või kai pikkus.
 */
interface TipSpec {
  title: string;
  /** Silt + väärtus, mis kuuluvad kokku. */
  metric?: { label: string; value: string; unit?: string };
  /** Tuhmim lisarida, nt tüüp või olek. */
  note?: string;
}

function tipHtml(spec: TipSpec): string {
  const metric = spec.metric
    ? `<div class="tip__row">
         <span class="tip__label">${escapeHtml(spec.metric.label)}</span>
         <span class="tip__value">${escapeHtml(spec.metric.value)}${
           spec.metric.unit ? `<small>${escapeHtml(spec.metric.unit)}</small>` : ''
         }</span>
       </div>`
    : '';

  const note = spec.note ? `<div class="tip__sub">${escapeHtml(spec.note)}</div>` : '';

  return `<div class="tip__name">${escapeHtml(spec.title)}</div>${metric}${note}`;
}

/** Jaama vihje: nimi, põhinäit ja tüüp. */
function stationTipHtml(f: MapGeoJSONFeature, ctx: PopupContext): string {
  const p = f.properties as Record<string, unknown>;
  const { t, speedUnit } = ctx;

  let values: Partial<Record<Variable, number | null>> = {};
  try {
    values = JSON.parse(String(p.values ?? '{}')) as typeof values;
  } catch {
    // Vigane JSON ei tohi vihjet katki teha.
  }

  // Näita seda, mille pärast jaama üldse vaadatakse: tuult, või kui seda
  // pole (lainepoi), siis lainekõrgust.
  const primary: Variable | null =
    values.wind_speed != null ? 'wind_speed' : values.wave_height != null ? 'wave_height' : null;

  return tipHtml({
    title: String(p.name ?? ''),
    metric: primary
      ? {
          label: t(`var.${primary}`),
          value: formatValue(primary, values[primary], speedUnit),
          unit: unitLabel(primary, speedUnit),
        }
      : undefined,
    note: t(`station.kind.${String(p.kind ?? 'coastal')}`),
  });
}

/** Sadama vihje: süvis otsustab, kas sinna üldse tasub minna. */
function harbourTipHtml(f: MapGeoJSONFeature, ctx: PopupContext): string {
  const p = f.properties as Record<string, unknown>;
  const { t } = ctx;
  const draught = p.maxDraught === null || p.maxDraught === undefined ? null : Number(p.maxDraught);
  const anchorage = p.kind === 'anchorage';

  // Enamik ankrukohti on OSM-is nimetud. Tühi pealkiri annaks vihje, mis ei
  // ütle midagi — tüübisilt vähemalt vastab küsimusele "mis märk see on?".
  const title = String(p.name ?? '') || t(anchorage ? 'anchorage.title' : 'harbour.title');

  return tipHtml({
    title,
    metric:
      draught !== null
        ? { label: t('harbour.maxDraught'), value: draught.toFixed(1), unit: 'm' }
        : undefined,
    note: draught === null && title !== t(anchorage ? 'anchorage.title' : 'harbour.title')
      ? t(anchorage ? 'anchorage.title' : 'harbour.title')
      : undefined,
  });
}

/** Laeva vihje: nimi, kiirus ja tüüp. */
function vesselTipHtml(f: MapGeoJSONFeature, ctx: PopupContext): string {
  const p = f.properties as Record<string, unknown>;
  const { t } = ctx;

  const name = String(p.name ?? '').trim() || t('vessel.unknown');
  const sog = p.sog === null || p.sog === undefined ? null : Number(p.sog);
  const category = String(p.category ?? 'default');
  const lengthM = p.lengthM === null || p.lengthM === undefined ? null : Number(p.lengthM);

  const type = t(`key.vessel.${category === 'default' ? 'other' : category}`);

  return tipHtml({
    title: name,
    metric:
      sog !== null && sog >= 0.5
        ? { label: t('vessel.sog'), value: sog.toFixed(1), unit: 'kn' }
        : undefined,
    note: lengthM !== null ? `${type} · ${lengthM} m` : type,
  });
}

export function closePopup(): void {
  popup?.remove();
  popup = null;
  openFeatureId = null;
  hoverTip?.remove();
  hoverTip = null;
}

function coordsOf(f: MapGeoJSONFeature, fallback: maplibregl.LngLat): maplibregl.LngLatLike {
  if (f.geometry.type === 'Point') {
    const [lon, lat] = f.geometry.coordinates as [number, number];
    return [lon, lat];
  }
  return fallback;
}

/** Jaama popup: nimi, tüüp, vanus ja kõik mõõdetud väärtused. */
function stationHtml(f: MapGeoJSONFeature, ctx: PopupContext): string {
  const p = f.properties as Record<string, unknown>;
  const { t, speedUnit } = ctx;

  let values: Partial<Record<Variable, number | null>> = {};
  try {
    values = JSON.parse(String(p.values ?? '{}')) as typeof values;
  } catch {
    // Vigane JSON ei tohi popupi katki teha — näitame vähemalt nime.
  }

  const kind = String(p.kind ?? 'coastal');
  const ageSeconds = Number(p.ageSeconds);
  const freshness = String(p.freshness ?? 'none');

  const rows = (Object.entries(values) as [Variable, number | null][])
    .filter(([, v]) => v !== null && v !== undefined)
    .map(
      ([variable, v]) => `
        <tr>
          <th>${escapeHtml(t(`var.${variable}`))}</th>
          <td>${escapeHtml(formatValue(variable, v, speedUnit))}
            <small>${escapeHtml(unitLabel(variable, speedUnit))}</small></td>
        </tr>`,
    )
    .join('');

  return `
    <div class="popup">
      <div class="popup__head">
        <strong>${escapeHtml(String(p.name ?? ''))}</strong>
        <span class="popup__kind">${escapeHtml(t(`station.kind.${kind}`))}</span>
      </div>
      <div class="popup__age popup__age--${escapeHtml(freshness)}">
        ${escapeHtml(formatAge(ageSeconds, t))}
      </div>
      ${rows ? `<table class="popup__table">${rows}</table>` : `<p class="popup__empty">${escapeHtml(t('station.noData'))}</p>`}
      <div class="popup__source">${escapeHtml(String(p.providerId ?? ''))}</div>
    </div>`;
}


/**
 * Sadama popup.
 *
 * Väljad on järjestatud selle järgi, mis otsustab sissesõidu: kõigepealt
 * SÜVIS (kas ma mahun), siis teenused, siis kontakt. Puuduvaid välju ei
 * näidata tühjana — OSM-i katvus on väljade kaupa väga erinev ja tühi rida
 * jätaks mulje, et sadamas neid asju POLE, mitte et me ei tea.
 */
function harbourHtml(f: MapGeoJSONFeature, ctx: PopupContext): string {
  const p = f.properties as Record<string, unknown>;
  const { t } = ctx;

  const num = (v: unknown): number | null =>
    v === null || v === undefined || v === '' ? null : Number(v);
  const bool = (v: unknown): boolean | null =>
    v === null || v === undefined || v === '' ? null : Boolean(v);
  const str = (v: unknown): string => String(v ?? '').trim();

  const rows: string[] = [];

  const draught = num(p.maxDraught);
  if (draught !== null) rows.push(row(t('harbour.maxDraught'), draught.toFixed(1), 'm'));

  const capacity = num(p.capacity);
  if (capacity !== null) rows.push(row(t('harbour.capacity'), String(capacity), ''));

  const services: string[] = [];
  if (bool(p.powerSupply)) services.push(t('harbour.power'));
  if (bool(p.sanitaryDump)) services.push(t('harbour.sanitaryDump'));
  if (bool(p.fuel)) services.push(t('harbour.fuel'));
  if (bool(p.drinkingWater)) services.push(t('harbour.water'));
  if (services.length) rows.push(row(t('harbour.services'), escapeHtml(services.join(', ')), ''));

  const vhf = str(p.vhf);
  if (vhf) rows.push(row('VHF', escapeHtml(vhf), ''));

  const phone = str(p.phone);
  if (phone) {
    rows.push(
      row(t('harbour.phone'), `<a href="tel:${escapeHtml(phone)}">${escapeHtml(phone)}</a>`, ''),
    );
  }

  const operator = str(p.operator);
  if (operator) rows.push(row(t('harbour.operator'), escapeHtml(operator), ''));

  // Ankrukoha omad väljad. OSM-i katvus on hõre, aga just need kaks otsustavad,
  // kas seal ankur peab: mille sisse ta läheb ja kas koht on üldse lubatud.
  const seabed = str(p.seabed);
  if (seabed) rows.push(row(t('anchorage.seabed'), escapeHtml(seabed.replace(/_/g, ' ')), ''));
  const anchorageCategory = str(p.anchorageCategory);
  if (anchorageCategory) {
    rows.push(row(t('anchorage.category'), escapeHtml(anchorageCategory.replace(/_/g, ' ')), ''));
  }

  const links: string[] = [];
  const website = str(p.website);
  if (website) {
    links.push(
      `<a href="${escapeHtml(website)}" target="_blank" rel="noopener noreferrer">${escapeHtml(
        t('harbour.website'),
      )}</a>`,
    );
  }
  const registry = str(p.registryUrl);
  if (registry) {
    links.push(
      `<a href="${escapeHtml(registry)}" target="_blank" rel="noopener noreferrer">${escapeHtml(
        t('harbour.registry'),
      )}</a>`,
    );
  }

  // Koordinaadivaade näitab enne sadama valimist ka ümbrust ning töötab iga
  // sadama ja ankrukoha jaoks ilma Navily kataloogi kopeerimata.
  const coords = f.geometry.type === 'Point' ? (f.geometry.coordinates as number[]) : null;
  const lon = coords?.[0];
  const lat = coords?.[1];
  if (lat !== undefined && lon !== undefined) {
    links.push(
      `<a href="${escapeHtml(navilyUrl(lat, lon))}" ` +
        `target="_blank" rel="noopener noreferrer" title="${escapeHtml(
          t('harbour.navily.hint'),
        )}">` +
        `${escapeHtml(t('harbour.navily'))}</a>`,
    );
  }

  const locode = str(p.locode);
  const anchorage = p.kind === 'anchorage';
  const kindLabel = t(anchorage ? 'anchorage.title' : 'harbour.title');
  const title = str(p.name) || kindLabel;

  return `
    <div class="popup">
      <div class="popup__head">
        <strong>${escapeHtml(title)}</strong>
        <span class="popup__kind">${escapeHtml(kindLabel)}${
          locode ? ` · ${escapeHtml(locode)}` : ''
        }</span>
      </div>
      ${rows.length ? `<table class="popup__table">${rows.join('')}</table>` : ''}
      ${links.length ? `<div class="popup__links">${links.join(' · ')}</div>` : ''}
      <div class="popup__source">OpenStreetMap</div>
    </div>`;
}

/** Laeva popup: nimi, mõõtmed, kiirus, kurss, sihtkoht. */
function vesselHtml(f: MapGeoJSONFeature, ctx: PopupContext): string {
  const p = f.properties as Record<string, unknown>;
  const { t } = ctx;

  const name = String(p.name ?? '').trim() || t('vessel.unknown');
  const sog = p.sog === null || p.sog === undefined ? null : Number(p.sog);
  const cog = p.cog === null || p.cog === undefined ? null : Number(p.cog);
  const heading = p.heading === null || p.heading === undefined ? null : Number(p.heading);
  const lengthM = p.lengthM === null || p.lengthM === undefined ? null : Number(p.lengthM);
  const beamM = p.beamM === null || p.beamM === undefined ? null : Number(p.beamM);
  const destination = String(p.destination ?? '').trim();
  const callSign = String(p.callSign ?? '').trim();
  const imo = p.imo === null || p.imo === undefined ? null : Number(p.imo);
  const flag = String(p.flag ?? '').trim();
  const eta = String(p.eta ?? '').trim();
  const draughtM = p.draughtM === null || p.draughtM === undefined ? null : Number(p.draughtM);
  const positionFixType =
    p.positionFixType === null || p.positionFixType === undefined
      ? null
      : Number(p.positionFixType);

  const rows: string[] = [];

  if (lengthM !== null) {
    rows.push(
      row(t('vessel.size'), `${lengthM} × ${beamM ?? '?'}`, 'm'),
    );
  }
  if (sog !== null) {
    // AIS-i kiirus on sõlmedes ja jääb sõlmedeks — see on laevanduse ühik,
    // mitte tuule oma, ja kasutaja tuuleühiku valik ei tohi seda muuta.
    rows.push(row(t('vessel.sog'), sog.toFixed(1), 'kn'));
  }
  const course = heading ?? cog;
  if (course !== null) {
    rows.push(row(t('vessel.cog'), `${Math.round(course)}° ${degreesToCompass(course)}`, ''));
  }
  if (destination) {
    rows.push(row(t('vessel.destination'), escapeHtml(destination), ''));
  }
  if (eta) {
    rows.push(row(t('vessel.eta'), escapeHtml(formatVesselEta(eta, ctx.lang)), ''));
  }
  if (draughtM !== null) {
    rows.push(row(t('vessel.draught'), draughtM.toFixed(1), 'm'));
  }
  if (callSign) {
    rows.push(row(t('vessel.callSign'), escapeHtml(callSign), ''));
  }
  if (imo !== null) {
    rows.push(row('IMO', escapeHtml(String(imo)), ''));
  }
  if (flag) {
    rows.push(row(t('vessel.flag'), escapeHtml(flag), ''));
  }
  if (positionFixType !== null) {
    rows.push(row(t('vessel.positionFix'), escapeHtml(positionFixName(positionFixType)), ''));
  }

  const stopped = sog !== null && sog < 0.5;

  return `
    <div class="popup">
      <div class="popup__head">
        <strong>${escapeHtml(name)}</strong>
        <span class="popup__kind">MMSI ${escapeHtml(String(p.mmsi ?? ''))}</span>
      </div>
      ${stopped ? `<div class="popup__age">${escapeHtml(t('vessel.moored'))}</div>` : ''}
      <table class="popup__table">${rows.join('')}</table>
      <div class="popup__source">AIS · ${escapeHtml(String(p.source ?? ''))}</div>
    </div>`;
}

function formatVesselEta(value: string, lang: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(lang === 'et' ? 'et-EE' : 'en-GB', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(date);
}

function positionFixName(code: number): string {
  return (
    [
      'Undefined',
      'GPS',
      'GLONASS',
      'GPS + GLONASS',
      'Loran-C',
      'Chayka',
      'Integrated navigation system',
      'Surveyed',
      'Galileo',
    ][code] ?? `AIS ${code}`
  );
}

/**
 * Popupi tabelirida.
 *
 * Ühik käib väärtusega ühte `nowrap`-lahtrisse: "3.8" ja "m" ei tohi eri
 * ridadele sattuda. Ühikuta väärtus (nimi, teenuste loend, link) tohib ja
 * PEABKI murduma — just selle keelamine ajas pikad tekstid popupist välja.
 */
function row(label: string, value: string, unit: string): string {
  const cell = unit
    ? `<span class="popup__val">${value} <small>${escapeHtml(unit)}</small></span>`
    : value;
  return `<tr><th>${escapeHtml(label)}</th><td>${cell}</td></tr>`;
}

function formatAge(ageSeconds: number, t: Translate): string {
  if (!Number.isFinite(ageSeconds) || ageSeconds < 0) return t('station.noData');
  const minutes = Math.round(ageSeconds / 60);
  if (minutes < 60) return t('station.age.minutes', { n: Math.max(0, minutes) });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return t('station.age.hours', { n: hours });
  return t('station.age.days', { n: Math.round(hours / 24) });
}

/**
 * Laevanimed ja sihtkohad tulevad AIS-ist — see on avatud raadiokanal, mille
 * sisu keegi ei valideeri. Kogu tekst peab läbima escape'imise.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
