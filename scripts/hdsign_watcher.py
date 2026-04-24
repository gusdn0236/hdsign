# hdsign_watcher.py
# GUI watcher for HD Sign worksheet automation
# Dependencies: pip install watchdog qrcode[pil] Pillow pywin32

from __future__ import annotations

import ctypes
import json
import queue
import shutil
import subprocess
import threading
import time
import tkinter as tk
from tkinter import messagebox
import zipfile
from pathlib import Path

import qrcode
from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

WATCH_DIR = Path(r"C:\Users\USER\Desktop\hdsign_orders")
DOWNLOADS_DIR = Path.home() / "Downloads"
DONE_DIR = WATCH_DIR / "done"
FLEXSIGN_EXE = r"C:\Users\USER\Desktop\FlexiSIGN 6.6\Program\App.exe"
ADMIN_URL = "https://hdsigncraft.com/admin"

_seen_zips: set[str] = set()
_seen_lock = threading.Lock()
_ui_queue: queue.Queue = queue.Queue()


# ── UI helpers (thread-safe) ────────────────────────────────────────────────

def ui_log(msg: str):
    _ui_queue.put(("log", msg))


def ui_status(state: str, detail: str = ""):
    _ui_queue.put(("status", state, detail))


def ui_alert(title: str, message: str):
    _ui_queue.put(("alert", title, message))


# ── System helpers ───────────────────────────────────────────────────────────

def is_running(exe: str) -> bool:
    r = subprocess.run(
        ["tasklist", "/FI", f"IMAGENAME eq {exe}"],
        capture_output=True, text=True,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    return exe.lower() in r.stdout.lower()


def check_prerequisites() -> bool:
    """Run from background thread. Uses ctypes MessageBox (thread-safe)."""
    missing = []
    if not is_running("Illustrator.exe"):
        missing.append("Adobe Illustrator")
    if not is_running("App.exe"):
        missing.append("FlexiSIGN")
    if missing:
        apps = "\n".join(f"  • {p}" for p in missing)
        ctypes.windll.user32.MessageBoxW(
            0,
            f"아래 프로그램이 실행 중이 아닙니다:\n\n{apps}\n\n"
            "먼저 실행한 후 다시 시작해 주세요.",
            "HD사인 지시서 프로그램 — 시작 불가",
            0x30,  # MB_ICONWARNING
        )
        return False
    return True


# ── QR & formatting ──────────────────────────────────────────────────────────

def generate_qr(output_path: Path):
    img = qrcode.make(ADMIN_URL)
    img.save(str(output_path))


def format_order_info(meta: dict) -> str:
    lines = [
        f"No: {meta.get('orderNumber', '-')}",
        f"거래처: {meta.get('companyName', '-')} ({meta.get('contactName', '-')})",
        f"제목: {meta.get('title', '-')}",
        f"납기: {meta.get('dueDate', '-')} {(meta.get('dueTime') or '').strip()}".strip(),
    ]
    delivery = meta.get("deliveryMethod") or ""
    address = meta.get("deliveryAddress") or ""
    if delivery:
        lines.append(f"배송: {delivery}" + (f"  {address}" if address else ""))
    items = meta.get("additionalItems") or ""
    if items:
        lines.append(f"추가물품: {items}")
    note = meta.get("note") or ""
    if note:
        lines.append(f"요청사항: {note}")
    return "\n".join(lines)


# ── Illustrator & FlexSign ────────────────────────────────────────────────────

def add_worksheet_layer(doc, qr_path: Path, info_text: str):
    try:
        for i in range(doc.Layers.Count, 0, -1):
            try:
                if doc.Layers.Item(i).Name == "worksheet":
                    doc.Layers.Item(i).Delete()
            except Exception:
                pass

        layer = doc.Layers.Add()
        layer.Name = "worksheet"

        bounds = doc.GeometricBounds
        right = bounds[2]
        top = bounds[1]
        qr_size, margin = 72, 10

        placed = doc.PlacedItems.Add()
        placed.File = str(qr_path)
        placed.Layer = layer
        placed.Position = [right - qr_size - margin, top - margin]
        placed.Width = qr_size
        placed.Height = qr_size

        tf = doc.TextFrames.Add()
        tf.Layer = layer
        tf.Contents = info_text
        tf.Position = [right - qr_size - margin - 230, top - margin]
        tf.Width = 220
        tf.Height = 300
        tf.TextRange.CharacterAttributes.Size = 6.5

    except Exception as e:
        ui_log(f"레이어 추가 실패: {e}")


def convert_ai_file(ai_path: Path, qr_path: Path, info_text: str) -> Path | None:
    if not is_running("Illustrator.exe"):
        ui_alert("Illustrator 필요", "Adobe Illustrator가 실행 중이 아닙니다.\n먼저 Illustrator를 열어 주세요.")
        return None
    try:
        import pythoncom
        import win32com.client as win32

        pythoncom.CoInitialize()
        ai_app = win32.GetActiveObject("Illustrator.Application")
        ai_app.UserInteractionLevel = -1

        doc = ai_app.Open(str(ai_path))
        add_worksheet_layer(doc, qr_path, info_text)

        out_dir = WATCH_DIR / "converted"
        out_dir.mkdir(exist_ok=True)
        out_path = out_dir / ai_path.name

        opts = win32.Dispatch("Illustrator.IllustratorSaveOptions")
        opts.Compatibility = 8
        opts.SaveMultipleArtboards = False
        doc.SaveAs(str(out_path), opts)
        doc.Close(2)

        return out_path

    except Exception as e:
        ui_log(f"변환 실패: {e}")
        return None


def launch_flexsign(file_path: Path):
    if is_running("App.exe"):
        # FlexSign이 이미 실행 중이면 새 인스턴스 안 열고 탐색기에서 파일 위치만 보여줌
        ui_log(f"파일 준비 완료 — FlexSign에서 열어주세요: {file_path.name}")
        try:
            subprocess.Popen(f'explorer /select,"{file_path}"')
        except Exception:
            pass
        return
    if not Path(FLEXSIGN_EXE).exists():
        ui_log(f"파일 준비 완료: {file_path}")
        return
    try:
        subprocess.Popen([FLEXSIGN_EXE, str(file_path)])
    except Exception as e:
        ui_log(f"FlexSign 실행 실패: {e}")


# ── ZIP processing ────────────────────────────────────────────────────────────

def process_zip(zip_path: Path):
    key = str(zip_path.resolve())
    with _seen_lock:
        if key in _seen_zips:
            return
        _seen_zips.add(key)

    time.sleep(1.5)

    temp_dir = WATCH_DIR / "extracting"
    temp_dir.mkdir(exist_ok=True)

    try:
        with zipfile.ZipFile(zip_path, "r") as zf:
            zf.extractall(str(temp_dir))
    except Exception as e:
        ui_log(f"압축 해제 실패: {e}")
        _seen_zips.discard(key)
        return

    json_files = list(temp_dir.glob("*.json"))
    if not json_files:
        ui_log("메타데이터 없음")
        return

    with open(json_files[0], encoding="utf-8") as f:
        meta = json.load(f)

    order_number = meta.get("orderNumber", "order")
    company = meta.get("companyName", "")
    title = meta.get("title", "")
    info_text = format_order_info(meta)

    ui_status("processing", f"{order_number} 파일을 준비하고 있습니다")
    ui_log(f"{company}  {title}")

    extract_dir = WATCH_DIR / order_number
    if extract_dir.exists():
        shutil.rmtree(str(extract_dir))
    temp_dir.rename(extract_dir)

    qr_path = WATCH_DIR / f"{order_number}_qr.png"
    generate_qr(qr_path)

    ai_files = list(extract_dir.glob("*.ai")) + list(extract_dir.glob("*.AI"))
    if not ai_files:
        ui_log(f"{order_number}: AI 파일 없음 — 확인 필요")
    else:
        for ai_file in ai_files:
            converted = convert_ai_file(ai_file, qr_path, info_text)
            if converted:
                ui_log(f"{order_number}: FlexSign에서 열었습니다")
                launch_flexsign(converted)

    DONE_DIR.mkdir(exist_ok=True)
    dest = DONE_DIR / zip_path.name
    if dest.exists():
        dest.unlink()
    shutil.move(str(zip_path), str(dest))

    ui_status("watching", "지시서가 도착하면 자동으로 열어드립니다")


def is_worksheet_zip(path: Path) -> bool:
    return path.suffix.lower() == ".zip" and "_" in path.stem


class ZipHandler(FileSystemEventHandler):
    def __init__(self, watch_path: Path):
        self._watch_path = watch_path

    def _handle(self, path: Path):
        if path.parent == self._watch_path and is_worksheet_zip(path):
            threading.Thread(target=process_zip, args=(path,), daemon=True).start()

    def on_created(self, event):
        if not event.is_directory:
            self._handle(Path(event.src_path))

    def on_moved(self, event):
        self._handle(Path(event.dest_path))


# ── GUI ───────────────────────────────────────────────────────────────────────

class App(tk.Tk):
    BG = "#f4f4f5"
    CARD = "white"
    DARK = "#18181b"

    def __init__(self):
        super().__init__()
        self.title("HD사인 지시서 프로그램")
        self.geometry("420x500")
        self.resizable(False, False)
        self.configure(bg=self.BG)
        self._observer = None
        self._log_rows: list[tk.Frame] = []
        self._build_ui()
        self.after(100, self._poll_queue)

    # ── layout ──

    def _build_ui(self):
        # Header
        hdr = tk.Frame(self, bg=self.DARK, height=78)
        hdr.pack(fill="x")
        hdr.pack_propagate(False)
        tk.Label(
            hdr, text="HD사인 지시서 프로그램",
            bg=self.DARK, fg="white",
            font=("맑은 고딕", 13, "bold"),
        ).place(relx=0.5, rely=0.35, anchor="center")
        tk.Label(
            hdr, text="다운받은 지시서 파일을 자동으로 FlexSign에서 열어드립니다",
            bg=self.DARK, fg="#a1a1aa",
            font=("맑은 고딕", 8),
        ).place(relx=0.5, rely=0.72, anchor="center")

        # Status card
        self._card = tk.Frame(self, bg=self.CARD)
        self._card.pack(fill="both", expand=True, padx=20, pady=20)

        # Status row
        row = tk.Frame(self._card, bg=self.CARD)
        row.pack(fill="x", padx=24, pady=(22, 0))

        self._dot = tk.Label(row, text="●", bg=self.CARD, fg="#2563eb",
                             font=("맑은 고딕", 28))
        self._dot.pack(side="left")

        col = tk.Frame(row, bg=self.CARD)
        col.pack(side="left", padx=(12, 0))

        self._status_lbl = tk.Label(col, text="시작하는 중", bg=self.CARD,
                                    fg=self.DARK, font=("맑은 고딕", 12, "bold"),
                                    anchor="w")
        self._status_lbl.pack(anchor="w")

        self._detail_lbl = tk.Label(col, text="", bg=self.CARD, fg="#71717a",
                                    font=("맑은 고딕", 9), anchor="w")
        self._detail_lbl.pack(anchor="w")

        # Divider
        tk.Frame(self._card, bg="#e4e4e7", height=1).pack(fill="x", padx=24, pady=(20, 0))

        # Log header
        tk.Label(self._card, text="최근 활동", bg=self.CARD, fg="#a1a1aa",
                 font=("맑은 고딕", 8, "bold")).pack(anchor="w", padx=24, pady=(14, 6))

        # Log area
        self._log_area = tk.Frame(self._card, bg=self.CARD)
        self._log_area.pack(fill="both", expand=True, padx=24, pady=(0, 20))

        self._placeholder = tk.Label(
            self._log_area, text="지시서 파일을 다운받으시면 여기에 표시됩니다.",
            bg=self.CARD, fg="#a1a1aa", font=("맑은 고딕", 9),
        )
        self._placeholder.pack(anchor="w", pady=2)

    # ── state updates ──

    def set_status(self, state: str, detail: str = ""):
        cfg = {
            "watching":   ("#16a34a", "준비 완료"),
            "processing": ("#d97706", "파일 처리 중"),
            "error":      ("#dc2626", "문제 발생"),
            "starting":   ("#2563eb", "시작하는 중"),
        }
        color, label = cfg.get(state, ("#71717a", state))
        self._dot.config(fg=color)
        self._status_lbl.config(text=label)
        self._detail_lbl.config(text=detail)

    def add_log(self, msg: str):
        self._placeholder.pack_forget()
        ts = time.strftime("%H:%M")

        row = tk.Frame(self._log_area, bg=self.CARD)
        row.pack(fill="x", pady=3, anchor="w")

        tk.Label(row, text="✓", bg=self.CARD, fg="#16a34a",
                 font=("맑은 고딕", 9, "bold"), width=2).pack(side="left")
        tk.Label(row, text=f"{ts}", bg=self.CARD, fg="#a1a1aa",
                 font=("맑은 고딕", 8), width=5).pack(side="left")
        tk.Label(row, text=msg, bg=self.CARD, fg="#3f3f46",
                 font=("맑은 고딕", 9), anchor="w", justify="left",
                 wraplength=280).pack(side="left", fill="x")

        self._log_rows.append(row)
        if len(self._log_rows) > 7:
            self._log_rows.pop(0).destroy()

    # ── queue polling ──

    def _poll_queue(self):
        try:
            while not _ui_queue.empty():
                item = _ui_queue.get_nowait()
                if item[0] == "log":
                    self.add_log(item[1])
                elif item[0] == "status":
                    self.set_status(item[1], item[2] if len(item) > 2 else "")
                elif item[0] == "alert":
                    t, m = item[1], item[2]
                    self.after(0, lambda t=t, m=m: messagebox.showwarning(t, m))
        except Exception:
            pass
        self.after(100, self._poll_queue)

    # ── watcher startup ──

    def start_watcher(self):
        self.set_status("starting", "Illustrator와 FlexSign을 확인하고 있습니다")

        def _run():
            if not check_prerequisites():
                self.after(0, self.destroy)
                return

            WATCH_DIR.mkdir(parents=True, exist_ok=True)
            DONE_DIR.mkdir(parents=True, exist_ok=True)

            for existing in WATCH_DIR.glob("*_지시서.zip"):
                threading.Thread(target=process_zip, args=(existing,), daemon=True).start()

            self._observer = Observer()
            self._observer.schedule(ZipHandler(WATCH_DIR), str(WATCH_DIR), recursive=False)
            self._observer.schedule(ZipHandler(DOWNLOADS_DIR), str(DOWNLOADS_DIR), recursive=False)
            self._observer.start()

            ui_status("watching", "지시서가 도착하면 자동으로 열어드립니다")

        threading.Thread(target=_run, daemon=True).start()

    def on_close(self):
        if self._observer:
            self._observer.stop()
            self._observer.join()
        self.destroy()


def main():
    app = App()
    app.protocol("WM_DELETE_WINDOW", app.on_close)
    app.after(300, app.start_watcher)
    app.mainloop()


if __name__ == "__main__":
    main()
