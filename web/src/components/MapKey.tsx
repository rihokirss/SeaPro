import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { FRESHNESS_COLORS, HARBOUR_COLORS, VESSEL_COLORS } from '../map/icons';

/**
 * Tingmärkide seletus.
 *
 * Kaardil on kolm eraldi märgikeelt korraga — jaamad (kuju = tüüp, värv =
 * andmete vanus), laevad (värv = laevatüüp, kuju = kas suund on teada) ja
 * tuulenooled. Ükski neist pole isetseletav ja kaatris pole aega arvata.
 *
 * Märgid joonistatakse SVG-na siinsamas, mitte ei tõmmata kaardi ikoonidest:
 * kaardi omad on canvas-ImageData'd, mida DOM-i ei saa panna, ja kahekordne
 * kirjeldus oleks igal juhul risk minna lahku. Kujud on siin sihilikult samad
 * mis `map/icons.ts`-is — kui üht muudad, muuda ka teist.
 */

interface Props {
  /** Kas laevakiht on sees — muidu pole mõtet laevamärke seletada. */
  showVessels: boolean;
  showStations: boolean;
  showHarbours: boolean;
  /**
   * Kas punktiprognoosi paneel on lahti. Lauaarvutil istub see paneel samas
   * alumises paremas nurgas ja kataks nupu ära, seega nihutame nupu kõrvale.
   */
  sheetOpen: boolean;
}

export function MapKey({ showVessels, showStations, showHarbours, sheetOpen }: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Sulge, kui klõpsatakse mujale või vajutatakse Esc — kaardirakenduses on
  // hõljuv paneel muidu kergesti unustatud ette jääma.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (e: PointerEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className={`mapkey${sheetOpen ? ' is-shifted' : ''}`} ref={wrapRef}>
      {open ? (
        <div className="mapkey__panel" role="dialog" aria-label={t('key.title')}>
          <h3>{t('key.title')}</h3>

          {showStations ? (
            <section className="mapkey__section">
              <h4>{t('key.stations')}</h4>
              <ul>
                <li>
                  <StationMark shape="circle" color={FRESHNESS_COLORS.fresh!} />
                  {t('station.kind.coastal')}
                </li>
                <li>
                  <StationMark shape="square" color={FRESHNESS_COLORS.fresh!} />
                  {t('station.kind.offshore')}
                </li>
                <li>
                  <StationMark shape="diamond" color={FRESHNESS_COLORS.fresh!} />
                  {t('station.kind.buoy')}
                </li>
              </ul>

              <h4>{t('key.freshness')}</h4>
              <ul>
                <li>
                  <StationMark shape="circle" color={FRESHNESS_COLORS.fresh!} />
                  {t('key.freshness.fresh')}
                </li>
                <li>
                  <StationMark shape="circle" color={FRESHNESS_COLORS.stale!} />
                  {t('key.freshness.stale')}
                </li>
                <li>
                  <StationMark shape="circle" color={FRESHNESS_COLORS.old!} />
                  {t('key.freshness.old')}
                </li>
                <li>
                  <StationMark shape="circle" color={FRESHNESS_COLORS.none!} />
                  {t('station.noData')}
                </li>
              </ul>
            </section>
          ) : null}

          {showHarbours ? (
            <section className="mapkey__section">
              <h4>{t('key.harbours')}</h4>
              <ul>
                <li>
                  <HarbourMark color={HARBOUR_COLORS.full} />
                  {t('key.harbour.full')}
                </li>
                <li>
                  <HarbourMark color={HARBOUR_COLORS.basic} />
                  {t('key.harbour.basic')}
                </li>
              </ul>
              <p className="mapkey__note">{t('key.harbours.note')}</p>
            </section>
          ) : null}

          {showVessels ? (
            <section className="mapkey__section">
              <h4>{t('key.vessels')}</h4>
              <ul>
                {(
                  [
                    ['cargo', 'key.vessel.cargo'],
                    ['tanker', 'key.vessel.tanker'],
                    ['passenger', 'key.vessel.passenger'],
                    ['fishing', 'key.vessel.fishing'],
                    ['sailing', 'key.vessel.sailing'],
                    ['fast', 'key.vessel.fast'],
                    ['default', 'key.vessel.other'],
                  ] as const
                ).map(([category, labelKey]) => (
                  <li key={category}>
                    <VesselMark color={VESSEL_COLORS[category]!} />
                    {t(labelKey)}
                  </li>
                ))}
              </ul>
              <p className="mapkey__note">{t('key.vessels.note')}</p>
            </section>
          ) : null}

          <section className="mapkey__section">
            <h4>{t('layer.wind')}</h4>
            <ul>
              <li>
                <WindMark />
                {t('key.windArrow')}
              </li>
            </ul>
            <p className="mapkey__note">{t('key.wind.note')}</p>
          </section>
        </div>
      ) : null}

      <button
        type="button"
        className={`icon-btn${open ? ' is-active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={t('key.title')}
        title={t('key.title')}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path
            d="M12 10.5v6"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <circle cx="12" cy="7.4" r="1.3" fill="currentColor" />
        </svg>
      </button>
    </div>
  );
}

/** Jaamamärk — samad kujud mis kaardil: ring, ruut, romb. */
function StationMark({ shape, color }: { shape: 'circle' | 'square' | 'diamond'; color: string }) {
  return (
    <svg className="mapkey__mark" viewBox="0 0 20 20" aria-hidden="true">
      {shape === 'circle' ? (
        <circle cx="10" cy="10" r="6.5" fill={color} stroke="#fff" strokeWidth="2" />
      ) : shape === 'square' ? (
        <rect x="3.5" y="3.5" width="13" height="13" fill={color} stroke="#fff" strokeWidth="2" />
      ) : (
        <path d="M10 2.5 17.5 10 10 17.5 2.5 10Z" fill={color} stroke="#fff" strokeWidth="2" />
      )}
    </svg>
  );
}

/** Sadamamärk — ankur ringi sees, sama kuju mis kaardil. */
function HarbourMark({ color }: { color: string }) {
  return (
    <svg className="mapkey__mark" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="8" fill={color} stroke="#fff" strokeWidth="1.5" />
      <g stroke="#fff" strokeWidth="1.4" fill="none" strokeLinecap="round">
        <circle cx="10" cy="5.8" r="1.5" />
        <path d="M10 7.3v6M7 9h6M6.4 11.8c.4 3 3.6 3 3.6 3s3.2 0 3.6-3" />
      </g>
    </svg>
  );
}

function VesselMark({ color }: { color: string }) {
  return (
    <svg className="mapkey__mark" viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M10 2.5 15 16 10 13.2 5 16Z"
        fill={color}
        stroke="rgba(8,26,40,0.85)"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function WindMark() {
  return (
    <svg className="mapkey__mark" viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M10 2.5 13.5 8.2h-2.3V17.5H8.8V8.2H6.5Z"
        fill="currentColor"
      />
    </svg>
  );
}
