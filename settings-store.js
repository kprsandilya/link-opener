/**
 * settings-store.js
 * -----------------------------------------------------------------------------
 * Canonical schema + persistence for the extension's user preferences.
 *
 * Settings live under their own key in `browser.storage.local`, separate from
 * session data (see storage.js). Everything funnels through `defaultSettings()`,
 * `loadSettings()`, and `saveSettings()` so the rest of the app never has to
 * know the storage backend or worry about missing/older fields — `mergeSettings`
 * deep-fills any gaps against the defaults.
 */

// Cross-browser API shim (Firefox `browser`, Chromium `chrome`).
const api = typeof browser !== "undefined" ? browser : chrome;

export const SETTINGS_KEY = "linkOpener.settings.v1";
export const SETTINGS_VERSION = 1;

/**
 * The full, documented settings schema with sensible defaults.
 * Grouped to mirror the sections shown on the settings page.
 * @returns {Settings}
 */
export function defaultSettings() {
  return {
    version: SETTINGS_VERSION,

    // ── Opening Behavior ──────────────────────────────────────────────────
    opening: {
      // How a saved session is opened.
      //   "new-window"     — one fresh window per group (default).
      //   "current-window" — open every URL as tabs in the current window.
      //   "merge"          — merge all groups' tabs into the current window.
      mode: "new-window",
      confirmLargeOpen: true,
      largeOpenThreshold: 50,
      focusFirstWindow: true,
    },

    // ── Saving ────────────────────────────────────────────────────────────
    saving: {
      includePrivateWindows: false,
      includePinnedTabs: false,
      // Newline-separated wildcard patterns (e.g. "*://*.example.com/*").
      ignorePatterns: "",
      preserveTabGroups: true,
    },

    // ── Automatic Saving ──────────────────────────────────────────────────
    autoSave: {
      enabled: false,
      intervalMinutes: 30,
      onWindowClose: false,
      onExit: false,
      retentionLimit: 10,
      minTabCount: 2,
    },

    // ── Export & Backup ───────────────────────────────────────────────────
    backup: {
      autoBackup: false,
      // Used as the download filename prefix (browsers control the directory).
      location: "link-opener-backups",
      format: "json", // "json" | "txt"
    },

    // ── Interface ─────────────────────────────────────────────────────────
    interface: {
      theme: "system", // "light" | "dark" | "system"
      popupSize: "medium", // "small" | "medium" | "large"
      dateFormat: "iso", // "iso" | "us" | "eu" | "long"
      timeFormat: "24h", // "12h" | "24h"
      density: "expanded", // "compact" | "expanded"
      smoothAnimations: true,
      // Toolbar buttons that can be hidden to declutter the popup.
      buttons: {
        addWindow: true,
        exportCurrent: true,
        importTxt: true,
        settings: true,
      },
    },

    // ── Power User ────────────────────────────────────────────────────────
    shortcuts: {
      openLinks: "Ctrl+Enter",
      addWindow: "Ctrl+Shift+N",
      exportCurrent: "Ctrl+E",
      focusSearch: "Ctrl+K",
    },
  };
}

/** Deep-merge a (possibly partial / older) object into a defaults object. */
function deepMerge(defaults, incoming) {
  if (incoming == null || typeof incoming !== "object") return defaults;
  const out = Array.isArray(defaults) ? [...defaults] : { ...defaults };
  for (const key of Object.keys(defaults)) {
    const dv = defaults[key];
    const iv = incoming[key];
    if (
      dv &&
      typeof dv === "object" &&
      !Array.isArray(dv) &&
      iv &&
      typeof iv === "object"
    ) {
      out[key] = deepMerge(dv, iv);
    } else if (iv !== undefined) {
      out[key] = iv;
    }
  }
  return out;
}

/**
 * Merge stored/imported settings onto the current defaults so newly added
 * fields always exist and stale fields are dropped.
 * @param {Partial<Settings>} incoming
 * @returns {Settings}
 */
export function mergeSettings(incoming) {
  const merged = deepMerge(defaultSettings(), incoming || {});
  merged.version = SETTINGS_VERSION;
  return merged;
}

/**
 * Load persisted settings, deep-merged onto defaults.
 * @returns {Promise<Settings>}
 */
export async function loadSettings() {
  try {
    const result = await api.storage.local.get(SETTINGS_KEY);
    const stored = result?.[SETTINGS_KEY];
    if (stored && typeof stored === "object") {
      return mergeSettings(stored);
    }
  } catch (err) {
    console.error("[Link Opener] Failed to load settings:", err);
  }
  return defaultSettings();
}

/**
 * Persist the full settings object.
 * @param {Settings} settings
 * @returns {Promise<void>}
 */
export async function saveSettings(settings) {
  try {
    await api.storage.local.set({ [SETTINGS_KEY]: mergeSettings(settings) });
  } catch (err) {
    console.error("[Link Opener] Failed to save settings:", err);
  }
}

/**
 * Reset settings back to defaults.
 * @returns {Promise<Settings>}
 */
export async function resetSettings() {
  const defaults = defaultSettings();
  await saveSettings(defaults);
  return defaults;
}

/**
 * Subscribe to live settings changes from other extension surfaces (e.g. the
 * settings tab updating while the popup is open).
 * @param {(settings: Settings) => void} callback
 * @returns {() => void} unsubscribe
 */
export function onSettingsChanged(callback) {
  const handler = (changes, area) => {
    if (area !== "local") return;
    if (changes[SETTINGS_KEY]) {
      callback(mergeSettings(changes[SETTINGS_KEY].newValue));
    }
  };
  api.storage.onChanged.addListener(handler);
  return () => api.storage.onChanged.removeListener(handler);
}

/* ---------------------------------------------------------------- Theming -- */

const POPUP_WIDTHS = { small: 380, medium: 460, large: 560 };

/** Resolve "system" against the OS preference into a concrete theme. */
export function resolveTheme(theme) {
  if (theme === "light" || theme === "dark") return theme;
  const prefersDark =
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  return prefersDark ? "dark" : "light";
}

/**
 * Apply interface-related settings to the current document. Shared by the popup
 * and the settings page so both stay visually in sync.
 * @param {Settings} settings
 */
export function applyInterfaceSettings(settings) {
  const root = document.documentElement;
  const ui = settings.interface;

  root.setAttribute("data-theme", resolveTheme(ui.theme));
  root.setAttribute("data-density", ui.density);
  root.toggleAttribute("data-no-motion", !ui.smoothAnimations);

  // Popup width only applies inside the constrained popup surface.
  if (document.body?.classList.contains("is-popup")) {
    const width = POPUP_WIDTHS[ui.popupSize] || POPUP_WIDTHS.medium;
    root.style.setProperty("--popup-width", `${width}px`);
  }
}

/**
 * @typedef {ReturnType<typeof defaultSettings>} Settings
 */
