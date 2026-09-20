# PostgreSQL, AIS-ajalugu ja migratsioon

SeaPro kasutab PostgreSQL 18 + PostGIS-i. Rakenduse ühendus on `DATABASE_URL`,
skeemi migratsioonid ja hooldus kasutavad `DATABASE_MAINTENANCE_URL`.
Rakenduse rollil puudub DDL-õigus. Hooldusroll pole superkasutaja.

## Paigaldus

```sh
sudo apt-get install postgresql-18-postgis-3
python3 scripts/setup-database.py
npm run db:migrate
```

Setup tuleb käivitada repo omanikuna, kellel on sudo õigus. See loob ainult
`seapro` andmebaasi ning `seapro_app` ja `seapro_maintenance` rollid. Olemasolevat
DATABASE_URL-i ei kirjutata üle. Paroolid genereeritakse juhuslikult ja
salvestatakse ainult õigustega 0600 `.env` faili.

Migratsioonid asuvad `server/migrations/`; neid rakendatakse nime järjekorras,
ühekordselt ja tehingus. Eraldi andmebaasilukk välistab paralleelmigratsioonid.
Rakendus ei käivita skeemimuudatusi automaatselt.

## Säilitamine

| Keskkonnamuutuja | Vaikimisi |
| --- | ---: |
| AIS_HISTORY_RETENTION_DAYS | 30 |
| AIS_HISTORY_HOT_DAYS | 7 |
| AIS_HEATMAP_RETENTION_DAYS | 0 |
| MODEL_VERIFICATION_RETENTION_DAYS | 365 |
| USAGE_RETENTION_DAYS | 45 |
| AIS_HISTORY_MOVING_INTERVAL_SECONDS | 60 |
| AIS_HISTORY_STATIONARY_INTERVAL_SECONDS | 300 |
| AIS_HISTORY_ARCHIVE_INTERVAL_SECONDS | 300 |
| DATABASE_QUEUE_MAX_MB | 512 |

Säilituspäevade väärtus 0 tähendab tähtajatut säilitamist. HOT_DAYS ja sammud
peavad olema positiivsed täisarvud; HOT_DAYS ei tohi ületada piiratud AIS-ajalugu.
`AIS_HISTORY_HOT_DAYS` vanusest arhiivitakse iga laeva igast
`AIS_HISTORY_ARCHIVE_INTERVAL_SECONDS` UTC-vahemikust viimane tegelikult
saabunud asukoht. Heatmapi jooned arvutatakse enne hõrendamist täpsest
värskest ajaloost. Muudatus rakendub pärast teenuse taaskäivitust. Lühem
periood eemaldab järgmise hooldusega aegunud andmed, pikem periood ei taasta
kustutatut. API filtreerib
säilitusaja ületanud punktid välja juba enne hooldustööd.

AIS-i kogumine ei sõltu vaatealast, lemmikutest ega avatud brauserist. Asukohad
saabuvad olemasolevatest voogudest; lisapäringuid allikatele ei tehta.
Salvestusvahemikust säilib viimane tegelik raport. Kattuvatel allikatel säilivad
päritoluandmed; sekundilise täpsusega Digitraffic ei tekita eraldi rada.
Vigased koordinaadid ja tulevikku üle 5 minuti ulatuvad raportid jäetakse välja.
Uue raporti vastuvõtu ajal lubame maksimaalselt kahe päeva hilinemist (või
lühemat HOT_DAYS-i), et juba pakitud ajalugu ei muudetaks.

Värske ajalugu asub päevapartitsioonides. Vanema ajaloo pakime laeva ja UTC-päeva
kaupa gzip-tihendatud, versioonitud JSON-massiivideks PostgreSQL-is. Punktide arv
ja SHA-256 kontrollsumma kontrollitakse enne algse partitsiooni eemaldamist.
Asukohti pakkimisel ei hõrendata. API ühendab värske ja pakitud ajaloo ühes
REPEATABLE READ hetktõmmises, vältides pakkimise ajal kadunud või topeltradu.

Heatmapi alus on **laevade liikumisjooned, mitte ruudustik**. Öine koondaja
salvestab tegelikud rajalõigud PostGIS-i ajatemplitega LINESTRING M kujul,
lihtsustatuna kuni 25 m geomeetrilise tolerantsiga. Tüübi või liikumisoleku
muutus katkestab lõigu; üks lõik hõlmab kuni tunni. Algne läbitud teepikkus ja
kohalolekuaeg säilivad eraldi. Seismine salvestatakse POINT M kujul. Koondid
on päevapõhised ja säilivad omaette reegli järgi. Tulevane kaardikiht saab
rõhutada kattuvaid trajektoore ning eristada laevatüüpe.

Üle 15 minuti andmelünki ja üle 100 sõlme eeldavaid asukohahüppeid ei ühendata.
Kohalolekut arvestatakse järjestikuste raportite vahel kuni 5 minutit; pikemate
vahede puhul ei väideta kogu aja jooksul kohalolekut. Punktide arv ei ole
liikumistiheduse mõõdik. Koondid kirjeldavad ainult vaadeldud AIS-liiklust.

## JSON-ajaloo üleviimine

Teenus peab lõpliku impordi ajal olema peatatud. Prooviimport teha kõigepealt
eraldi testandmebaasi; tootmisfailid jäävad proovimigratsiooni ajal puutumata.

```sh
pm2 stop seapro
# Varunda data/model-verification.json ja data/openmeteo-usage.json.
npm run db:import -- /tee/varundatud/failideni
npm run build
pm2 start ecosystem.config.cjs --only seapro --update-env
```

Import on idempotentne ja tehinguline: valideerib väljad, kontrollib kõiki
imporditud kirjeid ning võrdleb fikseeritud ajahetkel mudelitäpsuse aruandeid.
Kogumise algusaeg ja algsed aja-/unikaalsusvõtmed säilivad. Varasemast 100 päeva
säilitusest juba kustutatud ilmaandmeid ega seni salvestamata AIS-ajalugu ei
saa taastada. Ilmapäringute sagedus ja arvutusmetoodika ei muutu.

Pärast migratsiooni kasutab rakendus ainult andmebaasi. Vanad JSON-id hoitakse
`data/legacy-backups/<UTC-aeg>/` kataloogis 30 päeva; neid pole vaja aktiivses
`data/` juurkaustas. Taastatav ilmavahemälu ja navigatsiooni offline-koopiad
jäävad failidesse.

Tagasipöördumine: peata uus teenus; käivita `npm run db:export -- /turvaline/kaust`,
mis ekspordib ka pärast migratsiooni kogutud ilma- ja kasutusandmed senisesse
JSON-vormingusse. Taasta eelmine rakenduse versioon ja kopeeri ekspordifailid
selle `data/` kausta. AIS-andmebaasi tagasipöördumisel ei kustutata.

## API ja kasutajaliides

- `/api/ais` on jätkuvalt reaalajakaart.
- `/api/ais/vessels?mmsi=230000001,230000002` tagastab kuni 100 laeva viimase
  teadaoleva seisu, sh aegunud oleku. Vaatealast väljaspool olevad lemmikud töötavad.
- `/api/ais/vessels/:mmsi/track?from=<ISO>&to=<ISO>` tagastab kuni 7 päeva
  punktid, eraldatud rajalõigud, tegeliku ajaloo piirid ja teadaolevad katkestused.
  Üle 100 000 punkti korral palutakse valida lühem periood (HTTP 413).
- Vigased sisendid annavad 400, andmebaasikatkestus 503. Tühi tulemus ei varja viga.
- `/api/health` → `history` näitab järjekorda, kirjutusaega, kehtivaid seadeid,
  viimast hooldust, katkestusi ning salvestusmahu hinnangut.

Laeva popupist saab avada raja, panna kaardi laevale järgnema või lisada lemmiku.
Ülariba radariikoon avab jälgimispaneeli. Kaardi käsitsi liigutamine lõpetab
järgimise; oma GPS-positsiooni ja AIS-laeva järgimine on vastastikku välistavad.
Lemmikud jäävad brauseri `seapro.vessel-favorites` kohalikku salvestusse.
Kasutajakontosid ega teiste seadmetega sünkroonimist pole.

## Hooldus ja varundus

```sh
npm run db:maintain
node --env-file=.env scripts/database-backup.mjs
```

Paigalda `deploy/seapro-database.service` ja `.timer`, kohandades teenuse
kasutaja, töökataloogi ja Node binaari tee (`command -v node`). NVM-paigaldusel
ei pruugi `/usr/bin/node` olemas olla. Timer käivitab hoolduse ja varunduse öösel 03:15 UTC
(kuni 5 min juhusliku nihkega). Hooldus loob partitsioonid 14 päeva ette,
koondab lõpetatud päevad ja kaks viimast päeva uuesti, pakib ajaloo ja rakendab
säilitusreegleid. Kirjutusjärjekorra taastumine peab enne pakkimist lõppema.

```sh
sudo systemctl enable --now seapro-database.timer
systemctl list-timers seapro-database.timer
journalctl -u seapro-database.service
```

Kirjutusjärjekord `data/database-queue/` on ainult taastumiseks: partiid
fsync'itakse, tehinguliselt kirjutatakse ning eemaldatakse eduka salvestuse järel.
Taaskäivitus taasesitab allesjäänud failid enne kasutusloendurite laadimist.
Järjekorra täitumine või kirjutusviga avaldub terviseinfos ja katkestuse kirjena.
Reaalaja AIS-kaart jätkab andmebaasi ajutise katkestuse ajal töötamist.

Varundus teeb `pg_dump` custom-vormingus andmebaasikoopia ning navigatsiooni
snapshot'ide arhiivi. Siht on `DATABASE_BACKUP_DIR` (vaikimisi
`/var/backups/seapro`); koopiate arv `DATABASE_BACKUP_KEEP` (vaikimisi 2).
Vanad koopiad eemaldatakse alles pärast uue komplekti edukat valmimist.
Sama ketta koopia ei kaitse ketta rikke eest; välise sihi saab seadistada eraldi.

Taastamise kontrolliks loo eraldi andmebaas, paigalda PostGIS ning anna selles
andmebaasis taastavale hooldusrollile `GRANT INSERT ON spatial_ref_sys TO seapro_maintenance`
(PostGIS-i konfiguratsiooniandmete taastamiseks). Seejärel taasta
`pg_restore --no-owner --no-comments --dbname=<testandmebaas> <koopia.dump>` abil. Kontrolli
kirjete arvu, viimaseid aegu ja ajaloopäringut. Tootmisbaasi kontrolliks üle ei kirjutata.

Kettamahu hinnang on ligikaudne; eriti esimesel päeval ja enne esimese pakitud
päeva teket. Andmebaasi, koondite, indeksite ja varukoopiate kasvule peab ruumi
jääma. Säilitusaega ega täpsust ei vähendata ruumipuudusel automaatselt.

## Kontrollid

`npm test`, `npm run typecheck`, `npm run build`.
Andmebaasitestid nõuavad eraldi `seapro_test` andmebaasi, selle ühendusi
keskkonnas ning `SEAPRO_DB_TEST=1`; käsk serveri kaustas:
`npx vitest run test/history.integration.test.ts`.
Koormuskatse: `npx tsx scripts/history-benchmark.ts` testandmebaasi ühendustega.
See keeldub tootmisandmebaasis käivitumast.
