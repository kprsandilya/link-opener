# Link Opener

![Manifest](https://img.shields.io/badge/Manifest-V3-7c5cff)
![Firefox](https://img.shields.io/badge/Firefox-142%2B-FF7139?logo=firefoxbrowser&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-34d399)
![No data collection](https://img.shields.io/badge/Data%20collection-none-2bd4ff)

A polished **Firefox Manifest V3** extension for **saving and reopening browser sessions**.

Link Opener turns lists of URLs into browser windows — and turns your open windows back into editable, shareable URL lists. Each **URL list corresponds to one browser window**, and every URL becomes its own tab.

> **Privacy first:** everything stays on your machine in `browser.storage.local`. The extension makes **no network requests**, runs **no remote code**, uses **no host permissions**, and **never reads page content**.

---

## Contents

- [Features](#features)
- [Settings](#settings)
- [Installation (temporary, for development)](#installation-temporary-for-development)
- [Installing permanently](#installing-permanently)
- [Permissions used](#permissions-used)
- [Project structure](#project-structure)
- [How it works](#how-it-works)
- [Development](#development)
- [Chromium compatibility](#chromium-compatibility)
- [Regenerating icons](#regenerating-icons)
- [License](#license)

---

## Features

### Window groups
- Add, delete, duplicate, and collapse/expand window groups.
- Groups are auto-numbered (`Window 1`, `Window 2`, …) and renamable.
- Live counters for **total windows** and **total links**.

### URL input
Each window has a textarea where you paste one URL per line. On open, Link Opener:
- Trims whitespace and **ignores blank lines**.
- **Prepends `https://`** when the scheme is omitted (`github.com` → `https://github.com`).
- **Skips invalid URLs gracefully** and shows an inline notice listing what was skipped — valid URLs still open.

### Open links
Clicking **Open Links** (or your configured shortcut, by default `Ctrl`/`Cmd` + `Enter`):
- Opens links in a **new window per group**, the **current window**, or **merged** into the current window — configurable in Settings.
- Opens **every URL as a tab**, preserving order.
- Optionally **focuses the first** created window.
- Asks for confirmation before opening a large number of tabs (toggle + threshold configurable; defaults to 50).

### Export current session
**Export Current Windows** reads all of your open Firefox windows and converts each into an editable URL list. Internal pages (`about:*`, `moz-extension:*`, etc.) are always ignored; pinned tabs, private windows, and custom **ignore URL patterns** are configurable in Settings. You're prompted before it replaces unsaved editor contents.

### Copy & export
- Per window: **Copy**, **Copy as Markdown**, **Download as .txt**.
- Global: **Copy All Windows**, **Export Session as JSON**, **Import Session from JSON**.
- Copied output is simple newline-separated URLs for easy sharing.

### Import
- **Import .txt** — blank lines separate windows; otherwise the file becomes one window.
- **Import Session from JSON** — restores a previously exported session.

### Persistence
All window groups, URLs, and UI state (collapsed, names) are saved to `browser.storage.local` and restored automatically when you reopen the popup.

### Settings
A dedicated, full-page **Settings** experience (`settings.html`) opens in its **own browser tab** from the popup's gear button (or via *Manage Extension → Preferences*). It uses a two-column desktop layout — a left sidebar for category navigation and a scrollable content pane — with **search**, **sticky Save/Discard controls**, helper text, and a clearly indicated unsaved-changes state. Every preference is persisted to `browser.storage.local` and applied live across the popup and settings tab. Sections:

- **Opening Behavior** — open mode (new window / current window / merge), focus-first-window, and an optional large-open confirmation with a configurable threshold.
- **Saving** — include private windows, include pinned tabs, preserve tab groups, and wildcard **ignore URL patterns** (supports `*` and `?`).
- **Automatic Saving** — periodic snapshots at a configurable interval, save-on-window-close, retention limits, and a minimum tab count.
- **Export & Backup** — automatic local backup files (JSON or `.txt`, with a filename prefix), plus import/export of sessions **and** settings independently.
- **Interface** — light / dark / system theme, popup size, layout density, date/time formatting, smooth-animations toggle, and per-button toolbar visibility.
- **Power User** — fully customizable keyboard shortcuts and a reset-to-defaults action.

### Experience
Theme-aware (light / dark / system) premium UI with glassmorphism, soft gradients, rounded cards, smooth animations, toasts, and modal confirmations. Respects both `prefers-reduced-motion` and the in-app *Smooth animations* toggle.

---

## Installation (temporary, for development)

1. Open Firefox and navigate to `about:debugging`.
2. Click **This Firefox** in the sidebar.
3. Click **Load Temporary Add-on…**.
4. Select the `manifest.json` file inside the `link-opener` folder.
5. The Link Opener icon appears in the toolbar — click it to open the popup.

> Temporary add-ons are removed when Firefox restarts.

---

## Installing permanently

Permanent installation requires a **packaged, signed** build (release/Beta Firefox refuses unsigned extensions). The full process — signing with `web-ext`, self-distribution, publishing to AMO, enterprise deployment, and the Chromium port — is documented in **[PUBLISHING.md](PUBLISHING.md)**.

---

## Permissions used

| Permission | Why it's needed |
|-----------|-----------------|
| `storage` | Persist your window groups, UI state, and settings via `browser.storage.local`. |
| `tabs`    | Create windows/tabs when opening links, and read tab URLs when exporting or auto-saving your session. |
| `alarms`  | Schedule periodic automatic saves / backups at your chosen interval. |
| `downloads` | Write automatic local backup files to your downloads folder. |

No host permissions are requested; the extension never reads page content.

---

## Project structure

```
link-opener/
├── manifest.json       # MV3 manifest (action popup + options page + background)
├── popup.html          # Popup markup + window-group template
├── popup.css           # Premium, theme-aware popup UI
├── popup.js            # Popup UI logic, persistence, messaging, settings glue
├── settings.html       # Full-page settings (two-column layout)
├── settings.css        # Settings UI (light/dark/system, density, responsive)
├── settings.js         # Settings page logic (bind/search/save/import/export)
├── settings-store.js   # Settings schema, defaults, load/save/merge + theming
├── storage.js          # Promise wrapper around browser.storage.local (sessions)
├── utils.js            # Pure helpers: URL parsing, wildcards, date formatting…
├── background.js       # Window/tab opening, session export, auto-save/backup
├── icons/              # 16 / 32 / 48 / 128 px PNG icons (+ generator script)
└── README.md
```

---

## How it works

- **`popup.js`** is the UI layer. It renders window cards, keeps the DOM as the
  source of truth while editing, and serializes that DOM into state for
  persistence (debounced) on every change.
- **`utils.js`** holds pure, testable helpers — most importantly `parseUrlList`,
  which normalizes/validates lines into `{ valid, invalid }`.
- **`storage.js`** centralizes session persistence so the rest of the app is
  unaware of the storage backend.
- **`settings-store.js`** is the single source of truth for preferences: the
  default schema, deep-merge load/save (so older saved settings gain new fields
  gracefully), a live `onSettingsChanged` subscription, and the shared
  `applyInterfaceSettings` used by both the popup and the settings page.
- **`background.js`** owns all privileged browser interactions. The popup sends
  it messages:
  - `OPEN_SESSIONS` → opens URL lists honoring the chosen open mode (new window /
    current window / merge) and focus preference.
  - `EXPORT_SESSION` → reads open windows and returns filtered URL groups
    (respecting pinned/private/ignore-pattern settings).

  It also runs the **automatic-save / backup** subsystem: an `alarms`-driven
  periodic snapshot, a best-effort snapshot when a window closes, retention
  pruning, and optional backup files written via the `downloads` API. This all
  runs in the background because creating multiple windows from a popup can
  close the popup mid-loop.

---

## Development

The project is dependency-free vanilla JS/HTML/CSS — there's no build step. For
linting, live-reloading, and packaging, Mozilla's [`web-ext`](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/)
CLI is recommended:

```bash
npm install --global web-ext   # one-time

web-ext lint                   # validate the manifest + sources (0 warnings)
web-ext run                    # launch a temporary Firefox with the add-on loaded
web-ext build                  # produce a distributable .zip in web-ext-artifacts/
```

See **[PUBLISHING.md](PUBLISHING.md)** for signing and distribution.

---

## Chromium compatibility

The code targets Firefox's promise-based `browser.*` APIs but is structured to
port easily:

- Every file that touches extension APIs uses a one-line shim:
  ```js
  const api = typeof browser !== "undefined" ? browser : chrome;
  ```
- For Chromium, switch the background entry in `manifest.json` from
  `"scripts": ["background.js"]` to `"service_worker": "background.js"`, and
  remove `browser_specific_settings`.

---

## Regenerating icons

The PNGs are produced from `icons/generate-icons.ps1` (Windows / .NET GDI+):

```powershell
powershell -ExecutionPolicy Bypass -File icons/generate-icons.ps1
```

---

## License

[MIT](LICENSE) — free to use, modify, and share.
