/**
 * popup.js
 * -----------------------------------------------------------------------------
 * All UI logic for the Link Opener popup. Responsibilities:
 *  - Render and manage the list of window groups (add / delete / duplicate /
 *    collapse / rename / edit URLs).
 *  - Persist state to browser.storage.local on every change (debounced).
 *  - Talk to the background script to open sessions and export current windows.
 *  - Copy / download / import / export helpers + JSON session round-tripping.
 *  - Live stats, validation feedback, toasts, modal confirmations, shortcuts.
 *
 * The DOM stays the source of truth while editing; `collectState()` serializes
 * it for persistence so we never fight a virtual model against the inputs.
 */

import { loadState, saveState, clearState, defaultState } from "./storage.js";
import {
  uid,
  parseUrlList,
  countValidUrls,
  toMarkdown,
  pluralize,
} from "./utils.js";
import {
  loadSettings,
  defaultSettings,
  applyInterfaceSettings,
  onSettingsChanged,
} from "./settings-store.js";

// Cross-browser API shim (Firefox `browser`, Chromium `chrome`).
const api = typeof browser !== "undefined" ? browser : chrome;

// Live copy of user preferences, kept in sync with the settings page.
let appSettings = defaultSettings();

/* --------------------------------------------------------- Element handles -- */
const els = {
  windows: document.getElementById("windows"),
  template: document.getElementById("window-template"),
  statWindows: document.getElementById("stat-windows"),
  statLinks: document.getElementById("stat-links"),
  // Toolbar
  add: document.getElementById("btn-add"),
  export: document.getElementById("btn-export"),
  importFile: document.getElementById("btn-import-file"),
  settings: document.getElementById("btn-settings"),
  more: document.getElementById("btn-more"),
  morePanel: document.getElementById("more-panel"),
  copyAll: document.getElementById("btn-copy-all"),
  exportJson: document.getElementById("btn-export-json"),
  importJson: document.getElementById("btn-import-json"),
  clearAll: document.getElementById("btn-clear-all"),
  // Footer
  open: document.getElementById("btn-open"),
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

// Tracks what an in-flight file import is for ("txt" or "json").
let pendingImportMode = null;

/* ============================================================================
   STATE  <->  DOM
   ========================================================================== */

/**
 * Serialize the current DOM into a persistable state object.
 * @returns {import("./storage.js").AppState}
 */
function collectState() {
  const groups = [...els.windows.querySelectorAll(".window")].map((card) => ({
    id: card.dataset.id,
    name: card.querySelector(".window-name").value.trim() || "Untitled",
    text: card.querySelector(".url-input").value,
    collapsed: card.classList.contains("collapsed"),
  }));
  return { version: 1, groups };
}

// Debounced save so rapid typing doesn't hammer storage.
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveState(collectState()), 250);
}

/* ============================================================================
   RENDERING
   ========================================================================== */

/**
 * Build a single window card from the template and wire up its events.
 * @param {import("./storage.js").WindowGroup} group
 * @returns {HTMLElement}
 */
function createWindowCard(group) {
  const frag = els.template.content.cloneNode(true);
  const card = frag.querySelector(".window");
  card.dataset.id = group.id || uid();

  const nameInput = card.querySelector(".window-name");
  const textarea = card.querySelector(".url-input");
  const collapseBtn = card.querySelector(".collapse-toggle");
  const cardMenu = card.querySelector(".card-menu");
  const menuBtn = card.querySelector(".js-menu-btn");

  nameInput.value = group.name || "";
  textarea.value = group.text || "";
  if (group.collapsed) card.classList.add("collapsed");

  // --- Editing ---
  nameInput.addEventListener("input", scheduleSave);
  textarea.addEventListener("input", () => {
    updateCardCount(card);
    validateCard(card);
    updateStats();
    scheduleSave();
  });

  // --- Collapse / expand ---
  collapseBtn.addEventListener("click", () => {
    card.classList.toggle("collapsed");
    scheduleSave();
  });

  // --- Per-card menu toggling ---
  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    closeAllMenus(cardMenu);
    cardMenu.hidden = !cardMenu.hidden;
  });

  // --- Card actions ---
  card.querySelector(".js-copy").addEventListener("click", () => copyCard(card));
  card.querySelector(".js-copy-md").addEventListener("click", () => {
    copyCard(card, true);
    cardMenu.hidden = true;
  });
  card.querySelector(".js-download").addEventListener("click", () => {
    downloadCard(card);
    cardMenu.hidden = true;
  });
  card.querySelector(".js-duplicate").addEventListener("click", () => {
    duplicateCard(card);
    cardMenu.hidden = true;
  });
  card.querySelector(".js-delete").addEventListener("click", () => {
    deleteCard(card);
    cardMenu.hidden = true;
  });

  updateCardCount(card);
  validateCard(card);
  return card;
}

/** Re-number window titles that still use the default "Window N" pattern. */
function renumberWindows() {
  const cards = [...els.windows.querySelectorAll(".window")];
  cards.forEach((card, i) => {
    const input = card.querySelector(".window-name");
    if (/^Window \d+$/.test(input.value.trim()) || input.value.trim() === "") {
      input.value = `Window ${i + 1}`;
    }
  });
}

/** Update the "N links" badge on a single card. */
function updateCardCount(card) {
  const count = countValidUrls(card.querySelector(".url-input").value);
  card.querySelector(".window-count").textContent = pluralize(count, "link");
}

/** Show / hide the inline validation panel for invalid URLs in a card. */
function validateCard(card) {
  const { invalid } = parseUrlList(card.querySelector(".url-input").value);
  const box = card.querySelector(".window-errors");
  if (invalid.length === 0) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  const sample = invalid.slice(0, 4).join(", ");
  const more = invalid.length > 4 ? ` +${invalid.length - 4} more` : "";

  // Build with DOM nodes (textContent) so user input is never treated as HTML.
  const strong = document.createElement("strong");
  strong.textContent = pluralize(invalid.length, "invalid line");
  box.replaceChildren(strong, document.createTextNode(` skipped: ${sample}${more}`));
  box.hidden = false;
}

/** Refresh the header totals (windows + valid links). */
function updateStats() {
  const cards = [...els.windows.querySelectorAll(".window")];
  let links = 0;
  for (const card of cards) {
    links += countValidUrls(card.querySelector(".url-input").value);
  }
  els.statWindows.textContent = String(cards.length);
  els.statLinks.textContent = String(links);
}

/** Render the full list from a state object (used on load / import / reset). */
function render(state) {
  els.windows.replaceChildren();
  for (const group of state.groups) {
    els.windows.appendChild(createWindowCard(group));
  }
  updateStats();
}

/* ============================================================================
   WINDOW GROUP ACTIONS
   ========================================================================== */

function addWindow(focus = true) {
  const n = els.windows.querySelectorAll(".window").length + 1;
  const card = createWindowCard({
    id: uid(),
    name: `Window ${n}`,
    text: "",
    collapsed: false,
  });
  els.windows.appendChild(card);
  updateStats();
  scheduleSave();
  if (focus) {
    card.scrollIntoView({ behavior: "smooth", block: "nearest" });
    card.querySelector(".url-input").focus();
  }
  return card;
}

function duplicateCard(card) {
  const clone = createWindowCard({
    id: uid(),
    name: card.querySelector(".window-name").value + " copy",
    text: card.querySelector(".url-input").value,
    collapsed: false,
  });
  card.after(clone);
  updateStats();
  scheduleSave();
  toast("Window duplicated");
}

function deleteCard(card) {
  const cards = els.windows.querySelectorAll(".window");
  // Keep at least one window around so the editor is never empty.
  if (cards.length === 1) {
    card.querySelector(".window-name").value = "Window 1";
    card.querySelector(".url-input").value = "";
    updateCardCount(card);
    validateCard(card);
    updateStats();
    scheduleSave();
    toast("Window cleared");
    return;
  }
  card.style.transition = "opacity .18s ease, transform .18s ease";
  card.style.opacity = "0";
  card.style.transform = "translateY(6px)";
  setTimeout(() => {
    card.remove();
    renumberWindows();
    updateStats();
    scheduleSave();
  }, 160);
}

/* ============================================================================
   COPY / DOWNLOAD / IMPORT / EXPORT
   ========================================================================== */

function cardUrls(card) {
  return parseUrlList(card.querySelector(".url-input").value).valid;
}

async function copyCard(card, asMarkdown = false) {
  const urls = cardUrls(card);
  if (urls.length === 0) return toast("No valid URLs to copy", "error");
  const name = card.querySelector(".window-name").value.trim();
  const text = asMarkdown ? toMarkdown(urls, name) : urls.join("\n");
  await copyText(text);
  toast(asMarkdown ? "Copied as Markdown" : "Copied URLs");
}

function downloadCard(card) {
  const urls = cardUrls(card);
  if (urls.length === 0) return toast("No valid URLs to download", "error");
  const name = card.querySelector(".window-name").value.trim() || "window";
  downloadText(`${slugify(name)}.txt`, urls.join("\n"));
  toast("Downloaded .txt");
}

async function copyAllWindows() {
  const cards = [...els.windows.querySelectorAll(".window")];
  const blocks = [];
  for (const card of cards) {
    const urls = cardUrls(card);
    if (urls.length === 0) continue;
    const name = card.querySelector(".window-name").value.trim();
    blocks.push(`# ${name}\n${urls.join("\n")}`);
  }
  if (blocks.length === 0) return toast("Nothing to copy", "error");
  await copyText(blocks.join("\n\n"));
  toast("Copied all windows");
}

function exportSessionJson() {
  const state = collectState();
  const payload = {
    app: "link-opener",
    version: 1,
    exportedAt: new Date().toISOString(),
    windows: state.groups.map((g) => ({
      name: g.name,
      urls: parseUrlList(g.text).valid,
    })),
  };
  downloadText(
    `link-opener-session-${stamp()}.json`,
    JSON.stringify(payload, null, 2)
  );
  toast("Session exported as JSON");
}

/**
 * Parse imported file contents into window groups.
 *  - JSON: expects { windows: [{ name, urls[] }] } or an array of groups.
 *  - TXT: blank line(s) separate windows; otherwise the whole file is one
 *    window.
 * @param {string} content
 * @param {"json"|"txt"} mode
 * @returns {import("./storage.js").WindowGroup[]}
 */
function parseImport(content, mode) {
  if (mode === "json") {
    const data = JSON.parse(content);
    const windows = Array.isArray(data) ? data : data.windows || [];
    return windows.map((w, i) => ({
      id: uid(),
      name: w.name || `Window ${i + 1}`,
      text: (w.urls || []).join("\n"),
      collapsed: false,
    }));
  }

  // Plain text: split into windows on blank-line gaps.
  const chunks = content
    .split(/\n\s*\n/)
    .map((c) => c.trim())
    .filter(Boolean);
  const source = chunks.length > 0 ? chunks : [content.trim()];
  return source.map((chunk, i) => ({
    id: uid(),
    name: `Window ${i + 1}`,
    text: chunk,
    collapsed: false,
  }));
}

/* ============================================================================
   OPEN / EXPORT SESSIONS (talk to background)
   ========================================================================== */

async function openLinks() {
  const cards = [...els.windows.querySelectorAll(".window")];
  const windows = [];
  let totalTabs = 0;

  for (const card of cards) {
    const urls = cardUrls(card);
    if (urls.length > 0) {
      windows.push(urls);
      totalTabs += urls.length;
    }
  }

  if (windows.length === 0) {
    return toast("Add some valid URLs first", "error");
  }

  // Confirm large opens (when enabled) to avoid accidentally spawning hundreds
  // of tabs. Threshold and toggle both come from user settings.
  const { confirmLargeOpen, largeOpenThreshold, mode, focusFirstWindow } =
    appSettings.opening;
  if (confirmLargeOpen && totalTabs > largeOpenThreshold) {
    const ok = await confirmModal({
      title: "Open a lot of tabs?",
      body: `This will open ${pluralize(totalTabs, "tab")} across ${pluralize(
        windows.length,
        "window"
      )}. Continue?`,
      confirmLabel: "Open them",
    });
    if (!ok) return;
  }

  try {
    const result = await api.runtime.sendMessage({
      type: "OPEN_SESSIONS",
      windows,
      mode,
      focusFirstWindow,
    });
    toast(
      `Opened ${pluralize(result.openedTabs, "tab")} in ${pluralize(
        result.openedWindows,
        "window"
      )}`
    );
  } catch (err) {
    console.error(err);
    toast("Failed to open links", "error");
  }
}

async function exportCurrentWindows() {
  // Warn before discarding unsaved-looking content.
  const hasContent = [...els.windows.querySelectorAll(".url-input")].some(
    (t) => t.value.trim() !== ""
  );
  if (hasContent) {
    const ok = await confirmModal({
      title: "Replace current session?",
      body: "Exporting your open Firefox windows will replace what's currently in the editor. Your open browser tabs are not affected.",
      confirmLabel: "Replace",
    });
    if (!ok) return;
  }

  try {
    const groups = await api.runtime.sendMessage({
      type: "EXPORT_SESSION",
      includePinned: appSettings.saving.includePinnedTabs,
      includePrivate: appSettings.saving.includePrivateWindows,
      ignorePatterns: appSettings.saving.ignorePatterns,
    });

    if (!groups || groups.length === 0) {
      return toast("No exportable windows found", "error");
    }

    const state = {
      version: 1,
      groups: groups.map((g) => ({
        id: uid(),
        name: g.name,
        text: g.urls.join("\n"),
        collapsed: false,
      })),
    };
    render(state);
    saveState(state);
    toast(`Exported ${pluralize(groups.length, "window")}`);
  } catch (err) {
    console.error(err);
    toast("Failed to export windows", "error");
  }
}

/* ============================================================================
   HELPERS  (clipboard, download, toast, modal, misc)
   ========================================================================== */

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for restricted contexts.
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
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

/**
 * Promise-based confirmation modal.
 * @param {{title:string, body:string, confirmLabel?:string}} opts
 * @returns {Promise<boolean>}
 */
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
    const onBackdrop = (e) => {
      if (e.target === els.modal) cleanup(false);
    };

    els.modalConfirm.addEventListener("click", onConfirm);
    els.modalCancel.addEventListener("click", onCancel);
    els.modal.addEventListener("click", onBackdrop);
  });
}

/** Close every open dropdown menu, optionally keeping one open. */
function closeAllMenus(keep) {
  document.querySelectorAll(".card-menu").forEach((m) => {
    if (m !== keep) m.hidden = true;
  });
  if (els.morePanel !== keep) els.morePanel.hidden = true;
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "window";
}

function stamp() {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
}

/* ============================================================================
   GLOBAL EVENT WIRING
   ========================================================================== */

function wireGlobalEvents() {
  els.add.addEventListener("click", () => addWindow());
  els.export.addEventListener("click", exportCurrentWindows);
  els.open.addEventListener("click", openLinks);
  els.settings.addEventListener("click", openSettingsPage);

  // "More" dropdown
  els.more.addEventListener("click", (e) => {
    e.stopPropagation();
    closeAllMenus(els.morePanel);
    els.morePanel.hidden = !els.morePanel.hidden;
    els.more.setAttribute("aria-expanded", String(!els.morePanel.hidden));
  });
  els.copyAll.addEventListener("click", () => {
    copyAllWindows();
    els.morePanel.hidden = true;
  });
  els.exportJson.addEventListener("click", () => {
    exportSessionJson();
    els.morePanel.hidden = true;
  });
  els.importJson.addEventListener("click", () => {
    pendingImportMode = "json";
    els.fileInput.value = "";
    els.fileInput.click();
    els.morePanel.hidden = true;
  });
  els.clearAll.addEventListener("click", async () => {
    els.morePanel.hidden = true;
    const ok = await confirmModal({
      title: "Clear everything?",
      body: "This removes all windows and URLs from the editor. This cannot be undone.",
      confirmLabel: "Clear All",
    });
    if (!ok) return;
    await clearState();
    render(defaultState());
    saveState(collectState());
    toast("Cleared everything");
  });

  // File import (.txt button + .json menu share one input)
  els.importFile.addEventListener("click", () => {
    pendingImportMode = "txt";
    els.fileInput.value = "";
    els.fileInput.click();
  });
  els.fileInput.addEventListener("change", handleFileImport);

  // Close menus on outside click.
  document.addEventListener("click", () => closeAllMenus());

  // Keyboard shortcuts (user-customizable via Settings → Power User).
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !els.modal.hidden) {
      els.modalCancel.click();
      return;
    }
    const sc = appSettings.shortcuts;
    if (eventMatchesCombo(e, sc.openLinks)) {
      e.preventDefault();
      openLinks();
    } else if (eventMatchesCombo(e, sc.addWindow)) {
      e.preventDefault();
      addWindow();
    } else if (eventMatchesCombo(e, sc.exportCurrent)) {
      e.preventDefault();
      exportCurrentWindows();
    }
  });
}

/**
 * Match a keydown event against a stored shortcut combo string such as
 * "Ctrl+Shift+N". Ctrl and Cmd are treated interchangeably so the same
 * preference works across platforms.
 * @param {KeyboardEvent} e
 * @param {string} combo
 * @returns {boolean}
 */
function eventMatchesCombo(e, combo) {
  if (!combo) return false;
  const want = { primary: false, alt: false, shift: false, key: null };
  for (const part of combo.split("+")) {
    if (part === "Ctrl" || part === "Cmd") want.primary = true;
    else if (part === "Alt") want.alt = true;
    else if (part === "Shift") want.shift = true;
    else want.key = part;
  }
  if (!want.key) return false;

  if (want.primary !== (e.ctrlKey || e.metaKey)) return false;
  if (want.alt !== e.altKey) return false;
  if (want.shift !== e.shiftKey) return false;

  let key = e.key;
  if (key === " ") key = "Space";
  else if (key.length === 1) key = key.toUpperCase();
  return key === want.key;
}

/** Open the full Settings page in a dedicated browser tab. */
async function openSettingsPage() {
  try {
    const url = api.runtime.getURL("settings.html");
    await api.tabs.create({ url });
    window.close(); // popup has served its purpose
  } catch (err) {
    console.error(err);
    toast("Couldn't open settings", "error");
  }
}

/** Reflect interface preferences (theme, density, animations, popup width). */
function applySettings(settings) {
  appSettings = settings;
  applyInterfaceSettings(settings);
  applyButtonVisibility(settings);
}

/** Show / hide toolbar buttons per the user's visibility preferences. */
function applyButtonVisibility(settings) {
  const map = {
    addWindow: els.add,
    exportCurrent: els.export,
    importTxt: els.importFile,
    settings: els.settings,
  };
  const visibility = settings.interface.buttons;
  for (const [key, el] of Object.entries(map)) {
    if (el) el.hidden = visibility[key] === false;
  }
}

async function handleFileImport(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const mode =
    pendingImportMode || (file.name.endsWith(".json") ? "json" : "txt");

  try {
    const content = await file.text();
    const groups = parseImport(content, mode);
    if (groups.length === 0) return toast("Nothing to import", "error");

    const hasContent = [...els.windows.querySelectorAll(".url-input")].some(
      (t) => t.value.trim() !== ""
    );
    if (hasContent) {
      const ok = await confirmModal({
        title: "Replace current session?",
        body: `Importing "${file.name}" will replace what's currently in the editor.`,
        confirmLabel: "Replace",
      });
      if (!ok) return;
    }

    const state = { version: 1, groups };
    render(state);
    saveState(state);
    toast(`Imported ${pluralize(groups.length, "window")}`);
  } catch (err) {
    console.error(err);
    toast("Could not read that file", "error");
  } finally {
    pendingImportMode = null;
  }
}

/* ============================================================================
   BOOT
   ========================================================================== */

async function init() {
  // Apply preferences as early as possible to avoid a theme flash.
  applySettings(await loadSettings());
  // React to changes made in the Settings tab while the popup is open.
  onSettingsChanged(applySettings);

  wireGlobalEvents();
  const state = await loadState();
  render(state);
}

document.addEventListener("DOMContentLoaded", init);
