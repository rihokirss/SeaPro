import type { ProviderCapabilities, Variable } from '@seapro/shared';
import { X } from 'lucide-react';
import { LANGS, useI18n } from '../i18n';
import { COLOR_SCALES, SCALAR_FIELDS, rgbaCss, sampleScale } from '../map/colorScales';
import { THEMES, type Theme } from '../lib/theme';
import { SPEED_UNITS, type SpeedUnit } from '../lib/units';

/**
 * Kuidas tuult kaardil näidata.
 *
 * Üks väli, mitte kaks lülitit: nooled ja animatsioon näitavad SAMA asja
 * kahel viisil ja korraga sisse lülitatuna võitlevad üksteisega. Kolmene
 * valik teeb vigase vahepealse oleku lihtsalt olematuks, selle asemel et
 * seda mujal koodis valvata.
 */
export type WindDisplay = 'off' | 'arrows' | 'animated';

export interface LayerState {
  overlays: string[];
  windDisplay: WindDisplay;
  /** Valevärvi-välja muutuja; null = väli välja lülitatud. */
  scalarField: Variable | null;
  stations: boolean;
  vessels: boolean;
  harbours: boolean;
  anchorages: boolean;
  placeLabels: boolean;
  navigationWarnings: boolean;
  navigationAids: boolean;
  trafficSchemes: boolean;
  wrecks: boolean;
  officialNavigation: boolean;
  routingGraph: boolean;
}

interface Props {
  open: boolean;
  onClose(): void;
  layers: LayerState;
  onLayersChange(next: LayerState): void;
  providers: ProviderCapabilities[];
  activeProviders: string[];
  onProvidersChange(next: string[]): void;
  activeModel: string;
  onModelChange(next: string): void;
  /** `undefined` = serveri vaikevalik (EWAM). */
  activeWaveModel: string | undefined;
  onWaveModelChange(next: string): void;
  speedUnit: SpeedUnit;
  onSpeedUnitChange(next: SpeedUnit): void;
  theme: Theme;
  onThemeChange(next: Theme): void;
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange(v: boolean): void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle__box" aria-hidden="true" />
      <span className="toggle__text">
        {label}
        {hint ? <small>{hint}</small> : null}
      </span>
    </label>
  );
}

/** Väike värviriba, mis näitab, mida valevärvi-kiht tähendab. */
function ScaleBar({ variable }: { variable: Variable }) {
  const scale = COLOR_SCALES[variable];
  if (!scale) return null;

  const first = scale.stops[0]!.value;
  const last = scale.stops[scale.stops.length - 1]!.value;
  const steps = 24;
  const gradient = Array.from({ length: steps }, (_, i) => {
    const v = first + ((last - first) * i) / (steps - 1);
    return `${rgbaCss(sampleScale(scale, v))} ${(i / (steps - 1)) * 100}%`;
  }).join(', ');

  return (
    <div className="scalebar">
      <div className="scalebar__bar" style={{ background: `linear-gradient(90deg, ${gradient})` }} />
      <div className="scalebar__labels">
        <span>{first}</span>
        <span>{scale.unit}</span>
        <span>{last}</span>
      </div>
    </div>
  );
}

export function LayerPanel({
  open,
  onClose,
  layers,
  onLayersChange,
  providers,
  activeProviders,
  onProvidersChange,
  activeModel,
  onModelChange,
  activeWaveModel,
  onWaveModelChange,
  speedUnit,
  onSpeedUnitChange,
  theme,
  onThemeChange,
}: Props) {
  const { t, lang, setLang } = useI18n();

  const set = (patch: Partial<LayerState>): void => onLayersChange({ ...layers, ...patch });

  const toggleOverlay = (id: string, on: boolean): void => {
    set({ overlays: on ? [...layers.overlays, id] : layers.overlays.filter((x) => x !== id) });
  };

  const toggleProvider = (id: string, on: boolean): void => {
    const next = on ? [...activeProviders, id] : activeProviders.filter((x) => x !== id);
    // Vähemalt üks allikas peab jääma, muidu on ekraan tühi ja kasutaja ei
    // saa aru, kas rakendus on katki või ta lülitas kõik välja.
    if (next.length === 0) return;
    onProvidersChange(next);
  };

  const forecastProviders = providers.filter((p) => p.kind === 'forecast');
  const observationProviders = providers.filter((p) => p.kind === 'observation');
  const openMeteo = providers.find((p) => p.id === 'open-meteo');
  const models = openMeteo?.models ?? [];
  const waveModels = openMeteo?.waveModels ?? [];
  // Server otsustab vaikimisi lainemudeli; kuni kasutaja pole valinud, näitame
  // aktiivsena loendi esimest, mis ongi serveri vaikevalik.
  const selectedWaveModel = activeWaveModel ?? waveModels[0]?.id;

  return (
    <>
      <div
        className={`panel-scrim${open ? ' is-open' : ''}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside className={`panel${open ? ' is-open' : ''}`} aria-hidden={!open}>
        <header className="panel__head">
          <h2>{t('action.layers')}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t('action.close')}>
            <X size={21} aria-hidden="true" />
          </button>
        </header>

        <div className="panel__body">
          <section className="panel__section">
            <h3>{t('layer.group.navigation')}</h3>
            <Toggle
              checked={layers.overlays.includes('chart')}
              onChange={(v) => toggleOverlay('chart', v)}
              label={t('layer.chart')}
              hint={t('layer.chart.hint')}
            />
            <Toggle
              checked={layers.overlays.includes('depth-details')}
              onChange={(v) => toggleOverlay('depth-details', v)}
              label={t('layer.depthDetails')}
              hint={t('layer.depthDetails.hint')}
            />
            <Toggle
              checked={layers.overlays.includes('bathymetry')}
              onChange={(v) => toggleOverlay('bathymetry', v)}
              label={t('layer.bathymetry')}
              hint={t('layer.bathymetry.hint')}
            />
            <Toggle
              checked={layers.placeLabels}
              onChange={(v) => set({ placeLabels: v })}
              label={t('layer.placeLabels')}
            />
            <Toggle
              checked={layers.officialNavigation}
              onChange={(v) => set({ officialNavigation: v })}
              label={t('layer.officialNavigation')}
              hint={t('layer.officialNavigation.hint')}
            />
            <Toggle
              checked={layers.routingGraph}
              onChange={(v) => set({ routingGraph: v })}
              label={t('layer.routingGraph')}
              hint={t('layer.routingGraph.hint')}
            />
            <Toggle
              checked={layers.navigationWarnings}
              onChange={(v) => set({ navigationWarnings: v })}
              label={t('layer.navigationWarnings')}
              hint={t('layer.navigationWarnings.hint')}
            />
            <Toggle
              checked={layers.wrecks}
              onChange={(v) => set({ wrecks: v })}
              label={t('layer.wrecks')}
            />
            <Toggle
              checked={layers.navigationAids}
              onChange={(v) => set({ navigationAids: v })}
              label={t('layer.navigationAids')}
            />
            <Toggle
              checked={layers.trafficSchemes}
              onChange={(v) => set({ trafficSchemes: v })}
              label={t('layer.trafficSchemes')}
              hint={t('layer.trafficSchemes.hint')}
            />
          </section>

          <section className="panel__section">
            <h3>{t('layer.group.traffic')}</h3>
            <Toggle
              checked={layers.vessels}
              onChange={(v) => set({ vessels: v })}
              label={t('layer.vessels')}
            />
            <Toggle
              checked={layers.harbours}
              onChange={(v) => set({ harbours: v })}
              label={t('layer.harbours')}
            />
            <Toggle
              checked={layers.anchorages}
              onChange={(v) => set({ anchorages: v })}
              label={t('layer.anchorages')}
              hint={t('layer.anchorages.hint')}
            />
          </section>

          <section className="panel__section">
            <h3>{t('layer.group.weather')}</h3>

            <Toggle
              checked={layers.overlays.includes('radar')}
              onChange={(v) => toggleOverlay('radar', v)}
              label={t('layer.radar')}
            />
            <Toggle
              checked={layers.stations}
              onChange={(v) => set({ stations: v })}
              label={t('layer.stations')}
            />
            <h4 className="panel__subhead">{t('layer.wind')}</h4>
            <div className="chips">
              {(['off', 'arrows', 'animated'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={`chip${layers.windDisplay === mode ? ' is-active' : ''}`}
                  onClick={() => set({ windDisplay: mode })}
                  title={mode === 'animated' ? t('layer.windAnimation.hint') : undefined}
                >
                  {t(`layer.wind.${mode}`)}
                </button>
              ))}
            </div>
          </section>

          <section className="panel__section">
            {/* Pealkiri oli varem sama mis kaardikihtidel ja lisas näidetena
                paar muutujanime — kaks ühesugust pealkirja paneelis ajasid
                segadusse. Üks väli korraga, sest kaks poolläbipaistvat
                värvikihti üksteise peal muudaks mõlemad loetamatuks. */}
            <h3>{t('layer.field')}</h3>
            <div className="chips">
              <button
                type="button"
                className={`chip${layers.scalarField === null ? ' is-active' : ''}`}
                onClick={() => set({ scalarField: null })}
              >
                {t('layer.field.none')}
              </button>
              {SCALAR_FIELDS.map((v) => (
                <button
                  key={v}
                  type="button"
                  className={`chip${layers.scalarField === v ? ' is-active' : ''}`}
                  onClick={() => set({ scalarField: layers.scalarField === v ? null : v })}
                >
                  {t(`var.${v}`)}
                </button>
              ))}
            </div>
            {layers.scalarField ? <ScaleBar variable={layers.scalarField} /> : null}
          </section>

          <section className="panel__section">
            <h3>{t('action.sources')}</h3>
            {/* Ainult Open-Meteo pakub võrgustikupäringut; ülejäänud on
                punktiallikad (met.no ToS keelab võrgustiku tõmbamise,
                Windfinder ja jaamad annavad ühe koha korraga). Seetõttu
                mõjutab see valik ainult punktipaneeli ja seda tuleb ka
                öelda — muidu paistab, et kaart lihtsalt ignoreerib valikut. */}
            <p className="panel__hint">{t('source.scope')}</p>

            <h4 className="panel__subhead">{t('source.kind.forecast')}</h4>
            {forecastProviders.map((p) => (
              <Toggle
                key={p.id}
                checked={activeProviders.includes(p.id)}
                onChange={(v) => toggleProvider(p.id, v)}
                label={p.label}
                hint={p.enabled ? undefined : p.disabledReason ?? t('source.disabled')}
              />
            ))}

            {observationProviders.length > 0 ? (
              <>
                <h4 className="panel__subhead">{t('source.kind.observation')}</h4>
                {observationProviders.map((p) => (
                  <Toggle
                    key={p.id}
                    checked={activeProviders.includes(p.id)}
                    onChange={(v) => toggleProvider(p.id, v)}
                    label={p.label}
                    hint={p.enabled ? undefined : p.disabledReason ?? t('source.disabled')}
                  />
                ))}
              </>
            ) : null}
          </section>

          {models.length > 0 ? (
            <section className="panel__section">
              <h3>{t('source.mapLayer')}</h3>
              <p className="panel__hint">{t('source.mapLayer.hint')}</p>

              <h4 className="panel__subhead">{t('source.model.atmo')}</h4>
              <div className="chips">
                {models.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={`chip${activeModel === m.id ? ' is-active' : ''}`}
                    onClick={() => onModelChange(m.id)}
                    title={m.note}
                  >
                    {m.label}
                  </button>
                ))}
              </div>

              {/*
                Lained eraldi, sest need tulevad teisest API-st teiste
                mudelinimedega. Ühte loendisse pandult valiks kasutaja
                lainekihile atmosfäärimudeli ja kiht kaoks vaikselt ära.
              */}
              {waveModels.length > 0 ? (
                <>
                  <h4 className="panel__subhead">{t('source.model.wave')}</h4>
                  <div className="chips">
                    {waveModels.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        className={`chip${selectedWaveModel === m.id ? ' is-active' : ''}`}
                        onClick={() => onWaveModelChange(m.id)}
                        title={m.note}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                  <p className="panel__hint">{t('source.model.wave.hint')}</p>
                </>
              ) : null}
            </section>
          ) : null}

          <section className="panel__section">
            <h3>{t('unit.label')}</h3>
            <div className="chips">
              {SPEED_UNITS.map((u) => (
                <button
                  key={u}
                  type="button"
                  className={`chip${speedUnit === u ? ' is-active' : ''}`}
                  onClick={() => onSpeedUnitChange(u)}
                >
                  {t(`unit.${u}`)}
                </button>
              ))}
            </div>
          </section>

          {/*
            Teema ja keel elavad siin, sest mõlemad on "seadista korra ja unusta"
            valikud. Keelevalik oli varem ülaribal ja võttis seal ruumi, mida
            telefonis on kõige vähem — iga avamise juures nähtav rippmenüü
            asja, mida vahetatakse kord elus.
          */}
          <section className="panel__section">
            <h3>{t('theme.label')}</h3>
            <div className="chips">
              {THEMES.map((th) => (
                <button
                  key={th}
                  type="button"
                  className={`chip${theme === th ? ' is-active' : ''}`}
                  onClick={() => onThemeChange(th)}
                >
                  {t(`theme.${th}`)}
                </button>
              ))}
            </div>
            <p className="panel__hint">{t('theme.hint')}</p>
          </section>

          <section className="panel__section">
            <h3>{t('lang.label')}</h3>
            <div className="chips">
              {LANGS.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  className={`chip${lang === l.id ? ' is-active' : ''}`}
                  onClick={() => setLang(l.id)}
                >
                  {l.label}
                </button>
              ))}
            </div>
          </section>
        </div>
      </aside>
    </>
  );
}
