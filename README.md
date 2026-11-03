# Nowcast (India)

A minute-level rain forecast for the next 5 hours, anywhere in India. It combines:

- **Live radar tracking.** The IMD Doppler radar mosaic (via RainViewer) is decoded, the storms' motion is measured, and the rain is projected forward with an ensemble of 50 possible tracks.
- **An AI model trained on Indian radar.** A U-Net, a type of neural network, keeps training every night on newly collected radar. A new version is published only when it beats the current one on the most recent day of data it hasn't seen.
- **Ten weather models and about 140 ensemble runs.** ECMWF, UK Met Office, DWD ICON, NOAA GFS, Météo-France, Canada GEM, JMA and CMA, via Open-Meteo.
- **Self-checking and local learning.** Every forecast is later checked against the radar at the pin. A per-location calibration learns from those checks, and the track record is shown in the app.

- **Explained, not just predicted.** Every forecast says *why*:
  - the prediction mode: radar tracking (rain already on radar coming here, the most predictable case), convective development (storms likely to form where radar sees nothing yet), model-led, or settled;
  - the evidence behind it, with each source tagged: where the rain is, its trend (strengthening or weakening over the last 30 minutes), its movement, the arrival window, how many weather models agree, satellite and thunderstorm potential;
  - a **rain journey** diagram (where the rain is now, how fast it moves, when it reaches you, and which sources agree);
  - confidence for each hour of the next five, falling with time.
- **IMD radar network.** The nearest IMD Doppler radars, their distance and how high their beam passes over the location, combined into a radar confidence, with links to IMD's own images.
- **Official warnings.** Lightning, thunderstorm, heavy-rain and cyclone warnings from IMD and the state disaster authorities, through NDMA's SACHET portal (the system behind the government's phone alerts). Each warning is matched to the location's mandal/taluk and district, shown at the top of the forecast with its expiry time and its original-language text, and sent as a notification when alerts are on.
- **Storm watch.** Meteosat-9 infrared (EUMETSAT) every 15 minutes: cloud tops that cool fast mark storms forming before radar sees rain. When that happens close by, with unstable air and nothing on radar, the near-term rain chance is raised.

The site is static (`public/`) plus four small relay functions (`api/`) on Vercel. The forecast and the AI run on the visitor's device, in a background thread.

### Data notes

- **Radar** is IMD's Doppler radar network, through RainViewer's composite. IMD publishes its radars only as images, and its data feeds need an approved account, so the site links to IMD's images rather than reading them.
- **Radar confidence** takes the weakest of coverage, image age and beam height. Puttaparthi is ~265 km from the nearest radar (Sriharikota), where the lowest beam passes ~6.5 km up and can miss shallow rain, so radar confidence there is low and the models get more weight.
- **Satellite** temperatures come from EUMETSAT's rendered infrared images (a grey scale), so absolute cloud-top temperatures are approximate (about ±5 °C). Changes between images, which is what detects growing storms, are much more precise.
- **Lightning:** there is no open feed of lightning strikes for India, but official lightning and thunderstorm *warnings* are public: Andhra Pradesh's disaster authority, for example, issues mandal-level lightning warnings for the next three hours. The site shows those, the models' thunderstorm potential, and a link to Blitzortung's live strike map (a volunteer network, not for safety decisions).
- **Warnings** come from SACHET's all-India feed (public domain) through `api/alerts.js`, which polls politely as NDMA's integration guide asks (ETag on the feed, each alert file fetched once) and is cached for 3 minutes for everyone. Warnings are matched to places by name; SACHET's exact warning-area maps are not publicly downloadable.

## How the forecast is made

1. **Radar nowcast (0–3 h).**
   - **Decoding:** the last 10 radar frames (10 minutes apart) are decoded pixel by pixel to reflectivity, then to rain rate.
   - **Quality control:** areas without radar coverage are marked unknown, not dry, and fixed clutter and stalled feeds are removed.
   - **Motion:** measured by multi-scale block matching. This copes with long rain bands, whose speed along the band is otherwise ambiguous, and falls back to the 700 hPa wind where there's no rain.
   - **Extrapolation:** the rain is projected forward along that motion, on a grid that follows the flow.
   - **How long rain keeps its shape:** measured live, both for individual cells and for wider rain areas. This sets how fast the forecast widens its uncertainty and when the models take over.
   - **Probabilities:** a "local Lagrangian" method (Germann & Zawadzki) — at each lead time, the chance of rain at the pin is the share of rainy pixels in a growing area around the point the rain will come from. A 50-member ensemble varies the track.
2. **AI nowcast (0–2 h, India).**
   - **Input and output:** the model reads the last hour of radar plus the coverage mask. It outputs the chance of rain at +10 … +120 min, and the chance of any rain in the next hour (used for the heatmap).
   - **How much it counts:** its weight at each lead time comes from last night's test against plain radar extrapolation. A model that doesn't beat extrapolation isn't used.
3. **Weather models (0–5 h).**
   - Each model is checked at the pin and on a 25 km ring around it, plus ensembles.
   - Models that matched the radar over the past hours, and that have done well at this spot over time, count for more.
4. **Blend.** Radar (and AI) dominate early; the models take over as the radar's skill fades. Each source is weighted by its expected skill.
5. **Self-checking.** Logged forecasts are checked against the radar later.
   - **Recalibration:** a regularised logistic recalibration per lead time corrects systematic errors at this location. A hold-out check discards it if it doesn't help.
   - **Track record:** "right 9 times out of 10", rain alerts that came true, rain caught in advance.

## Reliability on Indian networks

Mobile and campus networks in India put thousands of people behind one public IP address. Open-Meteo (10,000 calls a day per IP) and RainViewer (100 requests a minute per IP) count those limits per address, so they can be used up by others on the same network. The app therefore:

- keeps requests light,
- caches model answers for 20 minutes and radar tiles for 3 hours, across reloads,
- falls back automatically to this site's caching relays (`api/om.js`, `api/rv.js`) when a direct request is refused. The relays' answers are cached at Vercel's CDN and shared between visitors.

## The AI backend (GitHub Actions, free)

| Workflow | When | What it does |
|---|---|---|
| `Collect India radar` (`.github/workflows/collect.yml`) | every 30 min | Saves the India radar mosaic (12 tiles per frame, ~4.9 km grid) into daily files in the `radar-data` GitHub release, and keeps about 15 months of them. |
| `Train India nowcast model` (`.github/workflows/train.yml`) | nightly 02:10 IST | Continues the previous night's training on the newest 2 weeks of radar plus 2 weeks picked at random from the older archive (so it doesn't forget earlier seasons). Then tests it on the newest day it hasn't seen, against the live model and two radar baselines. It publishes `public/ai/model.json` + `model.bin` only if better, and updates `public/ai/metrics.json`. |

The first model appears once about 300 training examples exist, usually after 2–3 days of collection. Each night after that, the model trains on more Indian radar. If a night's data can't be read, the published model simply stays in use.

### One-time setup

1. Create a **public** GitHub repository (public repositories get free Actions minutes) and upload everything in this folder, including the hidden `.github` folder.
2. In the repository, go to **Settings → Actions → General → Workflow permissions** and choose **Read and write permissions**.
3. Open the **Actions** tab, enable workflows if asked, then run **Collect India radar** once with **Run workflow** to check it works.
4. In Vercel, connect the project to this repository (**Project → Settings → Git → Connect Git Repository**), so each nightly model update deploys automatically.

Radar comes from RainViewer's free API, which is for personal and educational use. The collector stays well under its rate limit.

## Run and test locally

```bash
python3 -m http.server 8080 --directory public
```

```bash
node test/engine.test.mjs && node test/full.test.mjs && node test/insight.test.mjs && node test/alerts.test.mjs && node test/scorecard.test.mjs && node test/relay.test.mjs
```

```bash
python3 test/py/test_collect.py
```

```bash
python3 test/py/test_train.py && node test/ai.test.mjs
```

```bash
node test/ui.test.mjs && node test/sw.test.mjs
```

The trainer test needs PyTorch. `ai.test.mjs` checks that the browser's model gives the same numbers as PyTorch.

## Files

```
public/                  the website (deployed by Vercel)
  index.html, css/       interface
  js/engine.js           one forecast: radar, AI, models, blend
  js/radar.js, png.js    radar tiles -> rain rate grid
  js/motion.js           storm motion
  js/nowcast.js          extrapolation, probabilities, next-hour heatmap field
  js/ai.js               the U-Net in plain JavaScript (same maths as backend/model.py)
  js/nwp.js              weather models, ensembles, live model checks
  js/blend.js            skill-based blending and the plain-language summary
  js/scorecard.js        forecast log, checks against radar, local learning
  js/insight.js          prediction mode, radar trend, model agreement, hourly confidence, rain journey data
  js/stations.js         IMD radar network, beam height, radar confidence
  js/satellite.js        Meteosat infrared: cloud-top cooling and cold tops near the location
  js/journey.js          the rain journey diagram (SVG)
  js/alerts.js           official warnings matched to the location (mandal, district)
  js/map.js, charts.js   map (smooth radar and chance-of-rain heatmap), next-hour chart
  js/worker.js           runs everything off the main thread, caching
  ai/                    model.json, model.bin, metrics.json (written by the nightly training)
api/om.js, api/rv.js     caching relays for Open-Meteo and RainViewer
api/sat.js               relay for Meteosat-9 infrared images (EUMETSAT WMS)
api/alerts.js            relay for official warnings (NDMA SACHET, Common Alerting Protocol)
backend/                 collector, model, trainer (Python)
.github/workflows/       collection every 30 min, nightly training
test/                    JavaScript and Python tests (synthetic storms with known answers)
vercel.json              static site in public/, relays in api/
```
