# @aaronge/can-i-hang-my-washing-out

Tells you whether it's worth hanging your washing out — for a chosen
location, using free [Open-Meteo](https://open-meteo.com) forecast data
(temperature, humidity, wind, rain probability and sunshine duration). Scores
this morning (06:00-12:00) and this afternoon/evening (12:00-18:00) out of
10, each with a short verdict, and a one-line **"Yes mate" / "No mate"**
headline so you can tell at a glance without reading the detail.

Runs on a schedule under `swamp serve` (twice in the morning, twice in the
afternoon/evening) so a fresh forecast is waiting whenever you check.

## Installation

```sh
swamp extension pull @aaronge/can-i-hang-my-washing-out
```

## Usage

Create a model instance. Location is optional — see
[Keeping your location private](#keeping-your-location-private) below before
setting it directly.

```sh
swamp model create @aaronge/can-i-hang-my-washing-out washing --json
swamp model method run washing forecast
```

Running the method prints the headline and both scores straight to the
terminal (via the method's log output), e.g.:

```
Yes mate 🧺 — best window is the morning (8.1/10)
Morning: 8.1/10 - Great drying day — hang it all out
Afternoon: 5.4/10 - Marginal — dries slowly, keep an eye on the sky
```

For a quick terminal habit, add a shell alias:

```sh
alias can-i-hang-my-washing-out='swamp model method run washing forecast'
```

Then just type `can-i-hang-my-washing-out` whenever you want to know.

Inspect the last stored result at any time without re-fetching:

```sh
swamp model output get washing --json
```

## Global arguments

| Argument    | Type   | Required | Description                                                                                  |
| ----------- | ------ | -------- | ---------------------------------------------------------------------------------------------- |
| `latitude`  | number | No       | Default latitude. Omit (with `longitude`) to auto-detect via free IP geolocation at run time. |
| `longitude` | number | No       | Default longitude. Omit (with `latitude`) to auto-detect via free IP geolocation at run time. |

The `forecast` method also accepts `latitude`/`longitude` as per-run
arguments (`--input latitude=... --input longitude=...`), which override the
global default for a single check without changing the model's stored
config.

## Keeping your location private

If this repo is (or might become) public, don't put your exact coordinates
directly into the model's global arguments — they'd be committed to git in
`models/@aaronge/can-i-hang-my-washing-out/washing.yaml` in plain text.
Instead, pick one of:

1. **Store it in a local vault** (never committed — `.swamp/` is
   git-ignored) and reference it with a `vault.get()` expression:

   ```sh
   swamp vault create local_encryption home-location --json
   swamp vault put home-location lat=51.5074 --json
   swamp vault put home-location lon=-0.1278 --json
   swamp model create @aaronge/can-i-hang-my-washing-out washing \
     --global-arg 'latitude=${{ vault.get(home-location, lat) }}' \
     --global-arg 'longitude=${{ vault.get(home-location, lon) }}' \
     --json
   ```

2. **Leave `latitude`/`longitude` unset entirely.** The `forecast` method
   then auto-detects your location via a free IP geolocation lookup
   (`ipapi.co`) at run time — nothing about where you live is ever written
   to disk or committed to source control.

## How it works

### `forecast` resource

The `forecast` method resolves a location (run argument → global argument →
IP geolocation, in that order), fetches today's hourly forecast from
Open-Meteo (no API key required), and aggregates it into two windows:
morning (06:00-12:00) and afternoon/evening (12:00-18:00). Each window gets
five 0-10 sub-scores — rain, sunshine, wind, humidity, temperature — combined
into one overall score. Rain acts as a multiplicative gate rather than a flat
weighting, since a near-certain downpour can ruin an otherwise perfect drying
day outright. The result (location, both windows, sub-scores, and the
headline) is written to the `forecast` resource, versioned on every run.

## Workflow

The bundled `washing-forecast` workflow declares a `trigger.schedule` cron
entry so it fires automatically under `swamp serve` — no manual runs needed
once it's deployed:

- **06:00 and 09:00** — two checks across the morning window
- **12:00 and 17:00** — two checks across the afternoon/evening window

Each firing runs the `forecast` method once, which scores both windows in a
single pass; the four-times-daily schedule just keeps the data fresh rather
than needing four separate model definitions. Overlap prevention means a
still-running check skips the next trigger rather than stacking up. See
`workflows/workflow-washing-forecast.yaml`.

## License

MIT — see LICENSE for details.
