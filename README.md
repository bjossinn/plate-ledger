# Plate Ledger

A phone-first workout logger for a four-day upper/lower split. Tick sets as you finish them,
log the weight and the reps you actually got, and edit the program whenever it changes.

**Live: https://bjossinn.github.io/plate-ledger/**

Open it in Safari on an iPhone (or Chrome on Android) and add it to your Home Screen — it
installs as a standalone app and works offline once it has loaded the first time.

## What it does

- Four colour-coded training days, coded like competition bumper plates.
- Weight/reps entry per set with a tap-to-complete tick.
- Per-exercise rest timers that start on their own — 3:00 after the compounds, 1:30 after
  isolation work, and adjustable per exercise.
- Dumbbell lifts record the weight of *one* dumbbell; volume counts both hands.
- "Last time" line under every exercise, and the weight box pre-fills with what you lifted before.
- `+ Set` / `− Set` for the days you do more or less than planned.
- **Finish workout** closes a session — from the button under the list at any point, or from the
  bottom bar once every set is ticked. Finishing frees the day up to be logged again the same day.
- Full program editing: rename, reorder, change sets and rep ranges, add notes, add or delete days.
- History with per-session volume, expandable to every logged set.
- Light/dark/system theme switch.

## Where the data lives

In the browser's `localStorage`, under the key `plate-ledger-v1` — one JSON blob holding the
program, every session, and your settings. There is no server and no account, so:

- Your log never leaves your device, and two people using the same URL never see each other's numbers.
- Clearing site data erases it. Use **Data → Copy backup** now and again; **Restore from text** reads it back.
- The log does not follow you between devices or between Safari and the installed Home Screen app.

## Structure

Plain static files, no build step and no dependencies.

| File | Purpose |
| --- | --- |
| `index.html` | The whole app — markup, styles and logic in one file |
| `sw.js` | Service worker; caches the shell so the app opens without a signal |
| `manifest.webmanifest` | Installability, name, icons, standalone display |
| `favicon.svg`, `icon-*.png`, `apple-touch-icon.png` | Icons |

To work on it, open `index.html` in a browser. To test the service worker you need to serve it
over HTTP rather than `file://`:

```sh
python -m http.server 8000
```

## Releasing

Installed copies serve from cache first and fetch the update in the background, so a new version
lands on the *second* launch. **Data → Check for updates** forces it immediately.

After changing any shell file, bump both:

- `VERSION` in `index.html` — shown under Data, so you can tell what a phone is running
- `CACHE` in `sw.js` — must change, or installed copies keep serving the old files
