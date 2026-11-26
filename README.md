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

Everything is stored on the device (IndexedDB), so no wifi is needed once it's loaded. Sign in with Google (Settings → Account & Backup) to sync with your team's shared cloud database (devices don't need to be used at the same time: whichever copy of a record was changed most recently wins, and a device catches up on everything it missed before it uploads anything); you can also export a backup file from there.

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
- **App Settings**: an on/off switch for whether the Equipment Inspection bonus (+20) counts in new game runs (it asks before changing), interactive vs. plain modes for scoring and for logging iterations, and whether to **track when the robot leaves and returns** while scoring. With that off, the Robot returned / Robot leaves buttons go away and only the total time and the 2:30 mark are tracked.
- **Recently Deleted**: deleting anything moves it here for 30 days so you can restore it.

### Log tab
- **+ Record Iteration** logs a change: pick which attachment (combined attachments aren't offered), how big the change was (small bug fix / moderate change / major strategy change), a photo (live in-app camera, or choose an existing one), and what/why changed (type or dictate via the mic button) — all timestamped automatically.
- Attachment chips filter the feed below — tap one, several, or **All**. Sort by date or by attachment name.

### Game Runs tab
- **Start New Practice Game Run** → tap to begin a 3-2-1 countdown → the match clock starts and the start horn plays (if you've added sound files — see `sounds/README.md`).
- Every Run, Mission, and Task is laid out on one long scrolling page: Runs are the big headers (they stick to the top while you scroll), missions are grouped under them, and each task is a card. Bool tasks are a green **Complete** / red **Incomplete** tap; counted or multi-state tasks show their options as buttons (achieving nothing shows as neutral, not green). Tapping any of them scores it and auto-scrolls to the next task, so it flows like a step-by-step prompt, but you can scroll back up to fix something or scroll down to skip ahead whenever you want. The **↓** button under the spider and snail jumps back to the latest task (it's outlined in amber).
- With robot-trip tracking on (the default), each Run ends in a **Robot returned** button and the next Run starts with **Robot leaves for next run**, which time each mission and the transitions between Runs. Robot returned on the last Run finishes the game run. With it off, there's just a **Finish game run** button at the bottom.
- The match clock counts down from 2:30 for the whole Game Run (not per-mission), with a warning sound at 30 seconds. At zero it buzzes, turns red, and keeps counting overtime so you can finish scoring; the score at the buzzer is saved as the **timed** score and anything after as the **final** score. Tap **🏁 End** when you're done.
- A **Precision Tokens** counter floats on every guided-run screen: **−** spends one and **+** gives one back (always between 0 and 6). The spider and snail below it track Mission 10. Unused tokens score bonus points at the end (1 left → +10, 2 → +15, 3 → +25, 4 → +35, 5 or 6 → +50, 0 → +0).
- **🏁 End** (top right) stops the game run early. The time is taken the moment you tap End, not when you confirm, so the confirmation prompt never adds extra time. Then it takes you to the Final Overview. **✕** (top left) throws the run away instead. Scores are saved as you tap, so reloading mid-run doesn't lose them.
- After the last Run, you land on a **Final Overview**: every Run, Mission, and Task, grouped and still tap-to-edit, with **Save & Finish** right at the top so you can skip straight past reviewing if you want, or fix something first.
- **Official time cutoff**: on the Final Overview, and when editing a saved Game Run (tap ✏️, then ✓ to save, or ✕ to cancel and throw away the changes — Close is hidden while editing), you can pick which task was the last one done before the real 2:30 buzzer, in case the clock was started late or early. Only the tasks scored around the 2:30 mark are listed (tap Show earlier / Show later for more). The timed score is recalculated from there. Tasks you score or fix on the Final Overview (after the clock stopped) still count toward the timed score if they come at or before that last counted task. (Only for game runs recorded after this feature was added.)
- Game Runs are named by date and their number that day, e.g. **Nov. 13 #3**, everywhere they show up (including the Google Sheets export).
- **Analysis tab**: one date range applies to both sub-tabs. **Score Trend** plots each run's timed score or final score (toggle at the top) with a gridline every 100 points; past 10 runs it scrolls sideways and zooms with a pinch (or the − / + buttons). **Missions** has a checkbox to show or hide the time columns (Pts/sec and Time).
- An **incomplete** game run (the app was closed mid-run, or someone else is scoring it) can be opened by anyone on any synced device: tap it to land on its Final Overview with the clock stopped, fix or fill in scores, then **Save & Finish**. ✕ there just closes it and keeps it incomplete.
- Saved Game Runs are listed newest first by when they started, each showing its timed and final score.
- Filter saved Game Runs by date range. The stats strip shows how many game runs are saved (or how many of them are shown, when filtered), best score, average score, and average total game time. **View breakdown** shows a per-mission score/time table with transitions placed between Runs (not between every mission), Runs bolded. **Export scoresheet CSV** builds a spreadsheet (one row per task, a Run column, one column per Game Run you pick a date range for) — matching the classic mission-tracker spreadsheet format.

## Ideas for what to put in "What changed" / "Why changed"
- **What changed**: the specific part, dimension, gear ratio, angle, material, or print setting you touched
- **Why changed**: what broke or underperformed on the previous run that prompted it, and what you expected the change to fix

Comparing consecutive iterations against their run outcomes is exactly the kind of engineering-process evidence FLL judges look for.

## A note on the scoring rubric
Mission list is fully customizable on purpose — build or rebuild it from the official scoresheet once your season's missions are released, and double check your point values against it.
