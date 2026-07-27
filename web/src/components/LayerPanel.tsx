import type { ProviderCapabilities, Variable } from '@seapro/shared';
import { useI18n } from '../i18n';
import { OVERLAY_LAYERS } from '../map/basemaps';
import { COLOR_SCALES, SCALAR_FIELDS, rgbaCss, sampleScale } from '../map/colorScales';
import { SPEED_UNITS, type SpeedUnit } from '../lib/units';

export interface LayerState {
  overlays: string[];
  windArrows: boolean;
  /** Animeeritud tuulevoog (osakesed). */
  windParticles: boolean;
  /** Valevärvi-välja muutuja; null = väli välja lülitatud. */
  scalarField: Variable | null;
  stations: boolean;
  vessels: boolean;
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
  speedUnit: SpeedUnit;
  onSpeedUnitChange(next: SpeedUnit): void;
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
  speedUnit,
  onSpeedUnitChange,
}: Props) {
  const { t } = useI18n();

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
  const models = providers.find((p) => p.id === 'open-meteo')?.models ?? [];

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
            ✕
          </button>
        </header>

        <div className="panel__body">
          <section className="panel__section">
            <h3>{t('layer.group.data')}</h3>

            <Toggle
              checked={layers.windArrows}
              onChange={(v) => set({ windArrows: v })}
              label={t('layer.wind')}
            />
            <Toggle
              checked={layers.windParticles}
              onChange={(v) => set({ windParticles: v })}
              label={t('layer.windAnimation')}
              hint={t('layer.windAnimation.hint')}
            />
            <Toggle
              checked={layers.stations}
              onChange={(v) => set({ stations: v })}
              label={t('layer.stations')}
            />
            <Toggle
              checked={layers.vessels}
              onChange={(v) => set({ vessels: v })}
              label={t('layer.vessels')}
            />
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
            <h3>{t('layer.group.overlay')}</h3>
            {OVERLAY_LAYERS.map((def) => (
              <Toggle
                key={def.id}
                checked={layers.overlays.includes(def.id)}
                onChange={(v) => toggleOverlay(def.id, v)}
                label={t(def.labelKey)}
              />
            ))}
          </section>

          <section className="panel__section">
            <h3>{t('action.sources')}</h3>

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
              <h3>Open-Meteo mudel</h3>
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
        </div>
      </aside>
    </>
  );
}
