# BNE Flood Watch

An **unofficial** storm-season dashboard for the Greater Brisbane area. It puts rain radar, forecasts, creek and river levels, road closures and historic flood extents on one map. It uses only free, open data and is hosted for free on GitHub Pages.

> ⚠️ **This is not an official warning service.** Data can be delayed or wrong. For warnings, use the [Bureau of Meteorology](https://www.bom.gov.au/weather-and-climate/warnings-and-alerts) and your council's disaster dashboard ([Brisbane](https://www.brisbane.qld.gov.au/community-support-and-safety/natural-disasters-and-emergencies/emergency-dashboard), [Logan](https://disaster.logan.qld.gov.au/)). In an emergency call **000**. For SES help call **132 500**.

## How it works

```
GitHub Actions (every ~10 min)                        Browser
  fetchers/*.mjs ──► public/data/*.json ──┐            ├─ fetches data/*.json from Pages
                     (force-pushed to     │            └─ fetches keyless, CORS-enabled sources directly:
                      the `data` branch)  │               RainViewer radar, Open-Meteo forecast,
  vite build ◄────────────────────────────┘               Queensland Spatial flood map tiles
       └──► GitHub Pages
```

- **Fetched by Actions:** sources that are heavy, keyed, or need history. The workflow stores a small snapshot, keeps it on the orphan `data` branch (one force-pushed commit, so the repo doesn't grow), and deploys it with the site.
- **Fetched by the browser:** sources that allow cross-origin requests and are cheap to call per visitor.
- **Live refresh:** an open page re-checks `status.json` every 5 minutes. It reloads the data layers when a new snapshot lands, and picks up new radar frames.
- **Offline:** a service worker (`public/sw.js`, production builds only) keeps the app, the last data snapshot and recently viewed map tiles. If the network drops, the page still opens with its dated data and shows an "Offline" chip.
- **Archive:** `.github/workflows/archive.yml` runs daily at 23:50 AEST. It uploads a gzipped snapshot to a monthly Release (`data-YYYY-MM`). Gauge files carry 72 h of history, so the daily snapshots form a continuous water-level record.
- **Status:** `data/status.json` records the last success and any error for each source. The header shows how old the data is.

## Data sources

| Layer | Source | Fetched by | Licence |
|---|---|---|---|
| Rain radar | [RainViewer](https://www.rainviewer.com/api.html) | Browser | Free with attribution |
| Forecast | [Open-Meteo](https://open-meteo.com/) (blends models, including BoM ACCESS) | Browser | CC BY 4.0, non-commercial |
| Rainfall totals (52 gauges, last 1 h / 3 h / 24 h) | [Brisbane City Council telemetry](https://data.brisbane.qld.gov.au/explore/dataset/telemetry-sensors-rainfall-and-stream-heights-observations/) | Actions | CC BY 4.0 |
| Creek and river gauges (46 stream-height gauges, 72 h history) | [Brisbane City Council telemetry](https://data.brisbane.qld.gov.au/explore/dataset/telemetry-sensors-rainfall-and-stream-heights-observations/) | Actions | CC BY 4.0 |
| Road closures, flooding, hazards, crashes | [QLDTraffic API](https://qldtraffic.qld.gov.au/more/Developers-and-Data) | Actions | CC BY 4.0 AU |
| Feb 2022 flood extent | [BCC flood awareness: historic floods Feb 2022](https://data.brisbane.qld.gov.au/explore/dataset/flood-awareness-historic-brisbane-river-and-creek-floods-feb-2022/), simplified into `public/static/` | One-off script | CC BY 4.0 |
| 2011, 1974 and 1893 flood extents | Queensland Spatial FloodCheck ArcGIS services | Browser (map tiles) | © State of Queensland |
| Base map | [OpenFreeMap](https://openfreemap.org/), © OpenStreetMap contributors | Browser | ODbL |

## Development

```bash
npm install
npm run fetch      # populate public/data/ locally (same script the workflow runs)
npm run dev        # http://localhost:5173/bne-flood-watch/
```

Run `npm run build:static-floods` to regenerate the simplified Feb 2022 overlay. You only need to do this when BCC updates the dataset.

### Adding a source

1. Write `fetchers/<name>.mjs` with a default async function that writes `public/data/latest/<name>.json` and returns a small info object.
2. Register it in `fetchers/run-all.mjs`.
3. Add a layer in `src/layers.ts`.

## Deployment setup (one-off)

1. Go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
2. Optional: under **Settings → Secrets and variables → Actions**, add `QLDTRAFFIC_API_KEY` if you register your own key. Otherwise the shared public key from the QLDTraffic spec is used.
3. Push to `main`. The *Update data & deploy* workflow then runs on every push and every ~10 minutes.

## Roadmap

- [x] BCC rainfall gauges (last 1 h / 3 h / 24 h totals)
- [x] Offline-capable PWA showing the last snapshot
- [x] Daily archive (Release assets)
- [ ] "Event replay" view built from the archive

### Blocked on licensing: Bureau of Meteorology data

BoM's [copyright notice](https://www.bom.gov.au/copyright) lists radar images as restricted content: publishing them online requires a data licence agreement. Content without stated terms (which includes the anonymous-FTP warnings and river-height tables) is for personal or in-house use only and "must not" be supplied to anyone else. So this project links to BoM rather than mirroring:

- BoM radar (sharper than RainViewer). Needs a BoM data licence (webreg@bom.gov.au).
- BoM warnings (CAP/XML) and river-height tables (IDQ60286 Brisbane, IDQ60285 Logan/Albert). Same licence needed.
- Logan creek gauges (Slacks Creek etc.) are Logan City Council's. They are published through BoM and Logan's disaster dashboard, not as open data.

## Licence

The code is MIT licensed. Data remains under its publishers' licences, listed above and in the site's "Data sources" panel.
