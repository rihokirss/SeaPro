# API võtmed

**Lühivastus: SeaPro töötab täisfunktsionaalselt ilma ühegi API võtmeta.**
Üheksast andmeallikast kaheksa on avatud. Ainus võti on valikuline ja katab
ühe konkreetse lünga.

Kõik seaded käivad `.env` faili kaudu (`cp .env.example .env`). See fail on
`.gitignore`-is ja seda ei tohi kunagi commitida.

---

## Kohustuslik: `CONTACT_EMAIL`

See ei ole võti, vaid kontakt.

```bash
CONTACT_EMAIL=sinu@email.ee
```

Läheb kõigi väljaminevate päringute `User-Agent` päisesse kujul
`SeaPro/0.1.0 (+sinu@email.ee)`.

**MET Norway ToS NÕUAB tuvastatavat kontakti** ja vastab anonüümsele või
geneerilisele User-Agentile `403 Forbidden`-iga. Kui see väli on täitmata,
lülitab MET Norway provider end käivitusel ise välja ja ütleb UI-s põhjuse —
rakendus töötab edasi, aga üks prognoosiallikas on puudu.

---

## Valikuline: `AISSTREAM_KEY`

```bash
AISSTREAM_KEY=
```

Ainus päris API võti kogu projektis.

**Mida see annab:** täiendava kogukondliku AIS-katvuse. Ilma selleta töötab
AIS edasi Fintraffic Digitraffici ja Transpordiameti Nutimere avaliku voo
kaudu.

**Kuidas hankida** (~2 minutit):

1. Ava <https://aisstream.io>
2. Logi sisse GitHubi kontoga
3. Mine **API Keys** lehele
4. **Create** — kopeeri võti
5. Kleebi see `.env` faili `AISSTREAM_KEY=` järele
6. Taaskäivita teenus: `sudo systemctl restart seapro`

Kontrolli, et töötab:

```bash
journalctl -u seapro -n 50 | grep aisstream
# ootuspärane: "aisstream: ühendatud"
```

**Hoiatus:** aisstream on beeta ilma SLA-ta. Ühenduse katkemine on normaalne;
server taasühendub ise kasvava ootega. Kui teenus päriselt kaob, jääb AIS
Digitraffici najal tööle.

---

## Millised allikad võtit EI vaja

| Allikas | Miks võtmeta töötab |
|---|---|
| Open-Meteo | tasuta mittekaubanduslik kasutus, CC BY 4.0 |
| MET Norway | avaandmed, vajab ainult kontakti User-Agentis |
| TalTech METOC | avalik portaal |
| LainePoiss | avalikud andmefailid |
| Riigi Ilmateenistus | avaandmed |
| Fintraffic Digitraffic AIS | avaandmed, vajab ainult `Digitraffic-User` päist |
| Windfinder | avaliku lehe parsimine (ametlik API on tasuline B2B) |
| Kõik kaardikihid | OSM, Transpordiamet, OpenSeaMap, EMODnet, Keskkonnaagentuur |

**Kaardipaanide kohta eraldi:** MapTiler ja Mapbox on sihilikult VÄLDITUD.
Mõlemad nõuaksid võtit ja tooksid kvoodi kaasa. Kasutame rasterpaane ja
ametlikke WMS-teenuseid, mis on avatud.

---

## Päringueelarve, mitte võti

Open-Meteo ei vaja võtit, aga tal on **tunnilimiit 5000 ja ööpäevane limiit
10 000 kutset** — ja ta loeb mitmepunktilise võrgustikupäringu iga punkti
eraldi kutseks. Päevane piir on see, mis tegelikult maksma jääb: tunnise
kiirusega saaks selle täis nelja tunniga.

Seevastu muutujate arv (kuni 10) ja ajavahemik (kuni 14 päeva) on kaalu mõttes
TASUTA — seetõttu pärimegi alati terve nädala ja kogu muutujate komplekti
korraga (vt [data-sources.md](data-sources.md)).

Eelarve seis on nähtav:

```bash
curl -s localhost:8080/api/health | jq .budgets
# {"open-meteo":        {"spent": 128, "limit": 3000, "dailySpent": 640, "dailyLimit": 8000},
#  "open-meteo-marine": {"spent":  64, "limit": 3000, "dailySpent": 320, "dailyLimit": 8000}}
```

Kui `spent` läheneb `limit`-ile, degradeerub rakendus sujuvalt vahemälust
serveeritud andmetele, mitte tühjale ekraanile.

---

## Turvalisus

- `.env` peab olema `chmod 600` ja kuuluma teenuse kasutajale
- `.env` ei tohi kunagi git-i sattuda — kontrollitud `.gitignore`-iga
- Võtmed jäävad AINULT serverisse; frontend ei näe neid kunagi, sest kõik
  välispäringud käivad proxy kaudu
- Kui võti lekib, tühista see aisstream.io lehel ja loo uus
