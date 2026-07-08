# BARP — Bobot Attachment & Run Progress

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
- **Attachments**: add one per swappable part on the bot. Tap **Edit order** to drag them into a new order, then **Save order** to lock it in — this list won't change often, so it lives in Settings rather than cluttering the Log tab.
- **Missions**: add a mission, then expand it to add its tasks. Each task scores as Yes/No, a counted number of objects, or a multiple-choice state — matching however that row is scored on the official scoresheet. Missions and tasks each get their own **Edit order** drag mode too. **Import CSV** bulk-adds missions/tasks from a spreadsheet (there's a "download example CSV" button in that dialog showing the exact format).
- **Match Settings**: how many precision tokens you start each run with.
- **Backup**: an automatic backup runs quietly in the background, kept in a separate database from your main data — restore from it if something goes wrong. You can also export/import a full `.json` backup manually. **Every deletion anywhere in the app also saves its own snapshot** from right before it happened (last 20 kept) — find those under **Undo a deletion** to put back exactly what you removed, even if the automatic backup already moved past it.

### Log tab
- **+ Record Iteration** logs a change: pick which attachment, how big the change was (small bug fix / moderate change / major strategy change), a photo (live in-app camera, or choose an existing one), and what/why changed (type or dictate via the mic button) — all timestamped automatically.
- Attachment chips filter the feed below — tap one, several, or **All**. Sort by date or by attachment name.

### Runs tab
- **Start New Practice Run** → tap to begin a 3-2-1 countdown → the match clock starts and the start horn plays (if you've added sound files — see `sounds/README.md`).
- Tasks come one at a time, full-screen: bool tasks are a big green **Complete** / red **Incomplete** tap; counted or multi-state tasks show their options as big buttons. Tapping any of them commits it and jumps to the next task automatically. A back arrow (top-left) revisits the previous task in the current mission.
- Once every task in a mission is marked, that screen is replaced by a single **Robot returned** button; tap it, then **Robot leaves for next mission** on the transition screen.
- The match clock runs continuously through the whole run (not per-mission) — turns red and buzzes at 2:30, with a warning sound at 2:00, same as a real match.
- A small precision-token counter floats on every guided-run screen; tap it to spend one.
- After the last mission, you land on a **Final Overview**: every mission and task, still tap-to-edit, with **Save & Finish** right at the top so you can skip straight past reviewing if you want, or fix something first.
- The stats strip shows best score, average score, and average total game time. Tap **View breakdown** on any saved run for its per-mission score/time table. **Export scoresheet CSV** builds a spreadsheet (one row per task, one column per run you pick, with a success-rate column) — matching the classic mission-tracker spreadsheet format.

## Ideas for what to put in "What changed" / "Why changed"
- **What changed**: the specific part, dimension, gear ratio, angle, material, or print setting you touched
- **Why changed**: what broke or underperformed on the previous run that prompted it, and what you expected the change to fix

Comparing consecutive iterations against their run outcomes is exactly the kind of engineering-process evidence FLL judges look for.

## A note on the scoring rubric
Mission list is fully customizable on purpose — build or rebuild it from the official scoresheet once your season's missions are released, and double check your point values against it.
