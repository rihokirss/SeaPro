import maplibregl, { type Map as MapLibreMap, type MapGeoJSONFeature } from 'maplibre-gl';
import type { Variable } from '@seapro/shared';
import { degreesToCompass } from '@seapro/shared';
import type { Translate } from '../i18n';
import { formatValue, unitLabel, type SpeedUnit } from '../lib/units';
import { STATIONS_LAYER } from './layers/stations';
import { VESSEL_LAYERS } from './layers/vessels';

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

export function registerPopups(map: MapLibreMap, getContext: () => PopupContext): void {
  const show = (lngLat: maplibregl.LngLatLike, html: string): void => {
    popup?.remove();
    popup = new maplibregl.Popup({
      closeButton: true,
      closeOnClick: true,
      maxWidth: '280px',
      offset: 14,
    })
      .setLngLat(lngLat)
      .setHTML(html)
      .addTo(map);
  };

  map.on('click', STATIONS_LAYER, (e) => {
    const f = e.features?.[0];
    if (!f) return;
    // Ära lase klikil ka punktipaneeli avada — jaam ON juba vastus.
    e.originalEvent.stopPropagation();
    show(coordsOf(f, e.lngLat), stationHtml(f, getContext()));
  });

  for (const layer of VESSEL_LAYERS) {
    map.on('click', layer, (e) => {
      const f = e.features?.[0];
      if (!f) return;
      e.originalEvent.stopPropagation();
      show(e.lngLat, vesselHtml(f, getContext()));
    });
  }

  // Kursor annab märku, et marker on klikitav.
  for (const layer of [STATIONS_LAYER, ...VESSEL_LAYERS]) {
    map.on('mouseenter', layer, () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', layer, () => {
      map.getCanvas().style.cursor = '';
    });
  }
}

export function closePopup(): void {
  popup?.remove();
  popup = null;
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
  if (callSign) {
    rows.push(row('Callsign', escapeHtml(callSign), ''));
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

function row(label: string, value: string, unit: string): string {
  return `<tr><th>${escapeHtml(label)}</th><td>${value}${unit ? ` <small>${escapeHtml(unit)}</small>` : ''}</td></tr>`;
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
