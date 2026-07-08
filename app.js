/* BARP — Bobot Attachment & Run Progress. vanilla JS, IndexedDB-backed, offline-first PWA. */

// ---------- Service worker ----------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

// ---------- IndexedDB helper ----------
const DB_NAME = "barp-db-v1";
const DB_VERSION = 3;
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
async function restoreFromShadowBackup() {
  const data = await getShadowBackup();
  if (!data) { alert("No automatic backup found yet."); return; }
  if (!confirm(`Restore the automatic backup from ${new Date(data.savedAt).toLocaleString()}? This replaces everything currently on this device.`)) return;
  await dbClear("attachments"); await dbClear("entries"); await dbClear("missions"); await dbClear("runs"); await dbClear("meta");
  for (const a of data.attachments || []) await dbPut("attachments", a);
  for (const en of data.entries || []) await dbPut("entries", en);
  for (const m of data.missions || []) await dbPut("missions", m);
  for (const r of data.runs || []) await dbPut("runs", r);
  for (const meta of data.meta || []) await dbPut("meta", meta);
  await initAll();
  alert("Automatic backup restored.");
}
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
    const data = {
      version: 1,
      attachments: await dbGetAllRaw("attachments"),
      entries: await dbGetAllRaw("entries"),
      missions: await dbGetAllRaw("missions"),
      runs: await dbGetAllRaw("runs"),
      meta: await dbGetAllRaw("meta"),
    };
    await dbPut("deletionSnapshots", { takenAt: Date.now(), label, data });
    const all = await dbGetAll("deletionSnapshots");
    if (all.length > MAX_DELETION_SNAPSHOTS) {
      all.sort((a, b) => a.takenAt - b.takenAt);
      for (const old of all.slice(0, all.length - MAX_DELETION_SNAPSHOTS)) await dbDelete("deletionSnapshots", old.id);
    }
  } catch (e) { /* best-effort — never block the actual delete on this */ }
}

async function renderDeletionSnapshots() {
  const list = document.getElementById("deletion-snapshot-list");
  if (!list) return;
  const all = (await dbGetAll("deletionSnapshots")).sort((a, b) => b.takenAt - a.takenAt);
  if (!all.length) { list.innerHTML = `<p class="empty-sub">Nothing deleted yet — this list fills in automatically.</p>`; return; }
  list.innerHTML = "";
  all.forEach((snap) => {
    const row = document.createElement("div");
    row.className = "mission-row";
    row.innerHTML = `
      <div class="m-info">
        <div class="m-name">${esc(snap.label)}</div>
        <div class="m-sub">${new Date(snap.takenAt).toLocaleString()}</div>
      </div>
      <button class="btn btn-ghost" data-act="restore">Restore</button>
    `;
    row.querySelector('[data-act="restore"]').addEventListener("click", async () => {
      if (!confirm(`Restore everything to how it was right before "${snap.label}"? This replaces everything currently on this device.`)) return;
      await dbClear("attachments"); await dbClear("entries"); await dbClear("missions"); await dbClear("runs"); await dbClear("meta");
      for (const a of snap.data.attachments || []) await dbPut("attachments", a);
      for (const en of snap.data.entries || []) await dbPut("entries", en);
      for (const m of snap.data.missions || []) await dbPut("missions", m);
      for (const r of snap.data.runs || []) await dbPut("runs", r);
      for (const meta of snap.data.meta || []) await dbPut("meta", meta);
      await initAll();
      alert("Restored.");
    });
    list.appendChild(row);
  });
}

// ---------- App state ----------
const state = {
  attachments: [],
  selectedAttachmentIds: new Set(),
  filterInitialized: false,
  entries: [],
  missions: [],
  runs: [],
  expandedMissions: new Set(),
  editingAttachmentOrder: false,
  editingMissionOrder: false,
  editingTasksForMissionId: null,
  guidedRun: null, // { run, missionIdx, phase, phaseStartTs, timerHandle }
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
function attachRowDrag(row, container, itemsArray) {
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
    ? `<div class="reorder-toolbar"><button type="button" class="btn btn-primary" id="btn-save-order-${prefix}">Save order</button><button type="button" class="btn btn-ghost" id="btn-cancel-order-${prefix}">Cancel</button></div>`
    : `<div class="reorder-toolbar"><button type="button" class="btn btn-ghost" id="btn-edit-order-${prefix}">Edit order</button></div>`;
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
    if (btn.dataset.view === "view-setup") { renderLastBackupTime(); renderDeletionSnapshots(); }
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
function runMaxPoints(missions) { return missions.reduce((sum, m) => sum + missionMaxPoints(m), 0); }
function runTotal(run, missions) { return missions.reduce((sum, m) => sum + missionScoreForRun(m, run), 0); }

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
    list.innerHTML = reorderToolbarHTML(editing, "attachments");
    if (!state.attachments.length) {
      list.insertAdjacentHTML("beforeend", `<p class="empty-sub">No attachments yet. Add one for each swappable part on the bot.</p>`);
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
          <div class="m-info"><div class="m-name">#${esc(att.number)} ${esc(att.name)}</div></div>
        `;
        list.appendChild(row);
        attachRowDrag(row, list, state.attachments);
      } else {
        const count = await iterationCount(att.id);
        row.className = "mission-row";
        row.innerHTML = `
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
            await loadAttachments();
          }
        });
        list.appendChild(row);
      }
    }
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
    for (const [idx, att] of state.attachments.entries()) { att.order = idx; await dbPut("attachments", att); }
    state.editingAttachmentOrder = false;
    await loadAttachments();
  });
}

function openAttachmentModal(att) {
  const isEdit = !!att;
  const nextNum = isEdit ? att.number : (state.attachments.length ? Math.max(...state.attachments.map((a) => Number(a.number) || 0)) + 1 : 1);
  openModal(`
    <h2>${isEdit ? "Edit attachment" : "New attachment"}</h2>
    <div class="field"><label>Number</label><input class="text-input" id="m-att-number" type="text" value="${esc(nextNum)}"></div>
    <div class="field"><label>Name</label><input class="text-input" id="m-att-name" type="text" value="${isEdit ? esc(att.name) : ""}" placeholder="e.g. Coral claw"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="m-cancel" type="button">Cancel</button>
      <button class="btn btn-primary" id="m-save" type="button">Save</button>
    </div>
  `);
  document.getElementById("m-cancel").addEventListener("click", closeModal);
  document.getElementById("m-save").addEventListener("click", async () => {
    const number = document.getElementById("m-att-number").value.trim();
    const name = document.getElementById("m-att-name").value.trim();
    if (!name) { alert("Give this attachment a name."); return; }
    if (!number) { alert("Give this attachment a number."); return; }
    const duplicate = state.attachments.find((a) => String(a.number) === String(number) && (!isEdit || a.id !== att.id));
    if (duplicate) { alert(`Attachment #${number} is already used by "${duplicate.name}". Pick a different number.`); return; }
    const record = isEdit ? att : { order: state.attachments.length };
    record.number = number; record.name = name;
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
    openModal(`<h2>No attachments yet</h2><p class="empty-sub">Go to Settings to add a bot attachment first.</p>
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

  document.getElementById("btn-take-photo").addEventListener("click", () => openCamera());
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
async function openCamera() {
  try {
    activeCameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
    const video = document.getElementById("camera-video");
    video.srcObject = activeCameraStream;
    document.getElementById("camera-view").hidden = false;
    document.getElementById("photo-btn-group").hidden = true;
  } catch (err) {
    // Permission denied, no camera, or an insecure context — fall back to the
    // regular file picker rather than leaving the person stuck.
    showErrorBanner("Couldn't access the camera (" + (err.message || err.name) + ") — use Choose from files instead.");
  }
}
function stopCamera() {
  if (activeCameraStream) { activeCameraStream.getTracks().forEach((t) => t.stop()); activeCameraStream = null; }
  const view = document.getElementById("camera-view");
  const btnGroup = document.getElementById("photo-btn-group");
  if (view) view.hidden = true;
  if (btnGroup) btnGroup.hidden = false;
}
function capturePhoto() {
  const video = document.getElementById("camera-video");
  const maxDim = 900;
  let { videoWidth: width, videoHeight: height } = video;
  if (!width || !height) return;
  if (width > height && width > maxDim) { height = Math.round(height * (maxDim / width)); width = maxDim; }
  else if (height > maxDim) { width = Math.round(width * (maxDim / height)); height = maxDim; }
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  canvas.getContext("2d").drawImage(video, 0, 0, width, height);
  pendingPhoto = canvas.toDataURL("image/jpeg", 0.72);
  document.getElementById("photo-preview-wrap").innerHTML = `<img class="photo-preview" src="${pendingPhoto}">`;
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
async function loadMissions() {
  state.missions = (await dbGetAll("missions")).sort((a, b) => a.order - b.order);
  state.missions.forEach((m) => { if (!m.tasks) m.tasks = []; if (m.taskSeq === undefined) m.taskSeq = 0; });
  renderMissions();
}

function taskSubLabel(t) {
  if (t.type === "bool") return `Yes/No · ${taskMaxPoints(t)} pts`;
  if (t.type === "number") return `Count 0–${t.max} · ${t.pointsPerUnit} pt/each · max ${taskMaxPoints(t)}`;
  return `Multi-state · max ${taskMaxPoints(t)} pts`;
}

function renderMissions() {
  const list = document.getElementById("mission-list");
  const editing = state.editingMissionOrder;
  list.innerHTML = reorderToolbarHTML(editing, "missions");
  if (!state.missions.length) {
    list.insertAdjacentHTML("beforeend", `<p class="empty-sub">No missions yet. Add one, then add its tasks.</p>`);
    wireMissionOrderToolbar();
    return;
  }
  state.missions.forEach((m, idx) => {
    const group = document.createElement("div");
    group.className = "mission-group";
    group.dataset.idx = idx;

    if (editing) {
      group.classList.add("drag-row");
      group.innerHTML = `
        <div class="mission-row mission-group-head">
          <span class="drag-handle">&#9776;</span>
          <div class="m-info"><div class="m-name">${esc(m.name)}</div></div>
        </div>
      `;
      list.appendChild(group);
      attachRowDrag(group, list, state.missions);
      return;
    }

    const expanded = state.expandedMissions.has(m.id);
    group.innerHTML = `
      <div class="mission-row mission-group-head">
        <button class="btn-icon mission-expand-btn" data-act="expand">${expanded ? "&#9660;" : "&#9654;"}</button>
        <div class="m-info">
          <div class="m-name">${esc(m.name)}</div>
          <div class="m-sub">${(m.tasks || []).length} task${(m.tasks || []).length === 1 ? "" : "s"} · max ${missionMaxPoints(m)} pts</div>
        </div>
        <button class="btn-icon" data-act="edit">&#9998;&#65039;</button>
        <button class="btn-icon" data-act="del">&#128465;&#65039;</button>
      </div>
      <div class="task-list" ${expanded ? "" : "hidden"}></div>
    `;
    group.querySelector('[data-act="expand"]').addEventListener("click", () => {
      if (expanded) state.expandedMissions.delete(m.id); else state.expandedMissions.add(m.id);
      renderMissions();
    });
    group.querySelector('[data-act="edit"]').addEventListener("click", () => openMissionNameModal(m));
    group.querySelector('[data-act="del"]').addEventListener("click", async () => {
      if (confirm(`Delete mission "${m.name}" and all its tasks?`)) {
        await snapshotBeforeDelete(`Before deleting mission "${m.name}"`);
        await dbDelete("missions", m.id);
        await loadMissions();
      }
    });
    if (expanded) {
      const taskListEl = group.querySelector(".task-list");
      renderTaskList(taskListEl, m);
    }
    list.appendChild(group);
  });
  wireMissionOrderToolbar();
}

function wireMissionOrderToolbar() {
  const editBtn = document.getElementById("btn-edit-order-missions");
  if (editBtn) editBtn.addEventListener("click", () => { state.editingMissionOrder = true; renderMissions(); });
  const cancelBtn = document.getElementById("btn-cancel-order-missions");
  if (cancelBtn) cancelBtn.addEventListener("click", async () => {
    state.editingMissionOrder = false;
    state.missions = (await dbGetAll("missions")).sort((a, b) => a.order - b.order);
    renderMissions();
  });
  const saveBtn = document.getElementById("btn-save-order-missions");
  if (saveBtn) saveBtn.addEventListener("click", async () => {
    for (const [idx, m] of state.missions.entries()) { m.order = idx; await dbPut("missions", m); }
    state.editingMissionOrder = false;
    await loadMissions();
  });
}

function renderTaskList(container, mission) {
  const editing = state.editingTasksForMissionId === mission.id;
  const prefix = `tasks-${mission.id}`;
  container.innerHTML = reorderToolbarHTML(editing, prefix);
  (mission.tasks || []).forEach((t, tIdx) => {
    const row = document.createElement("div");
    row.dataset.idx = tIdx;
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

  const editBtn = document.getElementById(`btn-edit-order-${prefix}`);
  if (editBtn) editBtn.addEventListener("click", () => { state.editingTasksForMissionId = mission.id; renderMissions(); });
  const cancelBtn = document.getElementById(`btn-cancel-order-${prefix}`);
  if (cancelBtn) cancelBtn.addEventListener("click", async () => {
    state.editingTasksForMissionId = null;
    const fresh = (await dbGetAll("missions")).find((mm) => mm.id === mission.id);
    if (fresh) mission.tasks = fresh.tasks;
    renderMissions();
  });
  const saveBtn = document.getElementById(`btn-save-order-${prefix}`);
  if (saveBtn) saveBtn.addEventListener("click", async () => {
    await dbPut("missions", mission);
    state.editingTasksForMissionId = null;
    await loadMissions();
  });
}

document.getElementById("btn-add-mission").addEventListener("click", () => openMissionNameModal(null));

function openMissionNameModal(m) {
  const isEdit = !!m;
  openModal(`
    <h2>${isEdit ? "Edit mission" : "New mission"}</h2>
    <div class="field"><label>Mission name</label><input class="text-input" id="m-mission-name" value="${isEdit ? esc(m.name) : ""}" placeholder="e.g. M07 — Coral nursery"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="m-cancel">Cancel</button>
      <button class="btn btn-primary" id="m-save">Save</button>
    </div>
  `);
  document.getElementById("m-cancel").addEventListener("click", closeModal);
  document.getElementById("m-save").addEventListener("click", async () => {
    const name = document.getElementById("m-mission-name").value.trim();
    if (!name) { alert("Name this mission."); return; }
    const record = isEdit ? m : { order: state.missions.length, tasks: [], taskSeq: 0 };
    record.name = name;
    const id = await dbPut("missions", record);
    closeModal();
    await loadMissions();
    if (!isEdit) state.expandedMissions.add(id);
    renderMissions();
  });
}

function optionRowHtml(label = "", points = 0) {
  return `<div class="option-row">
    <input class="text-input" placeholder="Option label" value="${esc(label)}" data-f="label">
    <input type="number" placeholder="pts" value="${points}" data-f="points">
    <button class="btn-icon" data-act="rm-option">&#10005;</button>
  </div>`;
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
    renderMissions();
  });
}

// ---- Import missions CSV ----
const EXAMPLE_MISSIONS_CSV =
`Mission,Task,Type,Points,Max,PointsPerUnit,Options
M01 Coral Nursery,Place sample in nursery,bool,20,,,
M01 Coral Nursery,Samples relocated,number,,4,10,
M02 Reef Restoration,Restoration state,choice,,,,Partial:10;Full:20
`;

document.getElementById("btn-import-missions").addEventListener("click", () => {
  openModal(`
    <h2>Import missions</h2>
    <p class="empty-sub">Upload a CSV with columns <strong>Mission, Task, Type, Points, Max, PointsPerUnit, Options</strong>. One row per task &mdash; rows sharing a Mission name are grouped together in the order they appear. <strong>Type</strong> is <code>bool</code>, <code>number</code>, or <code>choice</code>. For <code>choice</code> rows, put states in <strong>Options</strong> as <code>Label:Points;Label:Points</code>. Importing adds to your existing missions rather than replacing them.</p>
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
  const iMission = col("mission"), iTask = col("task"), iType = col("type"), iPoints = col("points"), iMax = col("max"), iPpu = col("pointsperunit"), iOptions = col("options");
  if (iMission === -1 || iTask === -1 || iType === -1) { alert("CSV needs at least Mission, Task, and Type columns."); return; }
  const dataRows = rows.slice(1);
  let missionsAdded = 0, tasksAdded = 0;
  for (const r of dataRows) {
    const missionName = (r[iMission] || "").trim();
    const taskName = (r[iTask] || "").trim();
    const type = (r[iType] || "").trim().toLowerCase();
    if (!missionName || !taskName || !["bool", "number", "choice"].includes(type)) continue;
    let mission = state.missions.find((m) => m.name.toLowerCase() === missionName.toLowerCase());
    if (!mission) {
      mission = { order: state.missions.length, name: missionName, tasks: [], taskSeq: 0 };
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
  await loadMissions();
  alert(`Imported ${tasksAdded} task${tasksAdded === 1 ? "" : "s"} across ${missionsAdded} new mission${missionsAdded === 1 ? "" : "s"} (plus any matched into existing missions).`);
});

// ==========================================================
// GUIDED PRACTICE RUNS
// ==========================================================
document.getElementById("btn-start-run").addEventListener("click", startGuidedRun);

// ---- Sound effects ----
// Official FLL match audio is copyrighted by FIRST, so no audio files ship
// with this app. Drop your own MP3s in a `sounds/` folder next to index.html
// with these exact names and they'll play automatically; if a file is
// missing, playback just silently no-ops.
const SOUND_FILES = {
  start: "sounds/start-horn.mp3",
  thirty: "sounds/thirty-seconds.mp3",
  buzzer: "sounds/buzzer.mp3",
};
function playSound(key) {
  try {
    const audio = new Audio(SOUND_FILES[key]);
    audio.play().catch(() => {});
  } catch (e) { /* no Audio support / no file — fine, just silent */ }
}

// ---- Precision tokens ----
async function getPrecisionTokensDefault() {
  const rec = await dbGet("meta", "precisionTokensDefault");
  return rec?.value ?? 2;
}
function precisionTokenWidgetHTML() {
  const remaining = state.guidedRun?.run?.precisionTokensRemaining ?? 0;
  return `<button type="button" class="precision-token-btn" id="grn-token-btn">&#129689; <span id="grn-token-count">${remaining}</span></button>`;
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
}

// ---- Start flow: countdown, then horn, then the match begins ----
async function startGuidedRun() {
  if (!state.missions.length || !state.missions.some((m) => (m.tasks || []).length)) {
    openModal(`<h2>No missions yet</h2><p class="empty-sub">Add missions and tasks in the Setup tab first, matching the official scoresheet.</p>
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
      <h2 class="gfs-mission-name">New Practice Run</h2>
    </div>
    <div class="gfs-body gfs-center">
      <button type="button" class="btn btn-amber btn-full gfs-big-action" id="grn-start-countdown">Tap to start countdown</button>
    </div>
    <div class="gfs-footer">
      <button type="button" class="btn-link-cancel" id="grn-cancel-pre">Cancel</button>
    </div>
  `);
  document.getElementById("grn-cancel-pre").addEventListener("click", closeGuidedFullscreen);
  document.getElementById("grn-start-countdown").addEventListener("click", runCountdown);
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
    label: `Run ${state.runs.length + 1}`,
    date: new Date(now).toLocaleDateString(),
    startedAt: now,
    inProgress: true,
    precisionTokensRemaining: await getPrecisionTokensDefault(),
    rawScores: {},
    missionTimings: [],
    transitionTimings: [],
    notes: "",
  };
  const id = await dbPut("runs", run);
  run.id = id;
  state.guidedRun = {
    run,
    missionIdx: 0,
    taskIdx: 0,
    matchStartTs: now,
    missionStartTs: now,
    played30: false,
    playedBuzzer: false,
  };
  renderCurrentTaskScreen();
  state.guidedRun.timerHandle = setInterval(tickGuidedTimer, 500);
}

// ---- Continuous match clock (one clock for the whole run, like a real FLL match) ----
function tickGuidedTimer() {
  if (!state.guidedRun) return;
  const elapsed = Date.now() - state.guidedRun.matchStartTs;
  const el = document.getElementById("grn-timer");
  if (el) {
    el.textContent = fmtDuration(elapsed);
    el.classList.toggle("timer-danger", elapsed >= 150000);
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
  return `<button type="button" class="btn-link-cancel" id="grn-cancel">Cancel this run</button>`;
}
function wireCancelLink() {
  document.getElementById("grn-cancel").addEventListener("click", async () => {
    if (!confirm("Cancel and discard this practice run?")) return;
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
// (where you see every task in a mission at once, not one at a time).
function taskRowHTML(t, raw) {
  const max = taskMaxPoints(t);
  if (t.type === "bool") {
    const on = !!raw[t.id];
    return `<div class="gfs-task-row" data-tid="${t.id}" data-type="bool">
      <span class="gfs-task-name">${esc(t.name)}</span>
      <span class="gfs-task-pts">${on ? max : 0} / ${max}</span>
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

// ---- One task at a time, tap-to-advance, with a back arrow ----
function renderCurrentTaskScreen() {
  const { run, missionIdx, taskIdx } = state.guidedRun;
  const mission = state.missions[missionIdx];
  const tasks = mission.tasks || [];
  if (taskIdx >= tasks.length) {
    renderRobotReturnedScreen();
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
      `<button type="button" class="gfs-num-btn gfs-num-btn-big${val === i ? " active" : ""}" data-val="${i}">${i}</button>`
    ).join("")}</div>`;
  } else {
    const cur = raw[task.id] ?? "";
    controlHTML = `<div class="gfs-choice-strip gfs-choice-strip-big">
      <button type="button" class="gfs-choice-btn gfs-choice-btn-big${cur === "" ? " active" : ""}" data-val="">Not achieved</button>
      ${(task.options || []).map((o, i) => `<button type="button" class="gfs-choice-btn gfs-choice-btn-big${String(cur) === String(i) ? " active" : ""}" data-val="${i}">${esc(o.label)} (${o.points})</button>`).join("")}
    </div>`;
  }

  openGuidedFullscreen(`
    <div class="gfs-header">
      <button type="button" class="gfs-back-btn" id="grn-back" ${taskIdx === 0 ? "disabled" : ""}>&#8592;</button>
      ${precisionTokenWidgetHTML()}
      <div class="guided-phase-badge">Mission ${missionIdx + 1} of ${state.missions.length} &middot; Task ${taskIdx + 1} of ${tasks.length}</div>
      <h2 class="gfs-mission-name">${esc(mission.name)}</h2>
      <div class="gfs-timer" id="grn-timer">${fmtDuration(Date.now() - state.guidedRun.matchStartTs)}</div>
    </div>
    <div class="gfs-body gfs-center">
      <p class="gfs-task-prompt">${esc(task.name)} <span class="gfs-task-pts">/ ${taskMaxPoints(task)} pts</span></p>
      ${controlHTML}
    </div>
    <div class="gfs-footer">${cancelGuidedRunLink()}</div>
  `);
  wireCancelLink();
  wirePrecisionTokenButton();
  document.getElementById("grn-back").addEventListener("click", () => {
    if (state.guidedRun.taskIdx > 0) { state.guidedRun.taskIdx--; renderCurrentTaskScreen(); }
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

function renderRobotReturnedScreen() {
  const { missionIdx } = state.guidedRun;
  const mission = state.missions[missionIdx];
  openGuidedFullscreen(`
    <div class="gfs-header">
      <button type="button" class="gfs-back-btn" id="grn-back">&#8592;</button>
      ${precisionTokenWidgetHTML()}
      <div class="guided-phase-badge">Mission ${missionIdx + 1} of ${state.missions.length}</div>
      <h2 class="gfs-mission-name">${esc(mission.name)}</h2>
      <div class="gfs-timer" id="grn-timer">${fmtDuration(Date.now() - state.guidedRun.matchStartTs)}</div>
    </div>
    <div class="gfs-body gfs-center">
      <p class="empty-sub">All tasks marked for this mission.</p>
      <button type="button" class="btn btn-primary btn-full gfs-big-action" id="grn-done">Robot returned</button>
    </div>
    <div class="gfs-footer">${cancelGuidedRunLink()}</div>
  `);
  wireCancelLink();
  wirePrecisionTokenButton();
  document.getElementById("grn-back").addEventListener("click", () => {
    state.guidedRun.taskIdx = Math.max(0, (mission.tasks || []).length - 1);
    renderCurrentTaskScreen();
  });
  document.getElementById("grn-done").addEventListener("click", async () => {
    const { run } = state.guidedRun;
    const now = Date.now();
    const durationMs = now - state.guidedRun.missionStartTs;
    run.missionTimings.push({ missionId: mission.id, missionName: mission.name, startTs: state.guidedRun.missionStartTs, endTs: now, durationMs });
    await dbPut("runs", run);
    if (missionIdx === state.missions.length - 1) {
      stopGuidedTimer();
      run.finishedAt = now;
      run.totalTimeMs = now - state.guidedRun.matchStartTs;
      await dbPut("runs", run);
      renderGuidedOverview();
    } else {
      state.guidedRun.missionIdx += 1;
      state.guidedRun.taskIdx = 0;
      state.guidedRun.transitionStartTs = now;
      renderGuidedTransitionPhase();
    }
  });
}

function renderGuidedTransitionPhase() {
  const { missionIdx } = state.guidedRun;
  const nextMission = state.missions[missionIdx];
  openGuidedFullscreen(`
    <div class="gfs-header">
      ${precisionTokenWidgetHTML()}
      <div class="guided-phase-badge">Transition</div>
      <h2 class="gfs-mission-name">Heading to: ${esc(nextMission.name)}</h2>
      <div class="gfs-timer" id="grn-timer">${fmtDuration(Date.now() - state.guidedRun.matchStartTs)}</div>
    </div>
    <div class="gfs-body gfs-center">
      <p class="empty-sub">Tap when the robot leaves base for the next mission.</p>
      <button type="button" class="btn btn-amber btn-full gfs-big-action" id="grn-leave">Robot leaves for next mission</button>
    </div>
    <div class="gfs-footer">${cancelGuidedRunLink()}</div>
  `);
  wireCancelLink();
  wirePrecisionTokenButton();
  document.getElementById("grn-leave").addEventListener("click", () => {
    const now = Date.now();
    const durationMs = now - state.guidedRun.transitionStartTs;
    state.guidedRun.run.transitionTimings.push({ beforeMissionId: nextMission.id, durationMs });
    state.guidedRun.missionStartTs = now;
    renderCurrentTaskScreen();
  });
}

function renderGuidedOverview() {
  const { run } = state.guidedRun;
  openGuidedFullscreen(`
    <div class="gfs-header">
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
      ${cancelGuidedRunLink()}
    </div>
  `);
  renderOverviewBody();
  wireCancelLink();
  document.getElementById("grn-save-top").addEventListener("click", finalizeGuidedRun);
  document.getElementById("grn-save-bottom").addEventListener("click", finalizeGuidedRun);
}

function renderOverviewBody() {
  const { run } = state.guidedRun;
  const body = document.getElementById("gfs-overview-body");
  body.innerHTML = state.missions.map((m) => {
    const score = missionScoreForRun(m, run);
    const max = missionMaxPoints(m);
    const timing = (run.missionTimings || []).find((t) => t.missionId === m.id);
    const rows = (m.tasks || []).map((t) => taskRowHTML(t, run.rawScores)).join("") || `<p class="empty-sub">No tasks.</p>`;
    return `<div class="gfs-section">
      <h3>${esc(m.name)} <span class="gfs-task-pts">${score} / ${max}${timing ? ` &middot; ${fmtDuration(timing.durationMs)}` : ""}</span></h3>
      <div class="gfs-task-list">${rows}</div>
    </div>`;
  }).join("");
  bindOverviewEvents();
  updateOverviewTotal();
}

function bindOverviewEvents() {
  document.querySelectorAll('#gfs-overview-body .gfs-task-row[data-type="bool"]').forEach((row) => {
    row.addEventListener("click", () => {
      state.guidedRun.run.rawScores[row.dataset.tid] = !state.guidedRun.run.rawScores[row.dataset.tid];
      renderOverviewBody();
    });
  });
  document.querySelectorAll("#gfs-overview-body .gfs-num-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.guidedRun.run.rawScores[btn.dataset.tid] = Number(btn.dataset.val);
      renderOverviewBody();
    });
  });
  document.querySelectorAll("#gfs-overview-body .gfs-choice-btn").forEach((btn) => {
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

// ---- Saved runs / analysis ----
async function loadRuns() {
  state.runs = (await dbGetAll("runs")).sort((a, b) => a.order - b.order);
  renderRuns();
}

function renderRuns() {
  const list = document.getElementById("run-list");
  const stats = document.getElementById("run-stats");
  list.innerHTML = "";
  const completed = state.runs.filter((r) => !r.inProgress);
  const incomplete = state.runs.filter((r) => r.inProgress);

  if (!completed.length && !incomplete.length) {
    list.innerHTML = `<p class="empty-sub">No practice runs yet. Click Start New Practice Run to begin tracking your progress.</p>`;
    stats.innerHTML = "";
    return;
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
      if (confirm(`Delete incomplete run "${run.label}"?`)) {
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
        <span>${(run.missionTimings || []).length} missions run</span>
      </div>
      <div class="run-card-actions">
        <button class="btn btn-ghost" data-act="view">View breakdown</button>
        <button class="btn btn-danger" data-act="del">Delete</button>
      </div>
    `;
    card.querySelector('[data-act="view"]').addEventListener("click", () => viewRunBreakdown(run));
    card.querySelector('[data-act="del"]').addEventListener("click", async () => {
      if (confirm(`Delete "${run.label}"?`)) {
        await snapshotBeforeDelete(`Before deleting run "${run.label}"`);
        await dbDelete("runs", run.id);
        await loadRuns();
      }
    });
    list.appendChild(card);
  });
}

function viewRunBreakdown(run) {
  const rows = (run.missionTimings || []).map((mt) => {
    const mission = state.missions.find((m) => m.id === mt.missionId);
    const score = mission ? missionScoreForRun(mission, run) : 0;
    const max = mission ? missionMaxPoints(mission) : 0;
    return `<tr><td>${esc(mt.missionName)}</td><td>${score}/${max}</td><td>${fmtDuration(mt.durationMs)}</td></tr>`;
  }).join("");
  const transRows = (run.transitionTimings || []).map((tt, i) => `<tr><td colspan="2">Transition ${i + 1}</td><td>${fmtDuration(tt.durationMs)}</td></tr>`).join("");
  openModal(`
    <h2>${esc(run.label)}</h2>
    <p class="empty-sub">${esc(run.date || "")}</p>
    <div class="run-total-bar"><span class="rt-label">Total score</span><span class="rt-num">${runTotal(run, state.missions)} / ${runMaxPoints(state.missions)}</span></div>
    <div class="run-total-bar"><span class="rt-label">Total time</span><span class="rt-num">${fmtDuration(run.totalTimeMs || 0)}</span></div>
    <table class="run-summary-table"><thead><tr><th>Mission</th><th>Score</th><th>Time</th></tr></thead><tbody>${rows}${transRows}</tbody></table>
    <div class="modal-actions"><button class="btn btn-ghost btn-full" id="m-close">Close</button></div>
  `);
  document.getElementById("m-close").addEventListener("click", closeModal);
}

// ---- Scoresheet-style CSV export ----
function parseLeadingMissionNumber(name, fallback) {
  const m = /^M?\s*0*([0-9]+)/i.exec(String(name || "").trim());
  return m ? Number(m[1]) : fallback;
}

function buildScoresheetCSV(runs) {
  const taskRows = [];
  state.missions.forEach((mission, mIdx) => {
    const mNum = parseLeadingMissionNumber(mission.name, mIdx + 1);
    (mission.tasks || []).forEach((task) => taskRows.push({ mission, task, mNum }));
  });

  const header = ["M#", "Official Name", "Notes", "Pts", ...runs.map((r) => r.label), "Success Rate", "", "Run #", "Score"];
  const lines = [header.map(csvEscape).join(",")];

  taskRows.forEach((row, i) => {
    const { mission, task, mNum } = row;
    const flags = runs.map((r) => (isTaskComplete(task, r.rawScores || {}) ? "1" : ""));
    const successCount = flags.filter((f) => f === "1").length;
    const successRate = runs.length ? Math.round((successCount / runs.length) * 100) : 0;
    const sideTable = i < runs.length ? [String(i + 1), String(runTotal(runs[i], state.missions))] : ["", ""];
    const rowVals = [mNum, mission.name, task.name, taskMaxPoints(task), ...flags, `${successRate}%`, "", ...sideTable];
    lines.push(rowVals.map(csvEscape).join(","));
  });

  return lines.join("\n");
}

document.getElementById("btn-export-runs-csv").addEventListener("click", () => {
  const completedRuns = state.runs.filter((r) => !r.inProgress).sort((a, b) => a.order - b.order);
  if (!completedRuns.length) { alert("No completed runs yet."); return; }
  openModal(`
    <h2>Export scoresheet CSV</h2>
    <p class="empty-sub">Choose which runs to include — each becomes one column, one row per scoring task.</p>
    <div class="field" id="export-run-checks">
      ${completedRuns.map((r) => `<label class="checkbox-row"><input type="checkbox" value="${r.id}" checked> ${esc(r.label)} <span class="entry-att-tag">${esc(r.date || "")}</span></label>`).join("")}
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="m-cancel" type="button">Cancel</button>
      <button class="btn btn-primary" id="m-export" type="button">Export</button>
    </div>
  `);
  document.getElementById("m-cancel").addEventListener("click", closeModal);
  document.getElementById("m-export").addEventListener("click", () => {
    const checked = new Set(Array.from(document.querySelectorAll("#export-run-checks input:checked")).map((el) => Number(el.value)));
    if (!checked.size) { alert("Pick at least one run."); return; }
    const runs = completedRuns.filter((r) => checked.has(r.id));
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
  };
  download(`barp-backup-${Date.now()}.json`, JSON.stringify(data, null, 2), "application/json");
});

document.getElementById("btn-import-backup").addEventListener("click", () => document.getElementById("file-import-backup").click());
document.getElementById("btn-restore-shadow").addEventListener("click", () => restoreFromShadowBackup());
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
    await dbClear("attachments"); await dbClear("entries"); await dbClear("missions"); await dbClear("runs"); await dbClear("meta");
    for (const a of data.attachments || []) await dbPut("attachments", a);
    for (const en of data.entries || []) await dbPut("entries", en);
    for (const m of data.missions || []) await dbPut("missions", m);
    for (const r of data.runs || []) await dbPut("runs", r);
    for (const meta of data.meta || []) await dbPut("meta", meta);
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

// ---------- Match settings ----------
const precisionTokensInput = document.getElementById("input-precision-tokens");
precisionTokensInput.addEventListener("change", async () => {
  const val = Math.max(0, Number(precisionTokensInput.value) || 0);
  precisionTokensInput.value = val;
  await dbPut("meta", { key: "precisionTokensDefault", value: val });
});
async function loadPrecisionTokensSetting() {
  precisionTokensInput.value = await getPrecisionTokensDefault();
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
  await loadRuns();
  await loadSeasonName();
  await loadPrecisionTokensSetting();
  await renderLastBackupTime();
  await renderDeletionSnapshots();
  document.getElementById("log-empty-state").hidden = state.attachments.length === 0 ? false : true;
}
initAll();
