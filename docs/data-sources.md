# Andmeallikad

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

**Päringueelarve on siin kriitiline.** Open-Meteo loeb mitmepunktilise päringu
IGA PUNKTI eraldi API-kutseks. 16×16 võrgustik = 256 kutset ühe kaardikaadri
kohta, tunnilimiit on 5000. Arenduses jooksis see täis paari tunniga ja kogu
tuulekiht kadus ilma vihjeta põhjusest. Kolm kaitset:

1. `GRID_MAX_STEPS = 8` — üks kaader maksab kuni 64 kutset
2. bbox kleebitakse ruudustikule (`routes/api.ts:snapBbox`) — lähestikused
   vaated jagavad ühte vahemälukirjet
3. `rateLimit.ts` peatab päringu ise 3000 kutse juures tunnis

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

---

## AIS — laevade asukohad

Kaks allikat, üks ühine register (`ais/registry.ts`). Liidetakse MMSI järgi,
võidab värskeim ajatempel. Kumbagi kadumine jätab teise tööle.

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

Ilma võtmeta on see lihtsalt välja lülitatud ja AIS töötab Digitraffici najal.

### AIS-i "teadmata" sentinelid

AIS kodeerib puuduvad väärtused skaala ülemise otsana, mitte tühjana:

| Väli | Sentinel | Tähendus |
|---|---|---|
| SOG | 1023 (= 102.3 sõlme) | kiirus teadmata |
| COG | 3600 (= 360.0°) | kurss teadmata |
| Heading | 511 | vööri suund teadmata |

Mõlemad providerid tõlgivad need puuduvaks väärtuseks. Ilma selleta näitaks
kaart sadamas seisvat laeva 102-sõlmese kiirusega.

---

## Kaardikihid

Kõik ilma võtmeta. MapTiler/Mapbox on sihilikult VÄLDITUD, et rakendusel
poleks ühtki kvooti ega võtmesõltuvust.

| Kiht | Allikas | Märkus |
|---|---|---|
| Aluskaart | `tile.openstreetmap.org` | |
| Tume aluskaart | `services.arcgisonline.com/.../Canvas/World_Dark_Gray_Base` | Valevärvi-välja alla. **Nõue: vesi tumedam kui maa.** Mõõdetud keskmine heledus z8 (avameri 58.5/20.0 vs sisemaa 58.6/25.8): Esri Dark Gray meri 35 / maa 70 ✅; CARTO `dark_nolabels` meri 38 / maa 11 ❌; CARTO positron 217/247 ❌; Esri Ocean 207/231 ❌. URL on `{z}/{y}/{x}`. ⚠ Esri litsentsitingimused kontrollimata — vt allpool |
| Merekaart (EE) | `gis.transpordiamet.ee/primar/wms_ip/TranspordiametNutimeri` | WMS, `layers=cells&styles=style-id-263`, bounds 57.45–60.1 N |
| Merekaart (FI) | `einavigointiin.fi/map/{z}/{x}/{y}` | **CORS puudub → käib meie proxy kaudu** (`/api/tiles/chart-fi/{z}/{x}/{y}`) |
| Navigatsioonimärgid | `tiles.openseamap.org/seamark/` | globaalne |
| Sügavused | `ows.emodnet-bathymetry.eu/wms` | |
| Ilmaradar | `ilmgs.envir.ee/geoserver/ilm/wms`, `layers=ilm:cmp_cap` | Eesti |

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

Eesti merekaart tuleb WMS-ilt, mis CORS-i saadab, ja töötab seetõttu otse.

### Tume aluskaart ja Esri litsents

Valevärvi-väli vajab tumedat vett: väli joonistatakse merele ja tume taust
annab talle kontrasti, rannajoon peab samal ajal loetavaks jääma. Rasterkihil
saab muuta ainult küllastust ja heledust tervikuna, seega vett ja maad eraldi
puutuda ei saa — valik peab tulema paanistikust endast.

Mõõtsime nelja võtmevaba kandidaati (keskmine heledus 256x256 paanilt, z8):

| Paanistik | Meri | Maa | Sobib |
|---|---|---|---|
| Esri Dark Gray Canvas | 35 | 70 | ✅ maa 2x heledam, kaart jääb tumedaks |
| CARTO `dark_nolabels` | 38 | 11 | ❌ vale suund |
| CARTO `light_nolabels` | 217 | 247 | ❌ vale suund ja liiga hele |
| Esri Ocean Base | 207 | 231 | ❌ liiga hele |

⚠ **Lahtine küsimus:** Esri paaniteenus on avalikult ligipääsetav ja annab
`copyrightText`-i ("Esri, HERE, Garmin, © OpenStreetMap contributors"), mille
me omistuses ka kuvame, aga Esri kasutustingimused nõuavad osade
aluskaartide puhul ArcGIS-i kontot. Me ei ole seda kontrollinud. Kui see
osutub piiravaks, tuleb otsida asendus — ükski mõõdetud võtmevaba CARTO
variant nõuet ei täida.
