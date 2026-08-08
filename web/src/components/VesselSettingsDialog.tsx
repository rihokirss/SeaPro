import { useEffect, useState, type FormEvent } from 'react';
import { Home, X } from 'lucide-react';
import { useI18n } from '../i18n';
import { normalizeVesselProfile, type HomeHarbour, type VesselProfile } from '../lib/vesselProfile';
import { SearchPicker } from './SearchPicker';

interface Props {
  profile: VesselProfile;
  onSave(profile: VesselProfile): void;
  onClose(): void;
}

interface Draft {
  name: string;
  speedKnots: string;
  fuelLitresPerHour: string;
  draughtM: string;
  underKeelClearanceM: string;
  beamM: string;
  airDraughtM: string;
}

function profileDraft(profile: VesselProfile): Draft {
  return {
    name: profile.name,
    speedKnots: String(profile.speedKnots),
    fuelLitresPerHour: String(profile.fuelLitresPerHour),
    draughtM: String(profile.draughtM),
    underKeelClearanceM: String(profile.underKeelClearanceM),
    beamM: profile.beamM === undefined ? '' : String(profile.beamM),
    airDraughtM: profile.airDraughtM === undefined ? '' : String(profile.airDraughtM),
  };
}

function optionalNumber(value: string): number | undefined {
  return value.trim() ? Number(value) : undefined;
}

export function VesselSettingsDialog({ profile, onSave, onClose }: Props) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(() => profileDraft(profile));
  const [homeHarbour, setHomeHarbour] = useState<HomeHarbour | undefined>(profile.homeHarbour);
  const update = (key: keyof Draft, value: string): void => setDraft((current) => ({ ...current, [key]: value }));

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    onSave(normalizeVesselProfile({
      name: draft.name,
      speedKnots: Number(draft.speedKnots),
      fuelLitresPerHour: Number(draft.fuelLitresPerHour),
      draughtM: Number(draft.draughtM),
      underKeelClearanceM: Number(draft.underKeelClearanceM),
      beamM: optionalNumber(draft.beamM),
      airDraughtM: optionalNumber(draft.airDraughtM),
      homeHarbour,
    }));
  };

  return <div className="route-vessel-dialog__backdrop">
    <section className="route-vessel-dialog" role="dialog" aria-modal="true" aria-labelledby="route-vessel-dialog-title">
      <header>
        <div><strong id="route-vessel-dialog-title">{t('route.vessel.settingsTitle')}</strong><span>{t('route.vessel.settingsHint')}</span></div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label={t('action.close')}><X size={21} aria-hidden="true" /></button>
      </header>
      <form onSubmit={submit}>
        <label>{t('route.vessel.name')}<input value={draft.name} maxLength={100} onChange={(event) => update('name', event.target.value)} placeholder={t('route.vessel.namePlaceholder')} /></label>
        <div className="route-form__grid">
          <label>{t('route.speed')}<input required type="number" min="0.1" max="100" step="0.1" value={draft.speedKnots} onChange={(event) => update('speedKnots', event.target.value)} /></label>
          <label>{t('route.fuelRate')}<input required type="number" min="0" max="10000" step="0.1" value={draft.fuelLitresPerHour} onChange={(event) => update('fuelLitresPerHour', event.target.value)} /></label>
          <label>{t('route.draught')}<input required type="number" min="0" max="50" step="0.1" value={draft.draughtM} onChange={(event) => update('draughtM', event.target.value)} /></label>
          <label>{t('route.clearance')}<input required type="number" min="0" max="20" step="0.1" value={draft.underKeelClearanceM} onChange={(event) => update('underKeelClearanceM', event.target.value)} /></label>
          <label>{t('route.beam')}<input type="number" min="0.1" max="100" step="0.1" value={draft.beamM} onChange={(event) => update('beamM', event.target.value)} /></label>
          <label>{t('route.airDraught')}<input type="number" min="0.1" max="100" step="0.1" value={draft.airDraughtM} onChange={(event) => update('airDraughtM', event.target.value)} /></label>
        </div>

        <fieldset className="route-home-harbour">
          <legend>{t('route.homeHarbour')}</legend>
          {homeHarbour ? <div className="route-home-harbour__selected">
            <Home size={19} aria-hidden="true" />
            <span><strong>{homeHarbour.name}</strong><small>{homeHarbour.lat.toFixed(5)}, {homeHarbour.lon.toFixed(5)}</small></span>
            <button type="button" onClick={() => setHomeHarbour(undefined)}>{t('route.homeHarbour.clear')}</button>
          </div> : <p>{t('route.homeHarbour.notSet')}</p>}
          <SearchPicker
            key={homeHarbour?.id ?? 'no-home-harbour'}
            placeholder={t('route.homeHarbour.searchPlaceholder')}
            initialQuery={homeHarbour?.name}
            filter={(result) => result.kind === 'harbour'}
            onChoose={(result) => setHomeHarbour({ id: result.id, name: result.name, lat: result.lat, lon: result.lon })}
          />
        </fieldset>

        <div className="route-vessel-dialog__actions">
          <button type="button" onClick={onClose}>{t('action.cancel')}</button>
          <button type="submit" className="primary">{t('route.vessel.save')}</button>
        </div>
      </form>
    </section>
  </div>;
}
