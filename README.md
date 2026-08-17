# DELTA — Data Validation Console

A single-file Windows `.exe` with a fully animated, modern desktop UI for
comparing two data exports (Source vs Target) column-by-column — no FastAPI
server, no browser tab required, and your data never leaves the machine.

Originally split out of Mythics' `Project_Charlie_Main` monorepo, where the
same comparison engine is called "post-validation" (`Server/Main.py`'s
`_run_validation_job`) — `validation_core.py` here is a dependency-free port
of that logic with no shared import, so if that engine changes upstream this
needs to be re-diffed and re-ported by hand.

The window is frameless with no OS titlebar; the app draws and themes its
own, including the minimize/maximize/close controls.

**The only network call anywhere in this app** is a startup check against
this repo's GitHub Releases to see if a newer version is available (see
[Auto-update](#auto-update) below) — nothing about your files, your
comparisons, or their results is ever transmitted anywhere.

## Architecture

| File / folder | Purpose |
|---|---|
| `validation_core.py` | The comparison engine. A faithful, dependency-free port of `_run_validation_job` from `Server/Main.py`. Includes the blank-vs-blank null/NaN fix described below. |
| `desktop_app.py` | Native window host (pywebview, `edgechromium`/WebView2 backend). Frameless window, hidden until the themed UI has painted. Exposes a small JS API (`Api` class) the frontend calls — file pickers, the validation run itself (background thread, progress streamed back via `window.evaluate_js(...)`), and window chrome (minimize/maximize/close/resize) for the custom titlebar. |
| `webapp/index.html` / `style.css` / `app.js` | The UI itself — plain HTML/CSS/vanilla JS (no build step, no framework, no CDN). Includes the custom OS titlebar and frameless-window resize handles. Self-hosted fonts in `webapp/assets/fonts/`. |
| `build_exe.bat` | Builds `dist\DeltaDataValidation.exe`. |
| `requirements.txt` | Python deps needed to run from source or build the exe. |

**Why a webview instead of Tkinter:** Tkinter can't produce the kind of
animated, modern interface that was asked for. pywebview renders the UI in
the OS's built-in WebView2 control (Windows 11 ships this; Windows 10 gets it
via Edge auto-update), so we get real CSS animations/gradients/transitions
without bundling a Chromium runtime — the exe stays a single file and a
reasonable size.

## Running from source

```
pip install -r requirements.txt
python desktop_app.py
```

## Building the exe

```
build_exe.bat
```

Output: `dist\DeltaDataValidation\DeltaDataValidation.exe` plus its
`_internal\` support folder (`--onedir` — see "Fixed: first-launch delay"
below for why it's a folder, not a single file). Requires the Microsoft
Edge WebView2 Runtime on the machine it runs on (already present on
Windows 11 and most updated Windows 10 installs — Windows itself uses it
for Search/Widgets, so in practice it's essentially always there; the
installer below handles it automatically either way).

## Building the installer

For distributing the app to other machines rather than running the raw exe,
`installer/` builds a proper Windows installer with [Inno Setup 6](https://jrsoftware.org/isinfo.php)
(`ISCC.exe` must be installed — `winget install JRSoftware.InnoSetup`):

```
build_exe.bat
installer\build_installer.bat
```

Output: `dist\DeltaDataValidation_Setup.exe`. It:
- Installs to `Program Files\DELTA Data Validation Console` (needs admin —
  Windows always requires elevation to write there) and registers a normal
  uninstaller entry in Apps & Features.
- Uses a wizard themed in the app's own palette (`installer/assets/`,
  regenerated from the repo-root `favicon.png` by `installer/gen_assets.py`
  — re-run it if the logo changes).
- Detects whether the Microsoft Edge WebView2 Runtime is already present
  (registry check) and, only if it's missing, downloads and silently runs
  Microsoft's official bootstrapper before launching the app for the first
  time — most machines already have it and skip this entirely.
- Offers a desktop shortcut (opt-in checkbox) and launches the app on
  finish (opt-out checkbox).

`installer/installer.iss`'s `AppVersion` and this app's `VERSION` file must
be bumped together by hand — Inno Setup's preprocessor has no plain-text
file-read primitive, so there's no single source of truth for the version
string.

## Auto-update

On every launch, once the UI is visible, `desktop_app.py`'s
`Api.check_for_updates()` does a single `GET` against
`api.github.com/repos/MythicsLLC/delta-data-validation/releases/latest`
(6s timeout, `urllib.request` — no extra dependency) and compares its
`tag_name` against the bundled `VERSION` file. Any failure — offline,
DNS, GitHub rate limit, whatever — is swallowed silently; there is no
error state for "couldn't check," because staying usable offline is the
whole point of the app.

If the release is newer and has a `*_Setup.exe` asset attached, a GitHub-
Desktop-style banner slides in (`__onUpdateAvailable` → `webapp/app.js`)
with **Update & Restart** / **Later**. Clicking Update:

1. Downloads the installer to `%TEMP%`, streaming progress into the banner.
2. Spawns a small detached `cmd.exe` helper that waits ~2s, runs the new
   installer with `/SILENT /NORESTART /SUPPRESSMSGBOXES`, then launches the
   freshly-installed exe. It's detached specifically so it outlives step 3.
3. Closes this app's own window — which goes through the same clean-
   shutdown path as a normal close (`window.events.closing`/`closed` in
   `main()`, ending in `os._exit(0)`).

`installer.iss` also sets `CloseApplications=yes` as a safety net for
someone manually re-running `Setup.exe` while the app happens to be open —
by the time that matters in the auto-update flow above, step 3 has already
closed it, so it's a no-op in practice.

**Cutting a release** that the auto-updater will pick up: bump `VERSION`
and `installer/installer.iss`'s `AppVersion` together, rebuild
(`build_exe.bat` then `installer\build_installer.bat`), then
`gh release create vX.Y.Z dist/DeltaDataValidation_Setup.exe --title vX.Y.Z --notes "..."`
— the tag must be `vX.Y.Z` (the updater strips a leading `v` before
comparing) and the asset filename must keep the `_Setup.exe` suffix.

## Design

The UI is a deliberate departure from the generic "dark glow SaaS dashboard"
look: a brutalist **inspection-manifest** aesthetic — cream paper, ink-black
borders, hard offset "sticker" shadows (no blur/glow anywhere), one hazard-
orange accent, Archivo (display) + JetBrains Mono (data), self-hosted so
there's zero font CDN dependency at runtime. Motion reads mechanical rather
than soft: panels slide in like cards being stamped down, the progress bar
is a punch-ticket strip of ticks filling in, result counts roll up digit by
digit like an odometer, and the success/error banners land with a rubber-
stamp thud instead of a fade.

## Custom titlebar

The window is created with `frameless=True` — there is no OS titlebar at
all. `webapp/index.html`'s `.ostitlebar` is drawn in its place: same ink-
black/cream palette as the rest of the app, with minimize/maximize/close
buttons wired to `pywebview.api.minimize_window()` /
`toggle_maximize_window()` / `close_window()` in `desktop_app.py`.

- **Dragging**: only the `.ostitlebar__drag` element (the icon + title,
  marked with pywebview's `.pywebview-drag-region` class) is draggable —
  not the whole strip — so the control buttons stay independently
  clickable. Double-clicking it toggles maximize, same as a native titlebar.
- **Resizing**: frameless WinForms windows have no native resize border, so
  `index.html` overlays thin invisible edge/corner handles (`.ez`) that
  stream `(edge, width, height)` to `Api.resize_window()` while dragged
  (throttled to one call per animation frame). Handles are disabled while
  maximized.
- **Maximize icon**: swaps between a single square and an overlapped-
  squares "restore" glyph, tracked locally in `Api._maximized` (there's no
  synchronous "is this window maximized" query in this pywebview version,
  so state is tracked rather than polled).

## Using the app

On first launch (and every launch thereafter, unless "Don't show this again"
is checked) a welcome dialog introduces the app before the main console.
Dismiss it via **Begin Audit**, the **×** button, clicking outside it, or
<kbd>Esc</kbd>.

1. **Files** — click (or drag onto) the Source/Target panels to pick files
   via the native file dialog; pick a sheet if the workbook has more than
   one. *(Drag-and-drop only shows the visual drop animation — the browser
   File API can't expose an OS path for a dropped file, so dropping opens
   the native picker instead of silently failing.)*
2. **Mapping** — click **Load Columns**. Each Source column gets an
   auto-suggested Target column (exact name match after normalizing case/
   punctuation); override any of them via the dropdown. Flag **Key**
   columns (at least one required, each needs a Target mapping), **Date**
   columns (auto-detection also runs on unflagged columns, same as the
   server), and **Include** for context-only columns.
3. **Options** — labels, case sensitivity, whether to include a full
   side-by-side data sheet, and the output folder.
4. **Run** — live ticket-strip progress + terminal-style log; on completion
   you get odometer-style stat cards (discrepancies / missing-in-each-side /
   records affected) and **Open Report** / **Open Output Folder** buttons.
   If a sheet would exceed Excel's row cap, the full data is also written to
   a sibling `.csv` (same behavior as the server's large-dataset path).

### Note on column-mapping suggestions

The web app's mapping suggestion calls Gemini (AI) over the network — not
appropriate for an offline tool. This app uses a transparent local heuristic
(normalize + exact match on column name) instead, with full manual override.
The **comparison engine itself** (cleaning, normalization, diffing) is
unchanged from the server.

### Bugfix carried over from the server

`_pl_clean_num_expr` in `validation_core.py` leaves blank numeric cells as
`""` so they cast to a Polars **null**, not the float `NaN`. Polars compares
`NaN` using total ordering, so `NaN > 0.0001` is `True` — mapping blanks to
the literal string `"NaN"` (the server's old behavior) made two blank cells
on both sides of a row register as a false-positive discrepancy. The diff
logic's null-aware XOR check (`cn.is_null() ^ co_expr.is_null()`) relies on
this.

## Self-test

`DeltaDataValidation.exe --selftest` runs a small synthetic validation
end-to-end (including a real `.xlsx` round-trip through the bundled
`python-calamine`/`fastexcel` Excel engine) with no GUI, and writes
`PASS=True`/`PASS=False` plus details to `%TEMP%\pva_selftest_result.txt`,
exiting 0/1 accordingly. Useful for confirming a new build's bundled
dependencies work without waiting on the GUI window.

## Window lifecycle: opening and closing

**Opening:** the window is created hidden (`hidden=True`) and only shown
once `webview.events.loaded` fires — i.e. once the themed UI has actually
painted. This avoids a flash of blank/default window chrome between the
process starting and the custom titlebar/theme appearing.

**Closing:** `window.events.closing` sets the validation cancel flag
(best-effort — stops the background thread from writing to an output file
after the user has asked to close), and `window.events.closed` forces an
immediate `os._exit(0)`. PyInstaller-frozen WebView2/pythonnet apps can
otherwise leave COM/background threads alive after the window itself has
disappeared; forcing the exit here means the process in Task Manager
disappears in sync with the window, every time you close normally (custom
title-bar × button, Alt+F4, or the taskbar close action all route through
the same WinForms `FormClosing`/`FormClosed` events pywebview listens on).

This does **not** cover force-killing the process itself (Task Manager "End
task", killing it from a script) — that bypasses Python entirely, so a
force-killed launch can still leave an orphaned `msedgewebview2.exe` child
behind (killing a parent doesn't kill its children). Close the app normally
instead of force-killing it if you're testing repeatedly.

## Fixed: first-launch delay (was PyInstaller `--onefile`)

Earlier builds used PyInstaller `--onefile`, which self-extracts the entire
bundle to a fresh `%TEMP%` folder on **every single launch** before Python
even starts. On a Defender-managed endpoint that meant antivirus real-time
scanning a freshly-written extraction on every launch — anywhere from
~10 seconds to over a minute before the window appeared, varying by AV
engine state, not anything in the app itself.

`build_exe.bat` now uses `--onedir` instead: PyInstaller writes the exe and
its support files once, and `installer.iss` installs that whole folder into
Program Files. There's no per-launch extraction step at all anymore, so
there's nothing for AV to re-scan on the 2nd, 3rd, ... launch — only
whatever one-time scan Defender does of a freshly-installed program, same
as any other Windows software. The `--onefile` "single .exe" convenience
wasn't actually buying anything once distribution moved to a proper
installer (`installer/`) instead of handing someone a bare .exe to run
directly, so there was no real tradeoff in dropping it.

**Still true regardless of onefile/onedir**, for anyone running an unsigned
build outside the installer (e.g. iterating from `dist\` during
development): code-signing the exe is the standard way to avoid antivirus
scrutiny of a newly-built binary if you ever need to hand one around
directly; a Defender exclusion on your build/`dist` folder is a dev-only
substitute, not something to ask end users to do.

A defensive fix is included for a separate, unrelated `--noconsole` gotcha:
PyInstaller windowed builds have `sys.stdout`/`stderr`/`stdin` set to `None`
(no console attached), which can break library startup/error-reporting code
that assumes a real stream. `desktop_app.py` patches these to `os.devnull`
streams before importing `webview` if frozen.
