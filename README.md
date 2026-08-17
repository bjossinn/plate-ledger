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

### Fuel

Daily protein, creatine and water against targets you set (defaults 200 g / 10 g / 3 L).
Quick-add buttons plus a custom amount, undo, and a seven-day strip showing which goals you hit.
Water is stored in millilitres and shown in litres. Each metric is a stat tile with a meter —
one value against one target — so identity never rests on colour alone; the hues are Okabe-Ito
derived and validated per theme for colour-vision deficiency.

### Account and sync

Optional. Sign in under **Data** and the log is mirrored to Postgres (Supabase), so a lost
phone is not a lost year. **Restore** pulls it back onto a fresh device and never overwrites
a session that already exists locally — the phone in your hand wins. Signing out leaves the
local log untouched; the cloud copy is a copy, not a migration.

Sync is a full idempotent upsert keyed on `(user_id, client_key)`, not a change log. At this
data volume a re-sync that *cannot* duplicate beats a delta that can drift.

The **program follows the account** too. Edits are timestamped and the newer side wins, with one
deliberate exception: a device syncing for the first time treats an untouched default program as
old, so signing in on a new phone pulls your real program instead of pushing the starter one over it.

Schema and the security model: [supabase/schema.sql](supabase/schema.sql). The publishable key
sits in this public repo by design — row-level security is the entire boundary, and it is
tested by attacking it (see the two-tier sharing rules in that file).

### Friends and activity

Add people by handle, accept or ignore requests, and see a shared feed of finished workouts,
records set and daily goals hit — yours and theirs together. Only finished workouts are
announced; a "started" event fired on every sync of an in-progress session, which mostly meant
the feed shouted each time the app was opened.

Sharing is two-tier and the tiers are enforced in Postgres, not in the UI. Accepted friends see
**summaries** automatically: day name, date, sets, volume, PRs, fuel totals. Your **individual
sets and weights** stay private until you turn detail on for a specific person, and that switch
is one-way — turning it on for someone does not let you see theirs.

Activity is re-derived from the local log on each sync rather than fired when it happens,
because when it happens you are usually in a gym with no signal. Each event carries a
`dedup_key`, so re-syncing can never duplicate the feed, and only the last 14 days are emitted.

### Sharing a training day

Train a day into shape, then **Edit → Send this day to a friend**. They see it under Friends and
choose to add it. Edit it later and send again: they are offered an **update** rather than a
second copy, and anything they have already logged against it stays attached — the shared
exercise ids survive the update, so a renamed lift keeps its history.

Only accepted friends can send you a day; the database rejects it otherwise.

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
