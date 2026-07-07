/* BARP — Build App for Robot Progress. vanilla JS, IndexedDB-backed, offline-first PWA. */

// ---------- Service worker ----------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

// ---------- IndexedDB helper ----------
const DB_NAME = "fll-logbook";
const DB_VERSION = 2;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
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
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeNames, mode) {
  return openDB().then((db) => db.transaction(storeNames, mode));
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGetAll(store) {
  const t = await tx([store], "readonly");
  return reqToPromise(t.objectStore(store).getAll());
}
async function dbGet(store, key) {
  const t = await tx([store], "readonly");
  return reqToPromise(t.objectStore(store).get(key));
}
async function dbPut(store, value) {
  const t = await tx([store], "readwrite");
  const result = await reqToPromise(t.objectStore(store).put(value));
  return result;
}
async function dbDelete(store, key) {
  const t = await tx([store], "readwrite");
  return reqToPromise(t.objectStore(store).delete(key));
}
async function dbGetByIndex(store, indexName, value) {
  const t = await tx([store], "readonly");
  return reqToPromise(t.objectStore(store).index(indexName).getAll(value));
}
async function dbClear(store) {
  const t = await tx([store], "readwrite");
  return reqToPromise(t.objectStore(store).clear());
}

// ---------- App state ----------
const state = {
  view: "view-log",
  attachments: [],
  activeAttachmentId: null,
  entries: [],
  missions: [],
  runs: [],
};

// ---------- Modal helpers ----------
const modalBackdrop = document.getElementById("modal-backdrop");
const modalBox = document.getElementById("modal-box");

function openModal(html) {
  modalBox.innerHTML = html;
  modalBackdrop.hidden = false;
}
function closeModal() {
  modalBackdrop.hidden = true;
  modalBox.innerHTML = "";
}
modalBackdrop.addEventListener("click", (e) => {
  if (e.target === modalBackdrop) closeModal();
});

// ---------- Tab navigation ----------
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".view").forEach((v) => (v.hidden = true));
    btn.classList.add("active");
    document.getElementById(btn.dataset.view).hidden = false;
    state.view = btn.dataset.view;
  });
});

// ---------- Utility ----------
function esc(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
function fmtDate(ts) {
  const d = new Date(ts);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
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
  // Minimal CSV parser supporting quoted fields.
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else field += c;
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

// ---------- Mission scoring math ----------
function missionMaxPoints(m) {
  if (m.type === "bool") return m.points || 0;
  if (m.type === "number") return (m.max || 0) * (m.pointsPerUnit || 1);
  if (m.type === "choice") return (m.options || []).reduce((mx, o) => Math.max(mx, o.points || 0), 0);
  return 0;
}
function pointsFromRaw(m, raw) {
  if (m.type === "bool") return raw ? (m.points || 0) : 0;
  if (m.type === "number") return (Number(raw) || 0) * (m.pointsPerUnit || 1);
  if (m.type === "choice") {
    if (raw === null || raw === undefined || raw === "") return 0;
    const opt = (m.options || [])[raw];
    return opt ? (opt.points || 0) : 0;
  }
  return 0;
}
function runTotal(run, missions) {
  return missions.reduce((sum, m) => sum + pointsFromRaw(m, (run.rawScores || {})[m.id]), 0);
}
function runSuccessRate(run, missions) {
  if (!missions.length) return 0;
  const successes = missions.filter((m) => {
    const max = missionMaxPoints(m);
    return max > 0 && pointsFromRaw(m, (run.rawScores || {})[m.id]) === max;
  }).length;
  return (successes / missions.length) * 100;
}

// ==========================================================
// ATTACHMENTS + LOG
// ==========================================================
async function loadAttachments() {
  state.attachments = (await dbGetAll("attachments")).sort((a, b) => (a.order ?? a.number ?? 0) - (b.order ?? b.number ?? 0));
  renderSettingsAttachments();
  renderAttachmentChips();
}

function renderSettingsAttachments() {
  const wrap = document.getElementById("settings-attachment-list");
  if (!wrap) return;
  wrap.innerHTML = "";
  state.attachments.forEach((att, i) => {
    const row = document.createElement("div");
    row.className = "mission-card";
    const changes = (state.entries || []).filter(e => e.attachmentId === att.id).length;
    row.innerHTML = `<b>#${esc(att.number)} ${esc(att.name)}</b><div class="empty-sub">${changes} improvement iteration${changes === 1 ? "" : "s"}</div>
      <div class="btn-group">
      <button class="btn-icon" data-up="1">↑</button>
      <button class="btn-icon" data-down="1">↓</button>
      </div>`;
    row.querySelector("[data-up]").onclick = () => moveAttachment(att, -1);
    row.querySelector("[data-down]").onclick = () => moveAttachment(att, 1);
    wrap.appendChild(row);
  });
}
async function moveAttachment(att, delta) {
  const arr = state.attachments;
  const i = arr.findIndex(a => a.id === att.id);
  const j = i + delta;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  for (let k=0;k<arr.length;k++) { arr[k].order=k; await dbPut("attachments", arr[k]); }
  await loadAttachments();
}
function renderAttachmentChips() {
  const wrap = document.getElementById("attachment-chips");
  wrap.innerHTML = "";
  state.attachments.forEach((att) => {
    const chip = document.createElement("button");
    chip.className = "chip" + (att.id === state.activeAttachmentId ? " active" : "");
    chip.innerHTML = `<span class="chip-num">#${esc(att.number)}</span>${esc(att.name)}`;
    chip.addEventListener("click", () => selectAttachment(att.id));
    wrap.appendChild(chip);
  });
  if (!state.attachments.length) {
    document.getElementById("log-empty-state").hidden = false;
    document.getElementById("log-active").hidden = true;
  }
}

async function selectAttachment(id) {
  state.activeAttachmentId = id;
  renderAttachmentChips();
  const att = state.attachments.find((a) => a.id === id);
  document.getElementById("log-empty-state").hidden = true;
  document.getElementById("log-active").hidden = false;
  document.getElementById("active-attachment-name").textContent = `#${att.number} ${att.name}`;
  await loadEntries(id);
}

async function loadEntries(attachmentId) {
  const entries = await dbGetByIndex("entries", "byAttachment", attachmentId);
  state.entries = entries.sort((a, b) => b.timestamp - a.timestamp);
  renderEntries();
}

function renderEntries() {
  const list = document.getElementById("entry-list");
  list.innerHTML = "";
  if (!state.entries.length) {
    list.innerHTML = `<p class="empty-sub">No changes logged yet for this attachment.</p>`;
    return;
  }
  state.entries.forEach((entry) => {
    const card = document.createElement("div");
    card.className = "entry-card";
    card.innerHTML = `
      ${entry.photo ? `<img src="${entry.photo}" alt="">` : ""}
      <div class="entry-body">
        <div class="entry-time">${fmtDate(entry.timestamp)}</div>
        <div class="entry-notes">${esc(entry.notes) || "<em>No notes</em>"}</div>
        <div class="entry-actions">
          <button class="btn-icon" data-id="${entry.id}" title="Delete">&#128465;&#65039;</button>
        </div>
      </div>`;
    card.querySelector(".btn-icon").addEventListener("click", async () => {
      if (confirm("Delete this log entry?")) {
        await dbDelete("entries", entry.id);
        await loadEntries(state.activeAttachmentId);
      }
    });
    list.appendChild(card);
  });
}

document.getElementById("btn-add-attachment").addEventListener("click", () => {
  const nextNum = state.attachments.length
    ? Math.max(...state.attachments.map((a) => Number(a.number) || 0)) + 1
    : 1;
  openModal(`
    <h2>New attachment</h2>
    <div class="field"><label>Number</label><input class="text-input" id="m-att-number" type="text" value="${nextNum}"></div>
    <div class="field"><label>Name</label><input class="text-input" id="m-att-name" type="text" placeholder="e.g. Coral claw" autofocus></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="m-cancel">Cancel</button>
      <button class="btn btn-primary" id="m-save">Save</button>
    </div>
  `);
  document.getElementById("m-cancel").addEventListener("click", closeModal);
  document.getElementById("m-save").addEventListener("click", async () => {
    const number = document.getElementById("m-att-number").value.trim();
    const name = document.getElementById("m-att-name").value.trim();
    if (!name) { alert("Give this attachment a name."); return; }
    const id = await dbPut("attachments", { number, name, order: state.attachments.length, createdAt: Date.now() });
    closeModal();
    await loadAttachments();
    selectAttachment(id);
  });
});

// Edit / delete active attachment — small controls injected next to its name
document.getElementById("btn-add-entry").addEventListener("click", () => openEntryModal());

function attachAttachmentManageRow() {
  const row = document.querySelector("#log-active .section-row");
  if (row.querySelector(".attach-manage")) return;
  const heading = document.getElementById("active-attachment-name");
  const manage = document.createElement("span");
  manage.className = "attach-manage btn-group";
  manage.innerHTML = `<button class="btn-icon" id="btn-edit-attachment" title="Edit">&#9998;&#65039;</button>
                       <button class="btn-icon" id="btn-delete-attachment" title="Delete">&#128465;&#65039;</button>`;
  heading.insertAdjacentElement("afterend", manage);
}
const logActiveObserver = new MutationObserver(() => attachAttachmentManageRow());
logActiveObserver.observe(document.getElementById("log-active"), { attributes: true });

document.addEventListener("click", async (e) => {
  if (e.target.id === "btn-edit-attachment") {
    const att = state.attachments.find((a) => a.id === state.activeAttachmentId);
    openModal(`
      <h2>Edit attachment</h2>
      <div class="field"><label>Number</label><input class="text-input" id="m-att-number" value="${esc(att.number)}"></div>
      <div class="field"><label>Name</label><input class="text-input" id="m-att-name" value="${esc(att.name)}"></div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="m-cancel">Cancel</button>
        <button class="btn btn-primary" id="m-save">Save</button>
      </div>`);
    document.getElementById("m-cancel").addEventListener("click", closeModal);
    document.getElementById("m-save").addEventListener("click", async () => {
      att.number = document.getElementById("m-att-number").value.trim();
      att.name = document.getElementById("m-att-name").value.trim();
      await dbPut("attachments", att);
      closeModal();
      await loadAttachments();
      selectAttachment(att.id);
    });
  }
  if (e.target.id === "btn-delete-attachment") {
    if (confirm("Delete this attachment and all its logged entries?")) {
      const entries = await dbGetByIndex("entries", "byAttachment", state.activeAttachmentId);
      for (const en of entries) await dbDelete("entries", en.id);
      await dbDelete("attachments", state.activeAttachmentId);
      state.activeAttachmentId = null;
      document.getElementById("log-active").hidden = true;
      document.getElementById("log-empty-state").hidden = false;
      await loadAttachments();
    }
  }
});

// ---- Entry modal (photo + notes + voice-to-text) ----
let pendingPhoto = null;
let recognizer = null;

function openEntryModal() {
  pendingPhoto = null;
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  openModal(`
    <h2>Log a change</h2>
    <div class="field">
      <label>Photo</label>
      <div class="photo-preview-wrap" id="photo-preview-wrap"></div>
      <input type="file" accept="image/*" capture="environment" id="m-entry-photo">
    </div>
    <div class="field">
      <label>Date changed</label>
      <input class="text-input" id="m-entry-date" value="${new Date().toISOString().slice(0,10)}" readonly>
    </div>
    <div class="field">
      <label>What changed?</label>
      <textarea class="textarea-input" id="m-entry-change" placeholder="Describe the attachment improvement or test change"></textarea>
    </div>
    <div class="field">
      <label>Why changed?</label>
      <textarea class="textarea-input" id="m-entry-why" placeholder="Why did you make this change?"></textarea>
    </div>
    <div class="field">
      <label>Notes</label>
      ${SpeechRec ? `<div class="voice-row">
        <button class="btn btn-ghost" id="m-voice-btn" type="button">&#127908; Voice note</button>
        <span class="voice-status" id="m-voice-status"></span>
      </div>` : `<p class="type-hint">Voice-to-text isn't supported in this browser — try Chrome on Android.</p>`}
      <textarea class="textarea-input" id="m-entry-notes" placeholder="What did you change and why?"></textarea>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="m-cancel">Cancel</button>
      <button class="btn btn-primary" id="m-save">Save entry</button>
    </div>
  `);
  document.getElementById("m-cancel").addEventListener("click", () => { stopRecognizer(); closeModal(); });

  document.getElementById("m-entry-photo").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    pendingPhoto = await resizeImageToDataURL(file, 900, 0.72);
    const wrap = document.getElementById("photo-preview-wrap");
    wrap.innerHTML = `<img class="photo-preview" src="${pendingPhoto}">`;
  });

  if (SpeechRec) {
    document.getElementById("m-voice-btn").addEventListener("click", () => toggleVoiceNote(SpeechRec));
  }

  document.getElementById("m-save").addEventListener("click", async () => {
    stopRecognizer();
    const notes = document.getElementById("m-entry-notes").value.trim();
    const change = document.getElementById("m-entry-change").value.trim();
    const why = document.getElementById("m-entry-why").value.trim();
    if (!notes && !pendingPhoto && !change) { alert("Add a change description, photo, or notes first."); return; }
    await dbPut("entries", {
      attachmentId: state.activeAttachmentId,
      timestamp: Date.now(),
      dateChanged: document.getElementById("m-entry-date").value,
      change,
      why,
      photo: pendingPhoto,
      notes,
    });
    closeModal();
    await loadEntries(state.activeAttachmentId);
  });
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

function toggleVoiceNote(SpeechRec) {
  const statusEl = document.getElementById("m-voice-status");
  const btn = document.getElementById("m-voice-btn");
  if (recognizer) { stopRecognizer(); return; }
  recognizer = new SpeechRec();
  recognizer.lang = "en-US";
  recognizer.continuous = true;
  recognizer.interimResults = false;
  recognizer.onstart = () => { statusEl.textContent = "listening…"; statusEl.classList.add("listening"); btn.textContent = "⏹ Stop"; };
  recognizer.onerror = () => { statusEl.textContent = "mic error — try again"; };
  recognizer.onend = () => { statusEl.classList.remove("listening"); statusEl.textContent = "stopped"; btn.textContent = "🎙 Voice note"; recognizer = null; };
  recognizer.onresult = (event) => {
    let transcript = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) transcript += event.results[i][0].transcript + " ";
    }
    if (transcript) {
      const ta = document.getElementById("m-entry-notes");
      ta.value = (ta.value ? ta.value + " " : "") + transcript.trim();
    }
  };
  recognizer.start();
}
function stopRecognizer() {
  if (recognizer) { try { recognizer.stop(); } catch (e) {} recognizer = null; }
}

// ==========================================================
// MISSIONS (Setup tab)
// ==========================================================
async function loadMissions() {
  state.missions = (await dbGetAll("missions")).sort((a, b) => a.order - b.order);
  renderMissions();
}

function renderMissions() {
  const list = document.getElementById("mission-list");
  list.innerHTML = "";
  if (!state.missions.length) {
    list.innerHTML = `<p class="empty-sub">No missions yet. Add one for each scoring row on the official scoresheet.</p>`;
    return;
  }
  state.missions.forEach((m, idx) => {
    const row = document.createElement("div");
    row.className = "mission-row";
    const detail = m.type === "bool" ? `Yes/No · ${missionMaxPoints(m)} pts`
      : m.type === "number" ? `Count 0–${m.max} · ${m.pointsPerUnit} pt/each · max ${missionMaxPoints(m)}`
      : `Multi-state · max ${missionMaxPoints(m)} pts`;
    const sub = (m.tasks?.length ? `${m.tasks.length} tasks · ` : "") + detail;
    row.innerHTML = `
      <div class="m-order">
        <button data-dir="up" ${idx === 0 ? "disabled" : ""}>&#9650;</button>
        <button data-dir="down" ${idx === state.missions.length - 1 ? "disabled" : ""}>&#9660;</button>
      </div>
      <div class="m-info">
        <div class="m-name">${esc(m.name)}</div>
        <div class="m-sub">${sub}</div>
      </div>
      <button class="btn-icon" data-act="edit">&#9998;&#65039;</button>
      <button class="btn-icon" data-act="del">&#128465;&#65039;</button>
    `;
    row.querySelector('[data-dir="up"]').addEventListener("click", () => reorderMission(idx, -1));
    row.querySelector('[data-dir="down"]').addEventListener("click", () => reorderMission(idx, 1));
    row.querySelector('[data-act="edit"]').addEventListener("click", () => openMissionModal(m));
    row.querySelector('[data-act="del"]').addEventListener("click", async () => {
      if (confirm(`Delete mission "${m.name}"?`)) { await dbDelete("missions", m.id); await loadMissions(); }
    });
    list.appendChild(row);
  });
}

async function reorderMission(idx, dir) {
  const other = idx + dir;
  if (other < 0 || other >= state.missions.length) return;
  const a = state.missions[idx], b = state.missions[other];
  const tmp = a.order; a.order = b.order; b.order = tmp;
  await dbPut("missions", a); await dbPut("missions", b);
  await loadMissions();
}

document.getElementById("btn-add-mission").addEventListener("click", () => openMissionModal(null));

function optionRowHtml(label = "", points = 0) {
  return `<div class="option-row">
    <input class="text-input" placeholder="Option label" value="${esc(label)}" data-f="label">
    <input type="number" placeholder="pts" value="${points}" data-f="points">
    <button class="btn-icon" data-act="rm-option">&#10005;</button>
  </div>`;
}

function openMissionModal(m) {
  const isEdit = !!m;
  const type = m?.type || "bool";
  openModal(`
    <h2>${isEdit ? "Edit mission" : "New mission"}</h2>
    <div class="field"><label>Mission name</label><input class="text-input" id="m-name" value="${isEdit ? esc(m.name) : ""}" placeholder="e.g. M07 — Coral nursery" autofocus></div>
    <div class="field"><label>Scoring type</label>
      <select class="text-input" id="m-type">
        <option value="bool" ${type === "bool" ? "selected" : ""}>Yes / No</option>
        <option value="number" ${type === "number" ? "selected" : ""}>Counted objects</option>
        <option value="choice" ${type === "choice" ? "selected" : ""}>Multiple states</option>
      </select>
    </div>
    <div class="field"><label>Mission tasks (optional)</label><textarea class="textarea-input" id="m-tasks" placeholder="One task per line"></textarea></div>
    <div id="m-type-fields"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="m-cancel">Cancel</button>
      <button class="btn btn-primary" id="m-save">Save</button>
    </div>
  `);

  document.getElementById("m-tasks").value = isEdit && m.tasks ? m.tasks.join("\n") : "";

  function renderTypeFields() {
    const t = document.getElementById("m-type").value;
    const box = document.getElementById("m-type-fields");
    if (t === "bool") {
      box.innerHTML = `<div class="field"><label>Points when achieved</label><input type="number" class="text-input" id="m-bool-points" value="${isEdit && m.type === "bool" ? m.points : 20}"></div>`;
    } else if (t === "number") {
      box.innerHTML = `
        <div class="field"><label>Max count</label><input type="number" class="text-input" id="m-num-max" value="${isEdit && m.type === "number" ? m.max : 5}"></div>
        <div class="field"><label>Points per unit</label><input type="number" class="text-input" id="m-num-ppu" value="${isEdit && m.type === "number" ? m.pointsPerUnit : 10}"></div>`;
    } else {
      const opts = (isEdit && m.type === "choice" && m.options.length) ? m.options : [{ label: "Partial", points: 10 }, { label: "Full", points: 20 }];
      box.innerHTML = `<div class="field"><label>States (in addition to "not achieved" = 0 pts)</label>
        <div class="options-editor" id="m-options">${opts.map((o) => optionRowHtml(o.label, o.points)).join("")}</div>
        <button class="btn btn-ghost" id="m-add-option" type="button" style="margin-top:8px;">+ Add state</button>
      </div>`;
      document.getElementById("m-add-option").addEventListener("click", () => {
        document.getElementById("m-options").insertAdjacentHTML("beforeend", optionRowHtml("", 0));
        bindOptionRemovers();
      });
      bindOptionRemovers();
    }
  }
  function bindOptionRemovers() {
    document.querySelectorAll('[data-act="rm-option"]').forEach((btn) => {
      btn.onclick = () => btn.closest(".option-row").remove();
    });
  }

  renderTypeFields();
  document.getElementById("m-type").addEventListener("change", renderTypeFields);
  document.getElementById("m-cancel").addEventListener("click", closeModal);
  document.getElementById("m-save").addEventListener("click", async () => {
    const name = document.getElementById("m-name").value.trim();
    if (!name) { alert("Name this mission."); return; }
    const t = document.getElementById("m-type").value;
    const record = isEdit ? m : { order: state.missions.length };
    record.name = name;
    record.type = t;
    record.tasks = document.getElementById("m-tasks").value.split("\n").map(x => x.trim()).filter(Boolean);
    if (t === "bool") {
      record.points = Number(document.getElementById("m-bool-points").value) || 0;
      delete record.max; delete record.pointsPerUnit; delete record.options;
    } else if (t === "number") {
      record.max = Number(document.getElementById("m-num-max").value) || 0;
      record.pointsPerUnit = Number(document.getElementById("m-num-ppu").value) || 0;
      delete record.points; delete record.options;
    } else {
      const rows = document.querySelectorAll("#m-options .option-row");
      record.options = Array.from(rows).map((r) => ({
        label: r.querySelector('[data-f="label"]').value.trim() || "State",
        points: Number(r.querySelector('[data-f="points"]').value) || 0,
      }));
      delete record.points; delete record.max; delete record.pointsPerUnit;
    }
    await dbPut("missions", record);
    closeModal();
    await loadMissions();
    await loadRuns();
  });
}

// ==========================================================
// RUNS
// ==========================================================
async function loadRuns() {
  state.runs = (await dbGetAll("runs")).sort((a, b) => a.order - b.order);
  renderRuns();
}

function renderRuns() {
  const list = document.getElementById("run-list");
  const stats = document.getElementById("run-stats");
  list.innerHTML = "";
  if (!state.runs.length) {
    list.innerHTML = `<p class="empty-sub">No runs yet. Start a practice run to record scores, timing, and improvements.</p>`;
    stats.innerHTML = "";
    return;
  }
  const totals = state.runs.map((r) => runTotal(r, state.missions));
  const rates = state.runs.map((r) => runSuccessRate(r, state.missions));
  const avg = (arr) => (arr.reduce((a, b) => a + b, 0) / arr.length);
  stats.innerHTML = `
    <div class="stat-box"><span class="stat-num">${state.runs.length}</span><span class="stat-label">Runs</span></div>
    <div class="stat-box"><span class="stat-num">${Math.max(...totals)}</span><span class="stat-label">Best score</span></div>
    <div class="stat-box"><span class="stat-num">${avg(totals).toFixed(1)}</span><span class="stat-label">Avg score</span></div>
    <div class="stat-box"><span class="stat-num">${avg(rates).toFixed(0)}%</span><span class="stat-label">Avg success</span></div>
  `;
  state.runs.forEach((run) => {
    const total = runTotal(run, state.missions);
    const rate = runSuccessRate(run, state.missions);
    const card = document.createElement("div");
    card.className = "run-card";
    card.innerHTML = `
      <div class="run-card-head">
        <div>
          <div class="run-title">${esc(run.label)}</div>
          <div class="run-date">${run.date ? esc(run.date) : "no date set"}</div>
        </div>
        <div class="run-stamp"><span class="rs-score">${total}</span><span class="rs-label">points</span></div>
      </div>
      <div class="run-meta-row">
        <span>${rate.toFixed(0)}% mission success</span>
        <span>${state.missions.length} missions</span>
      </div>
      <div class="run-card-actions">
        <button class="btn btn-primary" data-act="score">Start scoring run</button>
        <button class="btn btn-ghost" data-act="edit">Edit</button>
        <button class="btn btn-danger" data-act="del">Delete</button>
      </div>
    `;
    card.querySelector('[data-act="score"]').addEventListener("click", () => openRunScoringModal(run));
    card.querySelector('[data-act="edit"]').addEventListener("click", () => openRunEditModal(run));
    card.querySelector('[data-act="del"]').addEventListener("click", async () => {
      if (confirm(`Delete "${run.label}"?`)) { await dbDelete("runs", run.id); await loadRuns(); }
    });
    list.appendChild(card);
  });
}

document.getElementById("btn-add-run").addEventListener("click", () => openRunEditModal(null));

function openRunEditModal(run) {
  const isEdit = !!run;
  openModal(`
    <h2>${isEdit ? "Edit run" : "New run"}</h2>
    <div class="field"><label>Run name</label><input class="text-input" id="r-label" value="${isEdit ? esc(run.label) : `Run ${state.runs.length + 1}`}" autofocus></div>
    <div class="field"><label>Date / round (optional)</label><input class="text-input" id="r-date" value="${isEdit ? esc(run.date || "") : ""}" placeholder="e.g. Qualifier 1"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="m-cancel">Cancel</button>
      <button class="btn btn-primary" id="m-save">Save</button>
    </div>
  `);
  document.getElementById("m-cancel").addEventListener("click", closeModal);
  document.getElementById("m-save").addEventListener("click", async () => {
    const label = document.getElementById("r-label").value.trim();
    if (!label) { alert("Name this run."); return; }
    const date = document.getElementById("r-date").value.trim();
    const record = isEdit ? run : { order: state.runs.length, rawScores: {}, notes: "" };
    record.label = label; record.date = date;
    await dbPut("runs", record);
    closeModal();
    await loadRuns();
  });
}

function openRunScoringModal(run) {
  if (!state.missions.length) { alert("Add missions in Setup first."); return; }
  let index = 0;
  const raw = { ...(run.rawScores || {}) };
  const startTime = Date.now();
  const answers = [];
  function render() {
    const m = state.missions[index];
    openModal(`
      <h2>${esc(run.label)}</h2>
      <p class="empty-sub">Mission ${index+1}/${state.missions.length}</p>
      <h3>${esc(m.name)}</h3>
      <div class="field"><label>Result</label><p class="empty-sub">${m.type==='bool'?'Tap YES if completed, NO if not.':m.type==='number'?'Enter the completed amount.':'Choose the completed state.'}</p></div>
      <div class="score-control-area" id="wizard-control"></div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="m-cancel">Cancel</button>
        <button class="btn btn-primary" id="m-next">${index===state.missions.length-1?'Finish':'Next mission'}</button>
      </div>`);
    const box=document.getElementById('wizard-control');
    if(m.type==='bool') box.innerHTML='<button class="btn btn-primary" id="yes">Yes completed</button> <button class="btn btn-ghost" id="no">No</button>';
    else if(m.type==='number') box.innerHTML=`<input class="text-input" id="num" type="number" min="0" max="${m.max}" value="0">`;
    else box.innerHTML=`<select class="text-input" id="choice"><option value="">Not achieved</option>${m.options.map((o,i)=>`<option value="${i}">${esc(o.label)}</option>`).join('')}</select>`;
    document.getElementById('m-cancel').onclick=closeModal;
    document.getElementById('m-next').onclick=async()=>{
      if(m.type==='bool') raw[m.id]=document.getElementById('yes').dataset.on==='1';
      if(m.type==='number') raw[m.id]=Number(document.getElementById('num').value)||0;
      if(m.type==='choice') raw[m.id]=document.getElementById('choice').value===''?null:Number(document.getElementById('choice').value);
      if(index===state.missions.length-1){
        const runTime=Date.now()-startTime;
        run.rawScores=raw; run.timeMs=runTime; run.completedAt=Date.now();
        await dbPut('runs',run); closeModal(); await loadRuns();
      } else { index++; render(); }
    };
  }
  render();
}

// ---- Export runs CSV ----
document.getElementById("btn-export-runs").addEventListener("click", () => {
  if (!state.runs.length) { alert("No runs to export yet."); return; }
  const header = ["Run", "Date/Round", ...state.missions.map((m) => m.name), "Total Score", "Missions Successful", "Success Rate %", "Notes"];
  const lines = [header.map(csvEscape).join(",")];
  state.runs.forEach((run) => {
    const successes = state.missions.filter((m) => {
      const max = missionMaxPoints(m);
      return max > 0 && pointsFromRaw(m, (run.rawScores || {})[m.id]) === max;
    }).length;
    const row = [
      run.label,
      run.date || "",
      ...state.missions.map((m) => pointsFromRaw(m, (run.rawScores || {})[m.id])),
      runTotal(run, state.missions),
      `${successes}/${state.missions.length}`,
      runSuccessRate(run, state.missions).toFixed(1),
      run.notes || "",
    ];
    lines.push(row.map(csvEscape).join(","));
  });
  const totals = state.runs.map((r) => runTotal(r, state.missions));
  const rates = state.runs.map((r) => runSuccessRate(r, state.missions));
  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  lines.push("");
  lines.push(["Average", "", ...state.missions.map(() => ""), avg(totals).toFixed(1), "", avg(rates).toFixed(1), ""].map(csvEscape).join(","));
  download(`fll-runs-${Date.now()}.csv`, lines.join("\n"), "text/csv");
});

// ---- Import run order template CSV ----
document.getElementById("btn-example-csv")?.addEventListener("click", () => {
  download("example-run-order.csv", "Run,Date/Practice\\nPractice 1,Test\\nPractice 2,Test\\nPractice 3,Test", "text/csv");
});

document.getElementById("btn-import-runs").addEventListener("click", () => {
  document.getElementById("file-import-runs").click();
});
document.getElementById("file-import-runs").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const text = await file.text();
  const rows = parseCSV(text);
  if (!rows.length) { alert("That file looks empty."); return; }
  let header = rows[0].map((h) => h.trim().toLowerCase());
  let runIdx = header.findIndex((h) => h === "run" || h === "run name" || h === "runname");
  let dateIdx = header.findIndex((h) => h === "date" || h === "date/round" || h === "round");
  let dataRows = rows.slice(1);
  if (runIdx === -1) {
    // No recognizable header — treat every row's first column as the run name.
    runIdx = 0; dateIdx = -1; dataRows = rows;
  }
  let order = state.runs.length;
  let added = 0;
  for (const r of dataRows) {
    const label = (r[runIdx] || "").trim();
    if (!label) continue;
    await dbPut("runs", { order: order++, label, date: dateIdx >= 0 ? (r[dateIdx] || "").trim() : "", rawScores: {}, notes: "" });
    added++;
  }
  await loadRuns();
  alert(`Imported ${added} run${added === 1 ? "" : "s"}.`);
});

// ==========================================================
// BACKUP
// ==========================================================
document.getElementById("btn-export-backup").addEventListener("click", async () => {
  const data = {
    version: 1,
    exportedAt: Date.now(),
    attachments: await dbGetAll("attachments"),
    entries: await dbGetAll("entries"),
    missions: await dbGetAll("missions"),
    runs: await dbGetAll("runs"),
    meta: await dbGetAll("meta"),
  };
  download(`fll-logbook-backup-${Date.now()}.json`, JSON.stringify(data, null, 2), "application/json");
});

document.getElementById("btn-import-backup").addEventListener("click", () => {
  document.getElementById("file-import-backup").click();
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
  if (rec?.value) {
    seasonInput.value = rec.value;
    document.getElementById("season-title").textContent = rec.value;
  }
}

// ---------- Init ----------
async function initAll() {
  await loadAttachments();
  await loadMissions();
  await loadRuns();
  await loadSeasonName();
  state.activeAttachmentId = null;
  document.getElementById("log-active").hidden = true;
  document.getElementById("log-empty-state").hidden = state.attachments.length > 0;
  if (state.attachments.length) {
    document.getElementById("log-empty-state").hidden = true;
  }
}
initAll();
