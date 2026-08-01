# Andmeallikad

## Kohanimeotsing — Photon / OpenStreetMap

`/api/search` vahendab kasutaja käivitatud asukoha- ja sadamaotsingu Photonile.
Photon toetab prefiksiotsingut ja kirjavigade talumist, mistõttu leiab näiteks
`Yxsk` nime `Yxskär`. Klient küsib soovitusi pärast 400 ms trükkimispausi;
server piirab välispäringud ühele sekundis ja vahemäldab tulemused nädalaks.
Teenuse saab `PHOTON_URL` kaudu asendada oma instantsiga.

Iga allikas on `server/src/providers/` all eraldi fail, mis implementeerib
`WeatherProvider` liidese. Frontend ei tea ühestki allikast midagi peale selle,
mida `capabilities` ütleb.

**Ühikute reegel:** server normaliseerib KÕIK väärtused SI-sse (tuul m/s,
lained m, temperatuur °C, rõhk hPa, nähtavus m, veetase m). Teisendused
sõlmedesse või Bft-i toimuvad ainult UI kihis. Iga allikas annab andmed oma
ühikutes ja provider teisendab — vt allpool iga allika juures, mis teisendust
vajas.

---

## Prognoosiallikad

### Open-Meteo — `providers/openMeteo.ts`

| | |
|---|---|
| Otspunktid | `api.open-meteo.com/v1/forecast`, `marine-api.open-meteo.com/v1/marine` |
| Võti | ei vaja |
| Litsents | CC BY 4.0 (mittekaubanduslik tasuta) |
| Katvus | globaalne |
| Ulatus | 7–8 päeva |

Peamine prognoosiallikas. Annab nii atmosfääri kui merevälju, natiivselt m/s
(`wind_speed_unit=ms`), ja toetab mitut mudelit korraga
(`models=metno_nordic,icon_eu,ecmwf_ifs025` → eraldi väljad järelliidetega).

**Päringueelarve on siin kriitiline.** Open-Meteo kutsekaal (nende enda
`ForecastApiResult.calculateQueryWeight()`):

```
kaal = summa üle asukohtade: max(1, (muutujad × mudelid / 10) × max(1, päevad / 14))
```

Sellest tuleneb kolm asja:

- **Iga võrepunkt maksab vähemalt 1.** 16×16 võrgustik = 256 kutset ühe
  kaardikaadri kohta. Tunnilimiit on 5000, ööpäevane 10 000.
- **Kuni 10 muutujat ja kuni 14 päeva on sama hinnaga kui üks muutuja ja üks
  tund.** Vähem küsimine ei säästa midagi — see tähendab ainult, et sama raha
  eest saab vähem vahemälu.
- **Mudelid korrutavad muutujate arvu**: 9 muutujat × 5 mudelit = 4,5 kutset
  asukoha kohta.

Kaitsed:

1. `GRID_MAX_STEPS = 8` — üks kaader maksab kuni 64 kutset
2. bbox kleebitakse ruudustikule (`routes/api.ts:snapBbox`) — lähestikused
   vaated jagavad ühte vahemälukirjet
3. üks päring toob **7 päeva ja kogu muutujate komplekti** (`BLOCK_DAYS`,
   `providers/openMeteo.ts`). Sama kaal, kordades rohkem vahemälu: ajaliuguri
   kerimine, järgmiste päevade eelhaare ja kihi vahetamine on pärast esimest
   tõmmet tasuta
4. klikitud punkt kleebitakse omakorda võrele 0.05°/0.1°
   (`routes/api.ts:snapPoint`) — Open-Meteo ümardab niikuinii mudeli lahtrini
   (ICON-EU ~7 km), seega kordusklikid samas lahes on tasuta. Vastuses
   `lat`/`lon` jäävad kasutaja omaks
5. `rateLimit.ts` peatab päringu ise 3000 kutse juures tunnis ja 8000 juures
   ööpäevas — päevane piir on praktikas see, mis maksma jääb
6. lainekiht kasutab **lainemudelit** (`waveModel`, vaikimisi DWD EWAM 5 km),
   mitte atmosfäärimudelit. Need on eri komplektid: `models=icon_eu`
   mere-API-le annab üksikpunktil 200 täis nulle ja mitmepunktilisel 400
   ("No data is available for this location") — mõlemal juhul tühja kihi.
   Lainemudel kehtib AINULT lainemuutujatele (`WAVE_VARIABLES`); meretemp,
   veetase ja hoovused tulevad alati `best_match`-ist, sest EWAM/GWAM neid ei
   arvuta. EWAM-i domeenist väljas (avaookean) kordab server päringu
   automaatselt `best_match`-iga — vt `fetchMarineWithFallback`
7. prognoosi- ja mere-API on eri hostid ERALDI kvoodiga, seega eraldi eelarved
   (`open-meteo`, `open-meteo-marine`) — tuulekihi limiit ei tohi lainekihti
   välja lülitada

Kaardil nähtava tiheduse annab **kliendipoolne interpoleerimine**
(`web/src/map/interpolate.ts`), mitte tihedam päring.

### MET Norway — `providers/metNo.ts`

| | |
|---|---|
| Otspunktid | `api.met.no/weatherapi/locationforecast/2.0/compact`, `.../oceanforecast/2.0/complete` |
| Võti | ei vaja, AGA nõuab tuvastatavat `User-Agent`i |
| Litsents | NLOD / CC BY 4.0 |
| Katvus | globaalne, parim Põhjalas; Läänemeri kaetud |
| Ulatus | 9 päeva |

**See allikas EI SAA kunagi töötada otse frontendist.** met.no ToS nõuab
User-Agenti kontaktiga ja vastab anonüümsele päringule 403-ga; brauser ei luba
JavaScriptil User-Agenti seada. Proxy pole siin mugavus, vaid tingimus.
Seadista `CONTACT_EMAIL` — ilma selleta lülitab provider end ise välja ja
ütleb UI-s põhjuse.

ToS nõuab ka `Expires` päise austamist ja koordinaatide ümardamist 4 komakohani
(muidu raiskame nende vahemälu).

### Windfinder — `providers/windfinder.ts`

| | |
|---|---|
| Otspunkt | `windfinder.com/forecast/<spot>` (HTML) |
| Võti | — (ametlik API on tasuline B2B) |
| Katvus | nimelised spotid, mitte suvalised koordinaadid |
| Ulatus | ~3 päeva, 3-tunnise sammuga |

⚠ **Ainus allikas, mis ei ole lepinguline API.** Parsime avalikku prognoosilehte
(`/forecast/<spot>` on nende robots.txt-i järgi lubatud; keelatud on `/api/`,
`/widget/`, `/share/` ja `*/print`).

Kolm asja, mis koodi kujundasid:

- **Klassinimed on hašitud.** Astro + CSS-moodulid annavad
  `_cell-wind-speeds_1swh1_235`, kus järelliide muutub iga nende deploy'ga.
  Sobitame ainult prefiksi järgi.
- **Parser viskab valju vea**, kui struktuur muutub — ei tagasta vaikselt
  tühja vastust. Vaikne tühjus näeks kasutajale välja nagu "tuult pole", mis on
  mereilmarakenduses ohtlikum kui nähtav veateade.
- **Windfinder ei tohi olla ühegi tuumikfunktsiooni eeltingimus.**

Koordinaate leht ei avalda, seega lähima spoti leidmiseks on kohalik nimekiri
`src/stations/windfinder-spots.json`, mille genereerib
`scripts/scrape-windfinder-spots.ts`.

---

## Mõõdetud andmed (mitte prognoos)

Need on rakenduse tegelik lisaväärtus prognoosiportaalide ees: päris mõõtmised
Eesti vetes, mida globaalsed mudelid sageli valesti hindavad.

### TalTech METOC — `providers/metocTaltech.ts`

| | |
|---|---|
| Otspunktid | `on-line.msi.ttu.ee/metoc/infowindow.php` (POST) |
| Võti | ei vaja |
| Katvus | 36 jaama Eesti rannikul ja avamerel |

Portaalil pole API-t. Kasutame `infowindow.php`-d, sest see annab ühe
päringuga kõik parameetrid pluss mõõtmise ajatempli. (`get_param_value.php`
nõuaks iga parameetri kohta eraldi päringut ega ütleks, kui vana väärtus on.)

Jaamade nimekiri on peidetud portaali HTML-i sisse genereeritud
JavaScripti; genereerime sellest staatilise `src/stations/metoc.json`
skriptiga `scripts/scrape-metoc-stations.ts`.

**Ühikuteisendus:** veetase tuleb SENTIMEETRITES ("+43 / +19 cm", EH2000 /
BK77). Võtame EH2000 ja teisendame meetriteks. Ilma selleta näitaks kaart
veetaset 43 meetrit.

**Ajavöönd:** ajatempel on Eesti kohalikus ajas ("27.07.2026 20:10"),
teisendame UTC-sse, arvestades suveaega.

Server on vana (Apache 2.2 / PHP 5.3), seega pärime **taustal** ühe korra 4
minuti jooksul, sõltumata kasutajate arvust. CORS puudub — proxy kohustuslik.

### LainePoiss — `providers/lainepoiss.ts`

| | |
|---|---|
| Otspunktid | `lainepoiss.eu/dashboard/buoys_conf.json`, `lainepoiss.eu/lp_data/LP_<n>/web.txt` |
| Võti | ei vaja |
| Katvus | Eesti lainepoid (praegu ~4 aktiivset) |

Lihtsaim allikas: konfiguratsioon on JSON, andmed on tühikutega eraldatud
tekst, 10 veergu:

```
kuupäev kellaaeg lat lon Hs Hmax Tp Pdir_naut mean_dir aku_V
2026-07-27 16:01:55 59.3911 24.0698 0.272 0.505 2.964 310 316 4.07
```

Kolm asja, mida parser peab taluma:

- **Positsioon tuleb andmereast**, mitte konfiguratsioonist — poi triivib
  ankru otsas ja teda tõstetakse hooajati ümber
- **`NaN` väljadena** — nt poil 35 puudub Hmax ja mean_dir
- **Surnud paigaldused ja rikutud read** — konfiguratsioonis on poisid
  aastatest 2022–2023 (Atlandi ookean, Ålesund), mille failid on alles, ja
  vähemalt üks poi raporteeris kuupäeva aastal 2226. Filtreerime välja
  mõõtmised, mis on vanemad kui 48 h või tulevikus.

Kaks konfiguratsioonis olevat poid (24, 28) vastavad 404-ga — nende failid
puuduvad. Kasutame `Promise.allSettled`, et üks selline ei kustutaks kogu
poide võrku ekraanilt.

### Riigi Ilmateenistus — `providers/ilmateenistus.ts`

| | |
|---|---|
| Otspunkt | `ilmateenistus.ee/ilma_andmed/xml/observations.php` |
| Võti | ei vaja |
| Katvus | ~110 jaama üle Eesti |

Täiendab METOC-i: METOC on mereseireks, Ilmateenistus annab tiheda võrgu koos
õhurõhu ja nähtavusega. XML ilma skeemita; parsime regexiga, sest struktuur on
lame ja stabiilne.

**Ühikuteisendus:** nähtavus tuleb KILOMEETRITES ("32"), teisendame meetriteks.
Sama väli tuleb METOC-ist juba meetrites (36492) — vahe pole ilmne enne kui
neid kõrvutada.

### Ilmatieteen laitos (FMI) — `providers/fmi.ts`

| | |
|---|---|
| Otspunkt | `opendata.fmi.fi/wfs` (WFS 2.0, salvestatud päringud) |
| Võti | **ei vaja** — kontrollitud päris päringutega, kõik kolm vastavad 200-ga |
| Litsents | CC BY 4.0 |
| Katvus | Soome laht, Ahvenamaa, Saaristomeri; poid ja mareograafid kuni Perämereni |

Täidab tühimiku, mille METOC ja Ilmateenistus jätavad: nemad lõpevad Eesti
rannikul, FMI katab Soome lahe põhjakalda.

Kolm salvestatud päringut, aga **üks vorming** (`multipointcoverage`), seega
ka üks parser:

| Päring | Mida annab | Mõõdetud |
|---|---|---|
| `fmi::observations::weather::multipointcoverage` | rannikujaamad (Utö, Nyhamn, Russarö, Kilpilahti sadam) | 64 jaama tuulega, 61 rõhuga, 44 nähtavusega |
| `fmi::observations::wave::multipointcoverage` | lainepoid (Suomenlahti, Pohjois-Itämeri, Suomenlinna) | 6 poid lainekõrgusega |
| `fmi::observations::mareograph::multipointcoverage` | veetase | 14 jaama |

**Vorming.** Kolm paralleelset loendit: `<gml:Point>` (jaama nimi ja
koordinaat), `<gmlcov:positions>` (read "lat lon unix_aeg") ja
`<gml:doubleOrNilReasonTupleList>` (sama arv ridu, veerud `<swe:field>`
järjekorras). Rida seotakse jaamaga **koordinaadi, mitte järjekorra kaudu** —
loendite järjestus ei ole sama ja järjekorrale toetumine annaks vaikselt vale
jaama väärtused.

Puuduv mõõtmine on sõna-sõnalt `NaN`. Iga välja jaoks võetakse **eraldi**
viimane mitte-NaN väärtus, sest parameetrid raporteerivad eri sammuga (tuul
10 min, veetemperatuur 1 h) — ühe "viimase rea" võtmine jätaks poole väljadest
tühjaks.

**Ühikuteisendus:** mareograaf annab veetaseme MILLIMEETRITES (mõõdetud 199,
302). Ilma teisenduseta näitaks kaart veetaset 199 meetrit. Sama lõks mis
METOC-il, ainult et seal olid sentimeetrid — kolm allikat, kolm eri ühikut,
mitte ükski neist meie oma. Nähtavus tuleb siin seevastu juba meetrites
(35239, 75000), erinevalt Ilmateenistusest, kes annab kilomeetrites.

**Kaks lõksu, mis maksid aega:**

- `weather` päring nõuab `bbox`-i. Ilma selleta vastab ta **200-ga ja
  `numberReturned="0"`**, mitte veaga — provider paistis töötavat, aga
  ilmajaamu ei tulnud ühtegi.
- Tundmatu nimi `parameters=` loendis annab **400 ja tapab terve päringu**,
  mitte ei jäta ühte veergu vahele (nt `TW_PT1H_AVG` `weather` päringus).
- `bbox`-i austab ainult `weather`. `wave` ja `mareograph` tagastavad kogu
  Soome jaamad sõltumata sellest — mõõdetuna kuni Kemi Ajos 65.7 N. Me ei
  filtreeri neid välja: Selkämeri ja Perämeri poid on ainsad mõõdetud lained
  sealkandis.

Kolm päringut käivad `Promise.allSettled` kaudu — ühe katkemine ei tohi
ülejäänud jaamu kaardilt kustutada.

---

## AIS — laevade asukohad

Kolm allikat, üks ühine register (`ais/registry.ts`). Positsioon liidetakse MMSI
järgi ja võidab värskeim ajatempel. Metaandmeid liidetakse väljade kaupa: ühe
allika tühi väärtus ei kustuta teiselt saadud nime, kutsungit, IMO numbrit,
lipuriiki, tüüpi, sihtkohta, ETA-t, süvist ega mõõtmeid. Nii võib sama laeva
värske asukoht tulla Transpordiametilt ja täielikum staatiline kirjeldus
Digitrafficult või aisstreamist. Ühe allika kadumine jätab teised tööle.

### Transpordiamet Nutimeri — `ais/transpordiamet.ts`

| | |
|---|---|
| Otspunkt | `gis.transpordiamet.ee/.../AIS-vessels-stream-out/StreamServer` |
| Võti | ei vaja |
| Katvus | Eesti kaldajaamade AIS-võrk |

ArcGIS WebSocketi tellimus piiratakse serveris `AIS_BBOX` ristkülikuga. Kuna
StreamServer võib ühenduse avamise ja filtri rakendumise vahel juba sõnumeid
saata, kontrollib provider sama ala ka lokaalselt. Voog taasühendub katkestuse
järel eksponentsiaalselt kasvava ootega. Vaikimisi ala `53,9,66,31.5` katab
kogu Läänemere Taani väinadest Botnia lahe põhjaosani.

### Fintraffic Digitraffic — `ais/digitraffic.ts`

| | |
|---|---|
| Otspunktid | `meri.digitraffic.fi/api/ais/v1/locations`, `/vessels` |
| Võti | ei vaja |
| Litsents | CC BY 4.0 |
| Katvus | Soome AIS-jaamade ulatus — Soome laht ja Põhja-Läänemeri |

Kaks nõuet, mille eiramine annab **406**:
- `Digitraffic-User` päis (kasutustingimus, mitte autentimine)
- gzip pakkimine peab olema lubatud

Eesti põhjarannik on kaetud. **Liivi laht ja Väinameri EI OLE.**

### aisstream.io — `ais/aisstream.ts`

| | |
|---|---|
| Otspunkt | `wss://stream.aisstream.io/v0/stream` |
| Võti | **jah** — `AISSTREAM_KEY`, vt [api-keys.md](api-keys.md) |
| Katvus | globaalne, sh Liivi laht ja Väinameri |

WebSocket, mitte REST. Tellimussõnum tuleb saata 3 s jooksul ühenduse
loomisest. Beeta ilma SLA-ta — kukkumine on normaalne, mitte erand; klass
taasühendub eksponentsiaalselt kasvava ootega.

Tellimus sisaldab nii Class A teateid (`PositionReport`, `ShipStaticData`) kui
ka väikelaevade jaoks olulisi Class B ja type 24 teateid
(`StandardClassBPositionReport`, `ExtendedClassBPositionReport`,
`StaticDataReport`). Ainult Class A filtriga jääks suur osa sadamate
väikelaevadest nähtamatuks või ilma nimeta.

Ilma võtmeta on see lihtsalt välja lülitatud ja AIS töötab Transpordiameti ning
Digitraffici najal.

### AIS-i "teadmata" sentinelid

AIS kodeerib puuduvad väärtused skaala ülemise otsana, mitte tühjana:

| Väli | Sentinel | Tähendus |
|---|---|---|
| SOG | 1023 (= 102.3 sõlme) | kiirus teadmata |
| COG | 3600 (= 360.0°) | kurss teadmata |
| Heading | 511 | vööri suund teadmata |

Kõik providerid tõlgivad need puuduvaks väärtuseks. Ilma selleta näitaks
kaart sadamas seisvat laeva 102-sõlmese kiirusega.

---

## Navigatsiooniohutus ja ametlikud merendusobjektid

Transpordiameti avalikud ArcGIS-teenused täiendavad merekaarti nelja valikulise
andmerühmaga. `/api/navigation` võtab alati bbox'i ja `include` loendi, nii et
server ei tõmba ega saada väljalülitatud kihte.

| Kiht | Allikas | Uuendamine |
|---|---|---|
| Navigatsioonihoiatused | `Navigatsioonihoiatused/Nav_hoiatused_avalik/FeatureServer`, kihid 7–9 | 2 min vahemälu; aegunud hoiatused filtreeritakse välja |
| AIS navigatsioonimärgid | `AIS-aton-stream-out/StreamServer/subscribe` | püsiv WebSocket; klient küsib serveri registrit iga 30 s |
| Vrakid | `HIS/HIS_avalik/MapServer`, kiht 7 | 24 h vahemälu |
| Ametlikud laevateed ja püsi-, ujuv- ning hooajalised märgid | `Nutimeri/pohiandmed/MapServer`, kihid 0–3 | 24 h vahemälu |

AIS AToN ühendatakse koordinaadi järgi sama füüsilise registrimärgiga; virtuaalne
AIS-märk jääb alati eraldi. Ametlikud laevateed ja märgid võivad ENC merekaardi
sisu dubleerida, mistõttu nende kiht on vaikimisi väljas. Hoiatused ja reaalaja
AIS-märgid on vaikimisi sees.

Sama Nutimeri teenuse sadamakiht 4 rikastab `/api/harbours` OSM-i kirjeid.
Esmane ühendusvõti on normaliseeritud UN/LOCODE (`EE RST` = `EERST`), seejärel
nimi ja asukoht. Nii jääb näiteks Ristna või Alliklepa kaardile ühe markerina:
OSM-ist tulevad kontaktid ja teenused, ametlikust registrist süvis ja registrilink.

---

## Kaardikihid

Kõik ilma võtmeta. MapTiler/Mapbox on sihilikult VÄLDITUD, et rakendusel
poleks ühtki kvooti ega võtmesõltuvust.

| Kiht | Allikas | Märkus |
|---|---|---|
| Aluskaart (värviline) | `tiles.openfreemap.org/planet` (vektor) | Oma stiil `web/src/map/colorBase.ts`. OSM-i rasterpaanid asendatud: nende palett on maismaakeskne (kollased teed, roheline mets) ja meri jääb lameda laiguna tagaplaanile |
| Tume aluskaart | `tiles.openfreemap.org/planet` (vektor, OpenMapTiles skeem) | Valevärvi-välja alla. Oma stiil `web/src/map/darkBase.ts`: vesi tume, maa heledam. **Vektor on siin nõue, mitte eelistus** — vt allpool |
| Merekaart (EE) | `gis.transpordiamet.ee/primar/wms_ip/TranspordiametNutimeri` | WMS, `layers=cells&styles=style-id-263`, bounds 57.45–60.1 N |
| Merekaart (FI) | `julkinen.traficom.fi/s57/wms`, `layers=cells`, `styles=style-id-203` | WMS, läbipaistva maismaaga |
| Navigatsioonimärgid | `tiles.openseamap.org/seamark/` | globaalne |
| Sügavused | `ows.emodnet-bathymetry.eu/wms` | |
| Ilmaradar | `ilmgs.envir.ee/geoserver/ilm/wms`, `layers=ilm:cmp_cap` | Eesti |

### Navily kaart

Sadamapopupi Navily link avab alati koordinaadivaate
(`/carte/place/<lat>/<lon>`). Nii näeb kasutaja enne sadama valimist ka ümbrust,
lähedasi sadamaid ja ankrukohti. Rakendus ei otsi ega talleta Navily sadama-ID-sid,
kataloogiandmeid või kasutajate loodud sisu ning selleks ei tööta eraldi
taustaskannerit.

---

## Kaalutud, aga kasutamata

**AISHub** (`data.aishub.net`) — tasuta, aga liikmelisus nõuab oma AIS-vastuvõtja
NMEA-voo jagamist (≥10 laeva, ≥90% uptime). Praktikas tähendab see riistvara
(dAISy / RTL-SDR) püsivalt võrgus. Mõttekas ainult siis, kui aisstreami katvus
Liivi lahes osutub kehvaks ja oled nõus vastuvõtja püsti panema.

**gis.ee/meri** — sarnane olemasolev rakendus (Merekaart). Nende endi otspunkte
(`api.gis.ee`, `ais.gis.ee`, `data.gis.ee`) me EI kasuta — need on nende
privaatne backend. Läheme alati algallikale. Sealt leidsime aga ülal loetletud
ametlikud kaardikihid.

### Miks Soome merekaart vajab proxyt

`einavigointiin.fi` saadab paani, aga ei saada `Access-Control-Allow-Origin`
päist, kui päringul on `Origin`. MapLibre laeb rasterpaane `crossOrigin`-iga,
sest WebGL peab pikslitele ligi pääsema — seega brauser tõmbab paani alla ja
viskab kohe minema. Sümptom on eksitav: võrgusakil on päringud edukad, kaardil
pole midagi ja konsool vaikib.

Mõõdetud (localhost:5174, paan `10/582/297`):

| Katse | Tulemus |
|---|---|
| `curl` | 200, `image/png` — curl ei saada `Origin`-it, seega CORS-i ei kontrollita |
| `fetch()` | Failed to fetch |
| `fetch(mode:'no-cors')` | opaque, status 0 |
| `<img>` ilma `crossOrigin`-ita | ok, 256×256 |
| `<img crossOrigin="anonymous">` | viga (kõigil neljal proovitud paanil) |
| kiht kaardil | 48 paanipäringut, 0 pikslit |

Pärast proxyt: 48 paani, kõik 200, `crossOrigin` loeb pikslid, katvus 100%.

Eesti ja Soome navigatsioonikaart lülituvad kasutajale ühe kihina. Soome ENC
kasutab sama Traficomi läbipaistva maismaaga WMS-stiili nagu Nutimeri; see
lubab Eesti WMS-il piirialal alt läbi paista ega kata Eestit valgete XYZ
paanidega. Mõlemad WMS-id saadavad CORS-i ja töötavad brauserist otse.

### Tume aluskaart: miks vektor

Valevärvi-väli vajab kaht asja korraga: vesi peab olema maast TUMEDAM (väli
joonistatakse merele ja vajab kontrasti) ja sadamad peavad jääma näha —
akvatooriumid, muulid, kaid.

Rasterpaanistikuga on see võimatu: `raster-saturation` ja `raster-brightness`
mõjuvad tervikpildile, vett ja maad eraldi puutuda ei saa. Mõõtsime neli
võtmevaba paanistikku (keskmine heledus 256x256 paanilt, z8, avameri
58.5/20.0 vs sisemaa 58.6/25.8):

| Paanistik | Meri | Maa | Otsus |
|---|---|---|---|
| CARTO `dark_nolabels` | 38 | 11 | detailne, aga vesi HELEDAM kui maa |
| CARTO `light_nolabels` | 217 | 247 | vale suund ja liiga hele |
| Esri Ocean Base | 207 | 231 | liiga hele |
| Esri Dark Gray Canvas | 35 | 70 | õige suund, aga ÜLDISTATUD — sadamaakvatooriume pole |

Ükski ei anna mõlemat. Vektorkaardil on vesi oma kihina olemas, seega
määrame värvi ise ja kogu OSM-i detail jääb alles. Allikas on **OpenFreeMap**
(OpenMapTiles skeem) — võtmeta ja kvoodita, nagu kõik ülejäänud allikad siin.

Stiilis on sihilikult ainult viis kihti: maa (taust), vesi, veeteed, muulid
(`transportation`, `class=pier`) ja hooned alates z14. Silte ei ole — need
tuleksid valevärvi-välja alt loetamatult ja rakendusel on oma sildikihid.

Kontrollitud Kakumäe sadamas (z14): 23 veeobjekti ja 8 muuli.
