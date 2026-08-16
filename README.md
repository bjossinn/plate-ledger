# Plate Ledger

A phone-first workout logger for a four-day upper/lower split. Tick sets as you finish them,
log the weight and the reps you actually got, and edit the program whenever it changes.

**Live: https://bjossinn.github.io/plate-ledger/**

Open it in Safari on an iPhone (or Chrome on Android) and add it to your Home Screen — it
installs as a standalone app and works offline once it has loaded the first time.

## What it does

- Four colour-coded training days, coded like competition bumper plates.
- Weight/reps entry per set with a tap-to-complete tick; a rest timer starts on its own.
- "Last time" line under every exercise, and the weight box pre-fills with what you lifted before.
- `+ Set` / `− Set` for the days you do more or less than planned.
- Full program editing: rename, reorder, change sets and rep ranges, add notes, add or delete days.
- History with per-session volume, expandable to every logged set.

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

After changing any shell file, bump `CACHE` in `sw.js` so installed copies pick up the new version.
