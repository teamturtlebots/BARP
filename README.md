# BARP — Bot Attachment & Run Progress

An installable web app (PWA) built for practice and testing, not competition day. Two things it does:

1. **Attachment log** — an engineering notebook per attachment: what changed, why, when, and how many iterations it's been through. Useful for FLL judging writeups as much as for your own memory.
2. **Guided practice runs** — walks you through your mission list mission-by-mission, timing each one and the transitions between them, then gives you score + timing analysis across all your saved runs.

Everything is stored **only on the device it's installed on** (IndexedDB) — no wifi needed once it's loaded. Back up from Settings before handing the device to someone else or wiping it.

## 1. Put it online (so a phone can install it)

A PWA needs `https://` to be installable. The free option for a student project is **GitHub Pages**:

1. Create a public repo (e.g. `barp`).
2. Upload every file here (`index.html`, `styles.css`, `app.js`, `manifest.json`, `sw.js`, `icons/`), keeping the folder structure.
3. Repo **Settings → Pages** → source = main branch, root folder → save.
4. GitHub gives you `https://yourusername.github.io/barp/` — give it a minute to go live.

(Netlify Drop / Vercel also work if you'd rather drag-and-drop than use git.)

## 2. Install it on a phone

**Android (Chrome):** open the URL → **⋮** menu → **Add to Home screen**.
**iPhone (Safari):** open the URL → **Share** → **Add to Home Screen**.

Each install has its own separate storage — use the backup export/import in Settings to move data between devices.

## 3. Using it

### Settings — set this up first
- **Attachments**: add one per swappable part on the bot. Reorder, rename, or delete from here — this list won't change often, so it lives in Settings rather than cluttering the Log tab.
- **Missions**: add a mission, then expand it to add its tasks. Each task scores as Yes/No, a counted number of objects, or a multiple-choice state — matching however that row is scored on the official scoresheet. **Import CSV** bulk-adds missions/tasks from a spreadsheet (there's a "download example CSV" button in that dialog showing the exact format).
- **Backup**: export a full `.json` backup any time; restore replaces everything currently on the device.

### Log tab
- Pick an attachment, then **+ Log change** for every iteration: a photo, what you changed, why you changed it (type or dictate via the mic button), all timestamped automatically.
- Each attachment shows its iteration count. Flip **Show all** to see every attachment's changes merged into one chronological feed instead of one attachment at a time.

### Runs tab
- **Start New Practice Run** walks you through your mission list in order: score each task as it happens, tap **Robot returned** when the mission's done, tap **Robot leaves** when you're heading to the next one. It's timing the mission itself and the transition between missions the whole way through.
- Finishing the last mission shows a run summary (score, total time, per-mission breakdown), then saves it.
- The analysis strip above your saved runs shows best score, average score, average mission time, your slowest mission, and how the latest run compares to the one before it. Tap **View breakdown** on any saved run for its full per-mission score/time table.

## Ideas for what to put in "What changed" / "Why changed"
- **What changed**: the specific part, dimension, gear ratio, angle, material, or print setting you touched
- **Why changed**: what broke or underperformed on the previous run that prompted it, and what you expected the change to fix

Comparing consecutive iterations against their run outcomes is exactly the kind of engineering-process evidence FLL judges look for.

## A note on the scoring rubric
Mission list is fully customizable on purpose — build or rebuild it from the official scoresheet once your season's missions are released, and double check your point values against it.
