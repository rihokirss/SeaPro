# SeaPro

SeaPro on avatud lähtekoodiga mereilma kaardirakendus Läänemere ja Eesti
ranniku jaoks. See koondab prognoosid, mõõtejaamad, lained, tuule, veetaseme,
AIS-laevad ja navigatsiooniinfo ühele interaktiivsele kaardile.

Lähtekood ja arendus: [github.com/rihokirss/SeaPro](https://github.com/rihokirss/SeaPro)

> [!WARNING]
> SeaPro on informatiivne abivahend. Ära kasuta seda ainsa ilma- või
> navigatsiooniinfo allikana. Merel järgi ametlikke teadaandeid, merekaarte ja
> kohalike ametiasutuste juhiseid.

## Võimalused

- tuule-, laine-, temperatuuri-, rõhu-, nähtavus- ja veetaseme prognoosid;
- Eesti ja Soome ranniku mõõtejaamad ning lainepoid;
- reaalajalähedased AIS-laevade asukohad;
- navigatsioonimärgid, faarvaatrid, hoiatused ja vrakid;
- automaatne A–B meremarsruut Eesti ja Soome vetes, arvestades sügavust,
  kive, takistusi, vrakke, laeva gabariite, ametlikke faarvaatreid,
  soovituslikke teid ja liiklusskeeme;
- asukoha- ja sadamaotsing;
- eesti- ja ingliskeelne kasutajaliides;
- paigaldatav PWA ning viimaste prognooside võrguühenduseta vahemälu.

## Andmepakkujad

Ilmaandmed normaliseeritakse serveris ühtsetesse SI-ühikutesse ja liidetakse
kliendis üheks vaateks. Kasutaja saab punktivaates pakkujaid sisse ja välja
lülitada. Kaardi ruudustikupõhine ilmapilt tuleb Open-Meteost, sest teised
pakkujad annavad üksikpunkti või jaamade andmeid ega toeta tihedat
võrgupäringut.

### Prognoosid

| Pakkuja | Katvus ja andmed | Märkused |
| --- | --- | --- |
| **Open-Meteo** | Globaalne; tuul, lained, temperatuurid, rõhk, niiskus, pilvisus, sademed, nähtavus, veetase ja hoovused | Peamine kaardikihi allikas. Atmosfäärimudelid: automaatne valik, MET Nordic, ICON-EU, ECMWF IFS ja GFS. Lainemudelid: DWD EWAM, automaatne valik ja DWD GWAM. |
| **MET Norway** | Globaalne, eriti hea Põhjalas; ilma- ja mereprognoos kuni üheksa päeva | Vajab `.env` failis `CONTACT_EMAIL` väärtust. Võti pole vajalik. |
| **Windfinder** | Nimepõhised prognoosipunktid; tuul, puhangud ja õhutemperatuur umbes kolmeks päevaks | Kasutab avaliku prognoosilehe andmeid, mitte ametlikku API-t, ning on seetõttu teistest pakkujatest muutlikum. |

Open-Meteo vaikimisi lainemudel on Läänemere jaoks 5 km lahutusega DWD EWAM.
Kaardipunkti vajutades saab võrrelda samas kohas mitme pakkuja aegridu.

#### Open-Meteo API piirangud

Open-Meteo tasuta teenuse päringueelarve on punktipõhine: mitmepunktilise
võrgupäringu iga asukoht läheb arvestusse eraldi. Projekt lähtub teenuse
kaaluvalemist:

```text
kaal = summa asukohtade kaupa:
       max(1, (muutujate arv × mudelite arv / 10) × max(1, päevade arv / 14))
```

SeaPro arvestab välise teenuse 5000 päringuühiku tunnipiiri ja 10 000 ühiku
päevapiiriga. Turvavaru jätmiseks peatab rakenduse enda piiraja uued
Open-Meteo päringud juba 3000 ühiku juures tunnis ja 8000 juures päevas.
Atmosfääri- ja mere-API eelarveid jälgitakse eraldi.

Tasulise Open-Meteo paketi kasutamiseks lisa serveri `.env` faili
`OPEN_METEO_API_KEY`. Võtme olemasolul kasutab SeaPro automaatselt reserveeritud
`customer-` endpointe ega rakenda tasuta paketi tunni- ja päevapiirajat. Ilma
võtmeta jääb kõik vaikimisi tasuta režiimi. Paketi kuueelarvet haldab
Open-Meteo; serveripoolne vahemälu jääb mõlemas režiimis tööle.

Server mõõdab eraldi ainult päriselt Open-Meteole läinud HTTP-päringuid,
nende hinnangulist arvestuskaalu ja cache'i tabamuse protsenti. Veebiklient
saadab anonüümse juhusliku seansi-ID; server salvestab sellest ainult
kuupõhiselt soolatud räsi. Päeva- ja kuunumbreid ning jooksva tempo põhjal
arvutatud kuuprognoosi näeb `/api/health` vastuse väljal
`openMeteo.usage`. Mõõdik püsib failis `data/openmeteo-usage.json`.

Päringumahu hoidmiseks:

- kaardivõre on kõige rohkem 8 × 8 punkti ehk 64 asukohta ühe päringu kohta;
- lähestikused kaardivaated ja klikitud punktid kleebitakse samale võrele, et
  nad jagaksid vahemälu;
- üks päring toob korraga kogu muutujakomplekti ja kuni seitsme päeva andmed,
  sest kuni kümne muutuja ning 14 päeva küsimine ei suurenda ühe asukoha
  minimaalset kaalu;
- tiheda kaardipildi loob klient hõreda võre interpoleerimisega;
- vaikevahemälu kestab Open-Meteo jaoks ühe tunni ja rakendus kasutab limiidi
  täitumisel võimalusel varasemaid vahemällu salvestatud andmeid.

Piiride hetkeseisu näeb töötava serveri tervisekontrollist:

```bash
curl -s http://localhost:8080/api/health | jq .budgets
```

Piirid ja teenuse tingimused võivad muutuda. Enne avaliku või suure
kasutajamahuga instantsi käivitamist kontrolli Open-Meteo kehtivat
kasutuspoliitikat. Tehniline taust on kirjas ka
[`docs/data-sources.md`](docs/data-sources.md).

### Mõõtmised

| Pakkuja | Katvus ja andmed |
| --- | --- |
| **TalTech METOC** | Eesti ranniku- ja avamerejaamad: tuul, lained, temperatuurid, rõhk, niiskus, nähtavus ja veetase. |
| **LainePoiss** | Eesti aktiivsed lainepoid: oluline ja maksimaalne lainekõrgus, periood ning suund. |
| **Riigi Ilmateenistus** | Eesti ilmajaamad: tuul, temperatuurid, rõhk, niiskus, nähtavus ja sademed. |
| **Ilmatieteen laitos (FMI)** | Soome rannikujaamad, lainepoid ja mareograafid Soome lahest Perämereni. |

### AIS ja navigatsiooniandmed

- **Fintraffic Digitraffic** annab Soome riikliku AIS-voo;
- **Transpordiameti Nutimeri** annab Eesti kaldajaamade avaliku AIS-voo;
- **aisstream.io** täiendab katvust, kui `AISSTREAM_KEY` on seadistatud;
- sama laev liidetakse MMSI järgi üheks kirjeks ja kaardile jõuab värskeim
  positsioon;
- **Transpordiameti Nutimeri** annab ametlikud navigatsioonimärgid,
  faarvaatrid, navigatsioonihoiatused, vrakid ja sadamaregistri andmed;
- **OpenStreetMapi** sadamaandmeid rikastatakse ametliku sadamaregistri
  väljadega ning AIS AtoN sõnumid täiendavad navigatsioonimärke.

## Kaardikihid

Aluskaart on OpenFreeMapi/OpenMapTilesi vektorkaart OpenStreetMapi andmetega.
SeaPro pakub sellele nii heledat kui tumedat merekasutuseks kohandatud stiili.

### Ilm

- **tuul** — väljalülitatud, suunanoolte või animeeritud osakestena;
- **ilmajaamad ja lainepoid** — viimased mõõtmised koos ajatempliga;
- **ilmaradar** — Keskkonnaagentuuri WMS-ist tegelikud radarivaatlused ja
  umbes 90 minuti `nowcasting`-lühiennustus; kaader järgib ajaliugurit;
- **valevärviväli** — korraga üks ruumiline väli: tuulekiirus,
  lainekõrgus, pilvisus, sademed, õhu- või meretemperatuur, rõhk, veetase,
  hoovuse kiirus või nähtavus;
- **ajaliugur** — prognoosikihi ja punktigraafikute liigutamine ajas.

### Navigatsioon

- Eesti ja Soome ametlikud elektroonilised merekaardid Transpordiameti ja
  Traficomi WMS-teenustest;
- ametlikud navigatsioonimärgid ja faarvaatrid;
- EMODneti vektorkujul samasügavusjooned;
- kehtivad navigatsioonihoiatused ning vrakid;
- OpenStreetMapi liikluseraldusskeemid eraldi vektorkihina, ilma ametlikke
  navigatsioonimärke dubleerivate poideta;
- EMODneti batümeetria;
- kohanimed, mida saab tihedama kaardipildi jaoks eraldi peita.

### Automaatmarsruut

Marsruudipaneelis saab valida A- ja B-punkti kaardilt, otsingust või GPS-ist
ning sisestada süvise, kiilualuse varu, laeva laiuse ja kõrguse veeliinist.
Server koostab ühe andmesnapshot'i, leiab sellel A*-otsinguga läbitava tee ning
tagastab tegeliku joone, navigeerimise kontrollpunktid, riskilõigud ja kasutatud
allikate värskuse.

Teadaolev maa, ebapiisav sügavus, puhverdatud kivi/takistus/vrakk, ametlik
liikluskeeld või liiga madal/kitsas läbipääs on kõva tõke. Puuduliku katvusega
vesi ei muutu vaikimisi ohutuks: seda võib kasutada ainult suure kuluga,
marsruut märgitakse nõuandvaks ja enne navigeerimist tuleb kinnitada ametliku
merekaardi kontroll. OpenSeaMapi soovituslik tee võib teadaolevalt sobivas
vees marsruuti eelistada, kuid ei saa sügavus- ega ohuinfot üle kirjutada.
TSS-i läbimine jääb v1-s alati nõuandvaks, sest positsioonipõhine otsing ei
tõenda veel iga lõigu kohalikku sõidusuunda.

Automaatmarsruut on planeerimisabi, mitte sertifitseeritud ECDIS ega asenda
ajakohast ametlikku merekaarti, mereteateid, kohapealset veetaset või kipri
otsust. Tehniline prioriteedijärjekord ja API on kirjeldatud
[`docs/routing.md`](docs/routing.md).

### Liiklus ja kohad

- AIS-laevad tüübi, kursi ja võimalusel tegelike mõõtmetega;
- sadamad ning ankrualad;
- kasutaja asukoht koos asukohatäpsuse ringiga;
- Photoni/OpenStreetMapi kohanime- ja sadamaotsing.

## Tehnoloogiad

Projekt on npm-workspaces monorepo:

- `web/` — React, TypeScript, Vite ja MapLibre GL;
- `server/` — Fastify, TypeScript ja Vitest;
- `shared/` — kliendi ja serveri ühised tüübid;
- `docs/` — andmeallikate ja API-võtmete tehniline dokumentatsioon;
- `deploy/` — näidised systemd ja Nginxiga juurutamiseks.

Nõutud on Node.js 22.12 või uuem ning npm.

## Kohalik käivitamine

```bash
git clone https://github.com/rihokirss/SeaPro.git
cd SeaPro
npm install
cp .env.example .env
```

Muuda `.env` failis vähemalt `CONTACT_EMAIL`, sest MET Norway nõuab
väljuvate päringute `User-Agent` päises tuvastatavat kontakti. AISStreami võti
on valikuline; rakenduse põhifunktsioonid töötavad ka ilma selleta.

Käivita arenduskeskkond:

```bash
npm run dev
```

Veebirakendus avaneb aadressil <http://localhost:5173> ja API töötab aadressil
<http://localhost:8080>. Vite suunab arenduses `/api` päringud serverile.

## Käsud

```bash
npm run dev        # veeb ja server arendusrežiimis
npm run typecheck  # TypeScripti kontroll
npm test           # automaattestid
npm run build      # tootmisbuild
npm start          # valmis rakenduse käivitamine pordil 8080
```

Väliseid teenuseid päriselt kasutavad integratsioonitestid käivituvad eraldi:

```bash
npm run test:live
```

## Konfiguratsioon ja andmeallikad

Seadistuste täielik näidis on failis [`.env.example`](.env.example). Täpsemad
selgitused asuvad dokumentides:

- [API võtmed ja turvalisus](docs/api-keys.md)
- [andmeallikad, ühikud ja päringulimiidid](docs/data-sources.md)
- [automaatmarsruudi andmekihid, ohutusreeglid ja API](docs/routing.md)
- [tootmiskeskkonda paigaldamine](deploy/README.md)

Rakendus kasutab mitut välist andme- ja kaarditeenust. Nende andmetele,
kaartidele ja logodele võivad kehtida projekti GPL-litsentsist erinevad
litsentsid ning kasutustingimused. Säilita kasutajaliideses olevad viited
andmeallikatele.

## Panustamine

Parandused ja uued ideed on teretulnud.

1. Tee repost fork ja loo oma muudatusele eraldi haru.
2. Tee võimalikult väike ning selge muudatus.
3. Käivita `npm run typecheck` ja `npm test`.
4. Kirjelda pull request'is, mida muutsid, miks seda vaja oli ja kuidas
   tulemust kontrollisid.

Vigadest teatades lisa võimalusel brauseri ja operatsioonisüsteemi versioon,
probleemi kordamise sammud ning asjakohased serverilogid. Ära lisa issue'sse,
commit'i ega pull request'i API-võtmeid või muid saladusi.

Projektile panustades nõustud, et sinu panus avaldatakse projekti
GPL-3.0-only litsentsi tingimustel.

## Litsents

SeaPro lähtekood on avaldatud [GNU General Public License v3.0 only](LICENSE)
tingimustel. Lühidalt: koodi võib kasutada, uurida, muuta ja levitada, kuid
levitatavad tuletatud versioonid peavad jääma sama litsentsi alla ning nende
lähtekood peab olema kättesaadav.
