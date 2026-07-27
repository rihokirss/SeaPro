# SeaPro paigaldus (ilma Dockerita)

Node 22+ on ainus eeldus. Rakendus jookseb ühe protsessina, mis serveerib nii API-d
kui frontendi ühelt pordilt (vaikimisi 8080).

## Esmapaigaldus

```bash
# 1. Kasutaja ja kataloog
sudo useradd --system --home /opt/seapro --shell /usr/sbin/nologin seapro
sudo mkdir -p /opt/seapro/data
sudo chown -R seapro:seapro /opt/seapro

# 2. Kood
sudo -u seapro git clone <repo-url> /opt/seapro
cd /opt/seapro

# 3. Konfiguratsioon
sudo -u seapro cp .env.example .env
sudo -u seapro nano .env          # täida CONTACT_EMAIL, vajadusel AISSTREAM_KEY
sudo chmod 600 .env               # .env sisaldab API võtit

# 4. Ehitus
sudo -u seapro npm ci
sudo -u seapro npm run build

# 5. Teenus
sudo cp deploy/seapro.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now seapro
sudo systemctl status seapro
```

## Uuendamine

```bash
cd /opt/seapro
sudo -u seapro git pull
sudo -u seapro npm ci
sudo -u seapro npm run build
sudo systemctl restart seapro
```

## Logid

```bash
journalctl -u seapro -f            # jooksvalt
journalctl -u seapro --since today # tänased
```

## HTTPS

Rakendus ise kuulab ainult HTTP-d. TLS käib nginxi kaudu — vt `nginx.conf.example`.

**HTTPS on kohustuslik**, kui tahad, et:
- **GPS-asukoht töötaks** — `navigator.geolocation` on brauserites HTTPS-ita blokeeritud
  (v.a `localhost`). Kaatris telefonis tähendab see: ilma TLS-ita ei näe sa oma asukohta.
- **PWA installuks** — service worker registreerub ainult turvalisel päritolul.

```bash
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/seapro
sudo nano /etc/nginx/sites-available/seapro     # asenda domeeninimi
sudo ln -s /etc/nginx/sites-available/seapro /etc/nginx/sites-enabled/
sudo certbot --nginx -d meri.sinudomeen.ee
sudo nginx -t && sudo systemctl reload nginx
```

## Kohalik arendus

```bash
npm ci
cp .env.example .env      # täida CONTACT_EMAIL
npm run dev               # Fastify :8080 + Vite :5173 (proxyb /api -> :8080)
```

Avaneb http://localhost:5173. Vite proxyb `/api` päringud serverile, seega
CORS-i probleeme arenduses pole.

Toodangu-ehituse proovimiseks lokaalselt:

```bash
npm run build && npm start   # kõik ühel pordil: http://localhost:8080
```

Telefonis testimiseks samas võrgus: `http://<arvuti-ip>:8080`.
NB — GPS ei tööta üle tavalise HTTP aadressi (v.a localhost); asukoha testimiseks
kasuta brauseri arendustööriistade asukoha-simulatsiooni või paigalda TLS.

## Vahemälu ja andmed

`/opt/seapro/data/` hoiab püsivat vahemälu (viimased edukad vastused allikatest).
Selle võib alati kustutada — rakendus ehitab selle uuesti. See on ainus kataloog,
kuhu systemd unit kirjutusõiguse annab.
