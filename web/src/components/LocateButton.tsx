import { useI18n } from '../i18n';
import { Crosshair, MapPin } from 'lucide-react';
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

  const label = geo.status === 'locating'
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
        (geo.status === 'locating' ? ' is-seeking' : '')
      }
      onClick={() => {
        if (geo.position) {
          // Olemasolev punkt annab kohese reaktsiooni. Värske GPS-fix uuendab
          // markerit taustal, kuid ei liiguta kaarti teist korda.
          onGoTo(geo.position.lat, geo.position.lon, 12);
          geo.request();
        } else {
          geo.request((position) => onGoTo(position.lat, position.lon, 12));
        }
      }}
      title={label}
      aria-label={label}
      disabled={geo.status === 'insecure' || geo.status === 'locating'}
    >
      {geo.position ? (
        /* Asukoht on teada: sihik tähendab "vii mind tagasi siia". */
        <Crosshair size={20} aria-hidden="true" />
      ) : (
        /* Asukohta (ja enamasti veel ka luba) pole: marker annab märku, et
           vajutus alustab asukoha küsimist, mitte ei lülita jälgimist sisse. */
        <MapPin size={20} aria-hidden="true" />
      )}
    </button>
  );
}
