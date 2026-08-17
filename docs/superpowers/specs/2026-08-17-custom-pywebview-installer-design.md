# Custom pywebview installer — design

## Status
Proposed. Not yet implemented.

## Goal
Replace the Inno Setup–generated installer (`installer/installer.iss`) with a
self-built installer that renders in the app's own frameless HTML/CSS/JS
design system — the same visual language as `desktop_app.py`/`webapp/` —
instead of a themed-but-still-native Win32 dialog wizard.

## Why (context)
The current installer (`installer/installer.iss`, built via
`installer/build_installer.bat` + Inno Setup 6/ISCC) already goes fairly far
in reskinning Inno's wizard: custom wizard art generated from `favicon.png`
(`installer/gen_assets.py`), `WizardStyle=modern`, a WebView2 bootstrap flow,
etc. But Inno's wizard is fundamentally native Win32 dialog controls
rendered via GDI — there is no supported way to get real CSS-style
animation, custom fonts beyond what GDI renders, or fully custom-styled
buttons without fragile owner-draw/hidden-button hacks. Top-tier installers
that *do* look fully custom (Adobe, enterprise WiX/Burn installers) achieve
it by using a real UI rendering framework (WPF/XAML) for the installer
itself, not by reskinning a classic wizard tool. For this repo, the
equivalent — and the smallest net-new tech, since it's already built and
proven in `desktop_app.py`/`webapp/` — is a second pywebview app that IS the
installer.

## Non-goals
- Not changing the main app (`desktop_app.py`/`webapp/`) itself.
- Not attempting to keep Inno Setup as a fallback/dual path long-term —
  once the new installer is verified working, `installer.iss` and the Inno
  build step are removed rather than kept as dead code.
- Not adding a license-acceptance page (the app has none today; no reason
  to invent one).
- Not building an MSI or supporting silent enterprise deployment tooling
  beyond what's needed for `/SILENT` auto-update (see below) — out of
  scope unless requested later.

## Architecture

A new sibling entry point, `installer_app.py` (repo root, alongside
`desktop_app.py`), built the same way the main app is: pywebview,
`edgechromium`/WebView2 backend, frameless window with the app's own
custom titlebar/drag/resize chrome. It hosts a new `webapp_installer/`
(HTML/CSS/JS, no build step — same philosophy as `webapp/`) that reuses the
main app's actual font files (`webapp/assets/fonts/`) and color/type
tokens from `webapp/style.css` so the two apps are visually one family.

The built `dist\DeltaDataValidation\*` (the main app's `--onedir` PyInstaller
output) is embedded into the installer's own PyInstaller build via
`--add-data`, so the installer carries the whole app payload inside itself
— functionally the same as how Inno's `Setup.exe` embeds `[Files]` today.

Unlike the main app (`--onedir`, to avoid the first-launch AV-rescan delay
described in `README.md`'s "Fixed: first-launch delay" section), the
installer is built `--onefile`: it runs once and exits, so onefile's
per-launch self-extraction cost doesn't apply, and a single downloadable
`.exe` is the better trade for something users download once.

## Components

1. **`installer_app.py`** — window host + an `Api` class:
   - `check_webview2()` — registry check, same logic as `installer.iss`'s
     `[Code]` section today.
   - `install(want_desktop_shortcut: bool)` — runs on a background thread
     (same pattern as `desktop_app.py`'s `run_validation`), pushes progress
     via `window.evaluate_js(...)` the same way the main app's progress bar
     and the auto-updater's download progress already do. Steps, in order:
     1. If WebView2 missing: download Microsoft's bootstrapper
        (`https://go.microsoft.com/fwlink/p/?LinkId=2124703`, same URL
        `installer.iss` uses today) and run it silently.
     2. Wipe `{app}\_internal` if it exists (upgrade case — same reasoning
        as `installer.iss`'s `[InstallDelete]` today: `--onedir`'s support
        folder can gain/lose/rename files between versions).
     3. Copy the embedded payload to
        `%ProgramFiles%\DELTA Data Validation Console`.
     4. Copy the running installer exe itself into the install directory as
        `uninstall.exe` (enables uninstall to work even after the original
        downloaded installer is deleted — mirrors Inno's own `unins000.exe`
        pattern).
     5. Write Start Menu shortcut (and Desktop shortcut if requested) via
        `pywin32`'s `win32com.client.Dispatch("WScript.Shell")
        .CreateShortCut(...)`.
     6. Write the Add/Remove Programs registry entry (see below).
   - `run_app()` — launches the freshly installed exe (Finish-screen
     "Launch DELTA", opt-out checkbox — same UX as today).
   - Window chrome methods (`minimize_window`, `close_window`, etc.) —
     copied from `desktop_app.py`'s existing implementations; no new
     design needed there.
   - `--uninstall` CLI flag: when `installer_app.py`/`uninstall.exe` is
     launched with this flag, `main()` skips the installer UI and instead
     removes the install directory, shortcuts, and registry key. (A minimal
     confirmation UI or none at all — TBD in the implementation plan; not
     a design-relevant decision.)

2. **`webapp_installer/`** — `index.html` / `style.css` / `app.js`, no
   build step, same philosophy as `webapp/`. Screens: Welcome → Options
   (desktop-shortcut checkbox) → Install (progress) → Finish (launch
   checkbox). Reuses `webapp/assets/fonts/` (bundled into this build too,
   not duplicated in git) and the app's ink-black/cream/hazard-orange
   palette and "inspection-manifest" visual language from `webapp/style.css`.

3. **Add/Remove Programs registry entry** — written under
   `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\` using the
   **same GUID** `installer.iss` already defines
   (`{86CD3451-B490-4BBE-B2DF-9AA40F6FCFCD}`), so Windows continues to treat
   this as the same application across the switch from Inno to the new
   installer (no duplicate Add/Remove Programs entries, existing installs
   upgrade cleanly). Fields: `DisplayName`, `DisplayVersion` (from
   `VERSION`), `Publisher` = "Mythics LLC", `DisplayIcon`, `UninstallString`
   (`"{app}\uninstall.exe" --uninstall`), `InstallLocation`,
   `EstimatedSize`, `NoModify=1`, `NoRepair=1`.

4. **Elevation** — PyInstaller's `--uac-admin` flag (embeds a manifest
   requesting `requireAdministrator`), same effect as `installer.iss`'s
   `PrivilegesRequired=admin`.

## Data flow

User downloads and double-clicks `DeltaDataValidation_Setup.exe` → Windows
UAC prompt (admin, via the embedded manifest) → frameless welcome window
appears (window creation follows the same hidden-until-painted pattern
`desktop_app.py` already uses, so there's no flash of blank window) → user
clicks through Options → Install triggers the background thread described
above, streaming progress into the same window → Finish screen offers
"Launch DELTA" and closes.

## Error handling

Unlike the main app's auto-updater (which silently swallows failures to
stay usable offline — see `desktop_app.py`'s `_check_for_updates_worker`),
**installer failures must not be silent**. Any step failing (WebView2
download, file copy blocked by AV/permissions, registry write failure)
surfaces as a real error state in the installer UI with the underlying
exception message. A silently-"successful" broken install is a worse
outcome than a visible, actionable failure.

## Build & CI changes

- New `installer/build_installer_app.bat` (or equivalent), replacing
  `installer/build_installer.bat`'s Inno invocation, driving PyInstaller
  with `--onefile --uac-admin`, `--add-data` for both the app payload and
  `webapp/assets/fonts/`, output named to keep the existing
  `dist\DeltaDataValidation_Setup.exe` path/name so nothing downstream
  (the auto-updater's `UPDATE_ASSET_SUFFIX` matching, `.github/workflows/
  release.yml`'s `files:` reference) needs to change.
- `.github/workflows/release.yml`'s "Build installer (Inno Setup)" step is
  replaced with a step running the new build script. No other workflow
  changes needed — `bump-version.yml` and the version-consistency check in
  `release.yml` are unaffected.
- `installer/installer.iss`, `installer/build_installer.bat`, and
  `installer/gen_assets.py` are removed once the new installer is verified
  working end-to-end (see Rollout below) — not kept as an unused fallback.

## Testing / verification plan

I cannot visually drive a native Windows installer window myself in this
environment (no GUI-automation tool available for a non-browser desktop
app, unlike the main app which could be reasoned about via its HTML). Plan:

1. `installer_app.py --selftest`: runs the `install()` logic against a
   temp directory instead of real Program Files, and skips/mocks the
   registry + shortcut steps (or writes them under a disposable test key) —
   exits 0/1, mirroring `desktop_app.py --selftest`. This lets CI smoke-test
   the file-copy/payload-embedding logic unattended.
2. CI builds the real installer artifact.
3. **You** download and run the actual built installer on a real Windows
   machine, confirm the visual result and that install/uninstall/upgrade
   actually work, and report back (screenshots or a description of what's
   wrong). At least one iteration round on the real UI should be expected.

## Rollout plan

Implemented and merged to `main` behind normal review — but **`release.yml`
is not switched over to the new installer step until you've confirmed a
real downloaded build installs, launches, and uninstalls correctly** on an
actual Windows machine. Until that confirmation, CI can build the new
installer as a separate/manual-dispatch artifact for testing without it
becoming the thing `bump-version.yml`/tags actually publish. Once
confirmed, swap `release.yml`'s build step and delete the Inno Setup files
in the same change.

## Open questions for the implementation plan (not blocking this design)

- Exact uninstall-confirmation UI (a themed confirm screen vs. none) —
  cosmetic, decide during implementation.
- Whether `pywin32`'s COM-based shortcut creation needs any special
  handling under PyInstaller `--onefile` (it's a common, well-supported
  pattern, but worth a real test rather than assuming).
