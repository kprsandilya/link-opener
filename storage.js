/**
 * storage.js
 * -----------------------------------------------------------------------------
 * Thin, promise-based wrapper around `browser.storage.local`.
 *
 * Centralizing persistence here keeps the rest of the app ignorant of the
 * storage backend. To port to Chromium you only need to swap `browser` for
 * `chrome` (see the `api` shim below) — the rest of the code is untouched.
 */

// Cross-browser API shim. Firefox exposes the promise-based `browser` global;
// Chromium exposes `chrome`. Both support the MV3 storage API.
const api = typeof browser !== "undefined" ? browser : chrome;

const STORAGE_KEY = "linkOpener.state.v1";

/**
 * The canonical shape of persisted state.
 * @typedef {Object} WindowGroup
 * @property {string} id
 * @property {string} name
 * @property {string} text       Raw textarea contents (one URL per line).
 * @property {boolean} collapsed
 *
 * @typedef {Object} AppState
 * @property {WindowGroup[]} groups
 * @property {number} version
 */

/** Default state used on first run. */
export function defaultState() {
  return {
    version: 1,
    groups: [
      {
        id: "default",
        name: "Window 1",
        text: "",
        collapsed: false,
      },
    ],
  };
}

/**
 * Load the persisted application state, falling back to defaults.
 * @returns {Promise<AppState>}
 */
export async function loadState() {
  try {
    const result = await api.storage.local.get(STORAGE_KEY);
    const stored = result?.[STORAGE_KEY];
    if (stored && Array.isArray(stored.groups) && stored.groups.length > 0) {
      return stored;
    }
  } catch (err) {
    console.error("[Link Opener] Failed to load state:", err);
  }
  return defaultState();
}

/**
 * Persist the full application state.
 * @param {AppState} state
 * @returns {Promise<void>}
 */
export async function saveState(state) {
  try {
    await api.storage.local.set({ [STORAGE_KEY]: state });
  } catch (err) {
    console.error("[Link Opener] Failed to save state:", err);
  }
}

/**
 * Clear all persisted data and reset to defaults.
 * @returns {Promise<void>}
 */
export async function clearState() {
  try {
    await api.storage.local.remove(STORAGE_KEY);
  } catch (err) {
    console.error("[Link Opener] Failed to clear state:", err);
  }
}
