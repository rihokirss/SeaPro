import { localeTag, useI18n } from '../i18n';

interface Props {
  nextIndex: number;
  distanceToNextM: number;
  bearing: number;
  crossTrackM: number;
  remainingNm: number;
  eta: string | null;
  warning: boolean;
  following: boolean;
  recording: boolean;
  onResume(): void;
  onToggleRecording(): void;
  onStop(): void;
}

export function NavigationBar(props: Props) {
  const { t, lang } = useI18n();
  return <div className={`nav-bar${props.warning ? ' is-warning' : ''}`} role="region" aria-label={t('nav.title')}>
    <div><span>{t('nav.next')}</span><strong>{props.nextIndex + 1} · {(props.distanceToNextM / 1852).toFixed(2)} NM</strong></div>
    <div><span>{t('nav.bearing')}</span><strong>{Math.round(props.bearing)}°</strong></div>
    <div><span>{t('nav.crossTrack')}</span><strong>{Math.round(props.crossTrackM)} m</strong></div>
    <div><span>{t('nav.remaining')}</span><strong>{props.remainingNm.toFixed(1)} NM</strong></div>
    <div><span>ETA</span><strong>{props.eta ? new Date(props.eta).toLocaleTimeString(localeTag(lang), { hour: '2-digit', minute: '2-digit' }) : '—'}</strong></div>
    {!props.following ? <button onClick={props.onResume}>{t('nav.resume')}</button> : null}
    <button className={props.recording ? 'is-recording' : ''} onClick={props.onToggleRecording}>{props.recording ? t('nav.recording') : t('nav.record')}</button>
    <button onClick={props.onStop}>{t('nav.stop')}</button>
  </div>;
}
