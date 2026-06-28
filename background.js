/**
 * background.js
 * -----------------------------------------------------------------------------
 * The extension's event page. It owns all privileged interactions with the
 * browser windows/tabs APIs so the popup stays a pure UI surface.
 *
 * Why do it here instead of in the popup?
 *  - Creating multiple windows from the popup can cause the popup to close
 *    mid-operation, aborting the loop. The background page has no such issue.
 *  - It keeps a single, testable place for the "open sessions" + "export
 *    sessions" logic.
 *
 * Communication is via `runtime.sendMessage` / `onMessage` using a small
 * message protocol:
 *   { type: "OPEN_SESSIONS", windows: string[][] }
 *   { type: "EXPORT_SESSION", includePinned: boolean }
 */

import { isInternalUrl, isValidUrl, matchesAnyPattern } from "./utils.js";
import { loadSettings, onSettingsChanged } from "./settings-store.js";

// Cross-browser API shim (see storage.js for rationale).
const api = typeof browser !== "undefined" ? browser : chrome;

/**
 * Reduce a raw windows array to groups of safe, openable http(s) URLs.
 * Invalid entries and now-empty groups are dropped.
 * @param {string[][]} windows
 * @returns {string[][]}
 */
function sanitizeGroups(windows) {
  if (!Array.isArray(windows)) return [];
  return windows
    .map((urls) =>
      Array.isArray(urls)
        ? urls.filter((u) => typeof u === "string" && isValidUrl(u))
        : []
    )
    .filter((urls) => urls.length > 0);
}

/**
 * Open a set of "windows", where each window is an array of URLs.
 *
 * The `mode` controls placement:
 *   "new-window"     — one fresh window per group (default).
 *   "current-window" — open every group's URLs as tabs in the current window.
 *   "merge"          — alias of current-window (everything merged together).
 *
 * @param {string[][]} windows
 * @param {{ mode?: string, focusFirstWindow?: boolean }} [opts]
 * @returns {Promise<{ openedWindows: number, openedTabs: number, firstWindowId: number|null }>}
 */
async function openSessions(windows, opts = {}) {
  const mode = opts.mode || "new-window";
  const focusFirstWindow = opts.focusFirstWindow !== false;

  // Defense-in-depth: never create a tab from anything that isn't a valid
  // http(s) URL, regardless of what the caller sent. This guards against
  // javascript:/data:/file: URLs slipping through if a future caller forgets
  // to pre-filter (the popup already filters, but we don't rely on it).
  const groups = sanitizeGroups(windows);

  if (mode === "current-window" || mode === "merge") {
    return openIntoCurrentWindow(groups, focusFirstWindow);
  }

  let openedWindows = 0;
  let openedTabs = 0;
  let firstWindowId = null;

  for (const urls of groups) {
    // Create the window with the first URL, then append the rest as tabs so
    // ordering is preserved exactly as the user entered them.
    const [firstUrl, ...restUrls] = urls;

    const win = await api.windows.create({ url: firstUrl, focused: false });
    openedWindows += 1;
    openedTabs += 1;
    if (firstWindowId === null) firstWindowId = win.id;

    for (const url of restUrls) {
      await api.tabs.create({ windowId: win.id, url });
      openedTabs += 1;
    }
  }

  // Bring the first created window forward so the user lands somewhere sensible.
  if (focusFirstWindow && firstWindowId !== null) {
    try {
      await api.windows.update(firstWindowId, { focused: true });
    } catch {
      /* non-fatal: window may have been closed already */
    }
  }

  return { openedWindows, openedTabs, firstWindowId };
}

/**
 * Open all URLs as tabs in the user's current window (current-window / merge).
 * @param {string[][]} groups
 * @param {boolean} focus
 */
async function openIntoCurrentWindow(groups, focus) {
  let current;
  try {
    current = await api.windows.getCurrent();
  } catch {
    current = null;
  }

  // Fall back to creating a window if there's no current one to target.
  const windowId = current?.id ?? null;
  let openedTabs = 0;
  let firstTabActivated = false;

  for (const urls of groups) {
    for (const url of urls) {
      const createProps = { url };
      if (windowId !== null) createProps.windowId = windowId;
      // Activate the very first opened tab so the user lands on it.
      createProps.active = focus && !firstTabActivated;
      await api.tabs.create(createProps);
      firstTabActivated = true;
      openedTabs += 1;
    }
  }

  if (focus && windowId !== null) {
    try {
      await api.windows.update(windowId, { focused: true });
    } catch {
      /* non-fatal */
    }
  }

  return {
    openedWindows: openedTabs > 0 ? 1 : 0,
    openedTabs,
    firstWindowId: windowId,
  };
}

/**
 * Read all currently open browser windows and return them as URL groups.
 * Internal pages are filtered out; pinned tabs, private windows, and
 * user-defined ignore patterns are all honored.
 *
 * @param {{ includePinned?: boolean, includePrivate?: boolean, ignorePatterns?: string }} [opts]
 * @returns {Promise<Array<{ name: string, urls: string[] }>>}
 */
async function exportSession(opts = {}) {
  const {
    includePinned = false,
    includePrivate = false,
    ignorePatterns = "",
  } = opts;

  const wins = await api.windows.getAll({ populate: true, windowTypes: ["normal"] });

  const groups = [];
  let index = 1;

  for (const win of wins) {
    if (win.incognito && !includePrivate) continue;

    const tabs = win.tabs || [];
    const urls = [];

    for (const tab of tabs) {
      if (!includePinned && tab.pinned) continue;
      if (isInternalUrl(tab.url)) continue;
      if (matchesAnyPattern(tab.url, ignorePatterns)) continue;
      urls.push(tab.url);
    }

    // Only include windows that have at least one exportable URL.
    if (urls.length > 0) {
      groups.push({ name: `Window ${index}`, urls });
      index += 1;
    }
  }

  return groups;
}

/**
 * Central message handler. Returns a promise so Firefox replies asynchronously.
 */
api.runtime.onMessage.addListener((message) => {
  switch (message?.type) {
    case "OPEN_SESSIONS":
      return openSessions(message.windows || [], {
        mode: message.mode,
        focusFirstWindow: message.focusFirstWindow,
      });

    case "EXPORT_SESSION":
      return exportSession({
        includePinned: Boolean(message.includePinned),
        includePrivate: Boolean(message.includePrivate),
        ignorePatterns: message.ignorePatterns || "",
      });

    default:
      return Promise.resolve({ error: `Unknown message type: ${message?.type}` });
  }
});

/* ============================================================================
   AUTOMATIC SAVING + LOCAL BACKUPS
   ----------------------------------------------------------------------------
   Driven entirely by user settings. A single alarm performs periodic snapshots;
   we also flush a best-effort snapshot of a window's tabs when it closes. Each
   snapshot can be retained in storage (a pruned ring buffer) and/or written to
   the downloads folder as an importable backup file.
   ========================================================================== */

const AUTOSAVE_STORAGE_KEY = "linkOpener.autosaves.v1";
const AUTOSAVE_ALARM = "link-opener-autosave";

let settings = null;
// Last-known filtered URL list per normal window, so we can snapshot on close.
const windowCache = new Map();

/** Apply the current saving filters to a list of tabs. */
function filterTabUrls(tabs) {
  if (!settings) return [];
  const urls = [];
  for (const tab of tabs || []) {
    if (!settings.saving.includePinnedTabs && tab.pinned) continue;
    if (isInternalUrl(tab.url)) continue;
    if (matchesAnyPattern(tab.url, settings.saving.ignorePatterns)) continue;
    urls.push(tab.url);
  }
  return urls;
}

/** Snapshot all currently open windows using the active saving preferences. */
function snapshotOpenWindows() {
  return exportSession({
    includePinned: settings.saving.includePinnedTabs,
    includePrivate: settings.saving.includePrivateWindows,
    ignorePatterns: settings.saving.ignorePatterns,
  });
}

/** Persist a snapshot into the pruned ring buffer of automatic saves. */
async function storeAutoSave(entry) {
  try {
    const result = await api.storage.local.get(AUTOSAVE_STORAGE_KEY);
    const list = Array.isArray(result?.[AUTOSAVE_STORAGE_KEY])
      ? result[AUTOSAVE_STORAGE_KEY]
      : [];
    list.push(entry);
    const limit = Math.max(1, settings.autoSave.retentionLimit || 10);
    const pruned = list.slice(-limit);
    await api.storage.local.set({ [AUTOSAVE_STORAGE_KEY]: pruned });
  } catch (err) {
    console.error("[Link Opener] Failed to store auto-save:", err);
  }
}

/** Write a snapshot to the downloads folder as an importable backup file. */
async function writeBackupFile(groups, trigger) {
  if (!api.downloads) return;
  const ext = settings.backup.format === "txt" ? "txt" : "json";
  const prefix = sanitizeFolder(settings.backup.location) || "link-opener-backups";
  const filename = `${prefix}/link-opener-${trigger}-${utcStamp()}.${ext}`;

  let content;
  let mime;
  if (ext === "txt") {
    content = groups
      .map((g) => `# ${g.name}\n${g.urls.join("\n")}`)
      .join("\n\n");
    mime = "text/plain";
  } else {
    content = JSON.stringify(
      {
        app: "link-opener",
        kind: "sessions",
        version: 1,
        exportedAt: new Date().toISOString(),
        trigger,
        windows: groups,
      },
      null,
      2
    );
    mime = "application/json";
  }

  const url = `data:${mime};charset=utf-8,${encodeURIComponent(content)}`;
  try {
    await api.downloads.download({
      url,
      filename,
      conflictAction: "uniquify",
      saveAs: false,
    });
  } catch (err) {
    console.error("[Link Opener] Failed to write backup file:", err);
  }
}

/** Run a full automatic save + optional backup for the given trigger. */
async function performAutoSave(trigger) {
  if (!settings) return;
  const wantStore = settings.autoSave.enabled;
  const wantBackup = settings.backup.autoBackup;
  if (!wantStore && !wantBackup) return;

  let groups = await snapshotOpenWindows();
  // Honor the minimum tab count for each window.
  const min = Math.max(1, settings.autoSave.minTabCount || 1);
  groups = groups.filter((g) => g.urls.length >= min);
  if (groups.length === 0) return;

  const entry = {
    id: `${Date.now().toString(36)}`,
    savedAt: new Date().toISOString(),
    trigger,
    windows: groups,
  };

  if (wantStore) await storeAutoSave(entry);
  if (wantBackup) await writeBackupFile(groups, trigger);
}

/** (Re)configure the periodic alarm based on the current settings. */
async function reconfigureAlarms() {
  if (!api.alarms || !settings) return;
  try {
    await api.alarms.clear(AUTOSAVE_ALARM);
  } catch {
    /* no-op */
  }
  const active = settings.autoSave.enabled || settings.backup.autoBackup;
  if (!active) return;
  const minutes = Math.max(1, settings.autoSave.intervalMinutes || 30);
  api.alarms.create(AUTOSAVE_ALARM, { periodInMinutes: minutes });
}

if (api.alarms) {
  api.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === AUTOSAVE_ALARM) performAutoSave("interval");
  });
}

/* ------------------------------------------------- Window-close snapshots -- */

let cacheTimers = new Map();

/** Refresh the cached URL list for a window (debounced per window). */
function scheduleCacheRefresh(windowId) {
  if (windowId == null || windowId === api.windows?.WINDOW_ID_NONE) return;
  clearTimeout(cacheTimers.get(windowId));
  cacheTimers.set(
    windowId,
    setTimeout(async () => {
      try {
        const tabs = await api.tabs.query({ windowId });
        windowCache.set(windowId, filterTabUrls(tabs));
      } catch {
        windowCache.delete(windowId);
      }
    }, 400)
  );
}

async function primeWindowCache() {
  try {
    const wins = await api.windows.getAll({ populate: true, windowTypes: ["normal"] });
    for (const win of wins) {
      windowCache.set(win.id, filterTabUrls(win.tabs));
    }
  } catch {
    /* non-fatal */
  }
}

function wireWindowCloseSnapshots() {
  if (!api.tabs || !api.windows) return;

  const refresh = (tabOrInfo) => {
    const windowId =
      typeof tabOrInfo === "number"
        ? tabOrInfo
        : tabOrInfo?.windowId ?? tabOrInfo?.newWindowId;
    scheduleCacheRefresh(windowId);
  };

  api.tabs.onCreated.addListener((tab) => refresh(tab.windowId));
  api.tabs.onRemoved.addListener((_id, info) => refresh(info.windowId));
  api.tabs.onUpdated.addListener((_id, changeInfo, tab) => {
    if (changeInfo.url || changeInfo.pinned !== undefined) refresh(tab.windowId);
  });
  if (api.tabs.onAttached) api.tabs.onAttached.addListener((_id, info) => refresh(info.newWindowId));
  if (api.tabs.onDetached) api.tabs.onDetached.addListener((_id, info) => refresh(info.oldWindowId));

  api.windows.onRemoved.addListener(async (windowId) => {
    const urls = windowCache.get(windowId);
    windowCache.delete(windowId);
    if (!settings?.autoSave.enabled || !settings.autoSave.onWindowClose) return;
    if (!urls || urls.length < Math.max(1, settings.autoSave.minTabCount || 1)) return;

    const entry = {
      id: `${Date.now().toString(36)}`,
      savedAt: new Date().toISOString(),
      trigger: "window-close",
      windows: [{ name: "Closed window", urls }],
    };
    await storeAutoSave(entry);
    if (settings.backup.autoBackup) await writeBackupFile(entry.windows, "window-close");
  });
}

/* ----------------------------------------------------------------- helpers - */

function sanitizeFolder(name) {
  return String(name || "")
    .replace(/[<>:"|?*\\]+/g, "") // drop characters illegal in download paths
    .split("/")
    .map((seg) => seg.trim())
    // Reject empty segments and any "." / ".." traversal components.
    .filter((seg) => seg && seg !== "." && seg !== "..")
    .join("/");
}

function utcStamp() {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
}

/* ----------------------------------------------------------------- bootstrap */

async function initBackground() {
  settings = await loadSettings();
  onSettingsChanged(async (next) => {
    settings = next;
    await reconfigureAlarms();
  });
  await primeWindowCache();
  wireWindowCloseSnapshots();
  await reconfigureAlarms();
}

initBackground();
