/**
 * SeaPro ühised tüübid — kasutavad nii server kui web.
 *
 * ÜHIKUTE REEGEL: server normaliseerib KÕIK väärtused siia loetletud SI-ühikutesse.
 * Teisendused (sõlmed, Bft, jalad) toimuvad ainult UI kihis. Ükski provider ei tohi
 * tagastada oma algset ühikut.
 */

// ---------------------------------------------------------------------------
// Muutujad
// ---------------------------------------------------------------------------

/** Kõik toetatud mõõdetavad/prognoositavad suurused. */
export const VARIABLES = [
  'wind_speed',       // m/s, 10 m kõrgusel
  'wind_gust',        // m/s
  'wind_dir',         // kraadi, KUST puhub (meteoroloogiline konventsioon)
  'wave_height',      // m, oluline lainekõrgus (Hs)
  'wave_max_height',  // m, maksimaalne lainekõrgus (Hmax)
  'wave_period',      // s
  'wave_dir',         // kraadi, kust lained tulevad
  'swell_height',     // m
  'swell_period',     // s
  'swell_dir',        // kraadi
  'sea_temp',         // °C
  'air_temp',         // °C
  'pressure',         // hPa
  'humidity',         // %
  'visibility',       // m
  'precipitation',    // mm/h
  'cloud_cover',      // %
  'sea_level',        // m (EH2000 või mudeli MSL — vt provideri märkust)
  'current_speed',    // m/s
  'current_dir',      // kraadi, KUHU liigub (ookeanograafiline konventsioon)
] as const;

export type Variable = (typeof VARIABLES)[number];

/**
 * Muutujad, mis tulevad LAINEmudelist.
 *
 * Miks eraldi loend: lainemudelid (DWD EWAM, GWAM) on puhtad lainemudelid —
 * meretemperatuur, veetase ja hoovused tulevad neist nullina, kuigi need on
 * samuti "mere" muutujad ja samast API-st. Lainemudeli valik tohib puudutada
 * ainult neid välju; ülejäänud jäävad automaatvalikule.
 */
export const WAVE_VARIABLES = [
  'wave_height',
  'wave_max_height',
  'wave_period',
  'wave_dir',
  'swell_height',
  'swell_period',
  'swell_dir',
] as const satisfies readonly Variable[];

export function isWaveVariable(v: Variable): boolean {
  return (WAVE_VARIABLES as readonly Variable[]).includes(v);
}

/** SI-ühik, milles server iga muutujat tagastab. Ainult kuvamiseks/kontrolliks. */
export const VARIABLE_UNITS: Record<Variable, string> = {
  wind_speed: 'm/s',
  wind_gust: 'm/s',
  wind_dir: '°',
  wave_height: 'm',
  wave_max_height: 'm',
  wave_period: 's',
  wave_dir: '°',
  swell_height: 'm',
  swell_period: 's',
  swell_dir: '°',
  sea_temp: '°C',
  air_temp: '°C',
  pressure: 'hPa',
  humidity: '%',
  visibility: 'm',
  precipitation: 'mm/h',
  cloud_cover: '%',
  sea_level: 'm',
  current_speed: 'm/s',
  current_dir: '°',
};

/** Suunamuutujad — neid ei tohi lineaarselt interpoleerida ega keskmistada. */
export const DIRECTION_VARIABLES: ReadonlySet<Variable> = new Set<Variable>([
  'wind_dir',
  'wave_dir',
  'swell_dir',
  'current_dir',
]);

// ---------------------------------------------------------------------------
// Providerid
// ---------------------------------------------------------------------------

export type ProviderKind =
  | 'forecast'      // mudelprognoos (Open-Meteo, met.no, Windfinder)
  | 'observation';  // päris mõõdetud andmed (METOC, LainePoiss, Ilmateenistus)

export interface ProviderModel {
  id: string;
  label: string;
  /** Lühikirjeldus UI tooltipile, nt "DWD ICON-EU, 7 km, Euroopa". */
  note?: string;
}

/** [lõuna, lääs, põhi, ida] — WGS84 kraadid. */
export type BBox = [number, number, number, number];

export interface ProviderCapabilities {
  id: string;
  /** Kuvatav nimi (ei tõlgita — need on pärisnimed). */
  label: string;
  kind: ProviderKind;
  variables: Variable[];
  /** Valitavad mudelid; puudub, kui providereil pole mudelivalikut. */
  models?: ProviderModel[];
  /**
   * Valitavad LAINEmudelid, kui allikal on merele oma mudelikomplekt.
   *
   * Eraldi väli, mitte `models` sisse segatud: Open-Meteo mere-API on eri host
   * eri mudelinimedega ja atmosfäärimudeli ID sinna saates tuleb vastuseks
   * 200 täis nulle — kiht kaob ekraanilt ilma veateateta. Kaks komplekti
   * peavad seetõttu ka tüübitasemel lahus olema.
   */
  waveModels?: ProviderModel[];
  /** Kas provider oskab ühe päringuga mitut punkti (võrgustiku kiht). */
  supportsGrid: boolean;
  /** Kas provider pakub nimelisi mõõtejaamu/poisid. */
  supportsStations: boolean;
  /** Katvuspiirkond; puudub = globaalne. */
  bbox?: BBox;
  /** Mitu tundi ette prognoos ulatub. Vaatlusprovideritel 0. */
  forecastHours: number;
  /** Atributsioon, mis PEAB UI-s nähtav olema. */
  attribution: string;
  attributionUrl?: string;
  /** Kas provider on hetkel kasutatav (nt aisstream ilma võtmeta = false). */
  enabled: boolean;
  /** Miks välja lülitatud, kui enabled=false. */
  disabledReason?: string;
}

// ---------------------------------------------------------------------------
// Ajaread
// ---------------------------------------------------------------------------

/** Üks ajahetk. Puuduv muutuja = null (mitte 0, mitte NaN). */
export interface TimeStep {
  /** ISO 8601 UTC, nt "2026-07-27T16:00:00Z". */
  time: string;
  values: Partial<Record<Variable, number | null>>;
}

export interface TimeSeries {
  providerId: string;
  /** Mudeli id, kui provider tagastas konkreetse mudeli. */
  modelId?: string;
  /** Punkt, mille kohta andmed KEHTIVAD (võib erineda küsitust — mudeli lähim ruut). */
  lat: number;
  lon: number;
  /** Millal allikas andmeid viimati uuendas, kui teada. */
  updatedAt?: string;
  steps: TimeStep[];
}

/** Üks provider võib tagastada mitu seeriat (üks mudeli kohta). */
export interface PointResult {
  lat: number;
  lon: number;
  series: TimeSeries[];
  /** Providerid, mis ebaõnnestusid — UI näitab neid eraldi, mitte ei vaiki maha. */
  errors: ProviderError[];
}

export interface ProviderError {
  providerId: string;
  message: string;
  /** Kas viga on ajutine (võrk/allikas maas) või struktuurne (parser katki). */
  kind: 'unavailable' | 'parse' | 'unsupported' | 'config';
}

// ---------------------------------------------------------------------------
// Võrgustik (kaardikihid)
// ---------------------------------------------------------------------------

export interface GridPoint {
  lat: number;
  lon: number;
  values: Partial<Record<Variable, number | null>>;
}

export interface GridFrame {
  providerId: string;
  modelId?: string;
  time: string;
  variables: Variable[];
  points: GridPoint[];
}

/** Kaardivälja vastus võib olla osaline, kui mõni võrgupaan ei tulnud. */
export interface GridDayResult {
  frames: GridFrame[];
  warning?:
    | { kind: 'rate_limited'; retryAfterSeconds: number }
    | { kind: 'error' };
}

// ---------------------------------------------------------------------------
// Mõõtejaamad ja poid
// ---------------------------------------------------------------------------

export type StationKind = 'coastal' | 'offshore' | 'buoy' | 'unknown';

export interface Station {
  /** Unikaalne providersiseselt, nt "kihnu" või "15". */
  id: string;
  providerId: string;
  name: string;
  kind: StationKind;
  lat: number;
  lon: number;
  /**
   * Kas jaama asukoht võib ajas muutuda (triiviv poi).
   * Nii tead, et markerit peab andmetega koos uuendama.
   */
  mobile?: boolean;
}

export interface StationReading extends Station {
  /** Viimase mõõtmise aeg, ISO 8601 UTC. Null = andmed puuduvad. */
  observedAt: string | null;
  values: Partial<Record<Variable, number | null>>;
  /** Vanus sekundites serveri vastuse hetkel — UI värvib markeri selle järgi. */
  ageSeconds: number | null;
}

// ---------------------------------------------------------------------------
// Prognoosimudelite verifikatsioon
// ---------------------------------------------------------------------------

export interface ModelSkillPoint {
  id: string;
  name: string;
  country: 'EE' | 'FI';
  observationProviderId: string;
}

export interface ModelSkillSourceStats {
  sourceId: string;
  label: string;
  samples: number;
  stations: number;
  /** Osakaal suurima sama vaate võrreldavast valimist, 0…1. */
  coverage: number;
  /** Kas valim on piisav ja kogu valitud punktide hulk on kaetud. */
  rankingEligible: boolean;
  windSpeedMae: number | null;
  windSpeedRmse: number | null;
  windSpeedBias: number | null;
  windGustMae: number | null;
  windDirectionMae: number | null;
  /** Spoti ja mõõtejaama keskmine vahemaa; mudelivõre puhul null. */
  averageLocationDistanceKm: number | null;
}

export interface ModelSkillReport {
  generatedAt: string;
  collectionStartedAt: string | null;
  lastObservationAt: string | null;
  lastForecastAt: string | null;
  days: 7 | 30 | 90;
  leadHours: 0 | 3 | 12 | 24 | 48;
  /** null tähendab kõigi kontrollpunktide koondit. */
  pointId: string | null;
  points: ModelSkillPoint[];
  sources: ModelSkillSourceStats[];
}

export interface ModelSkillSeriesEntry {
  capturedAt: string;
  validAt: string;
  observedAt: string;
  forecastWindSpeed: number | null;
  forecastWindGust: number | null;
  forecastWindDirection: number | null;
  observedWindSpeed: number | null;
  observedWindGust: number | null;
  observedWindDirection: number | null;
}

export interface ModelSkillSeriesSource {
  sourceId: string;
  label: string;
  entries: ModelSkillSeriesEntry[];
}

export interface ModelSkillSeriesReport {
  generatedAt: string;
  days: 7 | 30 | 90;
  leadHours: 0 | 3 | 12 | 24 | 48;
  point: ModelSkillPoint;
  sources: ModelSkillSeriesSource[];
}

/** METOC-i originaali värskuseastmed; kasutame sama loogikat kõigi jaamade jaoks. */
export type Freshness = 'fresh' | 'stale' | 'old' | 'none';

export function freshnessOf(ageSeconds: number | null): Freshness {
  if (ageSeconds === null) return 'none';
  if (ageSeconds < 5 * 3600) return 'fresh';
  if (ageSeconds < 24 * 3600) return 'stale';
  return 'old';
}

// ---------------------------------------------------------------------------
// AIS
// ---------------------------------------------------------------------------

export interface Vessel {
  mmsi: number;
  name?: string;
  callSign?: string;
  imo?: number;
  /** AIS ship type kood (0-99). */
  shipType?: number;
  /** Lipuriigi kolmetäheline kood, nt EST või FIN. */
  flag?: string;
  /**
   * Laeva mõõtmed AIS-i staatilisest sõnumist, meetrites.
   *
   * AIS ei anna pikkust ja laiust otse, vaid neli kaugust GPS-ANTENNIST:
   *   toBow      A — antennist vöörini
   *   toStern    B — antennist ahtrini
   *   toPort     C — antennist pardast vasakule
   *   toStarboard D — antennist pardast paremale
   *
   * Pikkus = A + B, laius = C + D. Antenni nihe on oluline: raporteeritud
   * positsioon ON antenni oma, mitte laeva keskpunkt, seega kere tuleb
   * joonistada antenni suhtes — muidu istub 300 m laev kaardil poole pikkuse
   * võrra nihkes.
   */
  toBow?: number;
  toStern?: number;
  toPort?: number;
  toStarboard?: number;
  /** Kogupikkus ja -laius, kui allikas ei anna antenni A/B/C/D nihkeid. */
  lengthM?: number;
  beamM?: number;
  lat: number;
  lon: number;
  /** Kiirus üle põhja, sõlmedes — AIS-i natiivne ühik, jääb sõlmedeks. */
  sog?: number;
  /** Kurss üle põhja, kraadi. */
  cog?: number;
  /** Vööri suund, kraadi. */
  heading?: number;
  /** AIS navigational status kood. */
  navStat?: number;
  destination?: string;
  /** Laeva raporteeritud ETA ISO 8601 UTC kujul. */
  eta?: string;
  /** Laeva raporteeritud süvis meetrites. */
  draughtM?: number;
  /** AIS-positsioneerimisseadme kood. */
  positionFixType?: number;
  /** ISO 8601 UTC. */
  timestamp: string;
  /** Kust see positsioon tuli. */
  source: 'digitraffic' | 'aisstream' | 'transpordiamet';
}

// ---------------------------------------------------------------------------
// Sadamad
// ---------------------------------------------------------------------------

/**
 * Sadam või väikesadam OpenStreetMapist.
 *
 * Väljad on valitud selle järgi, mida kaatriga sadamasse minnes tegelikult
 * teada tahetakse: kas ma mahun sisse (süvis), kas seal on elekter ja
 * septikutühjendus, ja kellele helistada. Kõik peale nime ja asukoha on
 * valikuline — OSM-i katvus on väljade kaupa väga erinev.
 */
export interface Harbour {
  /** OSM tüüp ja id, nt "way/123456". */
  id: string;
  /**
   * Sadam või ankrukoht.
   *
   * Sama kuju, sest kaatri jaoks on mõlemad "koht, kuhu ööseks jääda", ja
   * mõlemad tulevad ÜHEST Overpassi päringust. Erinevus on väljade katvuses:
   * sadamal on teenused ja kontaktid, ankrukohal tavaliselt ainult asukoht,
   * kaitstus ja põhjatüüp.
   */
  kind: 'harbour' | 'anchorage';
  name: string;
  lat: number;
  lon: number;
  /** seamark:harbour:category — "marina", "marina_no_facilities", "ferry" jne. */
  category?: string;
  phone?: string;
  website?: string;
  operator?: string;
  /** Suurim süvis meetrites. */
  maxDraught?: number;
  /** Kohtade arv. */
  capacity?: number;
  powerSupply?: boolean;
  sanitaryDump?: boolean;
  fuel?: boolean;
  drinkingWater?: boolean;
  /** VHF-kanal. */
  vhf?: string;
  /** Link riiklikku sadamaregistrisse, kui OSM-is olemas. */
  registryUrl?: string;
  /** UN/LOCODE. */
  locode?: string;
  /** seamark:anchorage:category — "unrestricted", "deep_water", "small_craft" jne. */
  anchorageCategory?: string;
  /** Põhjatüüp (OSM `seamark:bottom:nature`) — muda, liiv, kivi. */
  seabed?: string;
  /** Millistest registritest kirje kokku pandi. */
  sources?: Array<'osm' | 'transpordiamet'>;
  /** Transpordiameti sadamaregistri objekti id. */
  officialId?: string;
}

// ---------------------------------------------------------------------------
// Navigatsiooniohutus ja ametlikud merendusobjektid
// ---------------------------------------------------------------------------

export type NavigationGeometry =
  | { type: 'Point'; coordinates: [number, number] }
  | { type: 'LineString'; coordinates: [number, number][] }
  | { type: 'MultiLineString'; coordinates: [number, number][][] }
  | { type: 'Polygon'; coordinates: [number, number][][] }
  | { type: 'MultiPolygon'; coordinates: [number, number][][][] };

export interface NavigationWarning {
  id: string;
  geometry: NavigationGeometry;
  number?: number;
  /** Algallikas; kaardi kujundus on allikast sõltumata SeaPro ühine stiil. */
  source?: 'transpordiamet' | 'traficom';
  titleEt?: string;
  titleEn?: string;
  titleFi?: string;
  textEt?: string;
  textEn?: string;
  textFi?: string;
  areaEt?: string;
  areaEn?: string;
  areaFi?: string;
  charts?: string;
  publishedAt?: string;
  validFrom?: string;
  validTo?: string;
  documentUrl?: string;
}

export interface Wreck {
  id: string;
  lat: number;
  lon: number;
  name: string;
  wreckDepthM?: number;
  surroundingDepthM?: number;
  heightM?: number;
  lengthM?: number;
  widthM?: number;
  vesselType?: string;
  sunkAt?: string;
  sunkReason?: string;
  condition?: string;
  history?: string;
  notes?: string;
  model3dUrl?: string;
}

export interface NavigationAid {
  id: string;
  lat: number;
  lon: number;
  name: string;
  nameEn?: string;
  kind: 'fixed' | 'floating' | 'seasonal' | 'ais' | 'virtual';
  /** Normaliseeritud IALA/AIS märgitüüp kaardi tingmärgi valimiseks. */
  category?:
    | 'lateral-port'
    | 'lateral-starboard'
    | 'preferred-port'
    | 'preferred-starboard'
    | 'cardinal-north'
    | 'cardinal-east'
    | 'cardinal-south'
    | 'cardinal-west'
    | 'isolated-danger'
    | 'safe-water'
    | 'special'
    | 'lighthouse'
    | 'leading'
    | 'leading-front'
    | 'leading-rear'
    | 'beacon'
    | 'virtual'
    | 'unknown';
  atonCode?: string;
  /** NMA registri täpne eestikeelne liigikirjeldus. */
  registryType?: string;
  registryUrl?: string;
  /** NMA registrist saadud päevamärgi/ehitise põhivärvid ikooni jaoks. */
  markColours?: Array<'red' | 'green' | 'white' | 'yellow' | 'orange' | 'black' | 'grey'>;
  atonType?: number;
  status?: number;
  offPosition?: boolean;
  virtual?: boolean;
  mmsi?: number;
  lightActive?: boolean;
  lightColour?: string;
  owner?: string;
  /** Registri vabatekstiline asukohakirjeldus. */
  location?: string;
  /** Laevatee nimi, millega märk on registris seotud. */
  fairwayName?: string;
  /** Registri tule ja sektorite detailid. */
  lightDetails?: string;
  lightSectors?: string;
  activeFrom?: string;
  activeTill?: string;
  updatedAt?: string;
  sources: Array<'registry' | 'vaylavirasto' | 'ais'>;
}

export interface Fairway {
  id: string;
  geometry:
    | { type: 'LineString'; coordinates: [number, number][] }
    | { type: 'MultiLineString'; coordinates: [number, number][][] };
  name: string;
  fairwayClass?: string;
  depthM?: number;
  shipDraughtM?: number;
  widthM?: number;
  type?: string;
}

export type TrafficSchemeKind =
  | 'separation_lane'
  | 'separation_zone'
  | 'separation_boundary'
  | 'separation_line'
  | 'separation_crossing'
  | 'separation_roundabout'
  | 'inshore_traffic_zone'
  | 'precautionary_area'
  | 'navigation_line'
  | 'recommended_route_centreline'
  | 'recommended_track'
  | 'recommended_traffic_lane'
  | 'two-way_route'
  | 'traffic_lane';

/** OpenStreetMapi/OpenSeaMapi liikluseraldusskeemi objekt ilma navimärkideta. */
export interface TrafficScheme {
  id: string;
  kind: TrafficSchemeKind;
  geometry:
    | { type: 'LineString'; coordinates: [number, number][] }
    | { type: 'MultiLineString'; coordinates: [number, number][][] }
    | { type: 'Polygon'; coordinates: [number, number][][] }
    | { type: 'MultiPolygon'; coordinates: [number, number][][][] };
  name?: string;
  orientation?: number;
}

export interface NavigationData {
  warnings: NavigationWarning[];
  wrecks: Wreck[];
  aids: NavigationAid[];
  fairways: Fairway[];
  trafficSchemes: TrafficScheme[];
}

// ---------------------------------------------------------------------------
// Kohanimede otsing
// ---------------------------------------------------------------------------

/** Serveri normaliseeritud otsingutulemus, sõltumata geokodeerimisteenusest. */
export interface SearchResult {
  /** Stabiilne OSM objekti viide (nt `N123`) või teenuse kohapõhine ID. */
  id: string;
  name: string;
  /** Nime täiendav aadress/asukohakirjeldus tulemuste eristamiseks. */
  subtitle?: string;
  kind: 'location' | 'harbour';
  lat: number;
  lon: number;
  /** Kaardi sihtsuum, tuletatud objekti tüübist ja piirdekastist. */
  zoom: number;
  /** Nominatimi piirdekast kujul [lõuna, lääs, põhi, ida]. */
  bbox?: BBox;
}

// ---------------------------------------------------------------------------
// Sademeradar
// ---------------------------------------------------------------------------

/** Keskkonnaagentuuri WMS-ist leitud päriselt saadaval radarikaadrite ajad. */
export interface RadarTimeline {
  /** Tegelikud komposiitradari vaatlused, ISO 8601 UTC. */
  observations: string[];
  /** Vaatlusest edasi arvutatud lühiennustuse kaadrid, ISO 8601 UTC. */
  forecasts: string[];
  latestObservation: string | null;
  latestForecast: string | null;
}

// ---------------------------------------------------------------------------
// Trackid (kaatri rajad) — liides valmis, implementatsioon tuleb hiljem
// ---------------------------------------------------------------------------

export interface TrackSummary {
  id: string;
  name: string;
  providerId: string;
  /** ISO 8601 UTC. */
  startedAt?: string;
  endedAt?: string;
  /** Meetrites. */
  distance?: number;
  /** Sekundites. */
  durationSeconds?: number;
  /** Arvutatud kasutaja sisestatud l/h põhjal. */
  estimatedFuelLitres?: number;
  averageSpeedKnots?: number;
}

export interface TrackPoint {
  lat: number;
  lon: number;
  time?: string;
  /** Sõlmedes. */
  speed?: number;
  course?: number;
}

export interface Track extends TrackSummary {
  points: TrackPoint[];
}

// ---------------------------------------------------------------------------
// Marsruudid ja marsruudianalüüs
// ---------------------------------------------------------------------------

export interface RouteWaypoint {
  id: string;
  lat: number;
  lon: number;
  name?: string;
}

/** GeoJSON-i joon, mille koordinaadid on alati [pikkuskraad, laiuskraad]. */
export interface RouteLineString {
  type: 'LineString';
  coordinates: [number, number][];
}

export type RoutePlanStatus = 'route' | 'advisory';
export type RoutePlanAssessment = 'clear' | 'caution' | 'unknown';
export type RoutePlanIssueSeverity = 'info' | 'warning' | 'critical';

/** Üks planeerija avastatud asjaolu; `code` on tõlgitav masinloetav võti. */
export interface RoutePlanIssue {
  code: string;
  severity: RoutePlanIssueSeverity;
  message?: string;
  sourceIds?: string[];
  details?: Record<string, string | number | boolean | null>;
}

export interface RoutePlanSource {
  id: string;
  fetchedAt: string;
  ageSeconds: number;
  stale: boolean;
  coverage: 'complete' | 'partial' | 'missing';
  error?: string;
}

export interface RoutePlanSegment {
  from: [number, number];
  to: [number, number];
  assessment: RoutePlanAssessment;
  reasons: string[];
  sourceIds: string[];
  minDepthM: number | null;
  requiredDepthM: number;
}

export interface RoutePlanEndpoint {
  requested: Pick<RouteWaypoint, 'lat' | 'lon'>;
  snapped: Pick<RouteWaypoint, 'lat' | 'lon'>;
  distanceM: number;
}

/** Salvestatav automaatmarsruut. Kontrollpunktid jäävad `Route.waypoints` sisse. */
export interface RoutePlan {
  status: RoutePlanStatus;
  geometry: RouteLineString;
  navigationWaypoints: RouteWaypoint[];
  segments: RoutePlanSegment[];
  endpoints: { start: RoutePlanEndpoint; end: RoutePlanEndpoint };
  distanceNm: number;
  generatedAt: string;
  snapshotId: string;
  sources: RoutePlanSource[];
  issues: RoutePlanIssue[];
}

export interface Route {
  id: string;
  name: string;
  waypoints: RouteWaypoint[];
  /** ISO 8601 koos ajavööndiga. */
  startTime: string;
  speedKnots: number;
  draughtM: number;
  underKeelClearanceM: number;
  /** Laeva suurim laius. Automaatmarsruudi puhul kohustuslik. */
  beamM?: number;
  /** Kõrgus veeliinist. Automaatmarsruudi puhul kohustuslik. */
  airDraughtM?: number;
  fuelLitresPerHour: number;
  /** Puudub käsitsi loodud või pärast käsitsi muutmist tühistatud marsruudil. */
  plan?: RoutePlan;
  createdAt: string;
  updatedAt: string;
}

export interface RoutePlanRequest {
  start: Pick<RouteWaypoint, 'lat' | 'lon'>;
  end: Pick<RouteWaypoint, 'lat' | 'lon'>;
  departureTime: string;
  speedKnots: number;
  draughtM: number;
  underKeelClearanceM: number;
  beamM: number;
  airDraughtM: number;
}

export type RoutePlanResponse =
  | ({ status: RoutePlanStatus } & RoutePlan)
  | {
      status: 'no_route';
      issues: RoutePlanIssue[];
      sources: RoutePlanSource[];
    };

export type DepthRisk = 'safe' | 'caution' | 'danger' | 'unknown';

export interface DepthRiskSegment {
  from: [number, number]; // [lon, lat]
  to: [number, number];
  risk: DepthRisk;
  minDepthM: number | null;
  requiredDepthM: number;
}

export interface RouteWeatherSample {
  lat: number;
  lon: number;
  time: string;
  distanceNm: number;
  /** Marsruudijala otspunkt; puudub ühtlasel ajaproovil. */
  waypointIndex?: number;
  values: Partial<Record<
    'wind_speed' | 'wind_gust' | 'wind_dir' | 'wave_height' | 'wave_period' | 'wave_dir',
    number | null
  >>;
  weatherAvailable: boolean;
  depthM: number | null;
  depthRisk: DepthRisk;
}

export interface RouteAnalysis {
  distanceNm: number;
  durationSeconds: number;
  /** UI tabeli ajapõhiste vahepunktide samm; jalgade otspunktid lisanduvad alati. */
  sampleIntervalMinutes: number;
  arrivalTime: string;
  estimatedFuelLitres: number;
  requiredDepthM: number;
  samples: RouteWeatherSample[];
  depthSegments: DepthRiskSegment[];
  warnings: string[];
  restrictions: Array<{ kind: 'fairway' | 'harbour'; name: string; maxDraughtM: number }>;
}

export interface RouteAnalysisRequest {
  /** Käsitsi marsruudi pöördepunktid või automaatmarsruudi navigatsioonipunktid. */
  waypoints: Array<Pick<RouteWaypoint, 'lat' | 'lon'>>;
  /** Automaatmarsruudi detailne joon sügavus- ja vahemaa-analüüsiks. */
  path?: RouteLineString;
  startTime: string;
  speedKnots: number;
  draughtM: number;
  underKeelClearanceM: number;
  fuelLitresPerHour: number;
  model?: string;
  waveModel?: string;
}

// ---------------------------------------------------------------------------
// Ühikuteisendused (UI kiht)
// ---------------------------------------------------------------------------

export type SpeedUnit = 'ms' | 'kn' | 'bft' | 'kmh';

export function msToKnots(ms: number): number {
  return ms * 1.943844;
}

export function msToKmh(ms: number): number {
  return ms * 3.6;
}

/** Beauforti aste (0-12) tuule kiirusest m/s. */
export function msToBeaufort(ms: number): number {
  // Ametlik Beauforti skaala alampiirid m/s.
  const limits = [0.5, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7];
  let bft = 0;
  for (const limit of limits) {
    if (ms >= limit) bft++;
    else break;
  }
  return bft;
}

export function convertSpeed(ms: number, unit: SpeedUnit): number {
  switch (unit) {
    case 'ms': return ms;
    case 'kn': return msToKnots(ms);
    case 'kmh': return msToKmh(ms);
    case 'bft': return msToBeaufort(ms);
  }
}

/** Suund kraadides → 16-punktiline kompassiruum, nt 213 → "SSW". */
export function degreesToCompass(deg: number): string {
  const points = [
    'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
  ];
  const idx = Math.round(((deg % 360) + 360) % 360 / 22.5) % 16;
  return points[idx] ?? 'N';
}

export * from './route.js';
