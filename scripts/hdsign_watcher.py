"""
hdsign_watcher.py
-----------------
Watches C:\Users\USER\Desktop\hdsign_orders for *_지시서.zip files.
For each ZIP:
  1. Extracts JSON metadata + AI files to a temp subfolder
  2. Opens each .ai file in Illustrator via COM
  3. Adds a "지시서" layer with order info text + QR code image
  4. Saves a copy as AI8-compatible (aiCC saved as legacy AI8)
  5. Launches FlexSign with the converted file
  6. Moves processed ZIP to hdsign_orders/done/

Dependencies: pip install watchdog qrcode[pil] Pillow pywin32
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path

import qrcode
from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

WATCH_DIR = Path(r"C:\Users\USER\Desktop\hdsign_orders")
DONE_DIR = WATCH_DIR / "done"
FLEXSIGN_EXE = r"C:\Users\USER\Desktop\FlexiSIGN 6.6\Program\App.exe"
ADMIN_URL = "https://hdsigncraft.com/admin"


def log(msg: str):
    ts = time.strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def generate_qr(url: str, output_path: Path) -> Path:
    img = qrcode.make(url)
    img.save(str(output_path))
    return output_path


def format_order_info(meta: dict) -> str:
    lines = []
    lines.append(f"요청번호: {meta.get('orderNumber', '-')}")
    lines.append(f"거래처: {meta.get('companyName', '-')}  ({meta.get('contactName', '-')})")
    lines.append(f"제목: {meta.get('title', '-')}")
    lines.append(f"납기: {meta.get('dueDate', '-')}  {meta.get('dueTime', '') or ''}")
    delivery = meta.get('deliveryMethod', '') or ''
    address = meta.get('deliveryAddress', '') or ''
    if delivery:
        lines.append(f"배송: {delivery}" + (f"  {address}" if address else ""))
    items = meta.get('additionalItems', '') or ''
    if items:
        lines.append(f"추가 물품: {items}")
    note = meta.get('note', '') or ''
    if note:
        lines.append(f"요청사항: {note}")
    return "\n".join(lines)


def add_worksheet_layer(ai_app, doc, qr_path: Path, info_text: str):
    """Add a '지시서' layer with info text and QR code to an open Illustrator document."""
    try:
        # Remove existing 지시서 layer if any
        for i in range(1, doc.Layers.Count + 1):
            try:
                if doc.Layers.Item(i).Name == "지시서":
                    doc.Layers.Item(i).Delete()
                    break
            except Exception:
                pass

        layer = doc.Layers.Add()
        layer.Name = "지시서"
        layer.ZOrder(1)  # bring to front

        # Get document bounds to position elements
        bounds = doc.GeometricBounds  # [left, top, right, bottom] in points
        doc_left = bounds[0]
        doc_top = bounds[1]

        # Place QR code image in top-right corner, 80x80pt
        qr_size = 80
        placed = doc.PlacedItems.Add()
        placed.File = str(qr_path)
        placed.Layer = layer
        qr_left = doc_left + (bounds[2] - bounds[0]) - qr_size - 10
        qr_top = doc_top - 10
        placed.Position = [qr_left, qr_top]
        placed.Width = qr_size
        placed.Height = qr_size

        # Add info text box below QR
        text_frame = doc.TextFrames.Add()
        text_frame.Layer = layer
        text_frame.Contents = info_text
        text_frame.Position = [qr_left - 200, qr_top]
        text_frame.Width = 200
        text_frame.Height = qr_size
        text_frame.TextRange.CharacterAttributes.Size = 7
        text_frame.TextRange.CharacterAttributes.FillColor = doc.DefaultFillColor

    except Exception as e:
        log(f"  레이어 추가 실패 (계속 진행): {e}")


def convert_ai_file(ai_path: Path, qr_path: Path, info_text: str) -> Path | None:
    """Open AI file in Illustrator, add layer, save as AI8, return saved path."""
    try:
        import win32com.client as win32
        import pythoncom
        pythoncom.CoInitialize()

        ai_app = win32.Dispatch("Illustrator.Application")
        ai_app.UserInteractionLevel = -1  # kDontDisplayAlerts = -1

        log(f"  Illustrator에서 열기: {ai_path.name}")
        doc = ai_app.Open(str(ai_path))

        add_worksheet_layer(ai_app, doc, qr_path, info_text)

        # Save as AI8 (Compatibility = 3 means Illustrator 8)
        converted_dir = ai_path.parent / "converted"
        converted_dir.mkdir(exist_ok=True)
        out_path = converted_dir / ai_path.name

        save_options = win32.Dispatch("Illustrator.IllustratorSaveOptions")
        # Compatibility: 1=CS, 2=CS2, 3=CS3... but AI8 = aiIllustrator8 = 8
        # The enum value for AI8 compatibility is 8 in Illustrator's COM API
        save_options.Compatibility = 8  # aiIllustrator8
        save_options.SaveMultipleArtboards = False

        doc.SaveAs(str(out_path), save_options)
        doc.Close(2)  # 2 = don't save again

        log(f"  AI8 저장 완료: {out_path.name}")
        return out_path

    except ImportError:
        log("  win32com 없음 — pywin32 설치 필요 (pip install pywin32)")
        return None
    except Exception as e:
        log(f"  Illustrator 변환 실패: {e}")
        return None


def launch_flexsign(file_path: Path):
    if not Path(FLEXSIGN_EXE).exists():
        log(f"  FlexSign 실행 파일 없음: {FLEXSIGN_EXE}")
        return
    try:
        subprocess.Popen([FLEXSIGN_EXE, str(file_path)])
        log(f"  FlexSign 실행: {file_path.name}")
    except Exception as e:
        log(f"  FlexSign 실행 실패: {e}")


def process_zip(zip_path: Path):
    log(f"ZIP 감지: {zip_path.name}")

    # Wait briefly to ensure the file is fully written
    time.sleep(1.5)

    extract_dir = WATCH_DIR / zip_path.stem
    extract_dir.mkdir(exist_ok=True)

    try:
        with zipfile.ZipFile(zip_path, "r") as zf:
            zf.extractall(str(extract_dir))
    except Exception as e:
        log(f"  압축 해제 실패: {e}")
        return

    # Find JSON metadata
    json_files = list(extract_dir.glob("*.json"))
    if not json_files:
        log("  JSON 메타데이터 없음 — 건너뜀")
        return

    with open(json_files[0], encoding="utf-8") as f:
        meta = json.load(f)

    order_number = meta.get("orderNumber", zip_path.stem)
    info_text = format_order_info(meta)
    log(f"  요청번호: {order_number}")

    # Generate QR code
    qr_path = extract_dir / "qr.png"
    generate_qr(ADMIN_URL, qr_path)
    log(f"  QR 생성 완료")

    # Find AI files
    ai_files = list(extract_dir.glob("*.ai")) + list(extract_dir.glob("*.AI"))
    if not ai_files:
        log("  AI 파일 없음 — 지시서 레이어 추가 건너뜀")
        # Move ZIP to done anyway
    else:
        for ai_file in ai_files:
            log(f"  처리 중: {ai_file.name}")
            converted = convert_ai_file(ai_file, qr_path, info_text)
            if converted:
                launch_flexsign(converted)

    # Move processed ZIP to done
    DONE_DIR.mkdir(exist_ok=True)
    dest = DONE_DIR / zip_path.name
    if dest.exists():
        dest.unlink()
    shutil.move(str(zip_path), str(dest))
    log(f"  완료 → done/{zip_path.name}")


class ZipHandler(FileSystemEventHandler):
    def __init__(self):
        self._seen = set()

    def on_created(self, event):
        if event.is_directory:
            return
        path = Path(event.src_path)
        if path.suffix.lower() == ".zip" and path.parent == WATCH_DIR and path not in self._seen:
            self._seen.add(path)
            process_zip(path)

    def on_moved(self, event):
        path = Path(event.dest_path)
        if path.suffix.lower() == ".zip" and path.parent == WATCH_DIR and path not in self._seen:
            self._seen.add(path)
            process_zip(path)


def main():
    WATCH_DIR.mkdir(parents=True, exist_ok=True)
    DONE_DIR.mkdir(parents=True, exist_ok=True)

    log(f"HD Sign 지시서 감시 시작")
    log(f"  감시 폴더: {WATCH_DIR}")
    log(f"  FlexSign: {FLEXSIGN_EXE}")
    log(f"  Ctrl+C 로 종료")

    # Process any existing ZIPs on startup
    for existing in WATCH_DIR.glob("*_지시서.zip"):
        process_zip(existing)

    observer = Observer()
    observer.schedule(ZipHandler(), str(WATCH_DIR), recursive=False)
    observer.start()

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        observer.stop()
    observer.join()
    log("종료.")


if __name__ == "__main__":
    main()
