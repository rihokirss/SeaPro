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
  showNavigationAids: boolean;
  showNavigationWarnings: boolean;
  showWrecks: boolean;
  showWind: boolean;
}

type KeyTab = 'navigation' | 'vessels' | 'weather' | 'places';

export function MapKey({
  showVessels,
  showStations,
  showHarbours,
  showNavigationAids,
  showNavigationWarnings,
  showWrecks,
  showWind,
}: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<KeyTab>('navigation');
  const wrapRef = useRef<HTMLDivElement>(null);

  const tabs: KeyTab[] = [
    ...(showNavigationAids || showNavigationWarnings || showWrecks ? ['navigation' as const] : []),
    ...(showVessels ? ['vessels' as const] : []),
    ...(showStations || showWind ? ['weather' as const] : []),
    ...(showHarbours ? ['places' as const] : []),
  ];

  useEffect(() => {
    if (!tabs.includes(activeTab) && tabs[0]) setActiveTab(tabs[0]);
  }, [activeTab, tabs.join(',')]);

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
    <div className="mapkey" ref={wrapRef}>
      {open ? (
        <div className="mapkey__panel" role="dialog" aria-label={t('key.title')}>
          <h3>{t('key.title')}</h3>
          <div className="mapkey__tabs" role="tablist" aria-label={t('key.title')}>
            {tabs.map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={activeTab === tab}
                className={activeTab === tab ? 'is-active' : ''}
                onClick={() => setActiveTab(tab)}
              >
                {t(`key.tab.${tab}`)}
              </button>
            ))}
          </div>

          {activeTab === 'navigation' ? (
            <section className="mapkey__section" role="tabpanel">
              {showNavigationAids ? (
                <>
                  <h4>{t('key.navigationAids')}</h4>
                  <ul>
                    {([
                      ['lateral-port', 'key.aid.lateralPort'],
                      ['lateral-starboard', 'key.aid.lateralStarboard'],
                      ['cardinal-north', 'key.aid.cardinalNorth'],
                      ['cardinal-east', 'key.aid.cardinalEast'],
                      ['cardinal-south', 'key.aid.cardinalSouth'],
                      ['cardinal-west', 'key.aid.cardinalWest'],
                      ['isolated-danger', 'key.aid.isolatedDanger'],
                      ['safe-water', 'key.aid.safeWater'],
                      ['special', 'key.aid.special'],
                      ['lighthouse', 'key.aid.lighthouse'],
                      ['virtual', 'key.aid.virtual'],
                    ] as const).map(([category, label]) => (
                      <li key={category}><NavigationMark category={category} />{t(label)}</li>
                    ))}
                  </ul>
                  <p className="mapkey__note">{t('key.aid.note')}</p>
                </>
              ) : null}
              {showNavigationWarnings ? (
                <p className="mapkey__legend-row"><WarningMark />{t('layer.navigationWarnings')}</p>
              ) : null}
              {showWrecks ? (
                <p className="mapkey__legend-row"><WreckMark />{t('layer.wrecks')}</p>
              ) : null}
            </section>
          ) : null}

          {activeTab === 'vessels' && showVessels ? (
            <section className="mapkey__section">
              <ul>
                {(
                  [
                    ['cargo', 'key.vessel.cargo'],
                    ['tanker', 'key.vessel.tanker'],
                    ['passenger', 'key.vessel.passenger'],
                    ['fishing', 'key.vessel.fishing'],
                    ['sailing', 'key.vessel.sailing'],
                    ['pleasure', 'key.vessel.pleasure'],
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

          {activeTab === 'weather' ? (
            <section className="mapkey__section" role="tabpanel">
              {showStations ? (
                <>
                  <h4>{t('key.stations')}</h4>
                  <ul>
                    <li><StationMark shape="circle" color={FRESHNESS_COLORS.fresh!} />{t('station.kind.coastal')}</li>
                    <li><StationMark shape="square" color={FRESHNESS_COLORS.fresh!} />{t('station.kind.offshore')}</li>
                    <li><StationMark shape="diamond" color={FRESHNESS_COLORS.fresh!} />{t('station.kind.buoy')}</li>
                  </ul>
                  <h4>{t('key.freshness')}</h4>
                  <ul>
                    <li><StationMark shape="circle" color={FRESHNESS_COLORS.fresh!} />{t('key.freshness.fresh')}</li>
                    <li><StationMark shape="circle" color={FRESHNESS_COLORS.stale!} />{t('key.freshness.stale')}</li>
                    <li><StationMark shape="circle" color={FRESHNESS_COLORS.old!} />{t('key.freshness.old')}</li>
                    <li><StationMark shape="circle" color={FRESHNESS_COLORS.none!} />{t('station.noData')}</li>
                  </ul>
                </>
              ) : null}
              {showWind ? (
                <>
                  <h4>{t('layer.wind')}</h4>
                  <ul><li><WindMark />{t('key.windArrow')}</li></ul>
                  <p className="mapkey__note">{t('key.wind.note')}</p>
                </>
              ) : null}
            </section>
          ) : null}

          {activeTab === 'places' && showHarbours ? (
            <section className="mapkey__section" role="tabpanel">
              <ul>
                <li><HarbourMark color={HARBOUR_COLORS.full} />{t('key.harbour.full')}</li>
                <li><HarbourMark color={HARBOUR_COLORS.basic} />{t('key.harbour.basic')}</li>
              </ul>
              <p className="mapkey__note">{t('key.harbours.note')}</p>
            </section>
          ) : null}
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

function NavigationMark({ category }: { category: string }) {
  const common = { stroke: '#173342', strokeWidth: 1.1 };
  const cardinalDirection = category.startsWith('cardinal-')
    ? category.slice('cardinal-'.length)
    : '';
  const upperUp = cardinalDirection === 'north' || cardinalDirection === 'east';
  const lowerUp = cardinalDirection === 'north' || cardinalDirection === 'west';
  return (
    <svg className="mapkey__mark mapkey__mark--aton" viewBox="0 0 20 24" aria-hidden="true">
      {category === 'lateral-port' ? (
        <rect x="6" y="6" width="8" height="16" fill="#df3f45" {...common} />
      ) : category === 'lateral-starboard' ? (
        <path d="M10 3 16 22H4Z" fill="#2b9b62" {...common} />
      ) : category.startsWith('cardinal-') ? (
        <g>
          <rect x="7" y="12" width="6" height="11" fill={cardinalDirection === 'east' ? '#111' : '#f1cc35'} {...common} />
          <path d={upperUp ? 'M10 1 7 5h6Z' : 'M7 1h6l-3 4Z'} fill="#111" />
          <path d={lowerUp ? 'M10 6 7 10h6Z' : 'M7 6h6l-3 4Z'} fill="#111" />
          {cardinalDirection === 'north' ? <rect x="7" y="12" width="6" height="4" fill="#111" /> : null}
          {cardinalDirection === 'south' ? <rect x="7" y="19" width="6" height="4" fill="#111" /> : null}
          {cardinalDirection === 'east' ? <rect x="7" y="15.5" width="6" height="4" fill="#f1cc35" /> : null}
          {cardinalDirection === 'west' ? <rect x="7" y="15.5" width="6" height="4" fill="#111" /> : null}
        </g>
      ) : category === 'isolated-danger' ? (
        <g><rect x="7" y="13" width="6" height="10" fill="#111" /><rect x="7" y="16.5" width="6" height="3" fill="#df3f45" /><circle cx="10" cy="3" r="2" /><circle cx="10" cy="8" r="2" /></g>
      ) : category === 'safe-water' ? (
        <g><circle cx="10" cy="16" r="6" fill="#fff" {...common} /><path d="M5.8 11.8h2.6v8.4H5.8ZM11.2 10.5h2.6v10.8h-2.6Z" fill="#df3f45" /><circle cx="10" cy="5" r="2.2" fill="#df3f45" /></g>
      ) : category === 'special' ? (
        <g><path d="m10 10 6 6-6 7-6-7Z" fill="#f0c62d" {...common} /><path d="m6.5 2.5 7 5M13.5 2.5l-7 5" stroke="#9a6d00" strokeWidth="1.5" /></g>
      ) : category === 'lighthouse' ? (
        <g><path d="M5.5 23 8 10h4l2.5 13Z" fill="#344b59" {...common} /><circle cx="10" cy="7" r="2.7" fill="#f0c62d" {...common} /></g>
      ) : (
        <g><circle cx="10" cy="12" r="7" fill="none" stroke="#238cae" strokeWidth="2" strokeDasharray="2 2" /><circle cx="10" cy="12" r="2" fill="#238cae" /></g>
      )}
    </svg>
  );
}

function WarningMark() {
  return (
    <svg className="mapkey__mark" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 1.8 18.5 18H1.5Z" fill="#f1b51c" stroke="#6d4700" strokeWidth="1" strokeLinejoin="round" />
      <path d="M10 7v5.2" stroke="#31240b" strokeWidth="2" strokeLinecap="round" />
      <circle cx="10" cy="14.6" r="1.1" fill="#31240b" />
    </svg>
  );
}

function WreckMark() {
  return <span className="mapkey__dot mapkey__dot--wreck" aria-hidden="true">×</span>;
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
