# FLL Field Logbook

A small installable web app (PWA) for two things your team needs at the pit table:

1. **Attachment log** — pick an attachment, snap a photo of every change, type or *speak* your notes.
2. **Run tracker** — build your mission list once (matching your season's scoring rubric), then score each practice/competition run like the official calculator, track score + mission success rate across all your runs, and export it all as a spreadsheet.

Everything is stored **only on the phone/tablet it's installed on** (IndexedDB), so it works with no wifi at the venue. There's a full backup/restore feature in Setup — use it.

## 1. Put it online (so a phone can install it)

A PWA needs to be served over `https://` to be installable — it can't be installed straight from a folder. The easiest free option for a student project is **GitHub Pages**:

1. Create a new repo on GitHub (e.g. `fll-logbook`), and set it public.
2. Upload every file in this folder (`index.html`, `styles.css`, `app.js`, `manifest.json`, `sw.js`, and the `icons/` folder) to the repo, keeping the same folder structure.
3. In the repo, go to **Settings → Pages**, set "Source" to your main branch, root folder, and save.
4. GitHub gives you a URL like `https://yourusername.github.io/fll-logbook/`. Give it a minute to go live.

(Netlify Drop or Vercel work too if you'd rather drag-and-drop the folder instead of using git — either one gives you an https URL, which is all that matters.)

## 2. Install it on a phone

**Android (Chrome):** open the URL, tap the **⋮** menu → **Add to Home screen** / **Install app**.

**iPhone (Safari):** open the URL, tap the **Share** button → **Add to Home Screen**.

Once added, it opens full-screen like any other app, with its own icon — no browser bar. Do this on every phone/tablet your team wants to use it on; each install has its own separate storage, so photos/notes/scores don't sync between devices (that's what the backup export in Setup is for, if you want to move data from one device to another).

## 3. Using it

### Log tab
- **+ Attachment** — add each attachment with a number and name (e.g. `#3 Coral claw`). Edit/delete with the pencil/trash icons once one is selected.
- Tap an attachment chip, then **+ Log change** to record one: take a photo (opens the camera directly on phones), type notes, or tap the mic to dictate — the recognized speech gets added straight into the notes box so you can keep talking while your hands are on the robot.
- Every entry is timestamped automatically, so you get a running build history per attachment — handy for the engineering notebook / innovation project writeup, and for remembering *why* you changed something two weeks ago.

### Setup tab — build your mission list first
Since your season's mission list and point values aren't out yet, this ships blank. When missions are released, add one row per scoring row on the rubric:
- **Yes/No** — a mission worth flat points if completed (a toggle switch when scoring).
- **Counted objects** — something you count (e.g. "samples in the habitat"), with points per unit and a max count (a number input when scoring).
- **Multiple states** — anything with a few discrete outcomes worth different points, like "not in base / partially in base / fully in base" (a dropdown when scoring).

Reorder with the ▲▼ arrows so the list matches the order missions appear on the paper scoresheet — makes it much faster to transcribe scores after a run.

### Runs tab
- **+ Run** — add one per attempt, named however you want (`Practice 3`, `Q1`, `Q2`, `Final`) — add them all up front in the order you'll run them, or add them as you go.
- **Import order** — instead of adding runs one at a time, upload a CSV with a `Run` column (and optionally a `Date` column) to bulk-create your run order from a template spreadsheet.
- **Score this run** — walks through every mission with the right control type, totals it live at the top (just like the official calculator), and lets you leave a note about that run.
- **Export CSV** — downloads a spreadsheet with one row per run, one column per mission, plus total score, missions successful, success rate %, and your notes — with season averages at the bottom. Opens straight in Excel/Sheets.

### Backup
Export a full `.json` backup before competition day and after it, and any time you're about to hand the phone to someone else. Restore replaces everything currently on the device, so double check before confirming.

## Ideas for what to log per attachment change (some teams find these useful)
- What broke or underperformed on the previous run that prompted the change
- What specifically changed (part, gear ratio, angle, material, print settings)
- What you expected it to fix
- The very next run's mission result, so you can tell later whether the change actually worked

## A note on the scoring rubric
This tool's mission list is completely customizable on purpose — the actual BIOGLOW mission list won't be revealed until the season kicks off. Rebuild the Setup list from the official scoresheet as soon as it's public, and double check your point values against it (https://eventhub.firstinspires.org/scoresheet is the official calculator, worth cross-checking your first few scored runs against).
