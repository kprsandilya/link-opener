/**
 * utils.js
 * -----------------------------------------------------------------------------
 * Pure, framework-free helper functions shared across the extension.
 * Everything here is side-effect free so it can be unit tested or reused in
 * both the popup (UI) and the background script.
 */

/**
 * A small id generator for window groups. Not cryptographically strong — it
 * only needs to be unique within a single session of the editor.
 * @returns {string}
 */
export function uid() {
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  );
}

/**
 * Normalize a single raw line into a usable URL.
 *
 * Rules:
 *  - Trims surrounding whitespace.
 *  - Returns null for blank lines (caller should skip them).
 *  - Automatically prepends "https://" when no scheme is present.
 *  - Leaves already-schemed URLs (http, https, ftp, etc.) untouched.
 *
 * @param {string} rawLine
 * @returns {string|null} normalized URL string, or null when the line is blank
 */
export function normalizeUrl(rawLine) {
  if (rawLine == null) return null;
  const trimmed = rawLine.trim();
  if (trimmed === "") return null;

  // If it already looks like it has a scheme (e.g. "https://", "ftp://",
  // "mailto:"), leave it alone. Otherwise assume https.
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed);
  return hasScheme ? trimmed : `https://${trimmed}`;
}

/**
 * Validate a normalized URL using the platform URL parser.
 * We only allow http/https for "open in tab" safety, but the parser also
 * guards against obviously malformed strings.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isValidUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Parse the contents of a textarea (one URL per line) into a structured result.
 *
 * @param {string} text
 * @returns {{ valid: string[], invalid: string[] }}
 *   valid   — normalized, openable URLs in their original order
 *   invalid — original raw lines that failed validation (for error display)
 */
export function parseUrlList(text) {
  const valid = [];
  const invalid = [];

  const lines = (text || "").split(/\r?\n/);
  for (const line of lines) {
    const normalized = normalizeUrl(line);
    if (normalized === null) continue; // blank line, skip silently

    if (isValidUrl(normalized)) {
      valid.push(normalized);
    } else {
      invalid.push(line.trim());
    }
  }

  return { valid, invalid };
}

/**
 * Count how many valid URLs a block of text contains. Used for the live
 * "total links" counter without allocating arrays we don't need.
 * @param {string} text
 * @returns {number}
 */
export function countValidUrls(text) {
  return parseUrlList(text).valid.length;
}

/**
 * Strip a URL down to a friendly hostname for display / markdown labels.
 * @param {string} url
 * @returns {string}
 */
export function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Returns true when a tab URL points to an internal browser page that should
 * be ignored during export (about:, moz-extension:, chrome:, etc.).
 * @param {string} url
 * @returns {boolean}
 */
export function isInternalUrl(url) {
  if (!url) return true;
  return /^(about:|moz-extension:|chrome:|edge:|chrome-extension:|view-source:|data:)/i.test(
    url
  );
}

/**
 * Convert a window group's URLs into Markdown bullet list form.
 * @param {string[]} urls
 * @param {string} [title]
 * @returns {string}
 */
export function toMarkdown(urls, title) {
  const header = title ? `### ${title}\n\n` : "";
  const body = urls.map((u) => `- [${hostnameOf(u)}](${u})`).join("\n");
  return header + body;
}

/**
 * Format a count with the correct singular/plural noun.
 * @param {number} n
 * @param {string} singular
 * @param {string} [plural]
 * @returns {string}
 */
export function pluralize(n, singular, plural) {
  const word = n === 1 ? singular : plural || `${singular}s`;
  return `${n} ${word}`;
}

/**
 * Convert a single glob-style pattern into a RegExp. Supports `*` (any run of
 * characters) and `?` (a single character); every other character is escaped so
 * the pattern is matched literally.
 * @param {string} pattern
 * @returns {RegExp}
 */
export function wildcardToRegExp(pattern) {
  const escaped = String(pattern)
    .trim()
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex metachars (not * ?)
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

/**
 * Test whether a URL matches any of the supplied newline-separated wildcard
 * patterns. Blank lines and lines starting with `#` (comments) are ignored.
 * @param {string} url
 * @param {string} patternsText
 * @returns {boolean}
 */
export function matchesAnyPattern(url, patternsText) {
  if (!url || !patternsText) return false;
  const patterns = patternsText
    .split(/\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith("#"));
  return patterns.some((p) => {
    try {
      return wildcardToRegExp(p).test(url);
    } catch {
      return false;
    }
  });
}

/**
 * Format a Date according to the user's chosen date/time preferences.
 * @param {Date|number|string} input
 * @param {{ dateFormat?: string, timeFormat?: string }} [opts]
 * @returns {string}
 */
export function formatDateTime(input, opts = {}) {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return "";

  const { dateFormat = "iso", timeFormat = "24h" } = opts;
  const pad = (n) => String(n).padStart(2, "0");

  const Y = date.getFullYear();
  const M = pad(date.getMonth() + 1);
  const D = pad(date.getDate());

  let datePart;
  switch (dateFormat) {
    case "us":
      datePart = `${M}/${D}/${Y}`;
      break;
    case "eu":
      datePart = `${D}/${M}/${Y}`;
      break;
    case "long":
      datePart = date.toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
      break;
    case "iso":
    default:
      datePart = `${Y}-${M}-${D}`;
      break;
  }

  let timePart;
  if (timeFormat === "12h") {
    const h = date.getHours();
    const h12 = h % 12 === 0 ? 12 : h % 12;
    const ampm = h < 12 ? "AM" : "PM";
    timePart = `${h12}:${pad(date.getMinutes())} ${ampm}`;
  } else {
    timePart = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  return `${datePart} ${timePart}`;
}
