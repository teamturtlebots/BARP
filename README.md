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

Everything is stored on the device (IndexedDB), so no wifi is needed once it's loaded. Sign in with Google (Settings → Account & Backup) to sync with your team's shared cloud database; you can also export a backup file from there.

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
- **Attachments**: add one per swappable part on the robot, with an optional picture (live camera or file). Tap **Edit**, use ▲ ▼ (or drag ☰) to reorder, then **Save**; numbers update to match. Mark an attachment **Combined into another attachment** once it's merged into another one. Its old iterations stay in the log, but you can't log new ones on it.
- **Runs**: your mission list, organized the way it happens on the table. Tap **Edit**, then **+ Run** to add a Run (one leave-and-return trip). Tap a Run to open it and use **+ Add mission** to pull missions (or just some of their tasks) from the season's official list. Everything stays collapsed until you tap it, so the list stays short on a phone. Use ▲ ▼ to reorder Runs, missions, and tasks, and tap ✏️ on a mission to move it to a different Run. Nothing is saved until you tap **Save**, and **Cancel** undoes the whole edit. **Import CSV** bulk-adds runs/missions/tasks from a spreadsheet.
- **App Settings**: equipment-inspection prompt, keep scoring after the buzzer, and interactive vs. plain modes for scoring and for logging iterations.
- **Recently Deleted**: deleting anything moves it here for 30 days so you can restore it.

### Log tab
- **+ Record Iteration** logs a change: pick which attachment (combined attachments aren't offered), how big the change was (small bug fix / moderate change / major strategy change), a photo (live in-app camera, or choose an existing one), and what/why changed (type or dictate via the mic button) — all timestamped automatically.
- Attachment chips filter the feed below — tap one, several, or **All**. Sort by date or by attachment name.

### Game Runs tab
- **Start New Practice Game Run** → tap to begin a 3-2-1 countdown → the match clock starts and the start horn plays (if you've added sound files — see `sounds/README.md`).
- Tasks come one at a time, full-screen: bool tasks are a big green **Complete** / red **Incomplete** tap; counted or multi-state tasks show their options as big buttons (achieving nothing shows as neutral, not green). Tapping any of them commits it and auto-advances — through every task in the current mission, then straight into the next mission in the same Run, with no stop in between.
- Once every mission in a Run is done, that screen becomes a single **Robot returned** button; tap it, then **Robot leaves for next run** on the transition screen before the next Run's missions begin.
- The match clock counts down from 2:30 for the whole Game Run (not per-mission) — turns red and buzzes at zero, with a warning sound at the 30-second mark.
- A **Precision Tokens** counter floats on every guided-run screen: **−** spends one and **+** gives one back (always between 0 and 6). The spider and snail below it track Mission 10. Unused tokens score bonus points at the end (1 left → +10, 2 → +15, 3 → +25, 4 → +35, 5 or 6 → +50, 0 → +0).
- **🏁 End** (top right) stops the game run early. It asks you to confirm first, then stops the clock and takes you to the Final Overview. **✕** (top left) throws the run away instead. Scores are saved as you tap, so reloading mid-run doesn't lose them.
- After the last Run, you land on a **Final Overview**: every Run, Mission, and Task, grouped and still tap-to-edit, with **Save & Finish** right at the top so you can skip straight past reviewing if you want, or fix something first.
- Filter saved Game Runs by date range. The stats strip shows best score, average score, and average total game time. **View breakdown** shows a per-mission score/time table with transitions placed between Runs (not between every mission), Runs bolded. **Export scoresheet CSV** builds a spreadsheet (one row per task, a Run column, one column per Game Run you pick a date range for) — matching the classic mission-tracker spreadsheet format.

## Ideas for what to put in "What changed" / "Why changed"
- **What changed**: the specific part, dimension, gear ratio, angle, material, or print setting you touched
- **Why changed**: what broke or underperformed on the previous run that prompted it, and what you expected the change to fix

Comparing consecutive iterations against their run outcomes is exactly the kind of engineering-process evidence FLL judges look for.

## A note on the scoring rubric
Mission list is fully customizable on purpose — build or rebuild it from the official scoresheet once your season's missions are released, and double check your point values against it.
