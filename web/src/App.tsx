import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type {
  GridFrame,
  PointResult,
  ProviderCapabilities,
  RadarTimeline,
  Harbour,
  StationReading,
  Variable,
  Vessel,
  NavigationData,
  Route,
  RouteAnalysis,
  RouteWaypoint,
  Track,
  TrackPoint,
} from '@seapro/shared';
import { bearingDegrees, crossTrackDistanceMetres, distanceMetres, isWaveVariable, routeDistanceNm, segmentProgress } from '@seapro/shared';
import { I18nContext, detectLang, makeTranslate, saveLang, type Lang } from './i18n';
import { RateLimitedError, api, type AppConfig } from './lib/api';
import { useGeolocation } from './lib/geolocation';
import { useFavorites } from './lib/favorites';
import { useTheme } from './lib/theme';
import { loadSpeedUnit, saveSpeedUnit, type SpeedUnit } from './lib/units';
import { loadMapView, saveMapView } from './lib/mapView';
import { loadLayerState, saveLayerState } from './lib/layerState';
import { floorToHour, formatDateTime } from './lib/time';
import { MapView } from './map/MapView';
import { radarFrameAt } from './map/basemaps';
import { hideWindArrows, updateWindArrows } from './map/layers/windArrows';
import { hideScalarField, updateScalarField } from './map/layers/scalarField';
import { setBasemapMuted } from './map/basemapTone';
import { WindParticleLayer } from './map/layers/windParticles';
import { setStationsVisible, updateStations } from './map/layers/stations';
import { setVesselsVisible, updateVessels } from './map/layers/vessels';
import { setAnchoragesVisible, setHarboursVisible, updateHarbours } from './map/layers/harbours';
import { closePopup, registerPopups } from './map/popups';
import { buildWindField, type Field } from './map/interpolate';
import { LayerPanel, type LayerState } from './components/LayerPanel';
import { TimeSlider } from './components/TimeSlider';
import { PointSheet } from './components/PointSheet';
import { TopBar } from './components/TopBar';
import { MapLegend } from './components/MapLegend';
import { MapKey } from './components/MapKey';
import { LocateButton } from './components/LocateButton';
import { RoutePanel } from './components/RoutePanel';
import { NavigationBar } from './components/NavigationBar';
import { routeStore } from './lib/routeStore';
import { setPlaceLabelsVisible } from './map/layers/placeLabels';
import {
  setNavigationVisibility,
  updateNavigation,
} from './map/layers/navigation';

const DEFAULT_LAYERS: LayerState = {
  overlays: ['seamark'],
  // Vaikimisi nooled + tuulevälja gradient: nool annab suuna, väli kiiruse.
  // Koos loevad nad end ühe pilguga, kumbki eraldi mitte.
  windDisplay: 'arrows',
  scalarField: 'wind_speed',
  stations: true,
  vessels: true,
  harbours: true,
  anchorages: false,
  placeLabels: true,
  navigationWarnings: true,
  navigationAids: true,
  wrecks: false,
  officialNavigation: false,
};

const EMPTY_NAVIGATION: NavigationData = {
  warnings: [],
  wrecks: [],
  aids: [],
  fairways: [],
};

/**
 * Kui kaugele ette punktiprognoosi küsime.
 *
 * Mõõdetud kate: Open-Meteo ja MET Norway annavad mõlemad ~8 päeva, kusjuures
 * Open-Meteo ulatub 16 päevani. Kvoodi mõttes on kuni 2 nädalat tasuta — üle
 * selle loeb Open-Meteo ühe punkti mitmeks kutseks. 10 päeva on seega piir,
 * kus info veel midagi ütleb ja kutseid juurde ei tule; 16 päeva näitaks
 * numbreid, mis on pigem müra kui prognoos.
 */
const FORECAST_HOURS = 240;

/**
 * Kui kaugele ulatub kaardi ajaliugur.
 *
 * SIHILIKULT lühem kui punktiprognoos. Kaks põhjust: liuguri rada on ekraani
 * laiune ja 10 päeva peale venitatuna läheb üks tund paari piksli peale, mis
 * teeb täpse tunni tabamise näputööks; ja iga uus ööpäev kaardil tähendab uut
 * võrgustikupäringut, mille eest Open-Meteo punktide kaupa arvet peab.
 *
 * Punktiprognoos (graafik ja tabel) katab kogu 10 päeva — seal on ajatelg
 * keritav ja lisapäringut ei tule.
 */
const SLIDER_HOURS = 120;

/**
 * Mitu punkti serverilt küsida.
 *
 * Hoiame selle SIHILIKULT väikesena: Open-Meteo loeb iga võrgupunkti eraldi
 * API-kutseks. Kaardil nähtava tiheduse annab kliendipoolne interpoleerimine
 * (`interpolate.ts`), mitte suurem päring.
 */
function gridStepsFor(width: number): number {
  return width < 480 ? 6 : 8;
}

/** Ajaliugurile lähim kaader juba mälus olevast ööpäevast. */
function frameAt(frames: GridFrame[], time: Date): GridFrame | null {
  if (frames.length === 0) return null;
  const target = new Date(time).setMinutes(0, 0, 0);
  let best: GridFrame | null = null;
  let bestDiff = Infinity;
  for (const f of frames) {
    const diff = Math.abs(new Date(f.time).getTime() - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = f;
    }
  }
  return best;
}

/**
 * Ühe muutujakomplekti ööpäevased kaadrid.
 *
 * Kaks tarbijat, kaks eraldi kutset: tuulenooled ja valevärvi-väli. Varem oli
 * see loogika ainult tuule jaoks ja valevärvi-välja kaadrit ei tõmmanud MITTE
 * KEEGI — `fieldFrame` jäi igaveseks `null`-iks, mistõttu töötas ainus
 * valevärvi-valik, mis tuule kaadrit taaskasutas (tuulekiirus). Kõik ülejäänud
 * — lained, pilved, temperatuur, rõhk — joonistasid tühja välja.
 *
 * Tagastab koristusfunktsiooni, mille useEffect otse edasi annab.
 */
function fetchGridDay(opts: {
  bbox: [number, number, number, number];
  vars: Variable[];
  time: Date;
  model: string;
  waveModel?: string;
  onFrames(frames: GridFrame[]): void;
  onNotice(notice: { kind: 'rateLimited'; retryAfterSeconds: number } | { kind: 'error' } | null): void;
}): () => void {
  const ac = new AbortController();
  api
    .gridDay(
      {
        bbox: opts.bbox,
        steps: gridStepsFor(window.innerWidth),
        vars: opts.vars,
        time: opts.time.toISOString(),
        model: opts.model === 'best_match' ? undefined : opts.model,
        waveModel: opts.waveModel,
      },
      ac.signal,
    )
    .then((res) => {
      opts.onFrames(res.frames);
      opts.onNotice(
        res.warning?.kind === 'rate_limited'
          ? { kind: 'rateLimited', retryAfterSeconds: res.warning.retryAfterSeconds }
          : res.warning?.kind === 'error'
            ? { kind: 'error' }
            : null,
      );
    })
    .catch((err: unknown) => {
      if (ac.signal.aborted) return;
      // Ainult kaardikiht kadus; punktiprognoos ja jaamad töötavad edasi.
      // Aga kasutaja peab teadma, MIKS kiht seisma jäi.
      opts.onNotice(
        err instanceof RateLimitedError
          ? { kind: 'rateLimited', retryAfterSeconds: err.retryAfterSeconds }
          : { kind: 'error' },
      );
    });
  return () => ac.abort();
}

const WIND_VARS: Variable[] = ['wind_speed', 'wind_dir', 'wind_gust'];
/** Stabiilne viide, et tühi valik ei käivitaks efekti iga renderi peale. */
const EMPTY_VARS: Variable[] = [];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Milliseid ööpäevi korraga mälus hoiame, valitud päeva suhtes.
 *
 * Esimene katse oli [0, +1] ehk praegune ja järgmine. See tegi ÜHE
 * ööpäevapiiri sujuvaks, aga liugurit järjest edasi sikutades jõudsid kohe
 * uuesti akna serva: hetkel, mil ületasid esimese piiri, alles hakati
 * ülejärgmist tõmbama, ja kiire lohistamise juures jõudsid sinna enne andmeid.
 *
 * Liikuv aken tähendab, et valitud hetke ümber on ALATI ööpäev igas suunas,
 * mitte ainult ühes. Hind on kolm ööpäeva ühe asemel, aga paanide vahemälu
 * teeb korduvad tõmbed tasuta ja aken nihkub ühe päeva kaupa, mitte tervikuna.
 */
const DAY_OFFSETS = [-1, 0, 1];

/**
 * Mitu ööpäevakomplekti vahemälus hoiame.
 *
 * Kolm on korraga vaja (DAY_OFFSETS); ülejäänu on ajalugu, mis teeb
 * tagasi-panimise ja päeva vahetamise hetkeliseks. Kaks korda rohkem on
 * piisavalt, et tavaline edasi-tagasi liikumine mahuks, ja piisavalt vähe,
 * et mälu ei kasvaks piiramatult.
 */
const CACHE_LIMIT = 6;

/**
 * Küsitav ala, ruudustikule kleebitult.
 *
 * Kaardi enda bbox muutub iga piksli nihkega. Kui teha sellest otse päringu
 * võti, on iga liigutus uus võti, uus päring ja uus tühimik andmetes — see
 * oli panimise vilkumise teine pool. Server kleebib ala niikuinii oma
 * ruudustikule ja tagastab väikese nihke peale sama sisu, seega teeme sama
 * juba siin.
 *
 * Samm sõltub ala suurusest (mitte suumitasemest otse), et käitumine oleks
 * ühesugune nii Läänemere ülevaates kui ühe lahe suuruses vaates. Lisaks
 * laiendame ala ~20% üle ekraani serva: nii jääb äsja nähtavale tulnud riba
 * juba tõmmatud andmete sisse.
 */
function snapBbox(
  bbox: [number, number, number, number],
): [number, number, number, number] {
  const [s, w, n, e] = bbox;
  const padLat = (n - s) * 0.2;
  const padLon = (e - w) * 0.2;
  const q = (span: number): number =>
    Math.max(0.05, 2 ** Math.round(Math.log2(Math.max(span, 0.001) / 8)));
  const qLat = q(n - s);
  const qLon = q(e - w);
  return [
    Math.floor((s - padLat) / qLat) * qLat,
    Math.floor((w - padLon) / qLon) * qLon,
    Math.ceil((n + padLat) / qLat) * qLat,
    Math.ceil((e + padLon) / qLon) * qLon,
  ];
}

/**
 * Kaardikihi kaadrid ööpäevade kaupa, JÄRGMINE ÖÖPÄEV ETTE TÕMMATUD.
 *
 * Terve ööpäev ühe päringuga tähendas juba seda, et tunni vahetamine liuguril
 * on mäluvalik, mitte võrgupäring. Aga ööpäeva PIIRIL algas kõik otsast: kell
 * 23-lt 00-le liikudes polnud järgmise päeva kaadreid kuskilt võtta ja väli
 * jäi hetkeks seisma, täpselt nagu vanasti iga tunni peal.
 *
 * Nüüd hoiame korraga kahte ööpäeva — valitut ja järgmist. Ülemineku hetkel on
 * andmed juba mälus ja päev vahetub sama sujuvalt kui tund. Kui kasutaja siis
 * edasi liigub, saab endisest "järgmisest" praegune ja ette tõmmatakse
 * ülejärgmine.
 *
 * Vahemälu on `ref`-is, mitte olekus: võti sisaldab ala, mudelit ja muutujaid,
 * seega vana vaate kaadrid ei saa kogemata uue peal kasutusse minna, ja
 * puhastamine ei tohi vallandada uut renderit keset tõmbamist. Renderi äratab
 * `bump`.
 */
function useGridDays(params: {
  bbox: [number, number, number, number] | null;
  vars: Variable[];
  time: Date;
  model: string;
  waveModel?: string;
  onNotice(notice: { kind: 'rateLimited'; retryAfterSeconds: number } | { kind: 'error' } | null): void;
}): GridFrame[] {
  const { bbox, vars, time, model, waveModel, onNotice } = params;
  const cache = useRef(new Map<string, GridFrame[]>());
  const [tick, bump] = useReducer((n: number) => n + 1, 0);

  const varsKey = vars.join(',');
  const bboxKey = bbox ? bbox.map((n) => n.toFixed(3)).join(',') : '';
  const dayKey = time.toISOString().slice(0, 10);
  const timeRef = useRef(time);
  timeRef.current = time;

  /**
   * Soovitud võtmed arvutame RENDERIS, mitte ainult efektis: tagastus peab
   * teadma, millised kaadrid on praegu õiged, ja millised on vana vaate omad,
   * mida hoiame ainult seni, kuni asendus kohale jõuab.
   */
  const wanted = useMemo(() => {
    const base = timeRef.current.getTime();
    return DAY_OFFSETS.map(
      (d) =>
        `${bboxKey}|${model}|${waveModel ?? '-'}|${varsKey}|${new Date(base + d * DAY_MS)
          .toISOString()
          .slice(0, 10)}`,
    );
    // `time` asemel `dayKey`: täpne tund ei tohi võtmeid ümber arvutada.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bboxKey, model, waveModel, varsKey, dayKey]);

  const wantedKey = wanted.join(';');
  const lastGood = useRef<GridFrame[]>([]);

  useEffect(() => {
    if (!bbox || vars.length === 0) {
      if (cache.current.size > 0) {
        cache.current.clear();
        lastGood.current = [];
        bump();
      }
      return;
    }

    const base = timeRef.current.getTime();
    const days = DAY_OFFSETS.map((d) => new Date(base + d * DAY_MS));

    const cancels: Array<() => void> = [];
    days.forEach((d, i) => {
      const key = wanted[i]!;
      if (cache.current.has(key)) return;
      cancels.push(
        fetchGridDay({
          bbox,
          vars,
          time: d,
          model,
          waveModel,
          onFrames: (frames) => {
            cache.current.set(key, frames);
            /**
             * Koristame ALLES NÜÜD, kui asendus on käes.
             *
             * Varem käis puhastus efekti alguses ja see oligi panimise
             * vilkumise põhjus: vana ala kaadrid kustutati kohe, `bump()`
             * renderdas tühja komplektiga, kihiefektid said `null`-i ja
             * peitsid nooled ning valevärvi-välja ära, kuni võrk vastas.
             * Ekraanil paistis see nii, nagu kaart laadiks end iga nihke
             * peale uuesti.
             *
             * Ülempiir hoiab mälu paigas ka siis, kui kasutaja mööda kaarti
             * ringi rändab: alles jäävad soovitud võtmed ja natuke ajalugu
             * (tagasi-panimine on tavaline), ülejäänu läheb vanuse järjekorras.
             */
            for (const stale of [...cache.current.keys()]) {
              if (cache.current.size <= CACHE_LIMIT) break;
              if (!wanted.includes(stale)) cache.current.delete(stale);
            }
            bump();
          },
          // Eelhaare EI TOHI teadet muuta. Muidu ütleks rakendus "limiit täis"
          // olukorras, kus nähtav päev on tegelikult ilusti ekraanil ja ainult
          // ülehomme jäi tõmbamata.
          onNotice: days[i]!.toISOString().slice(0, 10) === dayKey ? onNotice : () => {},
        }),
      );
    });
    return () => cancels.forEach((c) => c());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantedKey, onNotice]);

  return useMemo(() => {
    const out: GridFrame[] = [];
    for (const key of wanted) {
      const frames = cache.current.get(key);
      if (frames) out.push(...frames);
    }
    // Kuni uuest alast ei ole veel ÜHTKI kaadrit, jääb ekraanile eelmine
    // pilt. Vale ala kaader on hetkeks vähem vale kui tühi kaart — nihe on
    // väike (vt snapBbox) ja alternatiiv on kihi kadumine.
    if (out.length === 0) return lastGood.current;
    lastGood.current = out;
    return out;
    // `tick` on siin ainus päris sõltuvus — vahemälu ise on ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, wantedKey]);
}

const makeId = (): string => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;

function newRoute(): Route {
  const now = new Date().toISOString();
  return {
    id: makeId(), name: 'Uus marsruut', waypoints: [], startTime: now,
    speedKnots: 6, draughtM: 1.2, underKeelClearanceM: 0.5, fuelLitresPerHour: 5,
    createdAt: now, updatedAt: now,
  };
}

export function App() {
  const [lang, setLangState] = useState<Lang>(detectLang);
  const t = useMemo(() => makeTranslate(lang), [lang]);
  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    saveLang(next);
    document.documentElement.lang = next;
  }, []);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const [config, setConfig] = useState<AppConfig | null>(null);
  const [providers, setProviders] = useState<ProviderCapabilities[]>([]);
  const [activeProviders, setActiveProviders] = useState<string[]>([]);
  const [activeModel, setActiveModel] = useState('best_match');
  // Lainemudel on eraldi olek, mitte `activeModel` osa: mere-API-l on oma
  // mudelinimed ja atmosfäärimudeli ID sinna saates tuleb 200 täis nulle ehk
  // tühi kiht. Vaikeväärtuse annab server (EWAM) — 'best_match' siin
  // tähendaks, et me kirjutaksime selle valiku üle.
  const [activeWaveModel, setActiveWaveModel] = useState<string | undefined>(undefined);

  const [layers, setLayers] = useState<LayerState>(() => loadLayerState(DEFAULT_LAYERS));
  const [panelOpen, setPanelOpen] = useState(false);
  const [routeOpen, setRouteOpen] = useState(false);
  const [route, setRoute] = useState<Route>(newRoute);
  const [savedRoutes, setSavedRoutes] = useState<Route[]>([]);
  const [routeEditing, setRouteEditing] = useState(false);
  const [routeAnalysis, setRouteAnalysis] = useState<RouteAnalysis | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [undoRoutes, setUndoRoutes] = useState<RouteWaypoint[][]>([]);
  const [redoRoutes, setRedoRoutes] = useState<RouteWaypoint[][]>([]);
  const editStart = useRef<Route | null>(null);
  const [speedUnit, setSpeedUnit] = useState<SpeedUnit>(loadSpeedUnit);
  const { theme, setTheme } = useTheme();

  const [selectedTime, setSelectedTime] = useState<Date>(() => floorToHour());
  const [radarTimeline, setRadarTimeline] = useState<RadarTimeline | null>(null);

  // GetCapabilities XML on suur; iga brauser ei tõmba seda otse. SeaPro
  // server parsib ja cache'ib ajad ning klient värskendab neid kord minutis
  // ainult siis, kui radar on päriselt sisse lülitatud.
  useEffect(() => {
    if (!layers.overlays.includes('radar')) return;
    let active = true;
    const load = (): void => {
      api.radarTimes().then(
        (timeline) => { if (active) setRadarTimeline(timeline); },
        () => { /* NÜÜD-kaader töötab WMS-i vaikeajaga edasi. */ },
      );
    };
    load();
    const interval = window.setInterval(load, 60_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [layers.overlays]);

  const radarFrame = useMemo(
    () => radarFrameAt(selectedTime, radarTimeline),
    [selectedTime, radarTimeline],
  );

  useEffect(() => {
    saveLayerState(layers);
  }, [layers]);

  useEffect(() => {
    routeStore.listRoutes().then((items) => setSavedRoutes(items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))).catch(() => {});
  }, []);

  useEffect(() => {
    if (routeEditing || route.waypoints.length < 2) { setRouteAnalysis(null); return; }
    const ac = new AbortController();
    const timer = window.setTimeout(() => {
      setRouteLoading(true); setRouteError(null);
      api.routeAnalysis({
        waypoints: route.waypoints, startTime: route.startTime, speedKnots: route.speedKnots,
        draughtM: route.draughtM, underKeelClearanceM: route.underKeelClearanceM,
        fuelLitresPerHour: route.fuelLitresPerHour,
        model: activeModel === 'best_match' ? undefined : activeModel, waveModel: activeWaveModel,
      }, ac.signal).then(setRouteAnalysis).catch((err: unknown) => {
        if (!ac.signal.aborted) setRouteError(err instanceof Error ? err.message : t('error.generic'));
      }).finally(() => { if (!ac.signal.aborted) setRouteLoading(false); });
    }, 500);
    return () => { window.clearTimeout(timer); ac.abort(); };
  }, [route, routeEditing, activeModel, activeWaveModel, t]);

  useEffect(() => {
    if (routeEditing || route.waypoints.length < 2) return;
    const timer = window.setTimeout(() => {
      routeStore.saveRoute(route).then(() => routeStore.listRoutes()).then((items) => setSavedRoutes(items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))).catch(() => {});
    }, 700);
    return () => window.clearTimeout(timer);
  }, [route, routeEditing]);

  /**
   * Andmepäringute jaoks viivitatud aeg.
   *
   * Liuguri lohistamine tekitab kümneid ajamuutusi sekundis. Ilma viivituseta
   * käivitas iga samm kohe võrgupäringu ja iga vastus (või 503) uue
   * seisumuutuse — kontrollitud liugur jäi selle laviini alla ja tõmbles.
   * Kuvatav aeg jääb hetkeliseks, ainult ANDMED ootavad, kuni lohistamine
   * peatub.
   */
  const [dataTime, setDataTime] = useState<Date>(selectedTime);
  useEffect(() => {
    const id = window.setTimeout(() => setDataTime(selectedTime), 250);
    return () => window.clearTimeout(id);
  }, [selectedTime]);
  const [picked, setPicked] = useState<{ lat: number; lon: number } | null>(null);
  /** Kas punktipaneel on täies mahus lahti — vt handlePick ja .mapctl. */
  const [sheetExpanded, setSheetExpanded] = useState(false);
  const [pointResult, setPointResult] = useState<PointResult | null>(null);
  const [pointLoading, setPointLoading] = useState(false);
  const [pointError, setPointError] = useState<string | null>(null);

  const [view, setView] = useState<{ bbox: [number, number, number, number]; zoom: number } | null>(
    null,
  );

  /**
   * Andmete jaoks küsitav ala on ruudustikule kleebitud, kuvamise jaoks
   * kasutame endiselt päris vaadet. Nii ei tekita väike nihe uut päringut
   * (ja seega ka mitte tühimikku), aga nooletihedus ja laevade päring
   * käivad täpselt selle järgi, mida ekraanil näha on.
   */
  const lastDataBbox = useRef<[number, number, number, number] | null>(null);
  const dataBbox = useMemo(() => {
    if (!view) return null;
    /**
     * Ruudustik üksi ei piisa: kui vaate serv juhtub olema ruudu piiri peal,
     * hüppab võti iga väikese nihkega edasi-tagasi. Seetõttu hoiame eelmist
     * ala nii kaua, kui see uut vaadet veel katab — ja vahetame alles siis,
     * kui vaade sellest välja jookseb või läheb nii väikeseks, et vana
     * ruudustik oleks liiga jäme (suumimine).
     */
    const prev = lastDataBbox.current;
    const [s, w, n, e] = view.bbox;
    if (
      prev &&
      prev[0] <= s &&
      prev[1] <= w &&
      prev[2] >= n &&
      prev[3] >= e &&
      prev[2] - prev[0] <= (n - s) * 3
    ) {
      return prev;
    }
    const next = snapBbox(view.bbox);
    lastDataBbox.current = next;
    return next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.bbox.join(',')]);

  /**
   * Kaardikihi seisund, kui andmed EI tule. Varem neelasime need vead vaikselt
   * alla ja kasutaja jaoks näis, nagu rakendus lihtsalt lakkaks uuenemast —
   * ilma ühegi vihjeta, kas asi on võrgus, allikas või meis.
   */
  const [layerNotice, setLayerNotice] = useState<
    { kind: 'rateLimited'; retryAfterSeconds: number } | { kind: 'error' } | null
  >(null);

  const geo = useGeolocation();
  const favorites = useFavorites();
  const mapRef = useRef<MapLibreMap | null>(null);
  // Ref üksi ei käivita renderdust, seega kihtide efektid jääksid kaardi
  // valmimist ootama igavesti. See lipp äratab nad üles.
  const [mapReady, setMapReady] = useState(false);
  const [navigationActive, setNavigationActive] = useState(false);
  const [nextWaypointIndex, setNextWaypointIndex] = useState(1);
  const [followingPosition, setFollowingPosition] = useState(true);
  const [recordTrack, setRecordTrack] = useState(false);
  const [trackPoints, setTrackPoints] = useState<TrackPoint[]>([]);
  const [offRouteWarning, setOffRouteWarning] = useState(false);
  const offRouteSince = useRef<number | null>(null);
  const navigationStartedAt = useRef<number>(0);

  const startNavigation = useCallback(() => {
    if (route.waypoints.length < 2) return;
    setNavigationActive(true); setNextWaypointIndex(1); setFollowingPosition(true);
    setTrackPoints([]); setRecordTrack(false); setOffRouteWarning(false);
    navigationStartedAt.current = Date.now(); setRouteOpen(false); setRouteEditing(false);
    geo.startWatch();
  }, [route.waypoints.length, geo.startWatch]);

  const stopNavigation = useCallback(() => {
    geo.stopWatch(); setNavigationActive(false); setOffRouteWarning(false);
    if (recordTrack && trackPoints.length > 1 && window.confirm(t('nav.saveTrack'))) {
      const ended = new Date().toISOString();
      const durationSeconds = Math.max(0, (Date.now() - navigationStartedAt.current) / 1000);
      const distanceNm = routeDistanceNm(trackPoints);
      const track: Track = {
        id: makeId(), name: `${route.name} · ${new Date().toLocaleDateString()}`, providerId: 'device-gps',
        startedAt: new Date(navigationStartedAt.current).toISOString(), endedAt: ended,
        distance: distanceNm * 1852, durationSeconds,
        averageSpeedKnots: durationSeconds ? distanceNm / durationSeconds * 3600 : 0,
        estimatedFuelLitres: durationSeconds / 3600 * route.fuelLitresPerHour,
        points: trackPoints,
      };
      routeStore.saveTrack(track).catch(() => {});
    }
    setRecordTrack(false);
  }, [geo.stopWatch, recordTrack, trackPoints, route.name, route.fuelLitresPerHour, t]);

  useEffect(() => {
    if (!navigationActive || !geo.position || route.waypoints.length < 2) return;
    const position = geo.position;
    const target = route.waypoints[nextWaypointIndex];
    const previous = route.waypoints[Math.max(0, nextWaypointIndex - 1)]!;
    if (target && (distanceMetres(position, target) <= 50 || segmentProgress(position, previous, target) >= 1) && nextWaypointIndex < route.waypoints.length - 1) {
      setNextWaypointIndex((index) => Math.min(route.waypoints.length - 1, index + 1));
    }
    if (followingPosition) mapRef.current?.easeTo({ center: [position.lon, position.lat], duration: 500 });
    const a = route.waypoints[Math.max(0, nextWaypointIndex - 1)]!;
    const b = route.waypoints[Math.min(nextWaypointIndex, route.waypoints.length - 1)]!;
    const crossTrack = crossTrackDistanceMetres(position, a, b);
    const limit = Math.max(100, position.accuracy * 2);
    if (crossTrack > limit) {
      offRouteSince.current ??= Date.now();
      if (Date.now() - offRouteSince.current >= 15_000) setOffRouteWarning(true);
    } else { offRouteSince.current = null; setOffRouteWarning(false); }
    if (recordTrack) setTrackPoints((current) => {
      const last = current.at(-1);
      if (last) {
        const elapsed = (position.timestamp - new Date(last.time ?? 0).getTime()) / 1000;
        const moved = distanceMetres(last, position);
        if (elapsed < 5 && moved < 10) return current;
        if (elapsed > 0 && moved / elapsed > 51.45) return current; // >100 kn GPS-hüpe
      }
      return [...current, { lat: position.lat, lon: position.lon, time: new Date(position.timestamp).toISOString(), speed: position.speed == null ? undefined : position.speed * 1.943844, course: position.heading ?? undefined }];
    });
  }, [navigationActive, geo.position, route.waypoints, nextWaypointIndex, followingPosition, recordTrack]);

  useEffect(() => {
    if (!navigationActive || !('wakeLock' in navigator)) return;
    let sentinel: { release(): Promise<void> } | null = null;
    (navigator as Navigator & { wakeLock: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock.request('screen').then((value) => { sentinel = value; }).catch(() => {});
    return () => { void sentinel?.release(); };
  }, [navigationActive]);

  const navMetrics = useMemo(() => {
    const pos = geo.position; const target = route.waypoints[nextWaypointIndex];
    if (!pos || !target) return { distance: 0, bearing: 0, crossTrack: 0, remaining: 0, eta: null as string | null };
    const a = route.waypoints[Math.max(0, nextWaypointIndex - 1)]!;
    const remaining = distanceMetres(pos, target) / 1852 + routeDistanceNm(route.waypoints.slice(nextWaypointIndex));
    const speedKnots = pos.speed && pos.speed > 0.25 ? pos.speed * 1.943844 : route.speedKnots;
    return {
      distance: distanceMetres(pos, target), bearing: bearingDegrees(pos, target),
      crossTrack: crossTrackDistanceMetres(pos, a, target), remaining,
      eta: speedKnots > 0 ? new Date(Date.now() + remaining / speedKnots * 3_600_000).toISOString() : null,
    };
  }, [geo.position, route.waypoints, route.speedKnots, nextWaypointIndex]);

  const changeSpeedUnit = useCallback((u: SpeedUnit) => {
    setSpeedUnit(u);
    saveSpeedUnit(u);
  }, []);

  // --- Algseadistus -------------------------------------------------------
  useEffect(() => {
    const ac = new AbortController();
    Promise.all([api.config(ac.signal), api.providers(ac.signal)])
      .then(([cfg, provs]) => {
        setConfig(cfg);
        setProviders(provs);
        setActiveProviders(provs.filter((p) => p.enabled).map((p) => p.id));
      })
      .catch(() => {
        // Offline käivitus: service worker annab vahemälust, mis tal on.
        // Kui sedagi pole, jääb kaart tööle ilma andmekihtideta.
      });
    return () => ac.abort();
  }, []);

  // --- Kaardikihi andmed (tuul + valevärvi-väli) --------------------------
  // Nii nooled kui animatsioon toituvad samast võrgustikupäringust.
  const fieldVar: Variable | null = layers.scalarField;
  // Tuulekaadrit on vaja ka siis, kui nooled on väljas, aga valevärvi-väli
  // näitab tuulekiirust — muidu jääks väli tühjaks just selles kombinatsioonis.
  const needWind = layers.windDisplay !== 'off' || fieldVar === 'wind_speed';

  const dayFrames = useGridDays({
    bbox: dataBbox,
    vars: needWind ? WIND_VARS : EMPTY_VARS,
    // `selectedTime`, mitte viivitatud `dataTime`: aken peab nihkuma juba
    // hetkel, kui liugur uude ööpäeva jõuab, mitte 250 ms pärast lohistamise
    // lõppu. Efekt käivitub ainult ööpäeva vahetusel, seega hetkeline aeg ei
    // maksa siin midagi.
    time: selectedTime,
    model: activeModel,
    onNotice: setLayerNotice,
  });

  /**
   * Valevärvi-välja oma ööpäevad.
   *
   * Miks eraldi päring, mitte sama mis tuulel: lained, hoovused ja veetase
   * tulevad Open-Meteo MERE-API-st, tuul ja õhk tavalisest. Server valib API
   * selle järgi, kas KÕIK küsitud muutujad on merelised, seega üks segapäring
   * kukuks õhu-API peale ja lainevälja ei tuleks üldse.
   *
   * Tuulekiirust siin ei küsita — see tuleb juba noolte kaadrist ja teine
   * päring maksaks sama palju kutseid identsete andmete eest.
   */
  const fieldVars = useMemo(
    () => (fieldVar && fieldVar !== 'wind_speed' ? [fieldVar] : EMPTY_VARS),
    [fieldVar],
  );
  /**
   * Valevärvi-välja mudel.
   *
   * Lainevälja puhul EI tohi atmosfäärimudel kaasa minna: mere-API vastab
   * `models=icon_eu` peale 200-ga, aga iga väärtus on null — kiht kaoks
   * ekraanilt ilma ühegi veateateta. Saadame selle asemel lainemudeli ja
   * jätame `model` automaatseks.
   */
  const fieldIsWave = fieldVar !== null && isWaveVariable(fieldVar);
  const fieldDayFrames = useGridDays({
    bbox: dataBbox,
    vars: fieldVars,
    time: selectedTime,
    model: fieldIsWave ? 'best_match' : activeModel,
    waveModel: fieldIsWave ? activeWaveModel : undefined,
    onNotice: setLayerNotice,
  });

  /** Valitud tunni kaader mälust. Kerimine ei puuduta võrku. */
  const gridFrame = useMemo(() => frameAt(dayFrames, selectedTime), [dayFrames, selectedTime]);
  const fieldFrame = useMemo(
    () => frameAt(fieldDayFrames, selectedTime),
    [fieldDayFrames, selectedTime],
  );

  // Interpoleeritud tuuleväli — sellest toituvad nii nooled kui osakesed.
  const windField: Field | null = useMemo(() => buildWindField(gridFrame), [gridFrame]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    if (layers.windDisplay === 'arrows' && windField) {
      const container = map.getContainer();
      updateWindArrows(map, windField, {
        bbox: view?.bbox ?? [0, 0, 0, 0],
        width: container.clientWidth,
        height: container.clientHeight,
        fieldVariable: fieldVar,
      });
    } else {
      hideWindArrows(map);
    }
  }, [windField, layers.windDisplay, mapReady, view, fieldVar]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    // Tuulekiiruse väli tuleb noolte kaadrist; muud väljad oma päringust.
    const frame = fieldVar === 'wind_speed' ? gridFrame : fieldFrame;
    if (fieldVar) updateScalarField(map, frame, fieldVar);
    else hideScalarField(map);

    // Värviline OSM ja värviline väli võitleksid teineteisega — tuhmistame
    // aluskaardi, kui väli on peal. Merekaart ja märgid jäävad puutumata,
    // sest nende värv kannab tähendust.
    setBasemapMuted(map, fieldVar !== null);
  }, [fieldFrame, gridFrame, fieldVar, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    setPlaceLabelsVisible(map, layers.placeLabels);
  }, [layers.placeLabels, mapReady]);

  // --- Animeeritud tuulevoog ----------------------------------------------
  const particlesRef = useRef<WindParticleLayer | null>(null);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    particlesRef.current = new WindParticleLayer(map);
    return () => {
      particlesRef.current?.destroy();
      particlesRef.current = null;
    };
  }, [mapReady]);

  useEffect(() => {
    const layer = particlesRef.current;
    if (!layer) return;
    layer.setField(windField);
    if (layers.windDisplay === 'animated' && windField) layer.start();
    else layer.stop();
    // `mapReady` on sõltuvustes sihilikult: kiht luuakse alles kaardi
    // valmimisel ja ilma selleta jääks juba saabunud väli talle edastamata
    // kuni järgmise andmemuutuseni.
  }, [windField, layers.windDisplay, mapReady]);

  // --- Mõõtejaamad ja poid -------------------------------------------------
  const [stations, setStations] = useState<StationReading[]>([]);

  useEffect(() => {
    if (!layers.stations) return;

    let cancelled = false;
    const load = (): void => {
      api
        .stations()
        .then((res) => {
          if (!cancelled) setStations(res.stations);
        })
        .catch(() => {
          // Jaamad kadusid; prognoos ja kaart töötavad edasi.
        });
    };

    load();
    // Jaamad mõõdavad 10-minutilise sammuga; tihedam küsimine ei annaks
    // uut infot, aga koormaks nii meie serverit kui allikaid.
    const timer = window.setInterval(load, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [layers.stations]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    if (layers.stations && stations.length > 0) {
      updateStations(map, stations, {
        // Number markeri kõrval järgib valitud värvivälja: kui vaatad laineid,
        // tahad jaamadelt lainekõrgust, mitte tuult.
        labelVariable: layers.scalarField === 'wave_height' ? 'wave_height' : 'wind_speed',
        speedUnit,
      });
    } else {
      setStationsVisible(map, false);
    }
  }, [stations, layers.stations, layers.scalarField, speedUnit, mapReady]);

  // --- Sadamad -------------------------------------------------------------
  const [harbours, setHarbours] = useState<Harbour[]>([]);

  // Sadamad ja ankrukohad tulevad ÜHEST päringust (vt server: overpass.ts),
  // seega piisab sellest, kui kas või üks kiht on sees.
  const wantPlaces = layers.harbours || layers.anchorages;

  useEffect(() => {
    if (!wantPlaces || !view) return;

    const ac = new AbortController();
    api
      .harbours(view.bbox, ac.signal)
      .then((res) => setHarbours(res.harbours))
      .catch(() => {
        // Overpass on koormatud ja vastab aeg-ajalt 504-ga. Sadamad ei liigu,
        // seega vana nimekiri jääb ekraanile ja miski muu ei katke.
      });
    return () => ac.abort();
    // Sõltub AINULT bbox'ist, mitte ajast: sadamad ei muutu tundide kaupa.
  }, [wantPlaces, view?.bbox.join(',')]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    if (wantPlaces && harbours.length > 0) updateHarbours(map, harbours);
    // Nähtavus käib kihtide kaupa: sama allikas, kaks eraldi lülitit.
    setHarboursVisible(map, layers.harbours && harbours.length > 0);
    setAnchoragesVisible(map, layers.anchorages && harbours.length > 0);
  }, [harbours, wantPlaces, layers.harbours, layers.anchorages, mapReady]);

  // --- Navigatsiooniohutus -------------------------------------------------
  const [navigationData, setNavigationData] = useState<NavigationData>(EMPTY_NAVIGATION);
  const wantNavigation =
    layers.navigationWarnings ||
    layers.navigationAids ||
    layers.wrecks ||
    layers.officialNavigation;

  useEffect(() => {
    if (!wantNavigation || !view) return;
    let cancelled = false;

    const include: Array<'warnings' | 'aids' | 'wrecks' | 'official'> = [];
    if (layers.navigationWarnings) include.push('warnings');
    if (layers.navigationAids) include.push('aids');
    if (layers.wrecks) include.push('wrecks');
    if (layers.officialNavigation) include.push('official');

    const load = (): void => {
      api.navigation(view.bbox, include).then((data) => {
        if (!cancelled) setNavigationData(data);
      }).catch(() => {
        // Staatilised kihid on serveris kettavahemälus ja vana edukas
        // vastus jääb ekraanile; üks allikatõrge ei kustuta ohutusinfot.
      });
    };

    load();
    // AIS AToN on reaalajas. Staatilised ArcGIS-kihid tulevad sama päringuga
    // vahemälust, seega 30 s klientpoll ei koorma nende algallikat.
    const timer = window.setInterval(load, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    wantNavigation,
    layers.navigationWarnings,
    layers.navigationAids,
    layers.wrecks,
    layers.officialNavigation,
    view?.bbox.join(','),
  ]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    if (wantNavigation) updateNavigation(map, navigationData);
    setNavigationVisibility(map, {
      warnings: layers.navigationWarnings,
      aids: layers.navigationAids,
      wrecks: layers.wrecks,
      official: layers.officialNavigation,
    });
  }, [navigationData, wantNavigation, layers.navigationWarnings, layers.navigationAids, layers.wrecks, layers.officialNavigation, mapReady]);

  // --- Laevad (AIS) --------------------------------------------------------
  const [vessels, setVessels] = useState<Vessel[]>([]);

  useEffect(() => {
    if (!layers.vessels || !view) {
      setVessels([]);
      return;
    }

    let cancelled = false;
    const load = (): void => {
      api
        .vessels(view.bbox)
        .then((res) => {
          if (!cancelled) setVessels(res.vessels);
        })
        .catch(() => {
          // AIS kadus; ilmakihid töötavad edasi.
        });
    };

    load();
    // Laevad liiguvad; 30 s vastab serveri Digitraffici pollimise sammule,
    // tihedam küsimine annaks sama vastuse.
    const timer = window.setInterval(load, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [layers.vessels, view]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    if (layers.vessels && vessels.length > 0) {
      // Kere või ikoon otsustatakse zoomi järgi, seega kiht tuleb uuesti
      // ehitada ka pärast suumimist, mitte ainult uute andmete saabudes.
      updateVessels(map, vessels, view?.zoom ?? map.getZoom());
    } else {
      setVesselsVisible(map, false);
      closePopup();
    }
  }, [vessels, layers.vessels, mapReady, view]);

  // --- Punktiprognoos ------------------------------------------------------
  useEffect(() => {
    if (!picked) return;
    const ac = new AbortController();
    setPointLoading(true);
    setPointError(null);
    api
      .point(
        {
          lat: picked.lat,
          lon: picked.lon,
          hours: FORECAST_HOURS,
          providers: activeProviders.length ? activeProviders : undefined,
          models: activeModel === 'best_match' ? undefined : [activeModel],
          // Graafiku laineread peavad tulema samast mudelist mis kaardikiht,
          // muidu näitaks popup ja kaart sama koha kohta eri arve.
          waveModel: activeWaveModel,
        },
        ac.signal,
      )
      .then(setPointResult)
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        setPointError(err instanceof Error ? err.message : t('error.generic'));
      })
      .finally(() => {
        if (!ac.signal.aborted) setPointLoading(false);
      });
    return () => ac.abort();
  }, [picked, activeProviders, activeModel, activeWaveModel, t]);

  /**
   * Klikk tühjal merel.
   *
   * Valib ALATI uue punkti, ka siis kui riba on juba lahti. Vahepeal sulges
   * teine klikk paneeli — see oli mõistlik seni, kuni paneel kattis pool
   * ekraanist ja sellest oli vaja pääseda. Kokkupandud riba on aga nii madal,
   * et ta ei sega, ja siis on uue punkti vaatamine palju sagedasem soov kui
   * sulgemine. Sulgemiseks on ribal oma rist.
   */
  const commitWaypoints = useCallback((waypoints: RouteWaypoint[]) => {
    setUndoRoutes((items) => [...items.slice(-49), route.waypoints]); setRedoRoutes([]);
    setRoute((current) => ({ ...current, waypoints, updatedAt: new Date().toISOString() }));
  }, [route.waypoints]);

  const handlePick = useCallback((lat: number, lon: number) => {
    if (routeEditing) {
      commitWaypoints([...route.waypoints, { id: makeId(), lat, lon }]);
      return;
    }
    setPicked({ lat, lon });
    setSheetExpanded(false); // Uus punkt algab alati ribast.
    setPointResult(null);
  }, [routeEditing, route.waypoints, commitWaypoints]);

  const moveRouteWaypoint = useCallback((index: number, lat: number, lon: number) => {
    setRoute((current) => ({ ...current, updatedAt: new Date().toISOString(), waypoints: current.waypoints.map((p, i) => i === index ? { ...p, lat, lon } : p) }));
  }, []);

  const insertRouteWaypoint = useCallback((index: number, lat: number, lon: number) => {
    const next = [...route.waypoints]; next.splice(index, 0, { id: makeId(), lat, lon }); commitWaypoints(next);
  }, [route.waypoints, commitWaypoints]);

  // Popupid loevad ühikut ja keelt renderdamise hetkel; hoiame neid ref'is,
  // et kaardi klikikäsitlejaid ei peaks iga seadistuse muutuse peale uuesti
  // registreerima.
  const popupCtx = useRef({ t, speedUnit, lang, interactionBlocked: routeEditing });
  popupCtx.current = { t, speedUnit, lang, interactionBlocked: routeEditing };

  useEffect(() => {
    if (routeEditing) closePopup();
  }, [routeEditing]);

  const handleReady = useCallback((map: MapLibreMap) => {
    mapRef.current = map;
    registerPopups(map, () => popupCtx.current);
    setMapReady(true);
  }, []);

  // Kaardi liigutamine tuleb pursetena; ilma viivituseta laseks iga
  // vahepealne kaader oma päringu. Server kleebib bbox'i niikuinii
  // ruudustikule, aga viivitus hoiab ka võrgu vaikselt.
  const moveTimer = useRef<number | null>(null);
  const handleMoveEnd = useCallback((bbox: [number, number, number, number], zoom: number) => {
    if (moveTimer.current !== null) window.clearTimeout(moveTimer.current);
    moveTimer.current = window.setTimeout(() => {
      setView({ bbox, zoom });
      // Keskpunkt tuleb kaardilt endalt — onMoveEnd annab ainult ala ja zoomi.
      // Salvestus käib sama viivituse sees, et lohistamine ei kirjutaks
      // localStorage'i iga kaadri kohta.
      const c = mapRef.current?.getCenter();
      if (c) saveMapView({ lat: c.lat, lon: c.lng, zoom });
    }, 350);
  }, []);
  useEffect(() => {
    return () => {
      if (moveTimer.current !== null) window.clearTimeout(moveTimer.current);
    };
  }, []);

  const goTo = useCallback((lat: number, lon: number, zoom = 11) => {
    mapRef.current?.easeTo({ center: [lon, lat], zoom });
  }, []);

  const i18nValue = useMemo(() => ({ lang, t, setLang }), [lang, t, setLang]);

  /*
   * Algvaade: viimane salvestatud, muidu serveri vaikeväärtus.
   *
   * Loetakse ÜHE KORRA ja hoitakse ref'is. MapView init-effekt jookseb tühjade
   * sõltuvustega ehk kasutab ainult esimese renderi väärtusi; kui see siin iga
   * renderiga ümber arvutuks, ei muudaks see midagi, aga tekitaks illusiooni,
   * et muudab.
   */
  const savedView = useRef(loadMapView()).current;
  const center: [number, number] = savedView
    ? [savedView.lat, savedView.lon]
    : [config?.defaultLat ?? 59.0, config?.defaultLon ?? 23.5];

  /**
   * Kui kaardikiht ei saanud valitud aja kohta andmeid, jääb ekraanile eelmine
   * kaader. Siin arvutame, MIS aega see kaader tegelikult näitab, et seda
   * saaks kasutajale öelda.
   */
  const staleFieldTime = useMemo(() => {
    if (!layerNotice || !gridFrame) return null;
    const shown = new Date(gridFrame.time);
    if (Number.isNaN(shown.getTime())) return null;
    const diffHours = Math.abs(shown.getTime() - selectedTime.getTime()) / 3600_000;
    if (diffHours < 1) return null;
    return formatDateTime(shown, lang);
  }, [layerNotice, gridFrame, selectedTime, lang]);

  const modelLabel = useMemo(() => {
    const models = providers.find((p) => p.id === 'open-meteo')?.models;
    return models?.find((m) => m.id === activeModel)?.label;
  }, [providers, activeModel]);

  return (
    <I18nContext.Provider value={i18nValue}>
      <div className={`app${picked ? ' has-point-forecast' : ''}`}>
        <TopBar
          onOpenLayers={() => setPanelOpen(true)}
          onOpenRoutes={() => { setRouteOpen(true); setPicked(null); }}
          geo={geo}
          favorites={favorites}
          onGoTo={goTo}
          bbox={view?.bbox}
        />

        <MapView
          center={center}
          zoom={savedView?.zoom ?? config?.defaultZoom ?? 7}
          activeOverlays={layers.overlays}
          radarFrame={radarFrame}
          ownPosition={geo.position}
          routeWaypoints={route.waypoints}
          routeSegments={routeAnalysis?.depthSegments ?? []}
          trackPoints={trackPoints}
          routeEditing={routeEditing}
          onReady={handleReady}
          onMoveEnd={handleMoveEnd}
          onPick={handlePick}
          onRouteMove={moveRouteWaypoint}
          onRouteMoveStart={() => { setUndoRoutes((items) => [...items.slice(-49), route.waypoints]); setRedoRoutes([]); }}
          onRouteInsert={insertRouteWaypoint}
          onUserMove={() => { if (navigationActive) setFollowingPosition(false); }}
        />

        {navigationActive ? <NavigationBar
          nextIndex={nextWaypointIndex}
          distanceToNextM={navMetrics.distance}
          bearing={navMetrics.bearing}
          crossTrackM={navMetrics.crossTrack}
          remainingNm={navMetrics.remaining}
          eta={navMetrics.eta}
          warning={offRouteWarning}
          following={followingPosition}
          recording={recordTrack}
          onResume={() => { setFollowingPosition(true); if (geo.position) goTo(geo.position.lat, geo.position.lon, 13); }}
          onToggleRecording={() => setRecordTrack((value) => !value)}
          onStop={stopNavigation}
        /> : null}

        {layerNotice ? (
          <div className="layer-notice" role="status">
            {layerNotice.kind === 'rateLimited'
              ? t('layer.rateLimited', {
                  min: Math.max(1, Math.ceil(layerNotice.retryAfterSeconds / 60)),
                })
              : t('layer.failed')}
            {layerNotice.kind === 'rateLimited' && gridFrame
              ? t('layer.showingCached')
              : null}
            {/* Kui kaardil on mõne muu tunni andmed, tuleb see VÄLJA ÖELDA.
                Vaikselt vale aja näitamine on mereilmakaardil ohtlikum kui
                andmete puudumine — kasutaja usub kella, mida ta näeb. */}
            {staleFieldTime ? (
              <strong> {t('layer.showingTime', { time: staleFieldTime })}</strong>
            ) : null}
          </div>
        ) : null}

        {layers.overlays.includes('radar') && radarFrame.kind !== 'observation' ? (
          <div className={`radar-time-status is-${radarFrame.kind}`} role="status">
            {radarFrame.kind === 'forecast'
              ? t('layer.radarForecast', {
                  time: radarFrame.time ? formatDateTime(radarFrame.time, lang) : '',
                })
              : t('layer.radarUnavailable')}
          </div>
        ) : null}

        <MapLegend variable={layers.scalarField} speedUnit={speedUnit} />

        {/* Kaardi nupuvirn all paremal. Punktiprognoosi paneel istub samas
            nurgas, seega virn tervikuna nihkub sellest kõrvale — muidu jääks
            mõlemad nupud paneeli alla kättesaamatuks. */}
        {/* Järjekord loeb: tingmärgid ülal, asukoht all. Tingmärkide paneel
            hõljub oma nupu kohal, seega peab see nupp olema virnas ÜLEMINE —
            muidu katab avatud paneel asukohanupu ära. Ja asukoht on niikuinii
            õigem kõige alla: seda vajutatakse ühe käega kõige sagedamini. */}
        <div
          className={`mapctl${
            picked === null ? '' : sheetExpanded ? ' is-shifted' : ' is-raised'
          }`}
        >
          <MapKey
            showVessels={layers.vessels}
            showStations={layers.stations}
            showHarbours={layers.harbours}
            showNavigationAids={layers.navigationAids || layers.officialNavigation}
            showNavigationWarnings={layers.navigationWarnings}
            showWrecks={layers.wrecks}
            showWind={layers.windDisplay !== 'off'}
          />
          <LocateButton geo={geo} onGoTo={goTo} />
        </div>

        <TimeSlider
          value={selectedTime}
          onChange={setSelectedTime}
          futureHours={SLIDER_HOURS}
          modelLabel={modelLabel}
          updatedAt={gridFrame ? gridFrame.time : null}
        />

        <LayerPanel
          open={panelOpen}
          onClose={() => setPanelOpen(false)}
          layers={layers}
          onLayersChange={setLayers}
          providers={providers}
          activeProviders={activeProviders}
          onProvidersChange={setActiveProviders}
          activeModel={activeModel}
          onModelChange={setActiveModel}
          activeWaveModel={activeWaveModel}
          onWaveModelChange={setActiveWaveModel}
          speedUnit={speedUnit}
          onSpeedUnitChange={changeSpeedUnit}
          theme={theme}
          onThemeChange={setTheme}
        />

        <RoutePanel
          open={routeOpen}
          route={route}
          savedRoutes={savedRoutes}
          analysis={routeAnalysis}
          loading={routeLoading}
          error={routeError}
          editing={routeEditing}
          canUndo={undoRoutes.length > 0}
          canRedo={redoRoutes.length > 0}
          onClose={() => { if (!routeEditing) setRouteOpen(false); }}
          onChange={setRoute}
          onNew={() => { setRoute(newRoute()); setRouteAnalysis(null); setUndoRoutes([]); setRedoRoutes([]); }}
          onLoad={(next) => { setRoute(next); setUndoRoutes([]); setRedoRoutes([]); setRouteEditing(false); }}
          onDelete={(id) => { routeStore.deleteRoute(id).then(() => routeStore.listRoutes()).then(setSavedRoutes).catch(() => {}); setRoute(newRoute()); setRouteAnalysis(null); }}
          onStartEdit={() => { editStart.current = structuredClone(route); setUndoRoutes([]); setRedoRoutes([]); setRouteEditing(true); }}
          onFinishEdit={() => { setRouteEditing(false); editStart.current = null; setRoute((current) => ({ ...current, updatedAt: new Date().toISOString() })); }}
          onCancelEdit={() => { if (editStart.current) setRoute(editStart.current); setRouteEditing(false); setUndoRoutes([]); setRedoRoutes([]); }}
          onUndo={() => setUndoRoutes((history) => { const previous = history.at(-1); if (!previous) return history; setRedoRoutes((redo) => [route.waypoints, ...redo]); setRoute((current) => ({ ...current, waypoints: previous, updatedAt: new Date().toISOString() })); return history.slice(0, -1); })}
          onRedo={() => setRedoRoutes((history) => { const next = history[0]; if (!next) return history; setUndoRoutes((undo) => [...undo, route.waypoints]); setRoute((current) => ({ ...current, waypoints: next, updatedAt: new Date().toISOString() })); return history.slice(1); })}
          onDeleteLast={() => { if (route.waypoints.length) commitWaypoints(route.waypoints.slice(0, -1)); }}
          onUseLocation={() => { if (geo.position) commitWaypoints([...route.waypoints, { id: makeId(), lat: geo.position.lat, lon: geo.position.lon }]); else geo.request((position) => commitWaypoints([...route.waypoints, { id: makeId(), lat: position.lat, lon: position.lon }])); }}
          onNavigate={startNavigation}
        />

        <PointSheet
          open={picked !== null}
          onClose={() => setPicked(null)}
          lat={picked?.lat ?? 0}
          lon={picked?.lon ?? 0}
          result={pointResult}
          loading={pointLoading}
          error={pointError}
          selectedTime={selectedTime}
          onSelectTime={setSelectedTime}
          speedUnit={speedUnit}
          expanded={sheetExpanded}
          onExpandedChange={setSheetExpanded}
          isFavorite={picked ? favorites.isFavorite(picked.lat, picked.lon) : false}
          onToggleFavorite={() => {
            if (!picked) return;
            const id = favorites.keyFor(picked.lat, picked.lon);
            if (favorites.isFavorite(picked.lat, picked.lon)) favorites.remove(id);
            else
              favorites.add(
                `${picked.lat.toFixed(2)}, ${picked.lon.toFixed(2)}`,
                picked.lat,
                picked.lon,
              );
          }}
        />
      </div>
    </I18nContext.Provider>
  );
}
