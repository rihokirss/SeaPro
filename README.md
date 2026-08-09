# SeaPro

SeaPro is an open-source marine weather map application for the Baltic Sea and
the Estonian coast. It brings forecasts, observation stations, waves, wind, sea
level, AIS vessels, and navigational information together on one interactive
map.

Source code and development: [github.com/rihokirss/SeaPro](https://github.com/rihokirss/SeaPro)

> [!WARNING]
> SeaPro is an informational aid. Do not use it as your sole source of weather
> or navigational information. At sea, follow official notices, nautical
> charts, and guidance from local authorities.

## Features

- forecasts for wind, waves, temperature, pressure, visibility, and sea level;
- coastal observation stations and wave buoys in Estonia and Finland;
- near-real-time AIS vessel positions;
- aids to navigation, fairways, warnings, and wrecks;
- automatic A–B marine routing in Estonian and Finnish waters, accounting for
  depth, rocks, obstacles, wrecks, vessel dimensions, official fairways,
  recommended routes, and traffic schemes;
- place and harbour search;
- Estonian, English, and Finnish user interfaces;
- an installable PWA with offline caching of the latest forecasts.

## Data providers

Weather data is normalised into consistent SI units on the server and combined
into a single view in the client. Users can enable and disable providers in the
point view. The gridded weather view on the map comes from Open-Meteo because
the other providers supply individual points or station data and do not support
dense grid queries.

### Forecasts

| Provider | Coverage and data | Notes |
| --- | --- | --- |
| **Open-Meteo** | Global; wind, waves, temperatures, pressure, humidity, cloud cover, precipitation, visibility, sea level, and currents | Main source for map layers. Atmospheric models: automatic selection, MET Nordic, ICON-EU, ECMWF IFS, and GFS. Wave models: DWD EWAM, automatic selection, and DWD GWAM. |
| **MET Norway** | Global, particularly strong in the Nordic region; weather and marine forecasts for up to nine days | Requires `CONTACT_EMAIL` in the `.env` file. No API key is needed. |
| **Windfinder** | Named forecast locations; wind, gusts, and air temperature for approximately three days | Uses data from the public forecast page rather than an official API, making it more susceptible to change than the other providers. |

Open-Meteo's default wave model for the Baltic Sea is DWD EWAM at 5 km
resolution. Selecting a point on the map lets you compare time series from
multiple providers at the same location.

#### Open-Meteo API limits

Open-Meteo's free-service request budget is point-based: every location in a
multi-point grid query is counted separately. The project follows the service's
weighting formula:

```text
weight = sum over locations:
         max(1, (number of variables × number of models / 10) × max(1, number of days / 14))
```

SeaPro accounts for the external service's hourly limit of 5,000 request units
and daily limit of 10,000 units. To leave a safety margin, the application's own
rate limiter stops new Open-Meteo requests at 3,000 units per hour and 8,000
units per day. Atmospheric and marine API budgets are tracked separately.

To use a paid Open-Meteo plan, add `OPEN_METEO_API_KEY` to the server's `.env`
file. When the key is present, SeaPro automatically uses the reserved
`customer-` endpoints and does not apply the free plan's hourly and daily rate
limits. Without a key, everything remains in the free mode by default.
Open-Meteo manages the plan's monthly budget; the server-side cache remains
active in both modes.

The server separately measures only HTTP requests actually sent to Open-Meteo,
their estimated billing weight, and the cache hit rate. The web client sends an
anonymous random session ID; the server stores only a monthly salted hash of
it. Daily and monthly totals, together with a projected monthly total based on
the current rate, are available under `openMeteo.usage` in the `/api/health`
response. The metrics are persisted in `data/openmeteo-usage.json`.

To keep request volume under control:

- the map grid contains at most 8 × 8 points, or 64 locations per request;
- nearby map views and selected points are snapped to the same grid so they can
  share cached data;
- one request fetches the full set of variables and up to seven days of data,
  because requesting up to ten variables and 14 days does not increase the
  minimum weight of a location;
- the client creates a dense map view by interpolating the sparse grid;
- Open-Meteo data is cached for one hour by default, and the application uses
  older cached data when possible after a limit has been reached.

You can inspect the current limits through the running server's health check:

```bash
curl -s http://localhost:8080/api/health | jq .budgets
```

Limits and service terms may change. Before running a public or high-traffic
instance, check Open-Meteo's current usage policy. Further technical background
is available in [`docs/data-sources.md`](docs/data-sources.md).

### Observations

| Provider | Coverage and data |
| --- | --- |
| **TalTech METOC** | Estonian coastal and offshore stations: wind, waves, temperatures, pressure, humidity, visibility, and sea level. |
| **LainePoiss** | Active Estonian wave buoys: significant and maximum wave height, period, and direction. |
| **Estonian Weather Service** | Estonian weather stations: wind, temperatures, pressure, humidity, visibility, and precipitation. |
| **Finnish Meteorological Institute (FMI)** | Finnish coastal stations, wave buoys, and tide gauges from the Gulf of Finland to the Bothnian Bay. |

### AIS and navigational data

- **Fintraffic Digitraffic** provides Finland's national AIS feed;
- **Estonian Transport Administration's Nutimeri** provides the public AIS feed
  from Estonian coastal stations;
- **aisstream.io** supplements coverage when `AISSTREAM_KEY` is configured;
- reports for the same vessel are merged by MMSI, and the newest position is
  shown on the map;
- **Estonian Transport Administration's Nutimeri** provides official aids to
  navigation, fairways, Estonian navigational warnings, wrecks, and harbour
  registry data;
- **Traficom's** public WFS provides current Finnish navigational warnings;
- **OpenStreetMap** harbour data is enriched with fields from the official
  harbour registry, while AIS AtoN messages supplement aids to navigation.

## Map layers

The base map is an OpenFreeMap/OpenMapTiles vector map using OpenStreetMap data.
SeaPro provides both light and dark styles adapted for marine use.

### Weather

- **wind** — off, direction arrows, or animated particles;
- **weather stations and wave buoys** — latest observations with timestamps;
- **weather radar** — actual radar observations from the Estonian Environment
  Agency's WMS and an approximately 90-minute `nowcasting` forecast; the frame
  follows the time slider;
- **false-colour field** — one spatial field at a time: wind speed, wave height,
  cloud cover, precipitation, air or sea temperature, pressure, sea level,
  current speed, or visibility;
- **time slider** — move the forecast layer and point charts through time.

### Navigation

- official Estonian and Finnish electronic nautical charts from the Estonian
  Transport Administration and Traficom WMS services;
- official aids to navigation and fairways;
- official depth contours and soundings from the Estonian Land and Spatial
  Development Board in Estonia and Traficom in Finland, combined in one static
  vector archive; EMODnet vector contours and model depths outside their
  combined coverage;
- current official Estonian and Finnish navigational warnings in one shared
  SeaPro symbol, line, area, and popup system, together with known wrecks;
- OpenStreetMap traffic separation schemes as a separate vector layer, without
  buoys that duplicate official aids to navigation;
- EMODnet bathymetry;
- place names, which can be hidden separately for a less crowded map.

### Automatic routing

In the route panel, you can select points A and B from the map, search, or GPS,
then enter the vessel's draught, under-keel clearance, beam, and height above
the waterline. The server builds a single data snapshot, uses A* search to find
a traversable path through it, and returns the actual geometry, navigation
waypoints, risk segments, and freshness of the sources used.

Known land, insufficient depth, a buffered rock, obstacle, or wreck, an
official traffic prohibition, or a passage that is too low or narrow is a hard
barrier. Water with incomplete coverage is not considered safe by default: it
can only be used at a high cost, the route is marked as advisory, and the user
must confirm that it will be checked against an official nautical chart before
navigating. An OpenSeaMap recommended route may be preferred in water known to
be suitable, but it cannot override depth or hazard information. Passing
through a TSS remains advisory in v1 because position-based search does not yet
prove the local direction of travel for every segment.

Automatic routing is a planning aid, not a certified ECDIS, and does not
replace an up-to-date official nautical chart, notices to mariners, the local
water level, or the skipper's judgement. The technical priority order and API
are documented in [`docs/routing.md`](docs/routing.md).

### Traffic and places

- AIS vessels with type, course, and actual dimensions where available;
- harbours and anchorages;
- the user's location with an accuracy circle;
- Photon/OpenStreetMap place-name and harbour search.

## Technology

The project is an npm workspaces monorepo:

- `web/` — React, TypeScript, Vite, and MapLibre GL;
- `server/` — Fastify, TypeScript, and Vitest;
- `shared/` — types shared between the client and server;
- `docs/` — technical documentation for data sources and API keys;
- `deploy/` — examples for deployment with systemd and Nginx.

Node.js 22.12 or newer and npm are required.

## Running locally

```bash
git clone https://github.com/rihokirss/SeaPro.git
cd SeaPro
npm install
cp .env.example .env
```

Set at least `CONTACT_EMAIL` in the `.env` file because MET Norway requires an
identifiable contact in the `User-Agent` header of outgoing requests. The
AISStream key is optional; the application's core features work without it.

Start the development environment:

```bash
npm run dev
```

The web application opens at <http://localhost:5173>, and the API runs at
<http://localhost:8080>. During development, Vite proxies `/api` requests to
the server.

## Commands

```bash
npm run dev        # web and server in development mode
npm run typecheck  # TypeScript checks
npm test           # automated tests
npm run build      # production build
npm start          # run the built application on port 8080
```

Integration tests that call external services run separately:

```bash
npm run test:live
```

## Configuration and data sources

A complete configuration example is available in [`.env.example`](.env.example).
More detailed explanations are available in:

- [API keys and security](docs/api-keys.md)
- [data sources, units, and request limits](docs/data-sources.md)
- [automatic-routing data layers, safety rules, and API](docs/routing.md)
- [production deployment](deploy/README.md)

The application uses several external data and map services. Their data, maps,
and logos may be subject to licences and terms of use that differ from the
project's GPL licence. Keep the data-source attributions shown in the user
interface.

## Contributing

Fixes and new ideas are welcome.

1. Fork the repository and create a separate branch for your change.
2. Keep the change as small and clear as possible.
3. Run `npm run typecheck` and `npm test`.
4. Explain in the pull request what you changed, why it was needed, and how you
   verified it.

When reporting a bug, include the browser and operating-system versions, steps
to reproduce the problem, and relevant server logs where possible. Do not add
API keys or other secrets to an issue, commit, or pull request.

By contributing to the project, you agree that your contribution will be
published under the terms of the GPL-3.0-only licence.

## Licence

SeaPro's source code is released under the
[GNU General Public License v3.0 only](LICENSE). In short, you may use, study,
modify, and distribute the code, but distributed derivative versions must
remain under the same licence and their source code must be made available.
