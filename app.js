/* BARP — Bobot Attachment & Run Progress. vanilla JS, IndexedDB-backed, offline-first PWA. */

// ---------- Service worker ----------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

// ---------- IndexedDB helper ----------
const DB_NAME = "barp-db-v1";
const DB_VERSION = 4;
let dbPromise = null;

function createStores(db) {
  if (!db.objectStoreNames.contains("attachments")) {
    db.createObjectStore("attachments", { keyPath: "id", autoIncrement: true });
  }
  if (!db.objectStoreNames.contains("entries")) {
    const s = db.createObjectStore("entries", { keyPath: "id", autoIncrement: true });
    s.createIndex("byAttachment", "attachmentId");
  }
  if (!db.objectStoreNames.contains("missions")) {
    db.createObjectStore("missions", { keyPath: "id", autoIncrement: true });
  }
  // "runGroups" = the "Run" concept in FLL terms: one leave-and-return trip,
  // containing several missions. Not to be confused with the "runs" store
  // below, which is a whole ~2:30 Game Run (the thing with the scoreboard).
  if (!db.objectStoreNames.contains("runGroups")) {
    db.createObjectStore("runGroups", { keyPath: "id", autoIncrement: true });
  }
  if (!db.objectStoreNames.contains("runs")) {
    db.createObjectStore("runs", { keyPath: "id", autoIncrement: true });
  }
  if (!db.objectStoreNames.contains("meta")) {
    db.createObjectStore("meta", { keyPath: "key" });
  }
  if (!db.objectStoreNames.contains("deletionSnapshots")) {
    db.createObjectStore("deletionSnapshots", { keyPath: "id", autoIncrement: true });
  }
  // Practice Sessions was removed as a feature — drop the leftover store if present.
  if (db.objectStoreNames.contains("sessions")) {
    db.deleteObjectStore("sessions");
  }
}

// allowRecovery=true means: if this specific database name/version conflicts
// with something already on the device, wipe just that stray database and
// recreate it fresh — there's nothing to lose from a database that has never
// successfully opened in the first place.
function tryOpenDB(allowRecovery) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => createStores(req.result);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      const err = req.error;
      if (allowRecovery && err && err.name === "VersionError") {
        const delReq = indexedDB.deleteDatabase(DB_NAME);
        delReq.onsuccess = () => { tryOpenDB(false).then(resolve, reject); };
        delReq.onerror = () => reject(err);
        delReq.onblocked = () => {
          reject(new Error("Another open tab/window with this app is blocking a required database reset — close it, then reload this page."));
        };
      } else {
        reject(err);
      }
    };
  });
}

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = tryOpenDB(true).catch((err) => { dbPromise = null; throw err; });
  return dbPromise;
}
function tx(storeNames, mode) { return openDB().then((db) => db.transaction(storeNames, mode)); }
function reqToPromise(req) {
  return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
}
async function dbGetAll(store) { const t = await tx([store], "readonly"); return reqToPromise(t.objectStore(store).getAll()); }
async function dbGet(store, key) { const t = await tx([store], "readonly"); return reqToPromise(t.objectStore(store).get(key)); }
async function dbPut(store, value) { const t = await tx([store], "readwrite"); const r = await reqToPromise(t.objectStore(store).put(value)); scheduleShadowBackup(); return r; }
async function dbDelete(store, key) { const t = await tx([store], "readwrite"); const r = await reqToPromise(t.objectStore(store).delete(key)); scheduleShadowBackup(); return r; }
async function dbGetByIndex(store, indexName, value) { const t = await tx([store], "readonly"); return reqToPromise(t.objectStore(store).index(indexName).getAll(value)); }
async function dbClear(store) { const t = await tx([store], "readwrite"); return reqToPromise(t.objectStore(store).clear()); }

// ---------- Auto-backup shadow database ----------
// A second, separate IndexedDB database that mirrors a full snapshot of your
// data. It's deliberately independent from the main database so a "Reset
// local data" or a corrupted main database doesn't take the backup down with
// it. Updated automatically ~1.5s after any save, debounced so a burst of
// edits only triggers one snapshot.
const SHADOW_DB_NAME = "barp-db-v1-shadow";
let shadowDbPromise = null;
function openShadowDB() {
  if (shadowDbPromise) return shadowDbPromise;
  shadowDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(SHADOW_DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains("snapshots")) {
        req.result.createObjectStore("snapshots", { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { shadowDbPromise = null; reject(req.error); };
  });
  return shadowDbPromise;
}
let shadowBackupTimer = null;
function scheduleShadowBackup() {
  clearTimeout(shadowBackupTimer);
  shadowBackupTimer = setTimeout(runShadowBackup, 1500);
}
async function runShadowBackup() {
  try {
    const data = {
      version: 2,
      savedAt: Date.now(),
      attachments: await dbGetAllRaw("attachments"),
      entries: await dbGetAllRaw("entries"),
      missions: await dbGetAllRaw("missions"),
      runs: await dbGetAllRaw("runs"),
      meta: await dbGetAllRaw("meta"),
      runGroups: await dbGetAllRaw("runGroups"),
    };
    const db = await openShadowDB();
    await new Promise((resolve, reject) => {
      const t = db.transaction("snapshots", "readwrite");
      t.objectStore("snapshots").put({ key: "latest", data });
      t.oncomplete = () => { renderLastBackupTime(); resolve(); };
      t.onerror = () => reject(t.error);
    });
  } catch (e) { /* best-effort background task — never surface this to the user */ }
}
// Raw reads that bypass the main dbGetAll/scheduleShadowBackup loop (avoids
// the backup triggering itself, and avoids depending on openDB()'s recovery
// path while a backup is mid-flight).
async function dbGetAllRaw(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction([store], "readonly").objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function getShadowBackup() {
  const db = await openShadowDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction("snapshots", "readonly").objectStore("snapshots").get("latest");
    req.onsuccess = () => resolve(req.result?.data || null);
    req.onerror = () => reject(req.error);
  });
}
async function restoreFullData(data) {
  await dbClear("attachments"); await dbClear("entries"); await dbClear("missions"); await dbClear("runs"); await dbClear("meta"); await dbClear("runGroups");
  for (const a of data.attachments || []) await dbPut("attachments", a);
  for (const en of data.entries || []) await dbPut("entries", en);
  for (const m of data.missions || []) await dbPut("missions", m);
  for (const r of data.runs || []) await dbPut("runs", r);
  for (const meta of data.meta || []) await dbPut("meta", meta);
  for (const g of data.runGroups || []) await dbPut("runGroups", g);
  await initAll();
}
async function snapshotCurrentData() {
  return {
    attachments: await dbGetAllRaw("attachments"),
    entries: await dbGetAllRaw("entries"),
    missions: await dbGetAllRaw("missions"),
    runs: await dbGetAllRaw("runs"),
    meta: await dbGetAllRaw("meta"),
    runGroups: await dbGetAllRaw("runGroups"),
  };
}
// Not persisted to disk — just enough to undo your last restore within this
// session, so it doesn't need to be very persistent.
let lastPreRestoreSnapshot = null;

async function renderLastBackupTime() {
  const el = document.getElementById("last-backup-line");
  if (!el) return;
  try {
    const data = await getShadowBackup();
    el.textContent = data ? `Last automatic backup: ${new Date(data.savedAt).toLocaleString()}` : "No automatic backup yet.";
  } catch (e) { el.textContent = "No automatic backup yet."; }
}

// ---------- Pre-delete safety snapshots ----------
// The rolling auto-backup updates itself shortly after every change — including
// deletes — so on its own it can't undo a delete (by the time it saves, the
// deleted item is already gone). This takes a separate, one-off full snapshot
// right before any delete actually happens, so there's always something to
// restore even after the auto-backup has moved on.
const MAX_DELETION_SNAPSHOTS = 20;
async function snapshotBeforeDelete(label) {
  try {
    const data = await snapshotCurrentData();
    await dbPut("deletionSnapshots", { takenAt: Date.now(), label, data });
    const all = await dbGetAll("deletionSnapshots");
    if (all.length > MAX_DELETION_SNAPSHOTS) {
      all.sort((a, b) => a.takenAt - b.takenAt);
      for (const old of all.slice(0, all.length - MAX_DELETION_SNAPSHOTS)) await dbDelete("deletionSnapshots", old.id);
    }
  } catch (e) { /* best-effort — never block the actual delete on this */ }
}

async function openBackupMenu() {
  const shadow = await getShadowBackup();
  const delSnaps = await dbGetAll("deletionSnapshots");
  const items = [];
  if (shadow) items.push({ label: "Automatic backup", takenAt: shadow.savedAt, data: shadow });
  delSnaps.forEach((s) => items.push({ label: s.label, takenAt: s.takenAt, data: s.data }));
  items.sort((a, b) => b.takenAt - a.takenAt);

  openModal(`
    <h2>Restore a backup</h2>
    ${lastPreRestoreSnapshot ? `<button type="button" class="btn btn-amber btn-full" id="btn-redo-restore" style="margin-bottom:14px;">&#8635; Redo (undo the last restore)</button>` : ""}
    <p class="empty-sub">Pick a point in time to restore everything back to. This includes the automatic background backup and a snapshot from right before every deletion.</p>
    <div id="backup-menu-list" class="mission-list">
      ${items.length ? "" : `<p class="empty-sub">Nothing to restore yet.</p>`}
    </div>
    <div class="modal-actions"><button class="btn btn-ghost btn-full" id="m-close" type="button">Close</button></div>
  `);
  document.getElementById("m-close").addEventListener("click", closeModal);
  const list = document.getElementById("backup-menu-list");
  items.forEach((item) => {
    const row = document.createElement("div");
    row.className = "mission-row";
    row.innerHTML = `
      <div class="m-info">
        <div class="m-name">${esc(item.label)}</div>
        <div class="m-sub">${new Date(item.takenAt).toLocaleString()}</div>
      </div>
      <button class="btn btn-ghost" data-act="restore">Restore</button>
    `;
    row.querySelector('[data-act="restore"]').addEventListener("click", async () => {
      if (!confirm(`Restore everything to "${item.label}" (${new Date(item.takenAt).toLocaleString()})? This replaces everything currently on this device.`)) return;
      lastPreRestoreSnapshot = { label: `Before restoring "${item.label}"`, data: await snapshotCurrentData() };
      await restoreFullData(item.data);
      closeModal();
      alert("Restored.");
    });
    list.appendChild(row);
  });
  const redoBtn = document.getElementById("btn-redo-restore");
  if (redoBtn) redoBtn.addEventListener("click", async () => {
    if (!lastPreRestoreSnapshot) return;
    if (!confirm("Undo that restore and bring back what was there right before it?")) return;
    const snap = lastPreRestoreSnapshot;
    lastPreRestoreSnapshot = null;
    await restoreFullData(snap.data);
    closeModal();
    alert("Redone.");
  });
}

// ---------- App state ----------
const state = {
  attachments: [],
  selectedAttachmentIds: new Set(),
  filterInitialized: false,
  entries: [],
  missions: [],
  runGroups: [], // "Run" = one leave-and-return trip, grouping several missions
  runs: [],
  expandedMissions: new Set(),
  expandedRunGroups: new Set(),
  editingAttachmentOrder: false,
  editingAllOrder: false,
  guidedRun: null, // { run, legIdx, missionIdxInLeg, taskIdx, matchStartTs, ... }
};

// ---------- Visible error reporting ----------
// If a click handler throws, buttons can look "dead" (the CSS :active press
// still fires since that's pure CSS, but nothing else happens). This surfaces
// the real error on screen instead of it vanishing into the console.
function showErrorBanner(message) {
  let banner = document.getElementById("error-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "error-banner";
    banner.className = "error-banner";
    banner.addEventListener("click", () => { banner.hidden = true; });
    document.body.appendChild(banner);
  }
  banner.onclick = () => { banner.hidden = true; };
  banner.textContent = "Something went wrong: " + message + " — tap to dismiss";
  banner.hidden = false;
}
function resetLocalDatabase() {
  const req = indexedDB.deleteDatabase(DB_NAME);
  req.onsuccess = () => location.reload();
  req.onerror = () => location.reload();
  req.onblocked = () => showErrorBanner("Close any other open tabs/windows with this app, then try again.");
}
window.addEventListener("error", (e) => showErrorBanner(e.message || String(e.error)));
window.addEventListener("unhandledrejection", (e) => showErrorBanner(e.reason?.message || String(e.reason)));

// ---------- Drag-to-reorder (touch-friendly, works with mouse too) ----------
// Attach to a row that has a ".drag-handle" element inside it. `itemsArray`
// is the live array being reordered (mutated in place via splice/swap) and
// `container` is the row's parent. Rows keep their real DOM nodes throughout
// the drag (swapped via insertBefore, never recreated), so pointer capture on
// the handle stays valid for the whole gesture.
function attachRowDrag(row, container, itemsArray, onSwap) {
  const handle = row.querySelector(".drag-handle");
  if (!handle) return;
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    try { handle.setPointerCapture(e.pointerId); } catch (err) {}
    row.classList.add("dragging");
    let startY = e.clientY;

    function swap(rowA, rowB) {
      const idxA = Number(rowA.dataset.idx), idxB = Number(rowB.dataset.idx);
      const tmp = itemsArray[idxA];
      itemsArray[idxA] = itemsArray[idxB];
      itemsArray[idxB] = tmp;
      rowA.dataset.idx = idxB;
      rowB.dataset.idx = idxA;
      if (onSwap) onSwap();
    }

    function onMove(ev) {
      const dy = ev.clientY - startY;
      row.style.transform = `translateY(${dy}px)`;
      const rect = row.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;

      const prev = row.previousElementSibling;
      if (prev && prev.classList.contains("drag-row")) {
        const prevRect = prev.getBoundingClientRect();
        if (midY < prevRect.top + prevRect.height / 2) {
          container.insertBefore(row, prev);
          swap(row, prev);
          startY = ev.clientY;
          row.style.transform = "translateY(0px)";
        }
      }
      const next = row.nextElementSibling;
      if (next && next.classList.contains("drag-row")) {
        const nextRect = next.getBoundingClientRect();
        if (midY > nextRect.top + nextRect.height / 2) {
          container.insertBefore(next, row);
          swap(row, next);
          startY = ev.clientY;
          row.style.transform = "translateY(0px)";
        }
      }
    }
    function onUp() {
      try { handle.releasePointerCapture(e.pointerId); } catch (err) {}
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      row.classList.remove("dragging");
      row.style.transform = "";
    }
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  });
}
function reorderToolbarHTML(editing, prefix) {
  return editing
    ? `<div class="reorder-toolbar-small"><button type="button" class="btn-small-link" id="btn-save-order-${prefix}">Save order</button><button type="button" class="btn-small-link" id="btn-cancel-order-${prefix}">Cancel</button></div>`
    : `<div class="reorder-toolbar-small"><button type="button" class="btn-small-link" id="btn-edit-order-${prefix}">&#8645; Reorder</button></div>`;
}

// ---------- Modal helpers ----------
const modalBackdrop = document.getElementById("modal-backdrop");
const modalBox = document.getElementById("modal-box");
function openModal(html) { modalBox.innerHTML = html; modalBackdrop.hidden = false; }
function closeModal() { modalBackdrop.hidden = true; modalBox.innerHTML = ""; }
modalBackdrop.addEventListener("click", (e) => {
  if (e.target === modalBackdrop && !state.guidedRun) closeModal();
});

function confirmDestructive(message, onConfirm) {
  openModal(`
    <h2>Are you sure?</h2>
    <p class="empty-sub">${message}</p>
    <div class="field"><label>Type DELETE to confirm</label><input class="text-input" id="cd-input" placeholder="DELETE" autocomplete="off"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="m-cancel" type="button">Cancel</button>
      <button class="btn btn-danger" id="cd-confirm" type="button" disabled>Delete</button>
    </div>
  `);
  document.getElementById("m-cancel").addEventListener("click", closeModal);
  const input = document.getElementById("cd-input");
  const btn = document.getElementById("cd-confirm");
  input.addEventListener("input", () => { btn.disabled = input.value.trim().toUpperCase() !== "DELETE"; });
  btn.addEventListener("click", () => { closeModal(); onConfirm(); });
}

let undoToastTimer = null;
function showUndoToast(message, onUndo) {
  let toast = document.getElementById("undo-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "undo-toast";
    toast.className = "undo-toast";
    document.body.appendChild(toast);
  }
  clearTimeout(undoToastTimer);
  toast.innerHTML = `<span>${esc(message)}</span><button type="button" id="undo-toast-btn">Undo</button>`;
  toast.hidden = false;
  document.getElementById("undo-toast-btn").addEventListener("click", () => {
    toast.hidden = true;
    clearTimeout(undoToastTimer);
    onUndo();
  });
  undoToastTimer = setTimeout(() => { toast.hidden = true; }, 8000);
}

// ---------- Tab navigation ----------
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".view").forEach((v) => (v.hidden = true));
    btn.classList.add("active");
    document.getElementById(btn.dataset.view).hidden = false;
    if (btn.dataset.view === "view-setup") { renderLastBackupTime(); }
  });
});

// ---------- Utility ----------
function esc(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtDate(ts) {
  const d = new Date(ts);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function fmtDuration(ms) {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60), s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
function csvEscape(val) {
  const s = String(val ?? "");
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; } }
      else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        if (row.some((f) => f !== "")) rows.push(row);
        row = [];
      } else field += c;
    }
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ---------- Task scoring math ----------
function taskMaxPoints(t) {
  if (t.type === "bool") return t.points || 0;
  if (t.type === "number") return (t.max || 0) * (t.pointsPerUnit || 1);
  if (t.type === "choice") return (t.options || []).reduce((mx, o) => Math.max(mx, o.points || 0), 0);
  return 0;
}
function pointsFromRawTask(t, raw) {
  if (t.type === "bool") return raw ? (t.points || 0) : 0;
  if (t.type === "number") return (Number(raw) || 0) * (t.pointsPerUnit || 1);
  if (t.type === "choice") {
    if (raw === null || raw === undefined || raw === "") return 0;
    const opt = (t.options || [])[raw];
    return opt ? (opt.points || 0) : 0;
  }
  return 0;
}
function missionMaxPoints(m) { return (m.tasks || []).reduce((sum, t) => sum + taskMaxPoints(t), 0); }
function missionScoreForRun(m, run) {
  return (m.tasks || []).reduce((sum, t) => sum + pointsFromRawTask(t, (run.rawScores || {})[t.id]), 0);
}
// Bonus points awarded for unused precision tokens at the end of a run —
// every run starts with 6, and how many are left over scores extra.
const PRECISION_TOKEN_BONUS = { 0: 0, 1: 10, 2: 15, 3: 25, 4: 35, 5: 50, 6: 50 };
function precisionTokenBonus(remaining) { return PRECISION_TOKEN_BONUS[remaining] ?? 0; }
const PRECISION_TOKENS_START = 6;

function runMaxPoints(missions) { return missions.reduce((sum, m) => sum + missionMaxPoints(m), 0) + 50; }
function runTotal(run, missions) {
  return missions.reduce((sum, m) => sum + missionScoreForRun(m, run), 0) + precisionTokenBonus(run.precisionTokensRemaining ?? 0);
}

// ==========================================================
// ATTACHMENTS + LOG
// ==========================================================
async function loadAttachments() {
  state.attachments = (await dbGetAll("attachments")).sort((a, b) => (a.order ?? a.number ?? 0) - (b.order ?? b.number ?? 0));
  if (!state.filterInitialized) {
    state.selectedAttachmentIds = new Set(state.attachments.map((a) => a.id));
    state.filterInitialized = true;
  } else {
    state.selectedAttachmentIds = new Set([...state.selectedAttachmentIds].filter((id) => state.attachments.some((a) => a.id === id)));
  }
  renderAttachmentChips();
  renderAttachmentsSetup();
  await renderIterationTotal();
  await renderEntryList();
}

async function iterationCount(attachmentId) {
  const entries = await dbGetByIndex("entries", "byAttachment", attachmentId);
  return entries.filter((e) => !e.deleted).length;
}

async function renderIterationTotal() {
  const all = (await dbGetAll("entries")).filter((e) => !e.deleted);
  const line = document.getElementById("iteration-total-line");
  line.textContent = all.length ? `${all.length} total engineering iteration${all.length === 1 ? "" : "s"} logged` : "";
}

function renderAttachmentChips() {
  const wrap = document.getElementById("attachment-chips");
  wrap.innerHTML = "";
  document.getElementById("log-empty-state").hidden = state.attachments.length > 0;
  document.querySelector(".filter-row").hidden = state.attachments.length === 0;
  if (!state.attachments.length) { document.getElementById("entry-list").innerHTML = ""; document.getElementById("log-select-prompt").hidden = true; return; }

  const allBtn = document.createElement("button");
  const allSelected = state.selectedAttachmentIds.size === state.attachments.length;
  allBtn.className = "chip chip-all" + (allSelected ? " active" : "");
  allBtn.textContent = "All";
  allBtn.addEventListener("click", async () => {
    state.selectedAttachmentIds = allSelected ? new Set() : new Set(state.attachments.map((a) => a.id));
    renderAttachmentChips();
    await renderEntryList();
  });
  wrap.appendChild(allBtn);

  state.attachments.forEach((att) => {
    const chip = document.createElement("button");
    chip.className = "chip" + (state.selectedAttachmentIds.has(att.id) ? " active" : "");
    chip.innerHTML = `<span class="chip-num">#${esc(att.number)}</span>${esc(att.name)}`;
    chip.addEventListener("click", async () => {
      if (state.selectedAttachmentIds.has(att.id)) state.selectedAttachmentIds.delete(att.id);
      else state.selectedAttachmentIds.add(att.id);
      renderAttachmentChips();
      await renderEntryList();
    });
    wrap.appendChild(chip);
  });
}

document.getElementById("sort-select").addEventListener("change", renderEntryList);

function entryCardHTML(entry, attachmentLabel) {
  const sizeLabel = { small: "Small — bug fix", moderate: "Moderate change", major: "Major — strategy change" }[entry.size] || "";
  return `
    ${entry.photo ? `<img src="${entry.photo}" alt="">` : ""}
    <div class="entry-body">
      <div class="entry-time">
        ${fmtDate(entry.timestamp)}
        ${attachmentLabel ? ` &middot; <span class="entry-att-tag">${esc(attachmentLabel)}</span>` : ""}
        ${sizeLabel ? ` &middot; <span class="size-badge size-${entry.size}">${esc(sizeLabel)}</span>` : ""}
      </div>
      <div class="entry-field"><span class="entry-field-label">What changed</span>${esc(entry.whatChanged) || "<em>&mdash;</em>"}</div>
      <div class="entry-field"><span class="entry-field-label">Why changed</span>${esc(entry.whyChanged) || "<em>&mdash;</em>"}</div>
      <div class="entry-actions">
        <button class="btn-icon" data-id="${entry.id}" title="Delete">&#128465;&#65039;</button>
      </div>
    </div>`;
}

async function renderEntryList() {
  const list = document.getElementById("entry-list");
  const prompt = document.getElementById("log-select-prompt");
  if (!state.attachments.length) { list.innerHTML = ""; prompt.hidden = true; return; }
  if (!state.selectedAttachmentIds.size) { list.innerHTML = ""; prompt.hidden = false; return; }
  prompt.hidden = true;

  const attById = Object.fromEntries(state.attachments.map((a) => [a.id, a]));
  const allEntries = await dbGetAll("entries");
  let entries = allEntries.filter((e) => !e.deleted && state.selectedAttachmentIds.has(e.attachmentId));

  const sortMode = document.getElementById("sort-select").value;
  if (sortMode === "name") {
    entries.sort((a, b) => {
      const an = attById[a.attachmentId]?.name || "", bn = attById[b.attachmentId]?.name || "";
      return an.localeCompare(bn) || b.timestamp - a.timestamp;
    });
  } else {
    entries.sort((a, b) => b.timestamp - a.timestamp);
  }

  list.innerHTML = "";
  if (!entries.length) {
    list.innerHTML = `<p class="empty-sub">No iterations recorded yet for the selected attachment${state.selectedAttachmentIds.size === 1 ? "" : "s"}. Tap + Record Iteration above to log your first change.</p>`;
    return;
  }
  const showTag = state.selectedAttachmentIds.size > 1 || state.attachments.length > 1;
  entries.forEach((entry) => {
    const att = attById[entry.attachmentId];
    const card = document.createElement("div");
    card.className = "entry-card";
    card.innerHTML = entryCardHTML(entry, showTag ? (att ? `#${att.number} ${att.name}` : "deleted attachment") : null);
    card.querySelector(".btn-icon").addEventListener("click", () => {
      confirmDestructive("This removes the entry from the log. You'll have a few seconds to undo right after.", async () => {
        await snapshotBeforeDelete(`Before deleting a log entry`);
        entry.deleted = true;
        entry.deletedAt = Date.now();
        await dbPut("entries", entry);
        await renderEntryList();
        await renderIterationTotal();
        renderAttachmentsSetup();
        showUndoToast("Entry deleted.", async () => {
          delete entry.deleted;
          delete entry.deletedAt;
          await dbPut("entries", entry);
          await renderEntryList();
          await renderIterationTotal();
          renderAttachmentsSetup();
        });
      });
    });
    list.appendChild(card);
  });
}

// ---- Attachment management (Setup tab) ----
document.getElementById("btn-add-attachment").addEventListener("click", () => openAttachmentModal(null));
document.getElementById("btn-record-iteration").addEventListener("click", () => openRecordIterationModal());

function renderAttachmentsSetup() {
  const list = document.getElementById("attachment-setup-list");
  const editing = state.editingAttachmentOrder;
  (async () => {
    list.innerHTML = "";
    if (!state.attachments.length) {
      list.innerHTML = `<p class="empty-sub">No attachments yet. Add one for each swappable part on the robot.</p>`;
      list.insertAdjacentHTML("beforeend", reorderToolbarHTML(editing, "attachments"));
      wireAttachmentOrderToolbar();
      return;
    }
    for (const [idx, att] of state.attachments.entries()) {
      const row = document.createElement("div");
      row.dataset.idx = idx;
      if (editing) {
        row.className = "mission-row drag-row";
        row.innerHTML = `
          <span class="drag-handle">&#9776;</span>
          <span class="drag-num">#${idx + 1}</span>
          <div class="m-info"><div class="m-name">${esc(att.name)}</div></div>
        `;
        list.appendChild(row);
        attachRowDrag(row, list, state.attachments, () => {
          [...list.querySelectorAll(".drag-row .drag-num")].forEach((el, i) => { el.textContent = `#${i + 1}`; });
        });
      } else {
        const count = await iterationCount(att.id);
        row.className = "mission-row";
        row.innerHTML = `
          ${att.photo ? `<img class="att-thumb" src="${att.photo}" alt="">` : ""}
          <div class="m-info">
            <div class="m-name">#${esc(att.number)} ${esc(att.name)}</div>
            <div class="m-sub">${count} iteration${count === 1 ? "" : "s"} logged</div>
          </div>
          <button class="btn-icon" data-act="edit">&#9998;&#65039;</button>
          <button class="btn-icon" data-act="del">&#128465;&#65039;</button>
        `;
        row.querySelector('[data-act="edit"]').addEventListener("click", () => openAttachmentModal(att));
        row.querySelector('[data-act="del"]').addEventListener("click", async () => {
          if (confirm(`Delete "${att.name}" and everything logged under it?`)) {
            await snapshotBeforeDelete(`Before deleting attachment "${att.name}"`);
            const entries = await dbGetByIndex("entries", "byAttachment", att.id);
            for (const en of entries) await dbDelete("entries", en.id);
            await dbDelete("attachments", att.id);
            const remaining = (await dbGetAll("attachments")).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
            for (const [i, a] of remaining.entries()) { a.order = i; a.number = i + 1; await dbPut("attachments", a); }
            await loadAttachments();
          }
        });
        list.appendChild(row);
      }
    }
    list.insertAdjacentHTML("beforeend", reorderToolbarHTML(editing, "attachments"));
    wireAttachmentOrderToolbar();
  })();
}

function wireAttachmentOrderToolbar() {
  const editBtn = document.getElementById("btn-edit-order-attachments");
  if (editBtn) editBtn.addEventListener("click", () => { state.editingAttachmentOrder = true; renderAttachmentsSetup(); });
  const cancelBtn = document.getElementById("btn-cancel-order-attachments");
  if (cancelBtn) cancelBtn.addEventListener("click", async () => {
    state.editingAttachmentOrder = false;
    state.attachments = (await dbGetAll("attachments")).sort((a, b) => (a.order ?? a.number ?? 0) - (b.order ?? b.number ?? 0));
    renderAttachmentsSetup();
  });
  const saveBtn = document.getElementById("btn-save-order-attachments");
  if (saveBtn) saveBtn.addEventListener("click", async () => {
    for (const [idx, att] of state.attachments.entries()) { att.order = idx; att.number = idx + 1; await dbPut("attachments", att); }
    state.editingAttachmentOrder = false;
    await loadAttachments();
    await runShadowBackup();
  });
}

function openAttachmentModal(att) {
  const isEdit = !!att;
  let pendingAttPhoto = isEdit ? (att.photo || null) : null;
  openModal(`
    <h2>${isEdit ? "Edit attachment" : "New attachment"}</h2>
    <div class="field"><label>Name</label><input class="text-input" id="m-att-name" type="text" value="${isEdit ? esc(att.name) : ""}" placeholder="e.g. Coral claw"></div>
    <div class="field">
      <label>Picture (optional)</label>
      <div class="photo-preview-wrap" id="att-photo-preview-wrap">${pendingAttPhoto ? `<img class="photo-preview" src="${pendingAttPhoto}">` : ""}</div>
      <div class="camera-view" id="att-camera-view" hidden>
        <video id="att-camera-video" autoplay playsinline muted></video>
        <div class="camera-controls">
          <button type="button" class="btn btn-ghost" id="att-camera-cancel">Cancel</button>
          <button type="button" class="btn btn-primary" id="att-camera-capture">Capture</button>
        </div>
      </div>
      <div class="btn-group" id="att-photo-btn-group">
        <button type="button" class="btn btn-amber" id="att-btn-take-photo">&#128247; Take Photo</button>
        <button type="button" class="btn btn-ghost" id="att-btn-choose-photo">Choose from files</button>
      </div>
      <input type="file" accept="image/*" id="m-att-photo" hidden>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="m-cancel" type="button">Cancel</button>
      <button class="btn btn-primary" id="m-save" type="button">Save</button>
    </div>
  `);
  const attCameraIds = { view: "att-camera-view", video: "att-camera-video", btnGroup: "att-photo-btn-group", previewWrap: "att-photo-preview-wrap" };
  document.getElementById("m-cancel").addEventListener("click", () => { stopCamera(); closeModal(); });
  document.getElementById("att-btn-choose-photo").addEventListener("click", () => document.getElementById("m-att-photo").click());
  document.getElementById("att-btn-take-photo").addEventListener("click", () => openCamera(attCameraIds, (dataUrl) => { pendingAttPhoto = dataUrl; }));
  document.getElementById("att-camera-cancel").addEventListener("click", () => stopCamera());
  document.getElementById("att-camera-capture").addEventListener("click", () => capturePhoto());
  document.getElementById("m-att-photo").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    pendingAttPhoto = await resizeImageToDataURL(file, 900, 0.72);
    document.getElementById("att-photo-preview-wrap").innerHTML = `<img class="photo-preview" src="${pendingAttPhoto}">`;
  });
  document.getElementById("m-save").addEventListener("click", async () => {
    stopCamera();
    const name = document.getElementById("m-att-name").value.trim();
    if (!name) { alert("Give this attachment a name."); return; }
    const record = isEdit ? att : { order: state.attachments.length, number: state.attachments.length + 1 };
    record.name = name;
    record.photo = pendingAttPhoto;
    if (!isEdit) record.createdAt = Date.now();
    const id = await dbPut("attachments", record);
    if (!isEdit) state.selectedAttachmentIds.add(id);
    closeModal();
    await loadAttachments();
  });
}

// ---- Record Iteration modal (attachment picker + size + what/why + photo + voice-to-text) ----
let pendingPhoto = null;
let pendingSize = "small";
let recognizer = null;

function openRecordIterationModal() {
  if (!state.attachments.length) {
    openModal(`<h2>No attachments yet</h2><p class="empty-sub">Go to Settings to add a robot attachment first.</p>
      <div class="modal-actions"><button class="btn btn-primary" id="m-close" type="button">Got it</button></div>`);
    document.getElementById("m-close").addEventListener("click", closeModal);
    return;
  }
  pendingPhoto = null;
  pendingSize = "small";
  const defaultAttId = state.selectedAttachmentIds.size === 1 ? [...state.selectedAttachmentIds][0] : state.attachments[0].id;
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  openModal(`
    <h2>Record Iteration</h2>
    <div class="field"><label>Attachment</label>
      <select class="text-input" id="ri-attachment">
        ${state.attachments.map((a) => `<option value="${a.id}" ${a.id === defaultAttId ? "selected" : ""}>#${esc(a.number)} ${esc(a.name)}</option>`).join("")}
      </select>
    </div>
    <div class="field"><label>Size of this iteration</label>
      <div class="size-picker" id="ri-size-picker">
        <button type="button" class="size-btn active" data-size="small">Small<span>bug fix</span></button>
        <button type="button" class="size-btn" data-size="moderate">Moderate<span>a real change</span></button>
        <button type="button" class="size-btn" data-size="major">Major<span>strategy change</span></button>
      </div>
    </div>
    <div class="field">
      <label>Photo</label>
      <div class="photo-preview-wrap" id="photo-preview-wrap"></div>
      <div class="camera-view" id="camera-view" hidden>
        <video id="camera-video" autoplay playsinline muted></video>
        <div class="camera-controls">
          <button type="button" class="btn btn-ghost" id="camera-cancel">Cancel</button>
          <button type="button" class="btn btn-primary" id="camera-capture">Capture</button>
        </div>
      </div>
      <div class="btn-group" id="photo-btn-group">
        <button type="button" class="btn btn-amber" id="btn-take-photo">&#128247; Take Photo</button>
        <button type="button" class="btn btn-ghost" id="btn-choose-photo">Choose from files</button>
      </div>
      <input type="file" accept="image/*" id="ri-photo" hidden>
    </div>
    <div class="field">
      <label>What changed?</label>
      ${SpeechRec ? `<div class="voice-row"><button class="btn btn-ghost" id="m-voice-btn-1" type="button">&#127908; Dictate</button><span class="voice-status" id="m-voice-status-1"></span></div>` : ""}
      <textarea class="textarea-input" id="ri-what" placeholder="e.g. Swapped the claw's gear ratio from 1:1 to 3:1"></textarea>
    </div>
    <div class="field">
      <label>Why changed?</label>
      ${SpeechRec ? `<div class="voice-row"><button class="btn btn-ghost" id="m-voice-btn-2" type="button">&#127908; Dictate</button><span class="voice-status" id="m-voice-status-2"></span></div>` : ""}
      <textarea class="textarea-input" id="ri-why" placeholder="e.g. It was stalling under load on the last run"></textarea>
    </div>
    ${SpeechRec ? "" : `<p class="type-hint">Voice-to-text isn't supported in this browser &mdash; try Chrome on Android.</p>`}
    <div class="modal-actions">
      <button class="btn btn-ghost" id="m-cancel" type="button">Cancel</button>
      <button class="btn btn-primary" id="m-save" type="button">Save entry</button>
    </div>
  `);
  document.getElementById("m-cancel").addEventListener("click", () => { stopRecognizer(); stopCamera(); closeModal(); });

  document.querySelectorAll("#ri-size-picker .size-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#ri-size-picker .size-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      pendingSize = btn.dataset.size;
    });
  });

  document.getElementById("btn-choose-photo").addEventListener("click", () => document.getElementById("ri-photo").click());
  document.getElementById("ri-photo").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    pendingPhoto = await resizeImageToDataURL(file, 900, 0.72);
    document.getElementById("photo-preview-wrap").innerHTML = `<img class="photo-preview" src="${pendingPhoto}">`;
  });

  const riCameraIds = { view: "camera-view", video: "camera-video", btnGroup: "photo-btn-group", previewWrap: "photo-preview-wrap" };
  document.getElementById("btn-take-photo").addEventListener("click", () => openCamera(riCameraIds, (dataUrl) => { pendingPhoto = dataUrl; }));
  document.getElementById("camera-cancel").addEventListener("click", () => stopCamera());
  document.getElementById("camera-capture").addEventListener("click", () => capturePhoto());

  if (SpeechRec) {
    document.getElementById("m-voice-btn-1").addEventListener("click", () => toggleVoiceNote(SpeechRec, "ri-what", "m-voice-status-1", "m-voice-btn-1"));
    document.getElementById("m-voice-btn-2").addEventListener("click", () => toggleVoiceNote(SpeechRec, "ri-why", "m-voice-status-2", "m-voice-btn-2"));
  }

  document.getElementById("m-save").addEventListener("click", async () => {
    stopRecognizer();
    stopCamera();
    const attachmentId = Number(document.getElementById("ri-attachment").value);
    const whatChanged = document.getElementById("ri-what").value.trim();
    const whyChanged = document.getElementById("ri-why").value.trim();
    if (!whatChanged && !whyChanged && !pendingPhoto) { alert("Add a photo or a note first."); return; }
    await dbPut("entries", { attachmentId, timestamp: Date.now(), photo: pendingPhoto, whatChanged, whyChanged, size: pendingSize });
    state.selectedAttachmentIds.add(attachmentId);
    closeModal();
    renderAttachmentChips();
    await renderEntryList();
    await renderIterationTotal();
    renderAttachmentsSetup();
  });
}

let activeCameraStream = null;
let activeCameraIds = null;
let activeCameraCallback = null;
async function openCamera(ids, onCapture) {
  activeCameraIds = ids;
  activeCameraCallback = onCapture;
  try {
    activeCameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
    const video = document.getElementById(ids.video);
    video.srcObject = activeCameraStream;
    document.getElementById(ids.view).hidden = false;
    document.getElementById(ids.btnGroup).hidden = true;
  } catch (err) {
    // Permission denied, no camera, or an insecure context — fall back to the
    // regular file picker rather than leaving the person stuck.
    showErrorBanner("Couldn't access the camera (" + (err.message || err.name) + ") — use Choose from files instead.");
  }
}
function stopCamera() {
  if (activeCameraStream) { activeCameraStream.getTracks().forEach((t) => t.stop()); activeCameraStream = null; }
  if (activeCameraIds) {
    const view = document.getElementById(activeCameraIds.view);
    const btnGroup = document.getElementById(activeCameraIds.btnGroup);
    if (view) view.hidden = true;
    if (btnGroup) btnGroup.hidden = false;
  }
}
function capturePhoto() {
  if (!activeCameraIds) return;
  const video = document.getElementById(activeCameraIds.video);
  const maxDim = 900;
  let { videoWidth: width, videoHeight: height } = video;
  if (!width || !height) return;
  if (width > height && width > maxDim) { height = Math.round(height * (maxDim / width)); width = maxDim; }
  else if (height > maxDim) { width = Math.round(width * (maxDim / height)); height = maxDim; }
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  canvas.getContext("2d").drawImage(video, 0, 0, width, height);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.72);
  const wrap = document.getElementById(activeCameraIds.previewWrap);
  if (wrap) wrap.innerHTML = `<img class="photo-preview" src="${dataUrl}">`;
  if (activeCameraCallback) activeCameraCallback(dataUrl);
  stopCamera();
}

function resizeImageToDataURL(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => { img.src = reader.result; };
    reader.onerror = reject;
    img.onload = () => {
      let { width, height } = img;
      if (width > height && width > maxDim) { height = Math.round(height * (maxDim / width)); width = maxDim; }
      else if (height > maxDim) { width = Math.round(width * (maxDim / height)); height = maxDim; }
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function toggleVoiceNote(SpeechRec, textareaId, statusId, btnId) {
  const statusEl = document.getElementById(statusId);
  const btn = document.getElementById(btnId);
  if (recognizer) { stopRecognizer(); return; }
  recognizer = new SpeechRec();
  recognizer.lang = "en-US"; recognizer.continuous = true; recognizer.interimResults = false;
  recognizer.onstart = () => { statusEl.textContent = "listening…"; statusEl.classList.add("listening"); btn.textContent = "⏹ Stop"; };
  recognizer.onerror = () => { statusEl.textContent = "mic error — try again"; };
  recognizer.onend = () => { statusEl.classList.remove("listening"); statusEl.textContent = "stopped"; btn.textContent = "🎙 Dictate"; recognizer = null; };
  recognizer.onresult = (event) => {
    let transcript = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) transcript += event.results[i][0].transcript + " ";
    }
    if (transcript) {
      const ta = document.getElementById(textareaId);
      ta.value = (ta.value ? ta.value + " " : "") + transcript.trim();
    }
  };
  recognizer.start();
}
function stopRecognizer() { if (recognizer) { try { recognizer.stop(); } catch (e) {} recognizer = null; } }

// ==========================================================
// MISSIONS + TASKS (Setup tab)
// ==========================================================
async function loadRunGroups() {
  state.runGroups = (await dbGetAll("runGroups")).sort((a, b) => a.order - b.order);
  renderRunGroups();
}
// Only for genuinely first-ever use — NOT called by loadRunGroups() itself,
// so deleting your last remaining Run doesn't silently bring one back.
async function ensureDefaultRunGroup() {
  const existing = await dbGetAll("runGroups");
  if (!existing.length) {
    const id = await dbPut("runGroups", { name: "Run 1", order: 0 });
    state.expandedRunGroups.add(id);
  }
}

// Missions carry a global .order spanning every run group, so guided-run
// traversal and CSV export can just sort state.missions and get the right
// sequence. This recomputes it from (run-group order, mission's order within
// that group) any time the grouping structure changes.
async function recomputeGlobalMissionOrder() {
  const groups = (await dbGetAll("runGroups")).sort((a, b) => a.order - b.order);
  const allMissions = await dbGetAll("missions");
  let globalIdx = 0;
  for (const g of groups) {
    const groupMissions = allMissions.filter((m) => m.runGroupId === g.id).sort((a, b) => a.order - b.order);
    for (const m of groupMissions) { m.order = globalIdx++; await dbPut("missions", m); }
  }
  const orphans = allMissions.filter((m) => !groups.some((g) => g.id === m.runGroupId)).sort((a, b) => a.order - b.order);
  for (const m of orphans) { m.order = globalIdx++; await dbPut("missions", m); }
}

async function loadMissions() {
  state.missions = (await dbGetAll("missions")).sort((a, b) => a.order - b.order);
  state.missions.forEach((m) => { if (!m.tasks) m.tasks = []; if (m.taskSeq === undefined) m.taskSeq = 0; });
}

function taskSubLabel(t) {
  if (t.type === "bool") return `Yes/No · ${taskMaxPoints(t)} pts`;
  if (t.type === "number") return `Count 0–${t.max} · ${t.pointsPerUnit} pt/each · max ${taskMaxPoints(t)}`;
  return `Multi-state · max ${taskMaxPoints(t)} pts`;
}

// ---- Runs (leave-and-return trips), each holding several missions ----
document.getElementById("btn-add-rungroup").addEventListener("click", () => openRunGroupModal(null));

function renderOrderToolbarTop() {
  const el = document.getElementById("order-toolbar-top");
  if (state.editingAllOrder) {
    el.innerHTML = `<button type="button" class="btn btn-primary" id="btn-save-order-all">Save order</button><button type="button" class="btn btn-ghost" id="btn-cancel-order-all">Cancel</button>`;
    document.getElementById("btn-save-order-all").addEventListener("click", saveAllOrder);
    document.getElementById("btn-cancel-order-all").addEventListener("click", async () => {
      state.editingAllOrder = false;
      await loadMissions();
      await loadRunGroups();
    });
  } else {
    el.innerHTML = `<button type="button" class="btn btn-ghost" id="btn-edit-order-all">&#8645; Reorder runs, missions &amp; tasks</button>`;
    document.getElementById("btn-edit-order-all").addEventListener("click", () => { state.editingAllOrder = true; renderRunGroups(); });
  }
}

// Reads whatever order rows currently sit in, in the DOM — robust regardless
// of how many nested levels were actually expanded/dragged this session.
async function saveAllOrder() {
  const groupEls = [...document.querySelectorAll("#rungroup-list > [data-gid]")];
  groupEls.forEach((el, idx) => {
    const g = state.runGroups.find((x) => x.id === Number(el.dataset.gid));
    if (g) g.order = idx;
  });
  for (const g of state.runGroups) await dbPut("runGroups", g);

  groupEls.forEach((groupEl) => {
    const missionEls = [...groupEl.querySelectorAll(":scope > .task-list > [data-mid]")];
    missionEls.forEach((mEl, idx) => {
      const m = state.missions.find((x) => x.id === Number(mEl.dataset.mid));
      if (m) m.order = idx;
    });
  });

  const allMissionEls = [...document.querySelectorAll("[data-mid]")];
  for (const mEl of allMissionEls) {
    const m = state.missions.find((x) => x.id === Number(mEl.dataset.mid));
    if (!m) continue;
    const taskEls = [...mEl.querySelectorAll(":scope > .task-list > [data-tid]")];
    if (!taskEls.length) continue;
    const reordered = taskEls.map((te) => m.tasks.find((t) => t.id === te.dataset.tid)).filter(Boolean);
    if (reordered.length === m.tasks.length) m.tasks = reordered;
  }
  for (const m of state.missions) await dbPut("missions", m);

  await recomputeGlobalMissionOrder();
  state.editingAllOrder = false;
  await loadMissions();
  await loadRunGroups();
  await runShadowBackup();
}

function renderRunGroups() {
  renderOrderToolbarTop();
  const list = document.getElementById("rungroup-list");
  const editing = state.editingAllOrder;
  list.innerHTML = "";
  if (!state.runGroups.length) {
    list.innerHTML = `<p class="empty-sub">No runs yet. Add one, then add the missions it covers.</p>`;
  }
  state.runGroups.forEach((g) => {
    const wrap = document.createElement("div");
    wrap.dataset.gid = g.id;
    wrap.className = "mission-group";
    const expanded = state.expandedRunGroups.has(g.id);
    const groupMissions = state.missions.filter((m) => m.runGroupId === g.id);
    wrap.innerHTML = `
      <div class="mission-row mission-group-head mission-expand-target" data-act="expand">
        ${editing ? `<span class="drag-handle">&#9776;</span>` : ""}
        <span class="mission-expand-chevron">${expanded ? "&#9660;" : "&#9654;"}</span>
        <div class="m-info">
          <div class="m-name">${esc(g.name)}</div>
          <div class="m-sub">${groupMissions.length} mission${groupMissions.length === 1 ? "" : "s"} &middot; tap to ${expanded ? "collapse" : "view missions"}</div>
        </div>
        ${editing ? "" : `<button class="btn-icon" data-act="edit">&#9998;&#65039;</button><button class="btn-icon" data-act="del">&#128465;&#65039;</button>`}
      </div>
      <div class="task-list" ${expanded ? "" : "hidden"}></div>
    `;
    wrap.querySelector('[data-act="expand"]').addEventListener("click", (e) => {
      if (e.target.closest('[data-act="edit"], [data-act="del"], .drag-handle')) return;
      if (expanded) state.expandedRunGroups.delete(g.id); else state.expandedRunGroups.add(g.id);
      renderRunGroups();
    });
    const editBtn = wrap.querySelector('[data-act="edit"]');
    if (editBtn) editBtn.addEventListener("click", () => openRunGroupModal(g));
    const delBtn = wrap.querySelector('[data-act="del"]');
    if (delBtn) delBtn.addEventListener("click", async () => {
      if (confirm(`Delete "${g.name}"? Its missions move to "Unassigned" rather than being deleted.`)) {
        await snapshotBeforeDelete(`Before deleting run "${g.name}"`);
        await dbDelete("runGroups", g.id);
        await loadRunGroups();
        await loadMissions();
        renderRunGroups();
      }
    });
    if (editing) attachRowDrag(wrap, list, state.runGroups);
    if (expanded) {
      const container = wrap.querySelector(".task-list");
      renderMissionsForGroup(container, g);
    }
    list.appendChild(wrap);
  });

  const orphans = state.missions.filter((m) => !state.runGroups.some((g) => g.id === m.runGroupId));
  if (orphans.length) {
    const wrap = document.createElement("div");
    wrap.className = "mission-group unassigned-group";
    const expanded = state.expandedRunGroups.has("unassigned");
    wrap.innerHTML = `
      <div class="mission-row mission-group-head mission-expand-target" data-act="expand">
        <span class="mission-expand-chevron">${expanded ? "&#9660;" : "&#9654;"}</span>
        <div class="m-info">
          <div class="m-name">Unassigned</div>
          <div class="m-sub">${orphans.length} mission${orphans.length === 1 ? "" : "s"} without a run &mdash; tap to ${expanded ? "collapse" : "view &amp; reassign"}</div>
        </div>
      </div>
      <div class="task-list" ${expanded ? "" : "hidden"}></div>
    `;
    wrap.querySelector('[data-act="expand"]').addEventListener("click", () => {
      if (expanded) state.expandedRunGroups.delete("unassigned"); else state.expandedRunGroups.add("unassigned");
      renderRunGroups();
    });
    if (expanded) {
      const container = wrap.querySelector(".task-list");
      renderOrphanMissions(container, orphans);
    }
    list.appendChild(wrap);
  }
}

function renderOrphanMissions(container, orphans) {
  container.innerHTML = "";
  orphans.forEach((m) => {
    const expanded = state.expandedMissions.has(m.id);
    const row = document.createElement("div");
    row.className = "mission-group";
    row.dataset.mid = m.id;
    row.innerHTML = `
      <div class="mission-row mission-group-head mission-expand-target" data-act="expand">
        <span class="mission-expand-chevron">${expanded ? "&#9660;" : "&#9654;"}</span>
        <div class="m-info">
          <div class="m-name">${esc(m.name)}</div>
          <div class="m-sub">${(m.tasks || []).length} task${(m.tasks || []).length === 1 ? "" : "s"} · max ${missionMaxPoints(m)} pts</div>
        </div>
        <button class="btn-icon" data-act="edit">&#9998;&#65039;</button>
        <button class="btn-icon" data-act="del">&#128465;&#65039;</button>
      </div>
      <div class="task-list" ${expanded ? "" : "hidden"}></div>
    `;
    row.querySelector('[data-act="expand"]').addEventListener("click", (e) => {
      if (e.target.closest('[data-act="edit"], [data-act="del"]')) return;
      if (expanded) state.expandedMissions.delete(m.id); else state.expandedMissions.add(m.id);
      renderRunGroups();
    });
    row.querySelector('[data-act="edit"]').addEventListener("click", () => openMissionNameModal(m, null));
    row.querySelector('[data-act="del"]').addEventListener("click", async () => {
      if (confirm(`Delete mission "${m.name}" and all its tasks?`)) {
        await snapshotBeforeDelete(`Before deleting mission "${m.name}"`);
        await dbDelete("missions", m.id);
        await loadMissions();
        renderRunGroups();
      }
    });
    if (expanded) renderTaskList(row.querySelector(".task-list"), m);
    container.appendChild(row);
  });
}

function wireRunGroupOrderToolbar() { /* kept as no-op: unified into renderOrderToolbarTop() */ }

function openRunGroupModal(g) {
  const isEdit = !!g;
  openModal(`
    <h2>${isEdit ? "Rename run" : "New run"}</h2>
    <p class="empty-sub">One trip out and back — group the missions the robot tackles in this trip.</p>
    <div class="field"><label>Name</label><input class="text-input" id="rg-name" value="${isEdit ? esc(g.name) : `Run ${state.runGroups.length + 1}`}"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="m-cancel" type="button">Cancel</button>
      <button class="btn btn-primary" id="m-save" type="button">Save</button>
    </div>
  `);
  document.getElementById("m-cancel").addEventListener("click", closeModal);
  document.getElementById("m-save").addEventListener("click", async () => {
    const name = document.getElementById("rg-name").value.trim();
    if (!name) { alert("Name this run."); return; }
    const record = isEdit ? g : { order: state.runGroups.length };
    record.name = name;
    const id = await dbPut("runGroups", record);
    closeModal();
    if (!isEdit) state.expandedRunGroups.add(id);
    await loadRunGroups();
  });
}

// ---- Missions nested within a run ----
function renderMissionsForGroup(container, group) {
  const editing = state.editingAllOrder;
  container.innerHTML = "";
  const groupMissions = state.missions.filter((m) => m.runGroupId === group.id).sort((a, b) => a.order - b.order);

  if (!groupMissions.length) {
    container.insertAdjacentHTML("beforeend", `<p class="empty-sub">No missions in this run yet.</p>`);
  }
  groupMissions.forEach((m) => {
    const expanded = state.expandedMissions.has(m.id);
    const row = document.createElement("div");
    row.className = "mission-group";
    row.dataset.mid = m.id;
    row.innerHTML = `
      <div class="mission-row mission-group-head mission-expand-target" data-act="expand">
        ${editing ? `<span class="drag-handle">&#9776;</span>` : ""}
        <span class="mission-expand-chevron">${expanded ? "&#9660;" : "&#9654;"}</span>
        <div class="m-info">
          <div class="m-name">${esc(m.name)}</div>
          <div class="m-sub">${(m.tasks || []).length} task${(m.tasks || []).length === 1 ? "" : "s"} · max ${missionMaxPoints(m)} pts &middot; tap to ${expanded ? "collapse" : "view tasks"}</div>
        </div>
        ${editing ? "" : `<button class="btn-icon" data-act="edit">&#9998;&#65039;</button><button class="btn-icon" data-act="del">&#128465;&#65039;</button>`}
      </div>
      <div class="task-list" ${expanded ? "" : "hidden"}></div>
    `;
    row.querySelector('[data-act="expand"]').addEventListener("click", (e) => {
      if (e.target.closest('[data-act="edit"], [data-act="del"], .drag-handle')) return;
      if (expanded) state.expandedMissions.delete(m.id); else state.expandedMissions.add(m.id);
      renderRunGroups();
    });
    const editBtn = row.querySelector('[data-act="edit"]');
    if (editBtn) editBtn.addEventListener("click", () => openMissionNameModal(m, group));
    const delBtn = row.querySelector('[data-act="del"]');
    if (delBtn) delBtn.addEventListener("click", async () => {
      if (confirm(`Delete mission "${m.name}" and all its tasks?`)) {
        await snapshotBeforeDelete(`Before deleting mission "${m.name}"`);
        await dbDelete("missions", m.id);
        await loadMissions();
        renderRunGroups();
      }
    });
    if (editing) attachRowDrag(row, container, groupMissions);
    if (expanded) {
      const taskListEl = row.querySelector(".task-list");
      renderTaskList(taskListEl, m);
    }
    container.appendChild(row);
  });
  if (!editing) {
    const addBtn = document.createElement("button");
    addBtn.className = "btn btn-ghost btn-full";
    addBtn.style.marginTop = "6px";
    addBtn.textContent = "+ Mission";
    addBtn.addEventListener("click", () => openMissionNameModal(null, group));
    container.appendChild(addBtn);
  }
}

function openMissionNameModal(m, group) {
  const isEdit = !!m;
  const currentGroupId = isEdit ? m.runGroupId : group?.id;
  openModal(`
    <h2>${isEdit ? "Edit mission" : "New mission"}</h2>
    <div class="field"><label>Mission name</label><input class="text-input" id="m-mission-name" value="${isEdit ? esc(m.name) : ""}" placeholder="e.g. M07 — Coral nursery"></div>
    <div class="field"><label>Run</label>
      <select class="text-input" id="m-mission-run">
        ${state.runGroups.map((g) => `<option value="${g.id}" ${g.id === currentGroupId ? "selected" : ""}>${esc(g.name)}</option>`).join("")}
      </select>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="m-cancel" type="button">Cancel</button>
      <button class="btn btn-primary" id="m-save" type="button">Save</button>
    </div>
  `);
  document.getElementById("m-cancel").addEventListener("click", closeModal);
  document.getElementById("m-save").addEventListener("click", async () => {
    const name = document.getElementById("m-mission-name").value.trim();
    if (!name) { alert("Name this mission."); return; }
    const newGroupId = Number(document.getElementById("m-mission-run").value);
    const record = isEdit ? m : { order: 9999, tasks: [], taskSeq: 0 };
    record.name = name;
    record.runGroupId = newGroupId;
    const id = await dbPut("missions", record);
    closeModal();
    if (!isEdit) state.expandedMissions.add(id);
    state.expandedRunGroups.add(newGroupId);
    await recomputeGlobalMissionOrder();
    await loadMissions();
    renderRunGroups();
  });
}

function optionRowHtml(label = "", points = 0) {
  return `<div class="option-row">
    <input class="text-input" placeholder="Option label" value="${esc(label)}" data-f="label">
    <input type="number" placeholder="pts" value="${points}" data-f="points">
    <button class="btn-icon" data-act="rm-option">&#10005;</button>
  </div>`;
}

function renderTaskList(container, mission) {
  const editing = state.editingAllOrder;
  container.innerHTML = "";
  (mission.tasks || []).forEach((t) => {
    const row = document.createElement("div");
    row.dataset.tid = t.id;
    if (editing) {
      row.className = "task-row drag-row";
      row.innerHTML = `
        <span class="drag-handle">&#9776;</span>
        <div class="m-info"><div class="m-name">${esc(t.name)}</div></div>
      `;
      container.appendChild(row);
      attachRowDrag(row, container, mission.tasks);
      return;
    }
    row.className = "task-row";
    row.innerHTML = `
      <div class="m-info">
        <div class="m-name">${esc(t.name)}</div>
        <div class="m-sub">${taskSubLabel(t)}</div>
      </div>
      <button class="btn-icon" data-act="edit">&#9998;&#65039;</button>
      <button class="btn-icon" data-act="del">&#128465;&#65039;</button>
    `;
    row.querySelector('[data-act="edit"]').addEventListener("click", () => openTaskModal(mission, t));
    row.querySelector('[data-act="del"]').addEventListener("click", async () => {
      if (confirm(`Delete task "${t.name}"?`)) {
        await snapshotBeforeDelete(`Before deleting task "${t.name}" from mission "${mission.name}"`);
        mission.tasks = mission.tasks.filter((tt) => tt.id !== t.id);
        await dbPut("missions", mission);
        await loadMissions();
        renderRunGroups();
      }
    });
    container.appendChild(row);
  });
  if (!editing) {
    const addBtn = document.createElement("button");
    addBtn.className = "btn btn-ghost btn-full";
    addBtn.style.marginTop = "6px";
    addBtn.textContent = "+ Task";
    addBtn.addEventListener("click", () => openTaskModal(mission, null));
    container.appendChild(addBtn);
  }
}

function openTaskModal(mission, t) {
  const isEdit = !!t;
  const type = t?.type || "bool";
  openModal(`
    <h2>${isEdit ? "Edit task" : "New task"}</h2>
    <p class="empty-sub">Mission: ${esc(mission.name)}</p>
    <div class="field"><label>Task name</label><input class="text-input" id="t-name" value="${isEdit ? esc(t.name) : ""}" placeholder="e.g. Sample in habitat"></div>
    <div class="field"><label>Scoring type</label>
      <select class="text-input" id="t-type">
        <option value="bool" ${type === "bool" ? "selected" : ""}>Yes / No</option>
        <option value="number" ${type === "number" ? "selected" : ""}>Counted objects</option>
        <option value="choice" ${type === "choice" ? "selected" : ""}>Multiple states</option>
      </select>
    </div>
    <div id="t-type-fields"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="m-cancel">Cancel</button>
      <button class="btn btn-primary" id="m-save">Save</button>
    </div>
  `);
  function renderTypeFields() {
    const ty = document.getElementById("t-type").value;
    const box = document.getElementById("t-type-fields");
    if (ty === "bool") {
      box.innerHTML = `<div class="field"><label>Points when achieved</label><input type="number" class="text-input" id="t-bool-points" value="${isEdit && t.type === "bool" ? t.points : 20}"></div>`;
    } else if (ty === "number") {
      box.innerHTML = `
        <div class="field"><label>Max count</label><input type="number" class="text-input" id="t-num-max" value="${isEdit && t.type === "number" ? t.max : 5}"></div>
        <div class="field"><label>Points per unit</label><input type="number" class="text-input" id="t-num-ppu" value="${isEdit && t.type === "number" ? t.pointsPerUnit : 10}"></div>`;
    } else {
      const opts = (isEdit && t.type === "choice" && t.options.length) ? t.options : [{ label: "Partial", points: 10 }, { label: "Full", points: 20 }];
      box.innerHTML = `<div class="field"><label>States (in addition to "not achieved" = 0 pts)</label>
        <div class="options-editor" id="t-options">${opts.map((o) => optionRowHtml(o.label, o.points)).join("")}</div>
        <button class="btn btn-ghost" id="t-add-option" type="button" style="margin-top:8px;">+ Add state</button>
      </div>`;
      document.getElementById("t-add-option").addEventListener("click", () => {
        document.getElementById("t-options").insertAdjacentHTML("beforeend", optionRowHtml("", 0));
        bindOptionRemovers();
      });
      bindOptionRemovers();
    }
  }
  function bindOptionRemovers() {
    document.querySelectorAll('[data-act="rm-option"]').forEach((btn) => { btn.onclick = () => btn.closest(".option-row").remove(); });
  }
  renderTypeFields();
  document.getElementById("t-type").addEventListener("change", renderTypeFields);
  document.getElementById("m-cancel").addEventListener("click", closeModal);
  document.getElementById("m-save").addEventListener("click", async () => {
    const name = document.getElementById("t-name").value.trim();
    if (!name) { alert("Name this task."); return; }
    const ty = document.getElementById("t-type").value;
    const record = isEdit ? t : { id: `m${mission.id}-t${++mission.taskSeq}` };
    record.name = name; record.type = ty;
    if (ty === "bool") {
      record.points = Number(document.getElementById("t-bool-points").value) || 0;
      delete record.max; delete record.pointsPerUnit; delete record.options;
    } else if (ty === "number") {
      record.max = Number(document.getElementById("t-num-max").value) || 0;
      record.pointsPerUnit = Number(document.getElementById("t-num-ppu").value) || 0;
      delete record.points; delete record.options;
    } else {
      const rows = document.querySelectorAll("#t-options .option-row");
      record.options = Array.from(rows).map((r) => ({
        label: r.querySelector('[data-f="label"]').value.trim() || "State",
        points: Number(r.querySelector('[data-f="points"]').value) || 0,
      }));
      delete record.points; delete record.max; delete record.pointsPerUnit;
    }
    if (!isEdit) mission.tasks.push(record);
    await dbPut("missions", mission);
    closeModal();
    await loadMissions();
    state.expandedMissions.add(mission.id);
    renderRunGroups();
  });
}

// ---- Import missions CSV ----
const EXAMPLE_MISSIONS_CSV =
`Run,Mission,Task,Type,Points,Max,PointsPerUnit,Options
Run 1,M01 Coral Nursery,Place sample in nursery,bool,20,,,
Run 1,M01 Coral Nursery,Samples relocated,number,,4,10,
Run 1,M02 Reef Restoration,Restoration state,choice,,,,Partial:10;Full:20
Run 2,M03 Salvage Operation,Ship raised,bool,20,,,
`;

document.getElementById("btn-import-missions").addEventListener("click", () => {
  openModal(`
    <h2>Import missions</h2>
    <p class="empty-sub">Upload a CSV with columns <strong>Run, Mission, Task, Type, Points, Max, PointsPerUnit, Options</strong>. The Run column groups missions into leave-and-return trips (created automatically if they don't exist yet — leave it blank to use your first run). Rows sharing a Mission name are grouped together. <strong>Type</strong> is <code>bool</code>, <code>number</code>, or <code>choice</code>. For <code>choice</code> rows, put states in <strong>Options</strong> as <code>Label:Points;Label:Points</code>. Importing adds to what's already there rather than replacing it.</p>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="m-example">Download example CSV</button>
      <button class="btn btn-primary" id="m-choose">Choose CSV file</button>
    </div>
  `);
  document.getElementById("m-example").addEventListener("click", () => download("missions-example.csv", EXAMPLE_MISSIONS_CSV, "text/csv"));
  document.getElementById("m-choose").addEventListener("click", () => { closeModal(); document.getElementById("file-import-missions").click(); });
});

document.getElementById("file-import-missions").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const rows = parseCSV(await file.text());
  if (!rows.length) { alert("That file looks empty."); return; }
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  const iRun = col("run"), iMission = col("mission"), iTask = col("task"), iType = col("type"), iPoints = col("points"), iMax = col("max"), iPpu = col("pointsperunit"), iOptions = col("options");
  if (iMission === -1 || iTask === -1 || iType === -1) { alert("CSV needs at least Mission, Task, and Type columns."); return; }
  if (!state.runGroups.length) {
    const gid = await dbPut("runGroups", { name: "Run 1", order: 0 });
    state.runGroups = await dbGetAll("runGroups");
  }
  const dataRows = rows.slice(1);
  let missionsAdded = 0, tasksAdded = 0, runsAdded = 0;
  for (const r of dataRows) {
    const missionName = (r[iMission] || "").trim();
    const taskName = (r[iTask] || "").trim();
    const type = (r[iType] || "").trim().toLowerCase();
    const runName = iRun !== -1 ? (r[iRun] || "").trim() : "";
    if (!missionName || !taskName || !["bool", "number", "choice"].includes(type)) continue;

    let group = runName ? state.runGroups.find((g) => g.name.toLowerCase() === runName.toLowerCase()) : state.runGroups[0];
    if (runName && !group) {
      const gid = await dbPut("runGroups", { name: runName, order: state.runGroups.length });
      group = { id: gid, name: runName, order: state.runGroups.length };
      state.runGroups.push(group);
      runsAdded++;
    }

    let mission = state.missions.find((m) => m.name.toLowerCase() === missionName.toLowerCase());
    if (!mission) {
      mission = { order: 9999, name: missionName, tasks: [], taskSeq: 0, runGroupId: group.id };
      const id = await dbPut("missions", mission);
      mission.id = id;
      state.missions.push(mission);
      missionsAdded++;
    }
    const task = { id: `m${mission.id}-t${++mission.taskSeq}`, name: taskName, type };
    if (type === "bool") task.points = Number(r[iPoints]) || 0;
    else if (type === "number") { task.max = Number(r[iMax]) || 0; task.pointsPerUnit = Number(r[iPpu]) || 0; }
    else if (type === "choice") {
      task.options = (r[iOptions] || "").split(";").map((s) => s.trim()).filter(Boolean).map((pair) => {
        const [label, pts] = pair.split(":");
        return { label: (label || "State").trim(), points: Number(pts) || 0 };
      });
    }
    mission.tasks.push(task);
    await dbPut("missions", mission);
    tasksAdded++;
  }
  await recomputeGlobalMissionOrder();
  await loadMissions();
  await loadRunGroups();
  alert(`Imported ${tasksAdded} task${tasksAdded === 1 ? "" : "s"} across ${missionsAdded} new mission${missionsAdded === 1 ? "" : "s"} and ${runsAdded} new run${runsAdded === 1 ? "" : "s"} (plus any matched into existing ones).`);
});

// ==========================================================
// GUIDED PRACTICE GAME RUNS
// ==========================================================
document.getElementById("btn-start-run").addEventListener("click", startGuidedRun);
document.getElementById("run-filter-from").addEventListener("change", renderRuns);
document.getElementById("run-filter-to").addEventListener("change", renderRuns);
document.getElementById("btn-clear-run-filter").addEventListener("click", () => {
  document.getElementById("run-filter-from").value = "";
  document.getElementById("run-filter-to").value = "";
  renderRuns();
});

// ---- Sound effects ----
// Official FLL match audio is copyrighted by FIRST, so these files aren't
// included by default — drop your own MP3s in a `sounds/` folder next to
// index.html with these exact names and they'll play automatically; if a
// file is missing, playback just silently no-ops.
const SOUND_FILES = {
  start: "sounds/start-horn.mp3",
  thirty: "sounds/thirty-seconds.mp3",
  buzzer: "sounds/buzzer.mp3",
};
const soundElements = {};
function getSoundElement(key) {
  if (!soundElements[key]) {
    try { soundElements[key] = new Audio(SOUND_FILES[key]); } catch (e) { return null; }
  }
  return soundElements[key];
}
function unlockAllSounds() {
  Object.keys(SOUND_FILES).forEach((key) => {
    const el = getSoundElement(key);
    if (!el) { showErrorBanner(`Couldn't create audio for "${key}" — Audio API unavailable.`); return; }
    const prevVolume = el.volume;
    el.volume = 0;
    let p;
    try { p = el.play(); } catch (err) { showErrorBanner(`Unlocking "${key}" threw: ${err.name} — ${err.message}`); el.volume = prevVolume; return; }
    if (p && p.catch) {
      p.then(() => { el.pause(); el.currentTime = 0; el.volume = prevVolume; })
       .catch((err) => { el.volume = prevVolume; showErrorBanner(`Unlocking "${key}" failed: ${err.name} — ${err.message}`); });
    }
  });
}
function playSound(key) {
  const el = getSoundElement(key);
  if (!el) { showErrorBanner(`Couldn't create audio for "${key}".`); return; }
  try {
    el.currentTime = 0;
    const p = el.play();
    if (p && p.catch) p.catch((err) => showErrorBanner(`Sound "${key}" didn't play: ${err.name} — ${err.message}`));
  } catch (e) {
    showErrorBanner(`Sound "${key}" error: ${e.name} — ${e.message}`);
  }
}

// ---- Precision tokens ----
function precisionTokenWidgetHTML() {
  const remaining = state.guidedRun?.run?.precisionTokensRemaining ?? 0;
  return `<button type="button" class="precision-token-btn" id="grn-token-btn">&#129689; Precision Tokens: <span id="grn-token-count">${remaining}</span></button>`;
}
function wirePrecisionTokenButton() {
  const btn = document.getElementById("grn-token-btn");
  if (btn) btn.addEventListener("click", usePrecisionToken);
}
async function usePrecisionToken() {
  const run = state.guidedRun?.run;
  if (!run || (run.precisionTokensRemaining || 0) <= 0) return;
  run.precisionTokensRemaining -= 1;
  await dbPut("runs", run);
  const el = document.getElementById("grn-token-count");
  if (el) el.textContent = run.precisionTokensRemaining;
  const overviewLabel = document.querySelector(".gfs-timer-label");
  if (overviewLabel && overviewLabel.textContent.includes("tokens left")) {
    overviewLabel.textContent = `${fmtDuration(run.totalTimeMs)} total time · ${run.precisionTokensRemaining} tokens left · review below or save now`;
  }
}

// ---- Helpers for navigating Run groups (legs) and their missions ----
function getLegMissions(leg) {
  return state.missions.filter((m) => m.runGroupId === leg.id).sort((a, b) => a.order - b.order);
}
function nextGameRunLabel() {
  const todayStr = new Date().toLocaleDateString();
  const todayCount = state.runs.filter((r) => new Date(r.startedAt || 0).toLocaleDateString() === todayStr).length;
  return `Game Run ${todayCount + 1}`;
}

// ---- Start flow: countdown, then horn, then the match begins ----
async function startGuidedRun() {
  const legsWithMissions = state.runGroups.filter((g) => getLegMissions(g).some((m) => (m.tasks || []).length));
  if (!legsWithMissions.length) {
    openModal(`<h2>No missions yet</h2><p class="empty-sub">Add runs, missions, and tasks in the Setup tab first, matching the official scoresheet.</p>
      <div class="modal-actions"><button class="btn btn-primary" id="m-close">Got it</button></div>`);
    document.getElementById("m-close").addEventListener("click", closeModal);
    return;
  }
  renderPreRunScreen();
}

function renderPreRunScreen() {
  openGuidedFullscreen(`
    <div class="gfs-header">
      <div class="guided-phase-badge">Ready?</div>
      <h2 class="gfs-mission-name">New Practice Game Run</h2>
    </div>
    <div class="gfs-body gfs-center">
      <button type="button" class="btn btn-amber btn-full gfs-big-action gfs-huge-action" id="grn-start-countdown">Tap to start countdown</button>
    </div>
    <div class="gfs-footer">
      <button type="button" class="btn-link-cancel" id="grn-cancel-pre">Cancel</button>
    </div>
  `);
  document.getElementById("grn-cancel-pre").addEventListener("click", closeGuidedFullscreen);
  document.getElementById("grn-start-countdown").addEventListener("click", () => {
    unlockAllSounds(); // must happen synchronously, right here, to count as a user gesture
    runCountdown();
  });
}

async function runCountdown() {
  const body = document.querySelector("#guided-fullscreen .gfs-body");
  const footer = document.querySelector("#guided-fullscreen .gfs-footer");
  if (footer) footer.hidden = true;
  for (const n of ["3", "2", "1"]) {
    if (body) body.innerHTML = `<div class="gfs-countdown-num">${n}</div>`;
    await new Promise((r) => setTimeout(r, 800));
  }
  if (body) body.innerHTML = `<div class="gfs-countdown-num gfs-countdown-go">GO!</div>`;
  playSound("start");
  await new Promise((r) => setTimeout(r, 400));
  await actuallyStartRun();
}

async function actuallyStartRun() {
  const now = Date.now();
  const run = {
    order: state.runs.length,
    label: nextGameRunLabel(),
    date: new Date(now).toLocaleDateString(),
    startedAt: now,
    inProgress: true,
    precisionTokensRemaining: PRECISION_TOKENS_START,
    rawScores: {},
    missionTimings: [],
    transitionTimings: [],
    notes: "",
  };
  const id = await dbPut("runs", run);
  run.id = id;
  // Skip to the first leg that actually has missions with tasks.
  let legIdx = 0;
  while (legIdx < state.runGroups.length && !getLegMissions(state.runGroups[legIdx]).some((m) => (m.tasks || []).length)) legIdx++;
  state.guidedRun = {
    run,
    legIdx,
    missionIdxInLeg: 0,
    taskIdx: 0,
    matchStartTs: now,
    missionStartTs: now,
    played30: false,
    playedBuzzer: false,
  };
  renderCurrentTaskScreen();
  state.guidedRun.timerHandle = setInterval(tickGuidedTimer, 500);
}

// ---- Continuous match clock (one clock for the whole game run, like a real FLL match) ----
const MATCH_LENGTH_MS = 150000; // 2:30, standard FLL match length
function tickGuidedTimer() {
  if (!state.guidedRun) return;
  const elapsed = Date.now() - state.guidedRun.matchStartTs;
  const remaining = Math.max(0, MATCH_LENGTH_MS - elapsed);
  const el = document.getElementById("grn-timer");
  if (el) {
    el.textContent = fmtDuration(remaining);
    el.classList.toggle("timer-danger", remaining <= 0);
  }
  if (elapsed >= 120000 && !state.guidedRun.played30) {
    state.guidedRun.played30 = true;
    playSound("thirty");
  }
  if (elapsed >= 150000 && !state.guidedRun.playedBuzzer) {
    state.guidedRun.playedBuzzer = true;
    playSound("buzzer");
  }
}
function stopGuidedTimer() {
  if (state.guidedRun?.timerHandle) clearInterval(state.guidedRun.timerHandle);
}
function liveTimerHTML() {
  return fmtDuration(Math.max(0, MATCH_LENGTH_MS - (Date.now() - state.guidedRun.matchStartTs)));
}

function openGuidedFullscreen(html) {
  let el = document.getElementById("guided-fullscreen");
  if (!el) {
    el = document.createElement("div");
    el.id = "guided-fullscreen";
    el.className = "guided-fullscreen";
    document.body.appendChild(el);
  }
  el.innerHTML = html;
  el.hidden = false;
}
function closeGuidedFullscreen() {
  const el = document.getElementById("guided-fullscreen");
  if (el) { el.hidden = true; el.innerHTML = ""; }
}

function cancelGuidedRunLink() {
  return `<button type="button" class="gfs-cancel-x" id="grn-cancel" title="Cancel this game run">&#10005;</button>`;
}
function wireCancelLink() {
  document.getElementById("grn-cancel").addEventListener("click", async () => {
    if (!confirm("Cancel and discard this practice game run?")) return;
    stopGuidedTimer();
    await dbDelete("runs", state.guidedRun.run.id);
    state.guidedRun = null;
    closeGuidedFullscreen();
    await loadRuns();
  });
}

// A task counts as "complete" once it has any score entered — not
// necessarily full points.
function isTaskComplete(t, raw) {
  const v = raw[t.id];
  if (t.type === "bool") return !!v;
  if (t.type === "number") return (Number(v) || 0) > 0;
  return v !== null && v !== undefined && v !== "";
}

// Small row-style task display, used only by the editable Final Overview
// (where you see every task in every mission at once, not one at a time).
function taskRowHTML(t, raw) {
  const max = taskMaxPoints(t);
  if (t.type === "bool") {
    const on = !!raw[t.id];
    return `<div class="gfs-task-row gfs-task-row-wrap" data-tid="${t.id}" data-type="bool">
      <span class="gfs-task-name">${esc(t.name)} <span class="gfs-task-pts">${on ? max : 0} / ${max}</span></span>
      <div class="gfs-choice-strip">
        <button type="button" class="gfs-choice-btn${on ? " active" : ""}" data-tid="${t.id}" data-val="yes">Yes</button>
        <button type="button" class="gfs-choice-btn${!on ? " active" : ""}" data-tid="${t.id}" data-val="no">No</button>
      </div>
    </div>`;
  }
  if (t.type === "number") {
    const val = raw[t.id] ?? 0;
    const btns = Array.from({ length: (t.max || 0) + 1 }, (_, i) =>
      `<button type="button" class="gfs-num-btn${val === i ? " active" : ""}" data-tid="${t.id}" data-val="${i}">${i}</button>`
    ).join("");
    return `<div class="gfs-task-row gfs-task-row-wrap" data-tid="${t.id}" data-type="number">
      <span class="gfs-task-name">${esc(t.name)} <span class="gfs-task-pts">${pointsFromRawTask(t, val)} / ${max}</span></span>
      <div class="gfs-num-strip">${btns}</div>
    </div>`;
  }
  const cur = raw[t.id] ?? "";
  const btns = [`<button type="button" class="gfs-choice-btn${cur === "" ? " active" : ""}" data-tid="${t.id}" data-val="">Not achieved</button>`]
    .concat((t.options || []).map((o, i) => `<button type="button" class="gfs-choice-btn${String(cur) === String(i) ? " active" : ""}" data-tid="${t.id}" data-val="${i}">${esc(o.label)}</button>`))
    .join("");
  return `<div class="gfs-task-row gfs-task-row-wrap" data-tid="${t.id}" data-type="choice">
    <span class="gfs-task-name">${esc(t.name)} <span class="gfs-task-pts">${pointsFromRawTask(t, cur)} / ${max}</span></span>
    <div class="gfs-choice-strip">${btns}</div>
  </div>`;
}

// ---- One task at a time, tap-to-advance, with a back arrow. Auto-advances
// through every mission in the current run before asking for "Robot returned". ----
function renderCurrentTaskScreen() {
  const { run, legIdx, missionIdxInLeg, taskIdx } = state.guidedRun;
  const leg = state.runGroups[legIdx];
  const legMissions = getLegMissions(leg);
  const mission = legMissions[missionIdxInLeg];
  const tasks = mission.tasks || [];
  if (taskIdx >= tasks.length) {
    finishCurrentMission(leg, legMissions);
    return;
  }
  const task = tasks[taskIdx];
  const raw = run.rawScores;
  let controlHTML;
  if (task.type === "bool") {
    controlHTML = `
      <button type="button" class="gfs-big-choice gfs-big-complete" id="gfs-mark-complete">Complete</button>
      <button type="button" class="gfs-big-choice gfs-big-incomplete" id="gfs-mark-incomplete">Incomplete</button>
    `;
  } else if (task.type === "number") {
    const val = raw[task.id] ?? 0;
    controlHTML = `<div class="gfs-num-strip gfs-num-strip-big">${Array.from({ length: (task.max || 0) + 1 }, (_, i) =>
      `<button type="button" class="gfs-num-btn gfs-num-btn-big${val === i ? (i === 0 ? " active-zero" : " active") : ""}" data-val="${i}">${i}</button>`
    ).join("")}</div>`;
  } else {
    const cur = raw[task.id] ?? "";
    controlHTML = `<div class="gfs-choice-strip gfs-choice-strip-big">
      <button type="button" class="gfs-choice-btn gfs-choice-btn-big${cur === "" ? " active-zero" : ""}" data-val="">Not achieved</button>
      ${(task.options || []).map((o, i) => `<button type="button" class="gfs-choice-btn gfs-choice-btn-big${String(cur) === String(i) ? " active" : ""}" data-val="${i}">${esc(o.label)}</button>`).join("")}
    </div>`;
  }

  const canGoBack = taskIdx > 0 || missionIdxInLeg > 0;
  openGuidedFullscreen(`
    <div class="gfs-header">
      ${cancelGuidedRunLink()}
      <button type="button" class="gfs-back-btn" id="grn-back" ${canGoBack ? "" : "disabled"}>&#8592;</button>
      ${precisionTokenWidgetHTML()}
      <div class="guided-phase-badge">${esc(leg.name)} &middot; Mission ${missionIdxInLeg + 1} of ${legMissions.length} &middot; Task ${taskIdx + 1} of ${tasks.length}</div>
      <h2 class="gfs-mission-name">${esc(mission.name)}</h2>
      <div class="gfs-timer" id="grn-timer">${liveTimerHTML()}</div>
    </div>
    <div class="gfs-body gfs-center">
      <p class="gfs-task-prompt">${esc(task.name)} <span class="gfs-task-pts">/ ${taskMaxPoints(task)} pts</span></p>
      ${controlHTML}
    </div>
    <div class="gfs-footer"></div>
  `);
  wireCancelLink();
  wirePrecisionTokenButton();
  document.getElementById("grn-back").addEventListener("click", () => {
    if (state.guidedRun.taskIdx > 0) {
      state.guidedRun.taskIdx--;
    } else if (state.guidedRun.missionIdxInLeg > 0) {
      state.guidedRun.missionIdxInLeg--;
      const prevMission = legMissions[state.guidedRun.missionIdxInLeg];
      state.guidedRun.taskIdx = Math.max(0, (prevMission.tasks || []).length - 1);
    } else {
      return;
    }
    renderCurrentTaskScreen();
  });

  if (task.type === "bool") {
    document.getElementById("gfs-mark-complete").addEventListener("click", () => { raw[task.id] = true; advanceTask(); });
    document.getElementById("gfs-mark-incomplete").addEventListener("click", () => { raw[task.id] = false; advanceTask(); });
  } else if (task.type === "number") {
    document.querySelectorAll(".gfs-num-btn-big").forEach((btn) => {
      btn.addEventListener("click", () => { raw[task.id] = Number(btn.dataset.val); advanceTask(); });
    });
  } else {
    document.querySelectorAll(".gfs-choice-btn-big").forEach((btn) => {
      btn.addEventListener("click", () => {
        const v = btn.dataset.val;
        raw[task.id] = v === "" ? null : Number(v);
        advanceTask();
      });
    });
  }
}
function advanceTask() {
  state.guidedRun.taskIdx++;
  renderCurrentTaskScreen();
}

async function finishCurrentMission(leg, legMissions) {
  const { run, missionIdxInLeg } = state.guidedRun;
  const mission = legMissions[missionIdxInLeg];
  const now = Date.now();
  const durationMs = now - state.guidedRun.missionStartTs;
  run.missionTimings.push({ missionId: mission.id, missionName: mission.name, runGroupId: leg.id, runGroupName: leg.name, startTs: state.guidedRun.missionStartTs, endTs: now, durationMs });
  await dbPut("runs", run);
  if (missionIdxInLeg < legMissions.length - 1) {
    state.guidedRun.missionIdxInLeg++;
    state.guidedRun.taskIdx = 0;
    state.guidedRun.missionStartTs = now;
    renderCurrentTaskScreen();
  } else {
    renderRobotReturnedScreen();
  }
}

function renderRobotReturnedScreen() {
  const { legIdx } = state.guidedRun;
  const leg = state.runGroups[legIdx];
  openGuidedFullscreen(`
    <div class="gfs-header">
      ${cancelGuidedRunLink()}
      <button type="button" class="gfs-back-btn" id="grn-back">&#8592;</button>
      ${precisionTokenWidgetHTML()}
      <div class="guided-phase-badge">${esc(leg.name)}</div>
      <h2 class="gfs-mission-name">All missions done for this run</h2>
      <div class="gfs-timer" id="grn-timer">${liveTimerHTML()}</div>
    </div>
    <div class="gfs-body gfs-center">
      <p class="empty-sub">Every mission in "${esc(leg.name)}" is marked.</p>
      <button type="button" class="btn btn-primary btn-full gfs-big-action gfs-huge-action" id="grn-done">Robot returned</button>
    </div>
    <div class="gfs-footer"></div>
  `);
  wireCancelLink();
  wirePrecisionTokenButton();
  document.getElementById("grn-back").addEventListener("click", () => {
    const legMissions = getLegMissions(leg);
    state.guidedRun.missionIdxInLeg = legMissions.length - 1;
    state.guidedRun.taskIdx = Math.max(0, (legMissions[legMissions.length - 1].tasks || []).length - 1);
    renderCurrentTaskScreen();
  });
  document.getElementById("grn-done").addEventListener("click", async () => {
    const { run, legIdx } = state.guidedRun;
    const now = Date.now();
    // Find the next leg (in run-group order) that actually has scoreable missions.
    let nextLegIdx = legIdx + 1;
    while (nextLegIdx < state.runGroups.length && !getLegMissions(state.runGroups[nextLegIdx]).some((m) => (m.tasks || []).length)) nextLegIdx++;
    if (nextLegIdx >= state.runGroups.length) {
      stopGuidedTimer();
      run.finishedAt = now;
      run.totalTimeMs = now - state.guidedRun.matchStartTs;
      await dbPut("runs", run);
      renderGuidedOverview();
    } else {
      state.guidedRun.legIdx = nextLegIdx;
      state.guidedRun.missionIdxInLeg = 0;
      state.guidedRun.taskIdx = 0;
      state.guidedRun.transitionStartTs = now;
      renderGuidedTransitionPhase();
    }
  });
}

function renderGuidedTransitionPhase() {
  const { legIdx } = state.guidedRun;
  const nextLeg = state.runGroups[legIdx];
  openGuidedFullscreen(`
    <div class="gfs-header">
      ${cancelGuidedRunLink()}
      ${precisionTokenWidgetHTML()}
      <div class="guided-phase-badge">Transition</div>
      <h2 class="gfs-mission-name">Heading to: ${esc(nextLeg.name)}</h2>
      <div class="gfs-timer" id="grn-timer">${liveTimerHTML()}</div>
    </div>
    <div class="gfs-body gfs-center">
      <p class="empty-sub">Tap when the robot leaves base for the next run.</p>
      <button type="button" class="btn btn-amber btn-full gfs-big-action gfs-huge-action" id="grn-leave">Robot leaves for next run</button>
    </div>
    <div class="gfs-footer"></div>
  `);
  wireCancelLink();
  wirePrecisionTokenButton();
  document.getElementById("grn-leave").addEventListener("click", () => {
    const now = Date.now();
    const durationMs = now - state.guidedRun.transitionStartTs;
    state.guidedRun.run.transitionTimings.push({ beforeRunGroupId: nextLeg.id, durationMs });
    state.guidedRun.missionStartTs = now;
    renderCurrentTaskScreen();
  });
}

function renderGuidedOverview() {
  const { run } = state.guidedRun;
  openGuidedFullscreen(`
    <div class="gfs-header">
      ${cancelGuidedRunLink()}
      ${precisionTokenWidgetHTML()}
      <div class="guided-phase-badge">Final overview</div>
      <h2 class="gfs-mission-name">${esc(run.label)}</h2>
      <div class="gfs-timer" id="gfs-overview-total">${runTotal(run, state.missions)} / ${runMaxPoints(state.missions)}</div>
      <div class="gfs-timer-label">${fmtDuration(run.totalTimeMs)} total time &middot; ${run.precisionTokensRemaining ?? 0} tokens left &middot; review below or save now</div>
      <button class="btn btn-primary btn-full" id="grn-save-top" type="button" style="margin-top:12px;">&#10003; Save &amp; Finish</button>
    </div>
    <div class="gfs-body" id="gfs-overview-body"></div>
    <div class="gfs-footer">
      <button class="btn btn-primary btn-full" id="grn-save-bottom" type="button">Save &amp; Finish</button>
    </div>
  `);
  renderOverviewBody();
  wireCancelLink();
  wirePrecisionTokenButton();
  document.getElementById("grn-save-top").addEventListener("click", finalizeGuidedRun);
  document.getElementById("grn-save-bottom").addEventListener("click", finalizeGuidedRun);
}

function renderOverviewBody() {
  const { run } = state.guidedRun;
  const body = document.getElementById("gfs-overview-body");
  body.innerHTML = state.runGroups.map((leg) => {
    const legMissions = getLegMissions(leg);
    const missionsHTML = legMissions.map((m) => {
      const score = missionScoreForRun(m, run);
      const max = missionMaxPoints(m);
      const timing = (run.missionTimings || []).find((t) => t.missionId === m.id);
      const rows = (m.tasks || []).map((t) => taskRowHTML(t, run.rawScores)).join("") || `<p class="empty-sub">No tasks.</p>`;
      return `<div class="gfs-subsection">
        <h4>${esc(m.name)} <span class="gfs-task-pts">${score} / ${max}${timing ? ` &middot; ${fmtDuration(timing.durationMs)}` : ""}</span></h4>
        <div class="gfs-task-list">${rows}</div>
      </div>`;
    }).join("");
    return `<div class="gfs-section">
      <h3>${esc(leg.name)}</h3>
      ${missionsHTML || `<p class="empty-sub">No missions in this run.</p>`}
    </div>`;
  }).join("");
  bindOverviewEvents();
  updateOverviewTotal();
}

function bindOverviewEvents() {
  document.querySelectorAll('#gfs-overview-body [data-type="bool"] .gfs-choice-btn').forEach((btn) => {
    btn.addEventListener("click", () => {
      state.guidedRun.run.rawScores[btn.dataset.tid] = btn.dataset.val === "yes";
      renderOverviewBody();
    });
  });
  document.querySelectorAll("#gfs-overview-body .gfs-num-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.guidedRun.run.rawScores[btn.dataset.tid] = Number(btn.dataset.val);
      renderOverviewBody();
    });
  });
  document.querySelectorAll('#gfs-overview-body [data-type="choice"] .gfs-choice-btn').forEach((btn) => {
    btn.addEventListener("click", () => {
      const v = btn.dataset.val;
      state.guidedRun.run.rawScores[btn.dataset.tid] = v === "" ? null : Number(v);
      renderOverviewBody();
    });
  });
}

function updateOverviewTotal() {
  const el = document.getElementById("gfs-overview-total");
  if (el) el.textContent = `${runTotal(state.guidedRun.run, state.missions)} / ${runMaxPoints(state.missions)}`;
}

async function finalizeGuidedRun() {
  stopGuidedTimer();
  const { run } = state.guidedRun;
  run.inProgress = false;
  await dbPut("runs", run);
  state.guidedRun = null;
  closeGuidedFullscreen();
  await loadRuns();
}
// ---- Saved game runs / analysis ----
async function loadRuns() {
  state.runs = (await dbGetAll("runs")).sort((a, b) => a.order - b.order);
  renderRuns();
}

function getRunDateFilterRange() {
  const fromVal = document.getElementById("run-filter-from")?.value;
  const toVal = document.getElementById("run-filter-to")?.value;
  return {
    from: fromVal ? new Date(fromVal).getTime() : -Infinity,
    to: toVal ? new Date(toVal).getTime() : Infinity,
  };
}

function renderRuns() {
  const list = document.getElementById("run-list");
  const stats = document.getElementById("run-stats");
  list.innerHTML = "";
  const allCompleted = state.runs.filter((r) => !r.inProgress);
  const incomplete = state.runs.filter((r) => r.inProgress);
  const { from, to } = getRunDateFilterRange();
  const completed = allCompleted.filter((r) => { const t = r.startedAt || 0; return t >= from && t <= to; });

  if (!allCompleted.length && !incomplete.length) {
    list.innerHTML = `<p class="empty-sub">No practice game runs yet. Click Start New Practice Game Run to begin tracking your progress.</p>`;
    stats.innerHTML = "";
    return;
  }
  if (!completed.length) {
    list.innerHTML = `<p class="empty-sub">No completed game runs in that date range.</p>`;
  }

  if (completed.length) {
    const totals = completed.map((r) => runTotal(r, state.missions));
    const best = Math.max(...totals);
    const avg = totals.reduce((a, b) => a + b, 0) / totals.length;
    const avgGameTime = completed.reduce((s, r) => s + (r.totalTimeMs || 0), 0) / completed.length;
    stats.innerHTML = `
      <div class="stat-box"><span class="stat-num">${best}</span><span class="stat-label">Best score</span></div>
      <div class="stat-box"><span class="stat-num">${avg.toFixed(1)}</span><span class="stat-label">Avg score</span></div>
      <div class="stat-box"><span class="stat-num">${fmtDuration(avgGameTime)}</span><span class="stat-label">Avg game time</span></div>
    `;
  } else {
    stats.innerHTML = "";
  }

  incomplete.forEach((run) => {
    const card = document.createElement("div");
    card.className = "run-card run-card-incomplete";
    card.innerHTML = `
      <div class="run-card-head">
        <div><div class="run-title">${esc(run.label)}</div><div class="run-date">incomplete run</div></div>
      </div>
      <div class="run-card-actions"><button class="btn btn-danger" data-act="del">Delete</button></div>
    `;
    card.querySelector('[data-act="del"]').addEventListener("click", async () => {
      if (confirm(`Delete incomplete game run "${run.label}"?`)) {
        await snapshotBeforeDelete(`Before deleting incomplete run "${run.label}"`);
        await dbDelete("runs", run.id);
        await loadRuns();
      }
    });
    list.appendChild(card);
  });

  completed.slice().reverse().forEach((run) => {
    const total = runTotal(run, state.missions);
    const maxTotal = runMaxPoints(state.missions);
    const card = document.createElement("div");
    card.className = "run-card";
    card.innerHTML = `
      <div class="run-card-head">
        <div>
          <div class="run-title">${esc(run.label)}</div>
          <div class="run-date">${esc(run.date || "")}</div>
        </div>
        <div class="run-stamp"><span class="rs-score">${total}</span><span class="rs-label">/ ${maxTotal}</span></div>
      </div>
      <div class="run-meta-row">
        <span>${fmtDuration(run.totalTimeMs || 0)} total</span>
        <span>${new Set((run.missionTimings || []).map(mt => mt.runGroupId)).size} run${new Set((run.missionTimings || []).map(mt => mt.runGroupId)).size === 1 ? "" : "s"} &middot; ${(run.missionTimings || []).length} mission${(run.missionTimings || []).length === 1 ? "" : "s"}</span>
      </div>
      <div class="run-card-actions">
        <button class="btn btn-ghost" data-act="view">View breakdown</button>
        <button class="btn btn-danger" data-act="del">Delete</button>
      </div>
    `;
    card.querySelector('[data-act="view"]').addEventListener("click", () => viewRunBreakdown(run));
    card.querySelector('[data-act="del"]').addEventListener("click", async () => {
      if (confirm(`Delete game run "${run.label}"?`)) {
        await snapshotBeforeDelete(`Before deleting run "${run.label}"`);
        await dbDelete("runs", run.id);
        await loadRuns();
      }
    });
    list.appendChild(card);
  });
}

function viewRunBreakdown(run) {
  const missionTimings = run.missionTimings || [];
  const transitions = run.transitionTimings || [];
  let rows = "";
  let transIdx = 0;
  let lastGroupId = undefined;
  missionTimings.forEach((mt) => {
    if (lastGroupId !== undefined && mt.runGroupId !== lastGroupId) {
      if (transitions[transIdx]) {
        rows += `<tr class="row-transition"><td colspan="2">Transition &mdash; ${esc(mt.runGroupName || "next run")}</td><td>${fmtDuration(transitions[transIdx].durationMs)}</td></tr>`;
        transIdx++;
      }
    }
    const mission = state.missions.find((m) => m.id === mt.missionId);
    const score = mission ? missionScoreForRun(mission, run) : 0;
    const max = mission ? missionMaxPoints(mission) : 0;
    rows += `<tr class="row-mission"><td>${esc(mt.missionName)}</td><td>${score}/${max}</td><td>${fmtDuration(mt.durationMs)}</td></tr>`;
    lastGroupId = mt.runGroupId;
  });
  const avgOpTime = transitions.length ? transitions.reduce((s, t) => s + t.durationMs, 0) / transitions.length : 0;
  const tokensLeft = run.precisionTokensRemaining ?? 0;
  openModal(`
    <h2>${esc(run.label)}</h2>
    <p class="empty-sub">${esc(run.date || "")}</p>
    <div class="run-total-bar"><span class="rt-label">Total score</span><span class="rt-num">${runTotal(run, state.missions)} / ${runMaxPoints(state.missions)}</span></div>
    <div class="run-total-bar"><span class="rt-label">Total time</span><span class="rt-num">${fmtDuration(run.totalTimeMs || 0)}</span></div>
    <div class="run-total-bar"><span class="rt-label">Avg operation time</span><span class="rt-num">${transitions.length ? fmtDuration(avgOpTime) : "—"}</span></div>
    <p class="empty-sub">Precision tokens: ${tokensLeft} left &middot; +${precisionTokenBonus(tokensLeft)} bonus pts</p>
    <table class="run-summary-table"><thead><tr><th>Mission</th><th>Score</th><th>Time</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="modal-actions"><button class="btn btn-ghost btn-full" id="m-close">Close</button></div>
  `);
  document.getElementById("m-close").addEventListener("click", closeModal);
}

// ---- Scoresheet-style CSV export ----
function buildScoresheetCSV(runs) {
  const sortedGroups = state.runGroups.slice().sort((a, b) => a.order - b.order);
  const groupNumberById = Object.fromEntries(sortedGroups.map((g, i) => [g.id, i + 1]));
  const groupsById = Object.fromEntries(sortedGroups.map((g) => [g.id, g]));

  const taskRows = [];
  state.missions.forEach((mission) => {
    const group = groupsById[mission.runGroupId];
    const runName = group ? group.name : "Unassigned";
    const runNum = group ? groupNumberById[group.id] : "";
    (mission.tasks || []).forEach((task) => taskRows.push({ mission, task, runName, runNum }));
  });

  const header = ["Official Name", "Notes", "Pts", "Name", "#", ...runs.map((r) => r.label), "Success Rate", "", "Run #", "Score"];
  const lines = [header.map(csvEscape).join(",")];

  taskRows.forEach((row, i) => {
    const { mission, task, runName, runNum } = row;
    const flags = runs.map((r) => (isTaskComplete(task, r.rawScores || {}) ? "1" : ""));
    const successCount = flags.filter((f) => f === "1").length;
    const successRate = runs.length ? Math.round((successCount / runs.length) * 100) : 0;
    const sideTable = i < runs.length ? [String(i + 1), String(runTotal(runs[i], state.missions))] : ["", ""];
    const rowVals = [mission.name, task.name, taskMaxPoints(task), runName, runNum, ...flags, `${successRate}%`, "", ...sideTable];
    lines.push(rowVals.map(csvEscape).join(","));
  });

  const tokenRow = ["", "", "Precision Tokens Left", "", "", ...runs.map((r) => String(r.precisionTokensRemaining ?? "")), "", "", "", ""];
  lines.push(tokenRow.map(csvEscape).join(","));

  return lines.join("\n");
}

document.getElementById("btn-export-runs-csv").addEventListener("click", () => {
  const completedRuns = state.runs.filter((r) => !r.inProgress).sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  if (!completedRuns.length) { alert("No completed runs yet."); return; }
  const toLocalInput = (ts) => {
    const d = new Date(ts);
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  };
  const earliest = (completedRuns[0].startedAt || Date.now()) - 60000;
  const latest = (completedRuns[completedRuns.length - 1].startedAt || Date.now()) + 60000;
  openModal(`
    <h2>Export scoresheet CSV</h2>
    <p class="empty-sub">Choose a date/time range — every completed run started in that window becomes one column.</p>
    <div class="field"><label>From</label><input type="datetime-local" id="export-from" class="text-input" value="${toLocalInput(earliest)}"></div>
    <div class="field"><label>To</label><input type="datetime-local" id="export-to" class="text-input" value="${toLocalInput(latest)}"></div>
    <p class="empty-sub" id="export-run-count"></p>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="m-cancel" type="button">Cancel</button>
      <button class="btn btn-primary" id="m-export" type="button">Export</button>
    </div>
  `);
  function inRangeRuns() {
    const fromVal = document.getElementById("export-from").value;
    const toVal = document.getElementById("export-to").value;
    const from = fromVal ? new Date(fromVal).getTime() : -Infinity;
    const to = toVal ? new Date(toVal).getTime() : Infinity;
    return completedRuns.filter((r) => { const t = r.startedAt || 0; return t >= from && t <= to; });
  }
  function updateCount() {
    const n = inRangeRuns().length;
    document.getElementById("export-run-count").textContent = `${n} run${n === 1 ? "" : "s"} in this range.`;
  }
  document.getElementById("export-from").addEventListener("change", updateCount);
  document.getElementById("export-to").addEventListener("change", updateCount);
  updateCount();
  document.getElementById("m-cancel").addEventListener("click", closeModal);
  document.getElementById("m-export").addEventListener("click", () => {
    const runs = inRangeRuns();
    if (!runs.length) { alert("No runs in that range."); return; }
    if (!state.missions.some((m) => (m.tasks || []).length)) { alert("Add missions and tasks in Setup first."); return; }
    const csv = buildScoresheetCSV(runs);
    closeModal();
    download(`barp-scoresheet-${Date.now()}.csv`, csv, "text/csv");
  });
});

// ==========================================================
// BACKUP
// ==========================================================
document.getElementById("btn-export-backup").addEventListener("click", async () => {
  const data = {
    version: 2,
    exportedAt: Date.now(),
    attachments: await dbGetAll("attachments"),
    entries: await dbGetAll("entries"),
    missions: await dbGetAll("missions"),
    runs: await dbGetAll("runs"),
    meta: await dbGetAll("meta"),
    runGroups: await dbGetAll("runGroups"),
  };
  download(`barp-backup-${Date.now()}.json`, JSON.stringify(data, null, 2), "application/json");
});

document.getElementById("btn-import-backup").addEventListener("click", () => document.getElementById("file-import-backup").click());
document.getElementById("btn-restore-shadow").addEventListener("click", () => openBackupMenu());
document.getElementById("btn-reset-db").addEventListener("click", () => {
  if (confirm("This permanently erases every attachment, entry, mission, and run stored on this device. This can't be undone. Continue?")) {
    resetLocalDatabase();
  }
});
document.getElementById("file-import-backup").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  if (!confirm("This replaces everything currently stored on this device with the backup file. Continue?")) return;
  try {
    const data = JSON.parse(await file.text());
    await dbClear("attachments"); await dbClear("entries"); await dbClear("missions"); await dbClear("runs"); await dbClear("meta"); await dbClear("runGroups");
    for (const a of data.attachments || []) await dbPut("attachments", a);
    for (const en of data.entries || []) await dbPut("entries", en);
    for (const m of data.missions || []) await dbPut("missions", m);
    for (const r of data.runs || []) await dbPut("runs", r);
    for (const meta of data.meta || []) await dbPut("meta", meta);
    for (const g of data.runGroups || []) await dbPut("runGroups", g);
    await initAll();
    alert("Backup restored.");
  } catch (err) {
    alert("Couldn't read that backup file: " + err.message);
  }
});

// ---------- Season name ----------
const seasonInput = document.getElementById("input-season-name");
seasonInput.addEventListener("change", async () => {
  const val = seasonInput.value.trim();
  await dbPut("meta", { key: "seasonName", value: val });
  document.getElementById("season-title").textContent = val || "BARP";
});
async function loadSeasonName() {
  const rec = await dbGet("meta", "seasonName");
  if (rec?.value) { seasonInput.value = rec.value; document.getElementById("season-title").textContent = rec.value; }
}

// ---------- Init ----------
async function purgeOldTrash() {
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
  const all = await dbGetAll("entries");
  const cutoff = Date.now() - THIRTY_DAYS;
  for (const e of all) {
    if (e.deleted && e.deletedAt && e.deletedAt < cutoff) await dbDelete("entries", e.id);
  }
}
async function initAll() {
  await purgeOldTrash();
  await loadAttachments();
  await loadMissions();
  await ensureDefaultRunGroup();
  await loadRunGroups();
  await loadRuns();
  await loadSeasonName();
  await renderLastBackupTime();
  document.getElementById("log-empty-state").hidden = state.attachments.length === 0 ? false : true;
}
initAll();
