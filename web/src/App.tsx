import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type {
  GridFrame,
  PointResult,
  ProviderCapabilities,
  Harbour,
  StationReading,
  Variable,
  Vessel,
} from '@seapro/shared';
import { I18nContext, detectLang, makeTranslate, saveLang, type Lang } from './i18n';
import { RateLimitedError, api, type AppConfig } from './lib/api';
import { useGeolocation } from './lib/geolocation';
import { useFavorites } from './lib/favorites';
import { loadSpeedUnit, saveSpeedUnit, type SpeedUnit } from './lib/units';
import { floorToHour, formatDateTime } from './lib/time';
import { MapView } from './map/MapView';
import { hideWindArrows, updateWindArrows } from './map/layers/windArrows';
import { hideScalarField, updateScalarField } from './map/layers/scalarField';
import { setBasemapMuted } from './map/basemapTone';
import { WindParticleLayer } from './map/layers/windParticles';
import { setStationsVisible, updateStations } from './map/layers/stations';
import { setVesselsVisible, updateVessels } from './map/layers/vessels';
import { setHarboursVisible, updateHarbours } from './map/layers/harbours';
import { closePopup, registerPopups } from './map/popups';
import { buildWindField, type Field } from './map/interpolate';
import { LayerPanel, type LayerState } from './components/LayerPanel';
import { TimeSlider } from './components/TimeSlider';
import { PointSheet } from './components/PointSheet';
import { TopBar } from './components/TopBar';
import { MapLegend } from './components/MapLegend';
import { MapKey } from './components/MapKey';

const DEFAULT_LAYERS: LayerState = {
  overlays: ['seamark'],
  // Vaikimisi nooled + tuulevälja gradient: nool annab suuna, väli kiiruse.
  // Koos loevad nad end ühe pilguga, kumbki eraldi mitte.
  windDisplay: 'arrows',
  scalarField: 'wind_speed',
  stations: true,
  vessels: true,
  harbours: true,
};

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

  const [layers, setLayers] = useState<LayerState>(DEFAULT_LAYERS);
  const [panelOpen, setPanelOpen] = useState(false);
  const [speedUnit, setSpeedUnit] = useState<SpeedUnit>(loadSpeedUnit);

  const [selectedTime, setSelectedTime] = useState<Date>(() => floorToHour());

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
  const [pointResult, setPointResult] = useState<PointResult | null>(null);
  const [pointLoading, setPointLoading] = useState(false);
  const [pointError, setPointError] = useState<string | null>(null);

  const [view, setView] = useState<{ bbox: [number, number, number, number]; zoom: number } | null>(
    null,
  );

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
  const [fieldFrame, setFieldFrame] = useState<GridFrame | null>(null);

  // Nii nooled kui animatsioon toituvad samast võrgustikupäringust.
  const needWind = layers.windDisplay !== 'off';
  const fieldVar: Variable | null = layers.scalarField;

  /**
   * Terve ööpäeva kaadrid korraga.
   *
   * Varem küsis klient iga tunni eraldi HTTP-ga. Server serveeris need küll
   * vahemälust, aga ring võrgu kaudu tähendas ajaliuguri liigutamisel nähtavat
   * viivitust enne, kui uus tuul ekraanile jõudis. Nüüd tuleb kogu ööpäev ühe
   * päringuga ja tunni vahetamine on mäluvalik — hetkeline.
   */
  const [dayFrames, setDayFrames] = useState<GridFrame[]>([]);

  // Ööpäev, mille kaadrid meil on. Uus päring alles siis, kui päev vahetub.
  const dayKey = new Date(dataTime).toISOString().slice(0, 10);

  useEffect(() => {
    if (!view || !needWind) {
      setDayFrames([]);
      return;
    }
    const ac = new AbortController();
    const steps = gridStepsFor(window.innerWidth);
    api
      .gridDay(
        {
          bbox: view.bbox,
          steps,
          vars: ['wind_speed', 'wind_dir', 'wind_gust'],
          time: dataTime.toISOString(),
          model: activeModel === 'best_match' ? undefined : activeModel,
        },
        ac.signal,
      )
      .then((res) => {
        setDayFrames(res.frames);
        setLayerNotice(null);
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        // Ainult kaardikiht kadus; punktiprognoos ja jaamad töötavad edasi.
        // Aga kasutaja peab teadma, MIKS kiht seisma jäi.
        setLayerNotice(
          err instanceof RateLimitedError
            ? { kind: 'rateLimited', retryAfterSeconds: err.retryAfterSeconds }
            : { kind: 'error' },
        );
      });
    return () => ac.abort();
    // Ainult ala, mudel ja PÄEV — mitte tund.
  }, [view, needWind, dayKey, activeModel]);

  /** Valitud tunni kaader mälust. Kerimine ei puuduta võrku. */
  const gridFrame = useMemo(() => {
    if (dayFrames.length === 0) return null;
    const target = new Date(selectedTime).setMinutes(0, 0, 0);
    let best: GridFrame | null = null;
    let bestDiff = Infinity;
    for (const f of dayFrames) {
      const diff = Math.abs(new Date(f.time).getTime() - target);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = f;
      }
    }
    return best;
  }, [dayFrames, selectedTime]);

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

  useEffect(() => {
    if (!layers.harbours || !view) return;

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
  }, [layers.harbours, view?.bbox.join(',')]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    if (layers.harbours && harbours.length > 0) updateHarbours(map, harbours);
    else setHarboursVisible(map, false);
  }, [harbours, layers.harbours, mapReady]);

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
          hours: 120,
          providers: activeProviders.length ? activeProviders : undefined,
          models: activeModel === 'best_match' ? undefined : [activeModel],
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
  }, [picked, activeProviders, activeModel, t]);

  const handlePick = useCallback((lat: number, lon: number) => {
    setPicked({ lat, lon });
    setPointResult(null);
  }, []);

  // Popupid loevad ühikut ja keelt renderdamise hetkel; hoiame neid ref'is,
  // et kaardi klikikäsitlejaid ei peaks iga seadistuse muutuse peale uuesti
  // registreerima.
  const popupCtx = useRef({ t, speedUnit, lang });
  popupCtx.current = { t, speedUnit, lang };

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
    moveTimer.current = window.setTimeout(() => setView({ bbox, zoom }), 350);
  }, []);
  useEffect(() => {
    return () => {
      if (moveTimer.current !== null) window.clearTimeout(moveTimer.current);
    };
  }, []);

  const goTo = useCallback((lat: number, lon: number, zoom = 11) => {
    mapRef.current?.easeTo({ center: [lon, lat], zoom });
    // Kasutaja hüppas mujale — lõpeta enda asukoha järgimine, muidu kaart
    // hüppaks järgmise GPS-fixi peale kohe tagasi.
    geo.setFollowMe(false);
  }, [geo]);

  const i18nValue = useMemo(() => ({ lang, t, setLang }), [lang, t, setLang]);

  const center: [number, number] = [config?.defaultLat ?? 59.0, config?.defaultLon ?? 23.5];

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
      <div className="app">
        <TopBar
          onOpenLayers={() => setPanelOpen(true)}
          geo={geo}
          favorites={favorites}
          onGoTo={goTo}
        />

        <MapView
          center={center}
          zoom={config?.defaultZoom ?? 7}
          activeOverlays={layers.overlays}
          ownPosition={geo.position}
          followMe={geo.followMe}
          onReady={handleReady}
          onMoveEnd={handleMoveEnd}
          onPick={handlePick}
        />

        {layerNotice ? (
          <div className="layer-notice" role="status">
            {layerNotice.kind === 'rateLimited'
              ? t('layer.rateLimited', {
                  min: Math.max(1, Math.ceil(layerNotice.retryAfterSeconds / 60)),
                })
              : t('layer.failed')}
            {/* Kui kaardil on mõne muu tunni andmed, tuleb see VÄLJA ÖELDA.
                Vaikselt vale aja näitamine on mereilmakaardil ohtlikum kui
                andmete puudumine — kasutaja usub kella, mida ta näeb. */}
            {staleFieldTime ? (
              <strong> {t('layer.showingTime', { time: staleFieldTime })}</strong>
            ) : null}
          </div>
        ) : null}

        <MapLegend variable={layers.scalarField} speedUnit={speedUnit} />

        <MapKey
          showVessels={layers.vessels}
          showStations={layers.stations}
          showHarbours={layers.harbours}
          sheetOpen={picked !== null}
        />

        <TimeSlider
          value={selectedTime}
          onChange={setSelectedTime}
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
          speedUnit={speedUnit}
          onSpeedUnitChange={changeSpeedUnit}
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
