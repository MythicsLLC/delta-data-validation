"""
DELTA — Data Validation Console — desktop host
================================================
Hosts the HTML/CSS/JS frontend (webapp/) in a native, frameless window via
pywebview (WebView2 on Windows — no Chromium bundling, no network calls at
runtime). The window has no OS titlebar; webapp/index.html draws its own,
themed to match the app, and this module exposes the window-chrome API
(minimize/maximize/close/resize) that titlebar drives via
`pywebview.api.<method>()`. See webapp/app.js for the exact contract this
implements.

Packaged into a single .exe with PyInstaller (see build_exe.bat).
"""

import os
import sys
import json
import threading
import traceback

# PyInstaller --noconsole (windowed subsystem) builds have no console, so
# sys.stdout/stderr/stdin are None. Some library startup/error-reporting
# paths assume a real file-like stream and can raise or misbehave on None.
# Patch them to harmless no-op streams before importing webview/pythonnet.
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w")
if sys.stdin is None:
    sys.stdin = open(os.devnull, "r")

import webview
from webview.window import FixPoint

import validation_core as vc

APP_TITLE = "DELTA — Data Validation Console"
DEFAULT_WIDTH = 1180
DEFAULT_HEIGHT = 860
MIN_WIDTH = 900
MIN_HEIGHT = 640


def _resource_path(*parts: str) -> str:
    """Resolve a path to a bundled resource, working both from source and
    from a PyInstaller --onefile exe (where data files are extracted to
    sys._MEIPASS at runtime)."""
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, *parts)



# pywebview validates each entry against r'^([\w ]+)\((\*\.\w+...)\)$' — the
# description part may only contain word characters and spaces. A "/" (as in
# "Excel / CSV") fails that regex and create_file_dialog() raises before the
# dialog ever opens, breaking file picking entirely. Keep these alphanumeric.
FILE_TYPES = ("Excel and CSV Files (*.xlsx;*.xls;*.csv)", "All files (*.*)")


class Api:
    """Methods callable from JS as `pywebview.api.<name>(...)`.

    Long-running work (run_validation) is dispatched to a background thread
    so the webview's message loop is never blocked; progress/completion are
    pushed back to JS via `window.evaluate_js(...)` callbacks instead of a
    return value.
    """

    # Maps a resize-handle edge id (from the frontend) to the FixPoint that
    # keeps the opposite edge/corner stationary while that edge is dragged.
    _RESIZE_FIX_POINTS = {
        "e":  FixPoint.NORTH | FixPoint.WEST,
        "s":  FixPoint.NORTH | FixPoint.WEST,
        "se": FixPoint.NORTH | FixPoint.WEST,
        "w":  FixPoint.NORTH | FixPoint.EAST,
        "sw": FixPoint.NORTH | FixPoint.EAST,
        "n":  FixPoint.SOUTH | FixPoint.WEST,
        "ne": FixPoint.SOUTH | FixPoint.WEST,
        "nw": FixPoint.SOUTH | FixPoint.EAST,
    }

    def __init__(self):
        self._window: webview.Window | None = None
        self._cancel_event: threading.Event | None = None
        self._run_lock = threading.Lock()
        self._maximized = False

    def set_window(self, window: webview.Window):
        self._window = window

    # ---- custom titlebar / window chrome ------------------------------
    # The window is frameless (see main()) so webapp/index.html draws its
    # own titlebar; these are the only way it can move/resize/minimize/
    # maximize/close the OS window.

    def minimize_window(self):
        self._window.minimize()
        return {"ok": True}

    def toggle_maximize_window(self):
        if self._maximized:
            self._window.restore()
            self._maximized = False
        else:
            self._maximized = True
            self._window.maximize()
        return {"ok": True, "maximized": self._maximized}

    def close_window(self):
        self._window.destroy()
        return {"ok": True}

    def resize_window(self, edge: str, width: int, height: int):
        """Drive edge/corner drag-resize from the frontend. Frameless
        WinForms windows have no native resize border, so index.html draws
        thin invisible resize handles and streams (edge, width, height)
        here while the user drags one."""
        if self._maximized:
            return {"ok": False}
        fix_point = self._RESIZE_FIX_POINTS.get(edge, FixPoint.NORTH | FixPoint.WEST)
        width = max(MIN_WIDTH, int(width))
        height = max(MIN_HEIGHT, int(height))
        self._window.resize(width, height, fix_point)
        return {"ok": True}

    # ---- file pickers ------------------------------------------------

    def pick_file(self, kind: str):
        result = self._window.create_file_dialog(
            webview.FileDialog.OPEN, allow_multiple=False, file_types=FILE_TYPES
        )
        if not result:
            return None
        path = result[0]
        return {"path": path, "name": os.path.basename(path)}

    def pick_output_dir(self):
        result = self._window.create_file_dialog(webview.FileDialog.FOLDER)
        if not result:
            return None
        return result[0]

    # ---- file introspection -------------------------------------------

    def list_sheets(self, path: str):
        try:
            return vc.list_sheets(path)
        except Exception as e:
            raise Exception(f"Could not list sheets: {e}")

    def read_columns(self, path: str, sheet=None):
        try:
            return vc.read_columns_only(path, sheet or None)
        except Exception as e:
            raise Exception(f"Could not read columns: {e}")

    # ---- validation run -------------------------------------------------

    def start_validation(self, params: dict):
        with self._run_lock:
            if self._cancel_event is not None:
                return {"ok": False, "error": "A validation is already running."}
            self._cancel_event = threading.Event()
            cancel_event = self._cancel_event

        thread = threading.Thread(
            target=self._run_worker, args=(dict(params), cancel_event), daemon=True
        )
        thread.start()
        return {"ok": True}

    def cancel_validation(self):
        if self._cancel_event is not None:
            self._cancel_event.set()
        return {"ok": True}

    def _run_worker(self, params: dict, cancel_event: threading.Event):
        def progress_cb(pct, stage):
            self._push("__onProgress", pct, stage)

        try:
            result = vc.run_validation(params, progress_cb=progress_cb, cancel_event=cancel_event)
            self._push("__onDone", result)
        except vc.ValidationCancelled:
            self._push("__onCancelled")
        except Exception as e:
            traceback.print_exc()
            self._push("__onError", str(e))
        finally:
            with self._run_lock:
                self._cancel_event = None

    def _push(self, js_fn: str, *json_args):
        """Call a window.<js_fn>(...) callback in the frontend with
        JSON-serializable args. Safe to call from a background thread."""
        if self._window is None:
            return
        encoded = ", ".join(json.dumps(a) for a in json_args)
        try:
            self._window.evaluate_js(f"{js_fn}({encoded})")
        except Exception:
            traceback.print_exc()

    # ---- misc -----------------------------------------------------------

    def open_path(self, path: str):
        try:
            os.startfile(path)
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def reveal_in_folder(self, path: str):
        try:
            os.startfile(os.path.dirname(path))
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}


def _run_selftest():
    """Headless diagnostic: exercises the real .xlsx (calamine) read path
    with no GUI window, so a frozen build's bundled dependencies can be
    confirmed working without waiting on window creation. Writes
    PASS=True/False + details to %TEMP%/pva_selftest_result.txt and exits
    with status 0/1 accordingly.
    """
    import tempfile
    import pandas as pd

    out_path = os.path.join(tempfile.gettempdir(), "pva_selftest_result.txt")
    tmp = tempfile.mkdtemp(prefix="pva_selftest_")
    try:
        src = pd.DataFrame({"EmpID": ["1", "2", "3"], "Salary": ["1000", "2000", ""]})
        tgt = pd.DataFrame({"EmpID": ["1", "2", "3"], "Pay": ["1000", "2500", ""]})
        src_path = os.path.join(tmp, "source.xlsx")
        tgt_path = os.path.join(tmp, "target.xlsx")
        src.to_excel(src_path, index=False)
        tgt.to_excel(tgt_path, index=False)

        params = {
            "legacy_path": src_path,
            "oracle_path": tgt_path,
            "legacy_filename": "source.xlsx",
            "oracle_filename": "target.xlsx",
            "mappings": {"EmpID": "EmpID", "Salary": "Pay"},
            "keyColumns": ["EmpID"],
            "includedColumns": [],
            "sourceLabel": "Source",
            "targetLabel": "Target",
            "caseSensitive": True,
            "output_dir": tmp,
        }
        result = vc.run_validation(params)
        ok = result["total_discrepancies"] == 1 and os.path.exists(result["output_path"])
        with open(out_path, "w") as f:
            f.write(f"PASS={ok}\nresult={result}\n")
        sys.exit(0 if ok else 1)
    except Exception:
        with open(out_path, "w") as f:
            f.write("PASS=False\n" + traceback.format_exc())
        sys.exit(1)
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--selftest":
        _run_selftest()
        return

    api = Api()
    window = webview.create_window(
        APP_TITLE,
        url=_resource_path("webapp", "index.html"),
        js_api=api,
        width=DEFAULT_WIDTH,
        height=DEFAULT_HEIGHT,
        min_size=(MIN_WIDTH, MIN_HEIGHT),
        background_color="#f2eee2",
        text_select=True,
        frameless=True,
        easy_drag=False,
        hidden=True,
    )
    api.set_window(window)

    # Keep the window hidden until the themed titlebar/UI has actually
    # painted, so opening the app never shows a flash of blank/default
    # window chrome before the custom frame appears.
    window.events.loaded += lambda: window.show()

    # Best-effort: stop an in-flight validation rather than let its thread
    # keep writing to an output file after the user has asked to close.
    def _on_closing():
        if api._cancel_event is not None:
            api._cancel_event.set()

    # PyInstaller --onefile + WebView2/pythonnet can leave COM/background
    # threads alive after the window disappears, which is exactly the
    # "orphaned msedgewebview2.exe" symptom described in README.md. Once
    # the window is gone there is nothing left to keep the process around
    # for, so force an immediate, unconditional process exit here instead
    # of waiting on those threads to notice.
    def _on_closed():
        os._exit(0)

    window.events.closing += _on_closing
    window.events.closed += _on_closed

    webview.start(gui="edgechromium", icon=_resource_path("webapp", "assets", "icon.ico"))


if __name__ == "__main__":
    main()
