import { useI18n } from '../i18n';
import type { GeoState } from '../lib/geolocation';

interface Props {
  geo: GeoState;
  onGoTo(lat: number, lon: number, zoom?: number): void;
}

/**
 * "Minu asukoht".
 *
 * Elas varem ülaribal, teiste nuppude reas. Kaatris on see vale koht: ülariba
 * on ekraani ülaservas, telefoni hoitakse alt, ja just seda nuppu vajutatakse
 * ühe käega kõige sagedamini. Nüüd on ta all paremal, tingmärkide nupu kohal,
 * pöidla ulatuses.
 *
 * Nupp ise ei tea paigutusest midagi — asukoha annab `.mapctl` virn.
 */
export function LocateButton({ geo, onGoTo }: Props) {
  const { t } = useI18n();

  const label =
    geo.status === 'locating'
      ? t('action.locating')
      : geo.status === 'denied'
        ? t('location.denied')
        : geo.status === 'insecure'
          ? t('location.insecure')
          : t('action.myLocation');

  return (
    <button
      type="button"
      className={
        'icon-btn' +
        (geo.status === 'ok' && geo.followMe ? ' is-active' : '') +
        (geo.status === 'locating' ? ' is-seeking' : '')
      }
      onClick={() => {
        geo.request();
        if (geo.position) onGoTo(geo.position.lat, geo.position.lon, 12);
      }}
      title={label}
      aria-label={label}
      disabled={geo.status === 'insecure'}
    >
      <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
        <circle cx="12" cy="12" r="2.4" fill="currentColor" />
        <path
          d="M12 1v3M12 20v3M1 12h3M20 12h3"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}
