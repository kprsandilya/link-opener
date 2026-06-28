# Installing Link Opener Permanently

The "Load Temporary Add-on…" flow in the README is great for development, but
those add-ons are **removed every time Firefox restarts**. To install Link
Opener permanently, the extension must be **packaged and signed**. Firefox
(release and Beta) refuses to permanently install unsigned extensions.

This guide covers every supported route, from the recommended signed build to
enterprise deployment and the Chromium port.

---

## TL;DR

| Goal | Best route |
|------|-----------|
| Install permanently on normal Firefox (just for you) | **Self‑distribution (unlisted) signing** via AMO + install the `.xpi` |
| Publish for everyone | **Listed** submission on [addons.mozilla.org](https://addons.mozilla.org) |
| Tinker without signing | **Firefox Developer Edition / Nightly / ESR** with signature enforcement off |
| Company‑wide rollout | **Enterprise policy** (`policies.json`) |
| Chrome / Edge | Repackage for the Chrome Web Store (see end) |

---

## 0. Prerequisites

- A [Firefox Add-ons (AMO) account](https://addons.mozilla.org) — free.
- [Node.js](https://nodejs.org) 18+ (for the `web-ext` tooling).
- Mozilla's official CLI:

```bash
npm install --global web-ext
```

Run all commands from the project root (the folder containing `manifest.json`).

---

## 1. Pre‑flight: verify the manifest

Permanent installs **require** a stable extension ID. Link Opener already
declares one, so confirm `manifest.json` contains:

```json
"browser_specific_settings": {
  "gecko": {
    "id": "link-opener@extension",
    "strict_min_version": "142.0",
    "data_collection_permissions": {
      "required": ["none"]
    }
  }
}
```

> Tip: For a real public listing, consider an ID based on a domain you control,
> e.g. `link-opener@yourdomain.com`. Changing the ID later creates a *different*
> add-on, so pick it before your first signed build.

Bump the `"version"` field for **every** new signed build — AMO rejects
duplicate version numbers.

---

## 2. Lint the package

Catch manifest and API problems before submitting:

```bash
web-ext lint
```

Fix any **errors** (warnings are usually fine). Common things it checks: unused
permissions, invalid manifest keys, and disallowed APIs.

---

## 3. Build an unsigned package (optional sanity step)

```bash
web-ext build
```

This produces `web-ext-artifacts/link_opener-<version>.zip`. You don't install
this zip directly; it's just the artifact that gets signed in the next step.

---

## 4A. Self‑distribution — install permanently *for yourself* (recommended)

This signs the add-on as **unlisted**, so it is **not** published in the public
gallery but *is* trusted by normal Firefox.

1. Create API credentials at
   <https://addons.mozilla.org/developers/addon/api/key/>. You'll get:
   - an **JWT issuer** (`AMO_JWT_ISSUER`)
   - an **JWT secret** (`AMO_JWT_SECRET`)

2. Sign:

```bash
web-ext sign \
  --channel=unlisted \
  --api-key="<AMO_JWT_ISSUER>" \
  --api-secret="<AMO_JWT_SECRET>"
```

On Windows PowerShell, use backticks (`` ` ``) instead of `\` for line
continuation, or put it all on one line.

3. After a minute or two you'll get a **signed `.xpi`** in
   `web-ext-artifacts/`.

4. Install it permanently:
   - Open `about:addons`.
   - Click the **gear ⚙ → Install Add-on From File…**.
   - Select the signed `.xpi`.

   *(Or just drag the `.xpi` onto a Firefox window.)*

The add-on now survives restarts. To update later, bump the version, re‑sign,
and install the new `.xpi` over the old one.

> **Self‑hosted updates (optional):** add an `update_url` under
> `browser_specific_settings.gecko` pointing at an `updates.json` manifest you
> host, so installed copies auto-update. See
> [Updating extensions](https://extensionworkshop.com/documentation/manage/updating-your-extension/).

---

## 4B. Listed submission — publish for everyone

Use this to distribute through the public Firefox Add-ons gallery.

**Option 1 — Web UI**
1. Go to <https://addons.mozilla.org/developers/>.
2. **Submit a New Add-on** → upload the `.zip` from `web-ext build`.
3. Choose **"On this site"** (listed) distribution.
4. Fill in listing details (summary, description, screenshots, categories,
   privacy policy if applicable) and submit for review.

**Option 2 — CLI**
```bash
web-ext sign --channel=listed --api-key="..." --api-secret="..."
```

Listed add-ons go through Mozilla's review. Once approved, anyone can install
from your public listing and receive automatic updates.

### What reviewers will look at (Link Opener already fares well)
- **Permissions justification.** Be ready to explain each permission:
  - `storage` — saves window groups, UI state, and settings locally.
  - `tabs` — creates windows/tabs and reads tab URLs to export/auto‑save.
  - `alarms` — schedules periodic auto‑save / backups.
  - `downloads` — writes local backup files.
- **No remote code.** All scripts are local ES modules; there is no `eval`,
  remote `<script>`, or network fetch. This satisfies MV3's strict CSP.
- **Data handling.** Everything stays in `browser.storage.local`; nothing is
  transmitted. State that clearly in your privacy policy / data‑collection form.
- **Minified/obfuscated code** must be accompanied by sources — not an issue
  here since the code ships unminified.

---

## 5. Developer Edition / Nightly / ESR — run unsigned

For local tinkering **without** signing (these builds let you disable signature
enforcement; release/Beta Firefox do not):

1. Use **Firefox Developer Edition**, **Nightly**, or **ESR**.
2. Open `about:config`.
3. Set `xpinstall.signatures.required` to **`false`**.
4. Install the `.xpi` (or zip) from `about:addons → Install Add-on From File…`.

> This is **not** available on standard Firefox release/Beta and is intended for
> development only.

---

## 6. Enterprise / managed deployment

For organizations rolling the add-on out to many machines, use an
[enterprise policy](https://mozilla.github.io/policy-templates/#extensionsettings).
Create a `policies.json` (or use Group Policy / Intune) like:

```json
{
  "policies": {
    "ExtensionSettings": {
      "link-opener@extension": {
        "installation_mode": "force_installed",
        "install_url": "https://your-server.example.com/link-opener.xpi"
      }
    }
  }
}
```

Place `policies.json` in the Firefox `distribution/` folder (next to the Firefox
binary) or deploy via your management tooling. Force‑installed add-ons still
need to be signed unless your org uses an unbranded/ESR configuration.

---

## 7. Packaging for Chrome / Edge (Chromium)

The code is structured to port easily (see the **Chromium compatibility**
section in `README.md`):

1. In `manifest.json`, switch the background entry from
   `"scripts": ["background.js"]` to `"service_worker": "background.js"`, and
   remove `browser_specific_settings`.
2. Zip the project folder.
3. Upload to the
   [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
   (one‑time registration fee) and submit for review. Edge uses the
   [Microsoft Partner Center](https://partner.microsoft.com/dashboard/microsoftedge).

For local Chromium installs, enable **Developer mode** at `chrome://extensions`
and use **Load unpacked** (the Chromium equivalent of a temporary add-on).

---

## Quick reference

```bash
# one-time
npm install --global web-ext

# every release
# 1) bump "version" in manifest.json
web-ext lint
web-ext build
web-ext sign --channel=unlisted --api-key="$AMO_JWT_ISSUER" --api-secret="$AMO_JWT_SECRET"
# 2) install the resulting .xpi via about:addons → Install Add-on From File…
```

### Useful links
- Extension Workshop — Distribution: <https://extensionworkshop.com/documentation/publish/>
- `web-ext` reference: <https://extensionworkshop.com/documentation/develop/web-ext-command-reference/>
- Signing & distribution: <https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/>
