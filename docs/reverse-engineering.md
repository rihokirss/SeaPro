# Reverse-engineeritud allikad

Kolm allikat üheksast ei ole lepingulised API-d, vaid parsitud avalikud lehed
või failid. See dokument kirjeldab, MIS neis täpselt parsitakse, et parandus
oleks kiire, kui allikas oma kuju muudab.

**Ühine reegel:** parser, mis ei saa andmeid kätte, peab viskama valju vea, mitte
tagastama vaikselt tühja vastust. Tühi vastus näeb kasutajale välja nagu
"tuult pole" — mereilmarakenduses on see ohtlikum kui nähtav veateade.
`routes/api.ts` eristab `kind: 'parse'` ja `kind: 'unavailable'` vigu ning UI
näitab neid erinevalt: "vajab parandust" vs "ajutiselt kättesaamatu".

---

## 1. TalTech METOC

`server/src/providers/metocTaltech.ts`

### Jaamade nimekiri

Jaamad on peidetud portaali HTML-i sisse genereeritud JavaScripti. Iga jaama
kohta üks plokk:

```js
var map_marker = new google.maps.Marker({ map: gmap,
  position: new google.maps.LatLng(58.036666666667, 24.456111111111),
  icon: circle_green });
...
$.ajax({ url: 'infowindow.php', type: 'post', data: { 'station': 'haademeeste' } ... })
```

Markerite ja slugide järjekord ON sama — skript kontrollib seda ja keeldub
tulemust kirjutamast, kui arvud ei klapi.

Ikoon kodeerib tüübi: `circle_*` = rannikujaam, `rectangle_*` = avamerejaam.

Genereeri: `npx tsx scripts/scrape-metoc-stations.ts` → `src/stations/metoc.json`
(36 jaama). Muutub ehk paar korda aastas.

### Mõõteväärtused

`POST infowindow.php` kehaga `station=<slug>` tagastab HTML-tabeli:

```html
<tr><td align=right>Last data:</td><td>27.07.2026 20:10</td></tr>
<tr><td align=right><a ...>Wind speed / gust</a>:</td><td>0.9 / 1.4 m/s</td></tr>
<tr><td align=right><a ...>Sealevel (EH2000 / BK77)</a>:</td><td>+43 / +19 cm</td></tr>
```

Sildilahtris on `<a>`-link (graafiku avamiseks), seega sildist eemaldatakse
kõik tagid enne sobitamist. Sildid sobitatakse **prefiksi järgi**, et sulgudes
olev täpsustus ei lõhuks parserit.

**Kaks lõksu:**

- **Veetase on sentimeetrites** ja kahes süsteemis ("+43 / +19 cm").
  Võtame EH2000 (esimese) ja korrutame 0.01-ga. Ilma selleta näitaks kaart
  43-meetrist veetaset.
- **Aeg on Eesti kohalikus ajas**, mitte UTC-s. Teisendame `Intl` abil, et
  suveaja üleminek ei tekitaks tunniviga.

Alternatiiv `get_param_value.php` (`site=kihnu&param=wind_speed` → `4.9;6.0;213`)
on olemas, aga nõuaks iga parameetri kohta eraldi päringut ega ütleks, kui vana
väärtus on. Seetõttu kasutame `infowindow.php`-d.

**Server on vana** (Apache 2.2 / PHP 5.3). 36 jaama × iga kasutaja oleks
julm — pärime taustal ühe korra 4 minuti jooksul, järjestikku, sõltumata
kasutajate arvust.

---

## 2. LainePoiss

`server/src/providers/lainepoiss.ts`

Tehniliselt lihtsaim allikas: konfiguratsioon on JSON, andmed on tekstifail.

### Konfiguratsioon

`GET /dashboard/buoys_conf.json`:

```json
{ "no": 15, "name": "15 - Pakri", "directory": "../lp_data/LP_15/",
  "show": true, "active": false, "showDataFrom": null, "showDataTo": null }
```

Kataloog tuleb VÕTTA konfiguratsioonist, mitte numbrist kokku panna — see on
portaali enda otsustada.

### Mõõtmised

`GET /lp_data/LP_<n>/web.txt`, tühikutega eraldatud, 10 veergu, read `\r\n`:

```
2026-07-27 16:01:55 59.3911 24.0698 0.272 0.505 2.964 310 316 4.07
   0          1        2       3      4     5     6    7   8   9
```

| # | Väli | Märkus |
|---|---|---|
| 0-1 | kuupäev, kellaaeg | UTC |
| 2-3 | lat, lon | **poi tegelik asukoht praegu** |
| 4 | Hs | oluline lainekõrgus, m |
| 5 | Hmax | võib olla `NaN` |
| 6 | Tp | tipuperiood, s |
| 7 | Pdir_naut | tipplaine suund |
| 8 | mean_dir | võib olla `NaN` |
| 9 | aku pinge | ei kasuta |

Veergude tähendus on kinnitatud portaali enda skriptist (`lp_script.js` loeb
`cols[5]` = Hmax, `cols[7]` = Pdirnaut, `cols[8]` = meandir).

**Neli lõksu, kõik päris andmetest leitud:**

1. **Positsioon tuleb andmereast.** Poi triivib ankru otsas ja teda tõstetakse
   hooajati ümber — konfiguratsioonis staatilist koordinaati polegi.
2. **`NaN` sõna-sõnalt.** Poi 35 raporteerib `NaN` Hmax ja mean_dir väljadel.
3. **Surnud paigaldused.** Konfiguratsioonis on poisid aastatest 2022–2023
   (Atlandi ookean, Ålesund, Kihnu), mille failid on alles ja mille viimased
   read parsitakse edukalt. Läänemere kaardil oleks nende näitamine otsene
   eksitus — filtreerime välja kõik, mille viimane mõõtmine on vanem kui 48 h.
4. **Rikutud ajatemplid.** Üks poi raporteeris kuupäeva **aastal 2226**. Ilma
   kontrollita tõuseks selline rida "kõige värskemaks" ja kuvaks vale mõõtmise
   praegusena. Viskame kõrvale kõik, mis on üle tunni tulevikus.

Kaks konfiguratsioonis olevat poid (24 MARTE, 28) vastavad **404**-ga — nende
andmefaili ei olegi. `Promise.allSettled`, mitte `Promise.all`, muidu kustutaks
üks selline kogu poide võrgu ekraanilt.

---

## 3. Windfinder

`server/src/providers/windfinder.ts`

⚠ Kõige hapram allikas. Ametlik API on tasuline B2B-teenus; parsime avalikku
lehte. `/forecast/<spot>` on nende robots.txt-i järgi lubatud — keelatud on
`/api/`, `/widget/forecast/`, `/share/forecast/` ja `*/print`.

### Spotinimekiri

Windfinderi URL-id töötavad **ainult nimeliste spottidega**; koordinaadipõhine
`/weatherforecast/59.400,24.600` vastab 404-ga. Koordinaate leht ei avalda.

Lahendus: iga prognoosileht lingib naaberspotte, seega ristleme seemnepunktidest
laiuti ja geokodeerime slugid Nominatimi abil.

```
npx tsx scripts/scrape-windfinder-spots.ts   →  src/stations/windfinder-spots.json
```

Tulemus (46 spotti pärast dubleerimise eemaldamist) tuleb ÜLE VAADATA —
automaatgeokodeerimine eksib samanimeliste kohtadega ja nimekirjas on ka
sisemaiseid punkte (lennuväljad, alevikud). Seepärast on provideris
`MAX_SPOT_DISTANCE_KM = 25`: avamerepunkti kohta ei tohi tagastada sisemaise
koha tuult.

### Prognoosilehe parsimine

Leht on Astro + CSS-moodulid, mis tähendab **hašitud klassinimesid**:

```html
<div class="_cell-direction_1swh1_230 ..."><img alt="171.94°" style="...rotate(171.94deg)"></div>
<div class="_cell-wind-speeds_1swh1_235">
  <div class="_data-major_1swh1_278 ...">4 m/s</div>
  <div class="_data-minor_1swh1_284 ...">max 7</div>
</div>
```

Järelliide `_1swh1_235` **muutub iga nende deploy'ga**. Sobitame ainult
prefiksi (`_cell-wind-speeds_`, `_data-major_`, `_data-minor_`,
`_cell-direction_`) — see osa tuleb CSS-mooduli failinimest ja on püsivam.

Suund on nooleikooni `alt`-atribuudis (`alt="171.94°"`), mitte tekstis.

**Kaks piirangut, mida peab teadma:**

- **Ajatempleid leht masinloetavalt ei anna.** Veerud on lihtsalt järjestikused
  3-tunnised sammud. Ehitame ajatelje ise käesolevast täistunnist. See on
  LIGIKAUDNE — sobib trendi kõrvutamiseks, mitte täpseks ajavõrdluseks teiste
  allikatega.
- **Ühik sõltub lokaadist.** Loeme ühiku väärtuse juurest (`4 m/s`, `8 kts`)
  ja teisendame. Tundmatu ühiku puhul jätame väärtuse VAHELE — vale ühik on
  halvem kui puuduv väärtus.

### Kui see katki läheb

Elutest (`npm run test:live`) tabab selle. Sümptom on `kind: 'parse'` viga
tekstiga "lehe struktuur muutus". Parandus on tavaliselt ühe regexi prefiksi
uuendamine — vaata lehe HTML-i ja võrdle ülaltoodud näitega.

Windfinder EI TOHI olla ühegi tuumikfunktsiooni eeltingimus. Kui ta kaob
päriseks, kaob üks võrdlusveerg ja midagi muud ei juhtu.
