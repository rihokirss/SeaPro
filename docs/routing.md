# Automaatmarsruutimine

SeaPro v1 automaatmarsruut leiab staatilise A–B tee Eesti ja Soome merealal.
Eesmärk on esmalt välistada masinloetavalt teadaolevad ohud ja seejärel
minimeerida tee pikkust. Ilm, lained, hoovus ja kütusekulu arvutatakse leitud
joonele olemasoleva marsruudianalüüsi kaudu, kuid need ei muuda veel otsingu
kaalu ega käivita reaalajas ümbermarsruutimist.

> SeaPro tulemus on nõuandev. See ei ole sertifitseeritud navigatsioonisüsteem
> ega taga vee sügavust, piirangu õiguslikku tõlgendust või ajutise ohu
> puudumist. Kontrolli teed alati ajakohaselt ametlikult merekaardilt ja
> mereteadetest.

## Aluse eelseadistus ja kodusadam

Kiirus, kütusekulu, süvis, kiilualune varu, laius ja kõrgus veeliinist on
marsruudivaatest eraldatud aluse eelseadistusse. Marsruudipaneel näitab neist
ainult kompaktset kokkuvõtet. Eelseadistus rakendub uuele marsruudile ja
asendab salvestatud marsruudi avamisel selle varasemad aluse parameetrid;
muutunud ohutusparameetrite korral tuleb automaatmarsruut uuesti arvutada.

Samasse eelseadistusse saab sadamaotsingust valida kodusadama. Kui kodusadam
on määratud, saab selle A/B otspunkti valikus ühe nupuga algus- või
lõpp-punktiks panna.

Aluse nimi, parameetrid ja kodusadam salvestatakse ainult kasutaja brauseri
`localStorage`-isse võtmega `seapro.vesselProfile.v1`. Eraldi serveripoolset
aluseprofiili ei looda. Marsruudi arvutamisel saadetakse serverile siiski
allpool kirjeldatud ohutus- ja sõiduparameetrid, sest neid on marsruudi
läbitavuse hindamiseks vaja.

## Sisend ja väljund

`POST /api/route-plan` võtab:

```json
{
  "start": { "lat": 59.49, "lon": 24.66 },
  "end": { "lat": 59.57, "lon": 24.62 },
  "departureTime": "2026-08-08T20:00:00+03:00",
  "speedKnots": 8,
  "draughtM": 1.2,
  "underKeelClearanceM": 0.5,
  "beamM": 3.5,
  "airDraughtM": 4
}
```

Edukas vastus on `status: "route"` või `status: "advisory"` ja sisaldab:

- GeoJSON `geometry`, mida kaart ja ilmaanalüüs tegelikult järgivad;
- kuni 100 kordusvalideeritud `navigationWaypoints` punkti;
- `segments`, kus igal lõigul on hinnang `clear`, `caution` või `unknown`,
  vähim teadaolev sügavus, põhjus ja allika-ID;
- algse ja kuni 1 NM ulatuses läbitavale veele kleebitud A/B-punkti;
- snapshot'i ID, genereerimisaja, allikate vanuse/katvuse ja märkused.

Sadamaregistri mõõtmepiirang (HIS `max_laev_syv`/`max_laev_lai`) ei anna
`no_route`: registrikirjed on kohati aegunud või kirjeldavad väikseimat
kaikohta. Kui laev ületab otspunkti sadama avaldatud limiidi, siis tuletatud
sadamakanalit ei ehitata (registrisüvis ei või avada EMODneti madalat vett),
otspunkt kleebitakse tavalise veepunktina ja vastus on vähemalt `advisory`
koos kriitilise `harbour_draught_limit`/`harbour_beam_limit` märkusega.
Kapten kontrollib sadama tegelikku sügavust ja gabariiti ise.

Kui masinloetavate andmete järgi läbitavat ühendust või lähedast läbitavat
otspunkti ei leita, on vastus `status: "no_route"`; sadamalimiidi märkus jääb
ka siis konteksti selgituseks kaasa. See on tavaline 200-vastus
koos põhjustega. Kui terve
baaskiht (EMODneti sügavus või OpenFreeMapi veemask) pole kättesaadav,
tagastab API 503 `data_unavailable`; tühi vastus ei lähe kunagi arvesse kui
"ohutu vesi".

## Snapshot'i kihid

| Prioriteet | Andmed | Kasutus |
|---|---|---|
| 1 | Transpordiameti HIS: kivid, takistused, vrakid, füüsilised märgid, laevateed ja mõõtealad | Ametlik oht blokeerib; ruumiliselt piiritletud ja laevale sobiv ametlik sügavus võib üldistatud DTM-i täpsustada. |
| 1 | Transpordiameti ja Traficomi kehtivad navigatsioonihoiatused | Eesti ja Soome punkt-, joon- ning alahoiatused lisavad marsruudile ettevaatusjälje; sulgemise, keelu või ohuna sõnastatud teade märgitakse kriitiliseks. Mõlemat allikat värskendatakse kahe minuti kaupa. |
| 1 | Väylävirasto WFS: väyläalad ja navigatsioonijooned, piirangud, `taitorakenteet:silta` veetee kõrgus, kanalirajatised, märgid ja AToN rikked | Laeva süvise, laiuse ja kõrguse kontroll; aktiivsed keelud ning ajutised rikked. Rikked värskendatakse staatilistest kihtidest eraldi kahe minuti kaupa. `mitoitussyvays` on projekteeritud süvis, mitte mõõdetud sügavus; füüsiliseks haraussügavuseks loetakse ainult `haraussyvyys`. |
| 2 | EMODnet Bathymetry WCS `emodnet:mean` | Põhiline sügavusvõre. NoData säilib eraldi seisundina. |
| 2 | OpenFreeMap/OpenMapTiles `water` vektor | Maa/vee mask koos rannajoone ja saarte aukudega. |
| 3 | OpenStreetMap/OpenSeaMap Overpass | Kivid, vrakid, sillad, TSS, soovituslikud teed ja liiklusrajad. Ühiskondlik koridor ei kirjuta ametlikku ohtu ega ebapiisavat sügavust üle. |

Visuaalset ENC WMS-i ei loeta pikslitest ega kasutata otsingupiiranguna. Selle
sümboloogia on mõeldud inimesele ja pole usaldusväärne masinloetav
objektiandmestik.

## Kulud ja tõkked

Otsing töötab kohalikul ligikaudu ruutmeetrilisel, ala suuruse järgi
adaptiivsel võrel. Rakendatav kuluhierarhia on:

| Lahter | Kordaja |
|---|---:|
| sobiv ametlik või soovituslik koridor teadaolevalt läbitavas vees (mitte TSS) | 0,7× |
| teadaolevalt piisava sügavusega vesi | 1× |
| alla 0,5 m lisavaru või kontrollitav läbipääsupiirang | 5× |
| puuduv sügavus/veemask, teenindusmaskist väljumine või osaline ametlik ohukiht | 25× |
| AToN rike, tõendamata ühesuunaline TSS, tundmatu silla gabariit või mitte-ametlik piiranguala | 50× |

Kõva tõke on vektorrannajoon, ametliku koridoriga kinnitamata DTM-maa,
teadaolevalt ebapiisav sügavus, ohu puhver, ametlik üldine liikluskeeld või
laeva gabariidile sobimatu sild/lüüs. Kivi, takistuse, vraki või füüsilise
märgi puhver on:

```text
laeva_laius / 2 + max(objekti_raadius, allika_ebatäpsus, võrelahtri_pooldiagonaal)
```

Soome `taitorakenteet:silta` avaldab silla veetee kõrguse punktgeomeetrial.
Kui laev on sellest kõrgem, kasutatakse punkti ümber 500 m konservatiivset
tõkkepuhvrit; rannajoon aitab kitsas kanalis takistuse sulgeda. See ei asenda
silla span'i kontrolli ametlikult kaardilt.

Teadaolevalt piisavalt sügaval oleva veealuse objekti lähedus ei blokeeri,
kuid saab 5× ettevaatuskulu. Tundmatu vähima sügavusega objekt blokeerib.
Virtuaalseid AIS AToN-e füüsilise takistusena ei kasutata.

Iga võrelahtri sügavust ja vee-/maamaski kontrollitakse keskpunktis ning
kaheksas serva lähedases punktis. Üks maa- või madalavee proov blokeerib terve
lahtri; puuduv proov muudab selle tundmatuks. See vähendab lahtrikeskmete vahele
jäävate kitsaste saarte ja madalike riski, kuid ei loo lähteandme
resolutsioonist täpsemat teadmist. Ametlik sügavus saab DTM-i väärtust
täpsustada ainult lahtris, mille kõik üheksa punkti on avaldatud väyläala või
tegeliku avaldatud laiuse sees.

TSS-i kohalikku sõidusuunda v1 positsioonipõhine otsinguolek ei tõenda.
Seetõttu ei nimetata TSS-i läbimist automaatselt õigeks suunaks ega anta sellele
eelistuskulu: ühesuunaline rada saab 50× ja muu liiklusrada 5× kulu ning tulemus
on alati `advisory`. Kapten peab skeemi, kurssi ja COLREG-i kohaldamist ise
kontrollima.

## Otsing ja kordusvalideerimine

Marsruut leitakse deterministliku kaheksanaabrilisel võrel töötava A*-ga.
Otsing kontrollib kogu planeerimisala, et kiire lokaalne koridor ei peidaks
väiksema riskiga varianti. Diagonaalis ei tohi kahe blokeeritud nurga vahelt läbi
pressida. Otsingul on ajapiir ja laiendatud sõlmede piir; ebaõnnestumisel ei
tagastata sirgjoonelist varuteed.

Leitud trepijoon lihtsustatakse line-of-sight kontrolliga. Iga otsetee
rasterdatakse uuesti samal snapshot'il, ei tohi läbida blokki, halvendada
riskiklassi, tuua sisse uut ohupõhjust ega ületada lubatud kulukasvu.
Kulukasvu piiril on lisaks suhtarvule väike absoluutne varu, mis silub
võreotsingu „murdumis-jõnksud" kulupiiridel (nt TSS-i raja ees) ilma
marsruuti sisuliselt ümber kujundamata. Pika
sirglõigu `clear`/`caution`/`unknown` piirid tuletatakse lahtrite kaupa ja
lisatakse ka GeoJSON-i joonele. Kaardi geomeetria ja navigeerimise
kontrollpunktid kirjeldavad sama valideeritud joont.

Enne vastust proovitakse valmis joont veel 10 m sammuga otse vee-/maamaski ja
sügavusrasteri vastu. Vahele jäänud maa või ebapiisav sügavus muudab tulemuse
`no_route`; vahepealne NoData muudab seda sisaldava riskilõigu `unknown`-iks.
Ametliku väylä sees kehtib seejuures sama ruumiliselt piiratud ametliku
haraussügavuse/projekteeritud süvise erand. Kontroll ei saa olla täpsem kui
lähteraster ise.

Kui esmane otsing annaks `no_route`, kontrollib planner enne vastamist odavalt,
kas ühenduse võis sulgeda jämeda võreraku sees segunenud sügav ja madal proov.
Ajutine kontroll ei ava ametlikku piirangut, ohtu ega täielikult madalat või
maismaal asuvat rakku. Ainult võimaliku ühenduse korral korratakse kogu ranget
otsingut sama snapshot'i peal kuni kaks korda väiksema lahtrisammuga (kuni
2 400 000 lahtrit, alumine siht 37,5 m). Peenvõres kehtib endiselt üheksa
proovi miinimum ning tulemus läbib sama 10 m lõppkontrolli; uut EMODneti
võrgupäringut ei tehta. Edukas esmane marsruut peenvõre kulu ei maksa.

## Piirid ja konfiguratsioon

Vaikeala ning ressursipiirid on `.env` kaudu muudetavad:

```dotenv
ROUTING_BBOX=57.45,18.75,66.2,28.45
ROUTING_MAX_DISTANCE_NM=500
ROUTING_PLAN_TIMEOUT_MS=90000
ROUTING_MAX_CONCURRENT_PLANS=2
ROUTING_SEARCH_TIMEOUT_MS=45000
ROUTING_SEARCH_MAX_NODES=1000000
ROUTING_TIMINGS_LOG=0
ROUTING_PREWARM=0
CACHE_MAX_MEMORY_MB=192
CACHE_MAX_PERSISTED_ENTRY_MB=8
```

Kui `ROUTING_PREWARM=1`, soojendab server tunnise kontrolltsükliga Eesti
rannikumere, Soome lahe ja Edela-Soome kanoonilised 1° staatilised
routingupaanid. Eelisjärjekorras on Soome laht ja Edela-Soome; pärast päris
marsruuti lisatakse järjekorda ka selle bbox'i naaberpaanid. Taustatöö ei lae
EMODneti sügavusrasterit ega kaheminutilisi navigatsioonihoiatusi/AToN-rikkeid
ning ei alusta uut paani aktiivse autoroute'i ajal.
Staatiliste Transpordiameti, Väylävirasto ja OSM/OpenSeaMapi routingupaanide
TTL on seitse päeva; tunnine kontroll laadib uuesti ainult aegunud või puuduva
paani. Dünaamiliste hoiatuste ja AToN-rikete TTL jääb kaheks minutiks.

Kiirust mõõdetakse korratavalt `server/scripts/bench-routing.ts` abil:
`capture` külmutab elusa snapshot'i `data/bench/` alla, `run` kordab
planeerimist võrguta ja deterministlikult koos faasiaegadega ning
`compare` on optimeerimiste regressioonivärav (geomeetria räsi peab
klappima või kulu olema võrdne). `ROUTING_TIMINGS_LOG=1` logib samad
faasiajad iga päris päringu kohta.

Ristkülik on ainult serveri kõva ressursipiir. Selle sees rakendub lisaks
konservatiivne Eesti ja Soome rannikumere teenindusmask; mask ei ole
merepiiri/jurisdiktsiooni kaart. Väljaspool maski olevat otspunkti API vastu ei
võta ning otsingus maskist väljuv lahter jääb `unknown`. Nii ei saa näiteks
Rootsi või Läti marsruut üksnes globaalse EMODnet/OSM katvuse tõttu näida
ametlikult kontrollituna.

Pikema või väga suure pindalaga tee adaptiivne võre on jämedam. Kui
resolutsioon ei võimalda kitsast läbipääsu ohutult tõendada, on õige tulemus
`no_route`, mitte oletuslik läbipääs.

Otsingukast ulatub A/B piirdekastist vähemalt 5 NM ja tavaliselt 25% otsese
kauguse võrra väljapoole (kuni 40 NM), et saartest möödumine ei jääks kohe
serva taha. V1 ei tee pärast `no_route` tulemust automaatselt teist, veel
suurema ala päringut; sellisel juhul võib kasutaja valida vahepunkti või
lühema etapi.
