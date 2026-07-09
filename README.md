# BARP — Bobot Attachment & Run Progress

An installable web app (PWA) built for practice and testing, not competition day. Two things it does:

1. **Attachment log** — an engineering notebook per attachment: what changed, why, when, and how many iterations it's been through. Useful for FLL judging writeups as much as for your own memory.
2. **Guided Game Runs** — walks you through your whole match, run by run and mission by mission, timing everything, then gives you score + timing analysis across every Game Run you've saved.

**Vocabulary, since these words get overloaded in FLL:**
- **Game Run** — the whole ~2:30 match. One score, one continuous clock, one entry in the Game Runs tab.
- **Run** — one leave-and-return trip within a Game Run (maybe with a different attachment on the robot each time). A Game Run is made of several of these.
- **Mission** — a scoring category (e.g. "M01 Coral Nursery"). Each Run covers one or more Missions.
- **Task** — the individual Yes/No, counted, or multi-state items that make up a Mission's score.

So the hierarchy is: **Game Run → Runs → Missions → Tasks.**

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
- **Attachments**: add one per swappable part on the robot, with an optional picture (live camera or file). Tap **Edit order** to drag them into a new order, then **Save order** to lock it in — numbers renumber automatically to match. This list won't change often, so it lives in Settings rather than cluttering the Log tab.
- **Runs**: this is where your mission list lives now, organized the way it actually happens on the table. Add a **Run** (one leave-and-return trip), expand it, add the **Missions** it covers, expand each mission to add its **Tasks**. Each task scores as Yes/No, a counted number of objects, or a multiple-choice state — matching however that row is scored on the official scoresheet. Runs, missions, and tasks each get their own **Edit order** drag mode. **Import CSV** bulk-adds runs/missions/tasks from a spreadsheet (there's a "download example CSV" button in that dialog showing the exact format, including the Run column).
- **Match Settings**: every Game Run starts with 6 precision tokens (fixed — see the scoring note below).
- **Backup**: an automatic backup runs quietly in the background, kept in a separate database from your main data. Every deletion anywhere in the app also saves its own snapshot from right before it happened (last 20 kept). **Restore from automatic backup** opens one menu combining both, so you can restore to any point — including a **Redo** if you picked the wrong one.

### Log tab
- **+ Record Iteration** logs a change: pick which attachment, how big the change was (small bug fix / moderate change / major strategy change), a photo (live in-app camera, or choose an existing one), and what/why changed (type or dictate via the mic button) — all timestamped automatically.
- Attachment chips filter the feed below — tap one, several, or **All**. Sort by date or by attachment name.

### Game Runs tab
- **Start New Practice Game Run** → tap to begin a 3-2-1 countdown → the match clock starts and the start horn plays (if you've added sound files — see `sounds/README.md`).
- Tasks come one at a time, full-screen: bool tasks are a big green **Complete** / red **Incomplete** tap; counted or multi-state tasks show their options as big buttons (achieving nothing shows as neutral, not green). Tapping any of them commits it and auto-advances — through every task in the current mission, then straight into the next mission in the same Run, with no stop in between.
- Once every mission in a Run is done, that screen becomes a single **Robot returned** button; tap it, then **Robot leaves for next run** on the transition screen before the next Run's missions begin.
- The match clock counts down from 2:30 for the whole Game Run (not per-mission) — turns red and buzzes at zero, with a warning sound at the 30-second mark.
- A **Precision Tokens** counter floats on every guided-run screen; tap it to spend one. Unused tokens score bonus points at the end (1 left → +10, 2 → +15, 3 → +25, 4 → +35, 5 or 6 → +50, 0 → +0).
- After the last Run, you land on a **Final Overview**: every Run, Mission, and Task, grouped and still tap-to-edit, with **Save & Finish** right at the top so you can skip straight past reviewing if you want, or fix something first.
- Filter saved Game Runs by date range. The stats strip shows best score, average score, and average total game time. **View breakdown** shows a per-mission score/time table with transitions placed between Runs (not between every mission), Runs bolded. **Export scoresheet CSV** builds a spreadsheet (one row per task, a Run column, one column per Game Run you pick a date range for) — matching the classic mission-tracker spreadsheet format.

## Ideas for what to put in "What changed" / "Why changed"
- **What changed**: the specific part, dimension, gear ratio, angle, material, or print setting you touched
- **Why changed**: what broke or underperformed on the previous run that prompted it, and what you expected the change to fix

Comparing consecutive iterations against their run outcomes is exactly the kind of engineering-process evidence FLL judges look for.

## A note on the scoring rubric
Mission list is fully customizable on purpose — build or rebuild it from the official scoresheet once your season's missions are released, and double check your point values against it.
