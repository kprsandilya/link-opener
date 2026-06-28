/**
 * settings.js
 * -----------------------------------------------------------------------------
 * Logic for the full-page Settings surface (settings.html).
 *
 * Design:
 *  - Controls declare which setting they bind to via `data-setting="a.b.c"`.
 *    A small generic layer reads/writes those dotted paths, so adding a new
 *    preference is usually just markup + a default in settings-store.js.
 *  - A working copy is edited live; interface-affecting changes preview
 *    instantly, while persistence happens on "Save changes" (with a clearly
 *    indicated unsaved state) or can be discarded.
 *  - Sidebar navigation, scroll-spy, and fuzzy-ish search keep the long list
 *    of preferences easy to traverse.
 */

import {
  loadSettings,
  saveSettings,
  defaultSettings,
  mergeSettings,
  applyInterfaceSettings,
} from "./settings-store.js";
import { loadState, saveState } from "./storage.js";
import { uid, parseUrlList, pluralize } from "./utils.js";

const api = typeof browser !== "undefined" ? browser : chrome;

/* ---------------------------------------------------------- Element handles */
const els = {
  nav: document.getElementById("nav"),
  search: document.getElementById("search"),
  scroll: document.getElementById("scroll"),
  noResults: document.getElementById("no-results"),
  contentTitle: document.getElementById("content-title"),
  contentSub: document.getElementById("content-sub"),
  saveState: document.getElementById("save-state"),
  actionStatus: document.getElementById("action-status"),
  save: document.getElementById("btn-save"),
  reset: document.getElementById("btn-reset"),
  back: document.getElementById("btn-back"),
  resetAll: document.getElementById("btn-reset-all"),
  versionTag: document.getElementById("version-tag"),
  // Backup / data actions
  exportSessions: document.getElementById("btn-export-sessions"),
  importSessions: document.getElementById("btn-import-sessions"),
  exportSettings: document.getElementById("btn-export-settings"),
  importSettings: document.getElementById("btn-import-settings"),
  // Modal
  modal: document.getElementById("modal"),
  modalTitle: document.getElementById("modal-title"),
  modalBody: document.getElementById("modal-body"),
  modalConfirm: document.getElementById("modal-confirm"),
  modalCancel: document.getElementById("modal-cancel"),
  // Misc
  toasts: document.getElementById("toasts"),
  fileInput: document.getElementById("file-input"),
};

const SECTION_META = {
  opening: {
    title: "Opening Behavior",
    sub: "Control how saved sessions are turned back into windows and tabs.",
  },
  saving: {
    title: "Saving",
    sub: "Decide what gets captured when you export your current windows.",
  },
  autosave: {
    title: "Automatic Saving",
    sub: "Let Link Opener snapshot your sessions in the background.",
  },
  backup: {
    title: "Export & Backup",
    sub: "Move your sessions and preferences in and out of the extension.",
  },
  interface: {
    title: "Interface",
    sub: "Personalize the look and feel of the popup and this page.",
  },
  power: { title: "Power User", sub: "Keyboard shortcuts and destructive actions." },
};

/** The last persisted settings + the live working copy. */
let savedSettings = defaultSettings();
let working = defaultSettings();
let pendingImportMode = null; // "sessions" | "settings"

/* ============================================================================
   DOTTED-PATH HELPERS
   ========================================================================== */

function getPath(obj, path) {
  return path.split(".").reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

function setPath(obj, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  let target = obj;
  for (const key of keys) {
    if (target[key] == null || typeof target[key] !== "object") target[key] = {};
    target = target[key];
  }
  target[last] = value;
}

/* ============================================================================
   CONTROL <-> STATE
   ========================================================================== */

/** Push every value from `settings` into the matching DOM control. */
function populateControls(settings) {
  // Checkboxes (switches + check grid)
  document
    .querySelectorAll('input[type="checkbox"][data-setting]')
    .forEach((el) => {
      el.checked = Boolean(getPath(settings, el.dataset.setting));
    });

  // Numbers
  document.querySelectorAll('input[type="number"][data-setting]').forEach((el) => {
    el.value = getPath(settings, el.dataset.setting);
  });

  // Text fields
  document
    .querySelectorAll('input[type="text"][data-setting], .text-field[data-setting]')
    .forEach((el) => {
      el.value = getPath(settings, el.dataset.setting) ?? "";
    });

  // Textareas
  document.querySelectorAll("textarea[data-setting]").forEach((el) => {
    el.value = getPath(settings, el.dataset.setting) ?? "";
  });

  // Selects
  document.querySelectorAll("select[data-setting]").forEach((el) => {
    el.value = getPath(settings, el.dataset.setting);
  });

  // Segmented controls
  document.querySelectorAll(".segmented[data-setting]").forEach((group) => {
    const value = getPath(settings, group.dataset.setting);
    group.querySelectorAll("button[data-value]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.value === value);
    });
  });

  // Shortcut recorders
  document.querySelectorAll(".shortcut[data-setting]").forEach((btn) => {
    btn.textContent = getPath(settings, btn.dataset.setting) || "Unset";
  });
}

/* ============================================================================
   DIRTY TRACKING
   ========================================================================== */

function isDirty() {
  return JSON.stringify(working) !== JSON.stringify(savedSettings);
}

function refreshDirtyUI() {
  const dirty = isDirty();
  els.save.disabled = !dirty;
  els.saveState.dataset.state = dirty ? "unsaved" : "saved";
  els.saveState.textContent = dirty ? "Unsaved changes" : "All changes saved";
  els.actionStatus.textContent = dirty
    ? "You have unsaved changes."
    : "All changes saved automatically.";
}

/** Apply a working-copy change: live-preview the interface, refresh dirty UI. */
function onWorkingChanged() {
  applyInterfaceSettings(working);
  refreshDirtyUI();
}

/* ============================================================================
   EVENT BINDING
   ========================================================================== */

function bindControls() {
  // Checkboxes
  document
    .querySelectorAll('input[type="checkbox"][data-setting]')
    .forEach((el) => {
      el.addEventListener("change", () => {
        setPath(working, el.dataset.setting, el.checked);
        onWorkingChanged();
      });
    });

  // Numbers — clamp to the input's min/max.
  document.querySelectorAll('input[type="number"][data-setting]').forEach((el) => {
    el.addEventListener("input", () => {
      let n = Number(el.value);
      if (Number.isNaN(n)) return;
      if (el.min !== "" && n < Number(el.min)) n = Number(el.min);
      if (el.max !== "" && n > Number(el.max)) n = Number(el.max);
      setPath(working, el.dataset.setting, n);
      onWorkingChanged();
    });
    el.addEventListener("blur", () => {
      el.value = getPath(working, el.dataset.setting);
    });
  });

  // Text + textarea
  document
    .querySelectorAll(
      'input[type="text"][data-setting], .text-field[data-setting], textarea[data-setting]'
    )
    .forEach((el) => {
      el.addEventListener("input", () => {
        setPath(working, el.dataset.setting, el.value);
        onWorkingChanged();
      });
    });

  // Selects
  document.querySelectorAll("select[data-setting]").forEach((el) => {
    el.addEventListener("change", () => {
      setPath(working, el.dataset.setting, el.value);
      onWorkingChanged();
    });
  });

  // Segmented
  document.querySelectorAll(".segmented[data-setting]").forEach((group) => {
    group.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-value]");
      if (!btn) return;
      setPath(working, group.dataset.setting, btn.dataset.value);
      group.querySelectorAll("button").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      onWorkingChanged();
    });
  });

  // Shortcut recorders
  document.querySelectorAll(".shortcut[data-setting]").forEach(bindShortcut);
}

/* ----------------------------------------------------- Shortcut recording -- */

let activeRecorder = null;

function bindShortcut(btn) {
  btn.addEventListener("click", () => {
    if (activeRecorder && activeRecorder !== btn) stopRecording(activeRecorder);
    if (btn.classList.contains("is-recording")) {
      stopRecording(btn);
      return;
    }
    activeRecorder = btn;
    btn.classList.add("is-recording");
    btn.textContent = "Press keys…";
  });
}

function stopRecording(btn) {
  btn.classList.remove("is-recording");
  btn.textContent = getPath(working, btn.dataset.setting) || "Unset";
  if (activeRecorder === btn) activeRecorder = null;
}

function handleRecorderKeydown(e) {
  if (!activeRecorder) return;
  e.preventDefault();
  e.stopPropagation();

  if (e.key === "Escape") {
    stopRecording(activeRecorder);
    return;
  }
  if (e.key === "Backspace" || e.key === "Delete") {
    setPath(working, activeRecorder.dataset.setting, "");
    stopRecording(activeRecorder);
    onWorkingChanged();
    return;
  }

  // Ignore lone modifier presses; wait for a real key.
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;

  const parts = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.metaKey) parts.push("Cmd");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");

  let key = e.key;
  if (key === " ") key = "Space";
  else if (key.length === 1) key = key.toUpperCase();
  parts.push(key);

  const combo = parts.join("+");
  setPath(working, activeRecorder.dataset.setting, combo);
  stopRecording(activeRecorder);
  onWorkingChanged();
}

/* ============================================================================
   NAVIGATION + SCROLL SPY
   ========================================================================== */

function setActiveSection(id) {
  els.nav.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.toggle("is-active", item.dataset.section === id);
  });
  const meta = SECTION_META[id];
  if (meta) {
    els.contentTitle.textContent = meta.title;
    els.contentSub.textContent = meta.sub;
  }
}

function bindNavigation() {
  els.nav.addEventListener("click", (e) => {
    const item = e.target.closest(".nav-item");
    if (!item) return;
    e.preventDefault();
    const section = document.getElementById(item.dataset.section);
    if (section) {
      section.scrollIntoView({ behavior: "smooth", block: "start" });
      setActiveSection(item.dataset.section);
    }
  });

  // Scroll spy: highlight whichever section header is near the top.
  let ticking = false;
  els.scroll.addEventListener("scroll", () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const sections = [...document.querySelectorAll(".section:not(.is-hidden)")];
      const top = els.scroll.scrollTop + 80;
      let current = sections[0]?.id;
      for (const sec of sections) {
        if (sec.offsetTop <= top) current = sec.id;
      }
      if (current) setActiveSection(current);
      ticking = false;
    });
  });
}

/* ============================================================================
   SEARCH
   ========================================================================== */

function bindSearch() {
  els.search.addEventListener("input", () => applySearch(els.search.value));
  els.search.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      els.search.value = "";
      applySearch("");
      els.search.blur();
    }
  });
}

function applySearch(query) {
  const q = query.trim().toLowerCase();
  const sections = [...document.querySelectorAll(".section")];
  let anyVisible = false;

  for (const section of sections) {
    const rows = [...section.querySelectorAll(".row")];
    let sectionHasMatch = false;

    for (const row of rows) {
      const haystack = (
        (row.querySelector(".row-title")?.textContent || "") +
        " " +
        (row.querySelector(".row-desc")?.textContent || "") +
        " " +
        (row.dataset.keywords || "")
      ).toLowerCase();
      const match = q === "" || haystack.includes(q);
      row.classList.toggle("is-hidden", !match);
      row.classList.toggle("is-match", q !== "" && match);
      if (match) sectionHasMatch = true;
    }

    section.classList.toggle("is-hidden", !sectionHasMatch);
    if (sectionHasMatch) anyVisible = true;
  }

  els.noResults.hidden = anyVisible;
}

/* ============================================================================
   SAVE / RESET
   ========================================================================== */

async function commit(message = "Settings saved") {
  await saveSettings(working);
  savedSettings = mergeSettings(working);
  working = mergeSettings(working);
  refreshDirtyUI();
  toast(message);
}

function discardChanges() {
  working = mergeSettings(savedSettings);
  populateControls(working);
  applyInterfaceSettings(working);
  refreshDirtyUI();
  toast("Reverted unsaved changes");
}

async function resetAllToDefaults() {
  const ok = await confirmModal({
    title: "Reset all settings?",
    body: "Every preference will return to its default value. Your saved sessions are not affected.",
    confirmLabel: "Reset everything",
  });
  if (!ok) return;
  working = defaultSettings();
  populateControls(working);
  applyInterfaceSettings(working);
  await commit("Settings reset to defaults");
}

/* ============================================================================
   IMPORT / EXPORT
   ========================================================================== */

async function exportSessionsJson() {
  const state = await loadState();
  const payload = {
    app: "link-opener",
    kind: "sessions",
    version: 1,
    exportedAt: new Date().toISOString(),
    windows: state.groups.map((g) => ({
      name: g.name,
      urls: parseUrlList(g.text).valid,
    })),
  };
  downloadJson(`link-opener-session-${stamp()}.json`, payload);
  toast("Sessions exported");
}

function exportSettingsJson() {
  const payload = {
    app: "link-opener",
    kind: "settings",
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: working,
  };
  downloadJson(`link-opener-settings-${stamp()}.json`, payload);
  toast("Settings exported");
}

async function handleFileImport(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const mode = pendingImportMode;
  pendingImportMode = null;

  try {
    const data = JSON.parse(await file.text());

    if (mode === "settings") {
      const incoming = data.settings || data;
      working = mergeSettings(incoming);
      populateControls(working);
      applyInterfaceSettings(working);
      await commit("Settings restored from file");
      return;
    }

    // Sessions import
    const windows = Array.isArray(data) ? data : data.windows || [];
    if (windows.length === 0) return toast("No sessions found in that file", "error");

    const groups = windows.map((w, i) => ({
      id: uid(),
      name: w.name || `Window ${i + 1}`,
      text: (w.urls || []).join("\n"),
      collapsed: false,
    }));

    const ok = await confirmModal({
      title: "Replace saved sessions?",
      body: `Importing "${file.name}" will replace your currently saved windows in the popup.`,
      confirmLabel: "Replace",
    });
    if (!ok) return;

    await saveState({ version: 1, groups });
    toast(`Imported ${pluralize(groups.length, "window")}`);
  } catch (err) {
    console.error(err);
    toast("Could not read that file", "error");
  }
}

function pickFile(mode) {
  pendingImportMode = mode;
  els.fileInput.value = "";
  els.fileInput.click();
}

/* ============================================================================
   HELPERS (download, toast, modal)
   ========================================================================== */

function downloadJson(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function toast(message, kind = "success") {
  const el = document.createElement("div");
  el.className = `toast ${kind === "error" ? "error" : ""}`;
  const dot = document.createElement("span");
  dot.className = "dot";
  const text = document.createElement("span");
  text.textContent = message;
  el.append(dot, text);
  els.toasts.appendChild(el);
  setTimeout(() => {
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 240);
  }, 2200);
}

function confirmModal({ title, body, confirmLabel = "Confirm" }) {
  return new Promise((resolve) => {
    els.modalTitle.textContent = title;
    els.modalBody.textContent = body;
    els.modalConfirm.textContent = confirmLabel;
    els.modal.hidden = false;

    const cleanup = (result) => {
      els.modal.hidden = true;
      els.modalConfirm.removeEventListener("click", onConfirm);
      els.modalCancel.removeEventListener("click", onCancel);
      els.modal.removeEventListener("click", onBackdrop);
      resolve(result);
    };
    const onConfirm = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onBackdrop = (ev) => {
      if (ev.target === els.modal) cleanup(false);
    };

    els.modalConfirm.addEventListener("click", onConfirm);
    els.modalCancel.addEventListener("click", onCancel);
    els.modal.addEventListener("click", onBackdrop);
  });
}

/** True when focus is in a text-entry control (so we don't hijack typing). */
function isEditableTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    el.isContentEditable
  );
}

function stamp() {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
}

/** Close the settings tab (works whether or not it was script-opened). */
async function closeThisTab() {
  try {
    const tab = await api.tabs.getCurrent();
    if (tab?.id != null) {
      await api.tabs.remove(tab.id);
      return;
    }
  } catch {
    /* fall through */
  }
  window.close();
}

/* ============================================================================
   GLOBAL WIRING
   ========================================================================== */

function wireGlobalEvents() {
  els.save.addEventListener("click", () => commit());
  els.reset.addEventListener("click", discardChanges);
  els.resetAll.addEventListener("click", resetAllToDefaults);
  els.back.addEventListener("click", closeThisTab);

  els.exportSessions.addEventListener("click", exportSessionsJson);
  els.importSessions.addEventListener("click", () => pickFile("sessions"));
  els.exportSettings.addEventListener("click", exportSettingsJson);
  els.importSettings.addEventListener("click", () => pickFile("settings"));
  els.fileInput.addEventListener("change", handleFileImport);

  // Global keyboard shortcuts for this page.
  document.addEventListener("keydown", (e) => {
    if (activeRecorder) {
      handleRecorderKeydown(e);
      return;
    }
    if (e.key === "Escape" && !els.modal.hidden) {
      els.modalCancel.click();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (isDirty()) commit();
      return;
    }
    if (e.key === "/" && !isEditableTarget(document.activeElement)) {
      e.preventDefault();
      els.search.focus();
    }
  });

  // Warn before leaving with unsaved changes.
  window.addEventListener("beforeunload", (e) => {
    if (isDirty()) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  // Keep "system" theme responsive to OS changes.
  if (window.matchMedia) {
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", () => applyInterfaceSettings(working));
  }
}

/* ============================================================================
   BOOT
   ========================================================================== */

async function init() {
  savedSettings = await loadSettings();
  working = mergeSettings(savedSettings);

  document.body.classList.add("is-settings");
  applyInterfaceSettings(working);
  populateControls(working);
  bindControls();
  bindNavigation();
  bindSearch();
  wireGlobalEvents();
  refreshDirtyUI();

  // Reflect the real extension version in the sidebar.
  try {
    const v = api.runtime.getManifest().version;
    if (v) els.versionTag.textContent = `v${v}`;
  } catch {
    /* non-fatal */
  }
}

document.addEventListener("DOMContentLoaded", init);
