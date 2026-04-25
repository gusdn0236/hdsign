# hdsign_watcher.py
# GUI watcher for HD Sign worksheet automation
# Dependencies: pip install watchdog qrcode[pil] Pillow pywin32

from __future__ import annotations

import ctypes
import json
import queue
import shutil
import struct
import subprocess
import threading
import time
import tkinter as tk
from tkinter import messagebox
import zipfile
from pathlib import Path

from urllib.parse import quote

import qrcode
from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

WATCH_DIR = Path(r"C:\Users\USER\Desktop\hdsign_orders")
DOWNLOADS_DIR = Path.home() / "Downloads"
DONE_DIR = WATCH_DIR / "done"
FLEXSIGN_EXE = r"C:\Users\USER\Desktop\FlexiSIGN 6.6\Program\App.exe"
EVIDENCE_URL_BASE = "https://hdsigncraft.com/p/"

# 작업지시서 상단 박스 색상 (RGB 0~255). 작성자별로 색을 바꿔쓰려면 여기만 수정.
HEADER_BOX_FILL = (220, 220, 220)     # 연한 회색
HEADER_BOX_STROKE = (130, 130, 130)   # 박스 테두리

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

def qr_matrix_js(url: str) -> str:
    """
    URL을 인코딩한 QR 매트릭스를 JS 2차원 배열 리터럴 문자열로 반환.
    Illustrator ExtendScript에서 각 검은 모듈을 사각형 path로 그리는 데 사용.
    """
    qr = qrcode.QRCode(
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=1, border=2,
    )
    qr.add_data(url)
    qr.make()
    matrix = qr.get_matrix()
    rows = [
        "[" + ",".join("1" if cell else "0" for cell in row) + "]"
        for row in matrix
    ]
    return "[" + ",".join(rows) + "]"


DELIVERY_SHORT = {
    "화물 발송": "화물",
    "퀵 발송": "퀵발송",
    "직접 배송": "직접배송",
    "직접 수령": "직접수령",
    "지방화물차 배송": "지방화물",
}


def _format_md(value) -> str:
    """ISO 날짜 또는 yyyy-MM-dd 문자열에서 MM-dd 만 추출."""
    if not value:
        return ""
    s = str(value).split("T")[0]
    parts = s.split("-")
    return f"{parts[1]}-{parts[2]}" if len(parts) >= 3 else s


def format_header_text(meta: dict) -> str:
    """중앙 박스용 한 줄 텍스트. 예: '04-24발주 04-25화물'."""
    parts = []
    order_md = _format_md(meta.get("createdAt"))
    if order_md:
        parts.append(f"{order_md}발주")
    due_md = _format_md(meta.get("dueDate"))
    delivery = DELIVERY_SHORT.get((meta.get("deliveryMethod") or "").strip(), "")
    if due_md:
        parts.append(f"{due_md}{delivery}" if delivery else due_md)
    return " ".join(parts) if parts else "-"


def format_left_text(meta: dict) -> str:
    """좌측 상단: 싸인월드 + 거래처 전화번호."""
    phone = (meta.get("phone") or "").strip()
    return "싸인월드\n" + phone if phone else "싸인월드"


def format_note_text(meta: dict) -> str:
    """우측 QR 아래: 추가물품 + 추가요청사항 (둘 다 비어있으면 빈 문자열)."""
    sections = []
    items = (meta.get("additionalItems") or "").strip()
    if items:
        sections.append(f"■ 추가물품\n{items}")
    note = (meta.get("note") or "").strip()
    if note:
        sections.append(f"■ 추가요청사항\n{note}")
    return "\n\n".join(sections)


# ── Illustrator & FlexSign ────────────────────────────────────────────────────

def _js_escape(s: str) -> str:
    return (s.replace("\\", "\\\\")
             .replace('"', '\\"')
             .replace("\r", "")
             .replace("\n", "\\n"))


def process_ai_to_v8(ai_app, src_path: Path, dst_path: Path,
                     qr_js_matrix: str,
                     header_text: str, left_text: str, note_text: str) -> bool:
    """
    JSX 한 번의 트랜잭션으로 open → worksheet 레이어 추가(QR + 주문정보 박스)
    → v8 SaveAs → close까지 전부 수행.
    크기는 첫 번째 대지(artboard) 폭에 비례해 자동 스케일링.
    Python/COM이 Open·SaveAs·Close를 나눠 호출하면 doc 참조가 엉켜서 수정 안 된
    사본이 저장되는 케이스가 발생 — 그걸 피하기 위해 전체 파이프라인을 JSX로 통합.
    """
    header_js = _js_escape(header_text)
    left_js = _js_escape(left_text)
    note_js = _js_escape(note_text)
    src_js = str(src_path).replace("\\", "/")
    dst_js = str(dst_path).replace("\\", "/")

    fr, fg, fb = HEADER_BOX_FILL
    sr, sg, sb = HEADER_BOX_STROKE

    script = (
        "try {"
        f"  var srcPath = \"{src_js}\";"
        f"  var dstPath = \"{dst_js}\";"
        "  var srcFile = new File(srcPath);"
        "  var dstFile = new File(dstPath);"
        "  function k(p) { return p.toLowerCase().replace(/\\\\/g, '/'); }"
        # 같은 경로의 잔여 문서가 열려 있으면 먼저 닫는다
        "  for (var z = app.documents.length - 1; z >= 0; z--) {"
        "    var fp = k(app.documents[z].fullName.fsName);"
        "    if (fp == k(srcPath) || fp == k(dstPath)) {"
        "      try { app.documents[z].close(SaveOptions.DONOTSAVECHANGES); } catch(e) {}"
        "    }"
        "  }"
        "  var doc = app.open(srcFile);"
        # 기존 worksheet 레이어 제거
        "  for (var i = doc.layers.length - 1; i >= 0; i--) {"
        "    if (doc.layers[i].name == 'worksheet') {"
        "      doc.layers[i].locked = false;"
        "      doc.layers[i].visible = true;"
        "      doc.layers[i].remove();"
        "    }"
        "  }"
        "  var layer = doc.layers.add();"
        "  layer.name = 'worksheet';"
        # 대지(첫 번째 artboard) 기준으로 비율 계산
        "  var ab = doc.artboards[0].artboardRect;"
        "  var abLeft = ab[0], abTop = ab[1], abRight = ab[2];"
        "  var abWidth = abRight - abLeft;"
        # QR은 대지 폭의 8% (50~240pt 사이로 클램프)
        "  var qrSize = abWidth * 0.08;"
        "  if (qrSize < 50) qrSize = 50;"
        "  if (qrSize > 240) qrSize = 240;"
        "  var sc = qrSize / 90.0;"
        "  var margin = 18 * sc;"
        "  var bigFont = 26 * sc;"
        "  var noteFont = 13 * sc;"
        # 박스 높이는 폰트에 맞춰 꽉 차게(1.25배), 너비는 텍스트가 가운데 들어갈 정도
        "  var boxH = bigFont * 1.25;"
        "  var boxW = bigFont * 14;"
        "  var lineGap = 6 * sc;"
        # 색상 정의
        "  var blk = new RGBColor(); blk.red = 0; blk.green = 0; blk.blue = 0;"
        "  var boxFill = new RGBColor();"
        f"  boxFill.red = {fr}; boxFill.green = {fg}; boxFill.blue = {fb};"
        "  var boxStroke = new RGBColor();"
        f"  boxStroke.red = {sr}; boxStroke.green = {sg}; boxStroke.blue = {sb};"
        # ── 좌측 상단: 싸인월드 + 거래처 전화번호 ──
        "  var leftTf = layer.textFrames.add();"
        f'  leftTf.contents = "{left_js}";'
        "  leftTf.position = [abLeft + margin, abTop - margin];"
        "  leftTf.textRange.characterAttributes.size = bigFont;"
        # ── 중앙 상단: 박스 + 발주/배송 텍스트 ──
        "  var centerX = (abLeft + abRight) / 2;"
        "  var boxLeft = centerX - boxW / 2;"
        "  var boxTop = abTop - margin;"
        "  var box = layer.pathItems.rectangle(boxTop, boxLeft, boxW, boxH);"
        "  box.filled = true; box.fillColor = boxFill;"
        "  box.stroked = true; box.strokeColor = boxStroke;"
        "  box.strokeWidth = 0.5 * sc;"
        # 박스 텍스트는 실제 glyph bounds 중심을 측정한 뒤
        # 박스 정중앙으로 옮겨야 정확히 가운데 들어간다.
        "  var headerTf = layer.textFrames.add();"
        f'  headerTf.contents = "{header_js}";'
        "  headerTf.textRange.characterAttributes.size = bigFont;"
        "  headerTf.position = [0, 0];"
        "  var hb = headerTf.geometricBounds;"  # [left, top, right, bottom]
        "  var glyphCx = (hb[0] + hb[2]) / 2;"
        "  var glyphCy = (hb[1] + hb[3]) / 2;"
        "  var boxCenterY = boxTop - boxH / 2;"
        "  headerTf.position = [centerX - glyphCx, boxCenterY - glyphCy];"
        # ── 우측 상단: QR ──
        "  var qrOriginX = abRight - margin - qrSize;"
        "  var qrOriginY = abTop - margin;"
        f"  var m = {qr_js_matrix};"
        "  var N = m.length;"
        "  var cell = qrSize / N;"
        "  var grp = layer.groupItems.add();"
        "  grp.name = 'qr';"
        "  for (var y = 0; y < N; y++) {"
        "    for (var x = 0; x < N; x++) {"
        "      if (m[y][x]) {"
        "        var r = grp.pathItems.rectangle("
        "          qrOriginY - y * cell, qrOriginX + x * cell, cell, cell"
        "        );"
        "        r.filled = true; r.stroked = false; r.fillColor = blk;"
        "      }"
        "    }"
        "  }"
        # ── QR 아래: 추가물품 + 추가요청사항을 묶은 외곽선 폼 박스 ──
        f'  var noteTextStr = "{note_js}";'
        "  if (noteTextStr.length > 0) {"
        "    var noteW = qrSize * 1.9;"
        "    var noteH = 200 * sc;"
        "    var noteRight = qrOriginX + qrSize;"
        "    var noteLeft = noteRight - noteW;"
        "    if (noteLeft < abLeft + margin + boxW / 2) {"
        "      noteLeft = qrOriginX;"
        "      noteW = qrSize;"
        "    }"
        "    var noteTop = qrOriginY - qrSize - lineGap;"
        # 외곽선만 있는 폼 박스 (채우기 없음)
        "    var noteBox = layer.pathItems.rectangle(noteTop, noteLeft, noteW, noteH);"
        "    noteBox.filled = false;"
        "    noteBox.stroked = true;"
        "    noteBox.strokeColor = boxStroke;"
        "    noteBox.strokeWidth = 0.5 * sc;"
        # 박스 안쪽 패딩만큼 작게 area text 경로
        "    var pad = 6 * sc;"
        "    var notePath = layer.pathItems.add();"
        "    notePath.filled = false; notePath.stroked = false;"
        "    notePath.setEntirePath(["
        "      [noteLeft + pad, noteTop - pad],"
        "      [noteLeft + noteW - pad, noteTop - pad],"
        "      [noteLeft + noteW - pad, noteTop - noteH + pad],"
        "      [noteLeft + pad, noteTop - noteH + pad]"
        "    ]);"
        "    notePath.closed = true;"
        "    var noteTf = layer.textFrames.areaText(notePath);"
        "    noteTf.contents = noteTextStr;"
        "    noteTf.textRange.characterAttributes.size = noteFont;"
        "  }"
        # v8로 저장 후 close
        "  var opts = new IllustratorSaveOptions();"
        "  opts.compatibility = Compatibility.ILLUSTRATOR8;"
        "  opts.saveMultipleArtboards = false;"
        "  doc.saveAs(dstFile, opts);"
        "  doc.close(SaveOptions.DONOTSAVECHANGES);"
        "  'OK';"
        "} catch (e) { 'ERR: ' + e.toString(); }"
    )

    try:
        result = ai_app.DoJavaScript(script)
        if result and str(result).startswith("ERR"):
            ui_log(f"Illustrator 처리 실패: {result}")
            return False
        return True
    except Exception as e:
        ui_log(f"DoJavaScript 호출 실패: {e}")
        return False


def convert_ai_file(ai_path: Path, qr_js_matrix: str,
                    header_text: str, left_text: str, note_text: str) -> Path | None:
    if not is_running("Illustrator.exe"):
        ui_alert("Illustrator 필요", "Adobe Illustrator가 실행 중이 아닙니다.\n먼저 Illustrator를 열어 주세요.")
        return None
    try:
        import pythoncom
        import win32com.client as win32

        pythoncom.CoInitialize()
        ai_app = win32.GetActiveObject("Illustrator.Application")
        ai_app.UserInteractionLevel = -1

        out_dir = WATCH_DIR / "converted"
        out_dir.mkdir(exist_ok=True)
        # FlexSign이 같은 파일명을 캐시해서 이전 버전을 다시 띄우는 일을 막기 위해
        # 변환 파일명에 타임스탬프를 붙여 매번 새 경로로 만든다.
        ts = time.strftime("%y%m%d_%H%M%S")
        out_path = out_dir / f"{ai_path.stem}_{ts}{ai_path.suffix}"

        if not process_ai_to_v8(ai_app, ai_path, out_path, qr_js_matrix,
                                header_text, left_text, note_text):
            return None

        ui_log(f"{ai_path.name} v8 저장 완료")
        return out_path

    except Exception as e:
        ui_log(f"변환 실패: {e}")
        return None


def _find_flexsign_hwnd() -> int:
    """실행 중인 FlexSign 메인 창의 HWND를 찾는다 (없으면 0)."""
    WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    user32 = ctypes.windll.user32
    user32.IsWindowVisible.argtypes = [ctypes.c_void_p]
    user32.IsWindowVisible.restype = ctypes.c_bool
    user32.GetWindowTextLengthW.argtypes = [ctypes.c_void_p]
    user32.GetWindowTextLengthW.restype = ctypes.c_int
    user32.GetWindowTextW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_int]
    user32.GetWindowTextW.restype = ctypes.c_int
    result = [0]

    def _cb(hwnd, _lparam):
        try:
            if not user32.IsWindowVisible(hwnd):
                return True
            length = user32.GetWindowTextLengthW(hwnd)
            if length == 0:
                return True
            buf = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, buf, length + 1)
            title = buf.value.lower()
            if "flexi" in title:
                result[0] = hwnd
                return False
        except Exception:
            pass
        return True

    cb = WNDENUMPROC(_cb)
    user32.EnumWindows(cb, 0)
    return result[0]


def _post_drop_files(hwnd: int, file_path: str) -> bool:
    """WM_DROPFILES로 해당 창에 파일을 드롭한다."""
    WM_DROPFILES = 0x0233
    GMEM_MOVEABLE = 0x0002
    GMEM_ZEROINIT = 0x0040

    file_list_bytes = (file_path + "\0\0").encode("utf-16-le")
    header = struct.pack("=IIIII", 20, 0, 0, 0, 1)
    payload = header + file_list_bytes

    kernel32 = ctypes.windll.kernel32
    user32 = ctypes.windll.user32
    kernel32.GlobalAlloc.argtypes = [ctypes.c_uint, ctypes.c_size_t]
    kernel32.GlobalAlloc.restype = ctypes.c_void_p
    kernel32.GlobalLock.argtypes = [ctypes.c_void_p]
    kernel32.GlobalLock.restype = ctypes.c_void_p
    kernel32.GlobalUnlock.argtypes = [ctypes.c_void_p]
    kernel32.GlobalUnlock.restype = ctypes.c_bool
    user32.PostMessageW.argtypes = [
        ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p
    ]
    user32.PostMessageW.restype = ctypes.c_bool

    hmem = kernel32.GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, len(payload))
    if not hmem:
        return False
    ptr = kernel32.GlobalLock(hmem)
    if not ptr:
        return False
    ctypes.memmove(ptr, payload, len(payload))
    kernel32.GlobalUnlock(hmem)
    return bool(user32.PostMessageW(hwnd, WM_DROPFILES, hmem, None))


def launch_flexsign(file_path: Path):
    ui_log(f"FlexSign 전달 시도: {file_path.name}")
    hwnd = 0
    try:
        hwnd = _find_flexsign_hwnd()
    except Exception as e:
        ui_log(f"FlexSign 창 검색 실패: {e}")

    if hwnd:
        ui_log(f"FlexSign 창 발견(HWND={hwnd}) — 파일 드롭 중")
        try:
            ok = _post_drop_files(hwnd, str(file_path))
        except Exception as e:
            ui_log(f"드롭 메시지 실패: {e}")
            ok = False
        if ok:
            try:
                # 최소화 상태에서만 RESTORE — 최대화 상태면 그대로 유지
                if ctypes.windll.user32.IsIconic(hwnd):
                    ctypes.windll.user32.ShowWindow(hwnd, 9)  # SW_RESTORE
                ctypes.windll.user32.SetForegroundWindow(hwnd)
            except Exception:
                pass
            ui_log(f"FlexSign에 전달 완료: {file_path.name}")
        else:
            ui_log(f"드롭 실패 — 수동으로 파일을 열어주세요: {file_path}")
        return

    # FlexSign 창을 못 찾음 — 새 인스턴스로 실행
    if not Path(FLEXSIGN_EXE).exists():
        ui_log(f"FlexSign 창도 실행파일도 찾을 수 없습니다: {FLEXSIGN_EXE}")
        return
    try:
        subprocess.Popen([FLEXSIGN_EXE, str(file_path)])
        ui_log(f"FlexSign 창 미발견 — 새 인스턴스 실행: {file_path.name}")
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
    header_text = format_header_text(meta)
    left_text = format_left_text(meta)
    note_text = format_note_text(meta)

    ui_status("processing", f"{order_number} 파일을 준비하고 있습니다")
    ui_log(f"{company}  {title}")

    extract_dir = WATCH_DIR / order_number
    if extract_dir.exists():
        shutil.rmtree(str(extract_dir))
    temp_dir.rename(extract_dir)

    # 주문지마다 고유한 증거사진 업로드 URL — 휴대폰으로 QR을 찍으면 카메라가 열린다.
    # 한글 주문번호("주문-yyMMdd-NN")가 들어가므로 ASCII URL로 percent-encode.
    qr_js = qr_matrix_js(EVIDENCE_URL_BASE + quote(order_number, safe=""))

    # Windows는 대소문자 구분 안 하므로 "*.ai" 하나로 .AI / .ai 모두 매칭 — dedupe
    ai_files = sorted({p.resolve() for p in extract_dir.glob("*.ai")})
    if not ai_files:
        ui_log(f"{order_number}: AI 파일 없음 — 확인 필요")
    else:
        for ai_file in ai_files:
            converted = convert_ai_file(Path(ai_file), qr_js,
                                        header_text, left_text, note_text)
            if converted:
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
        self._has_logs = False
        self._log_count = 0
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

        # Log area — Text widget so the user can drag-select and copy
        self._log_text = tk.Text(
            self._card, bg=self.CARD,
            relief="flat", bd=0, highlightthickness=0,
            wrap="word", cursor="arrow",
            padx=0, pady=0, height=10,
        )
        self._log_text.pack(fill="both", expand=True, padx=24, pady=(0, 20))

        self._log_text.tag_configure("check", foreground="#16a34a",
                                     font=("맑은 고딕", 9, "bold"))
        self._log_text.tag_configure("time", foreground="#a1a1aa",
                                     font=("맑은 고딕", 8))
        self._log_text.tag_configure("msg", foreground="#3f3f46",
                                     font=("맑은 고딕", 9))
        self._log_text.tag_configure("placeholder", foreground="#a1a1aa",
                                     font=("맑은 고딕", 9))

        self._log_text.insert("1.0",
            "지시서 파일을 다운받으시면 여기에 표시됩니다.", "placeholder")
        self._log_text.config(state="disabled")

        # Right-click copy menu
        self._log_menu = tk.Menu(self, tearoff=0)
        self._log_menu.add_command(label="복사", command=self._copy_selection)
        self._log_menu.add_command(label="전체 복사", command=self._copy_all)
        self._log_text.bind("<Button-3>", self._show_log_menu)

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
        ts = time.strftime("%H:%M")
        self._log_text.config(state="normal")
        if not self._has_logs:
            self._log_text.delete("1.0", "end")
            self._has_logs = True
        self._log_text.insert("end", "✓  ", "check")
        self._log_text.insert("end", f"{ts}  ", "time")
        self._log_text.insert("end", f"{msg}\n", "msg")
        self._log_count += 1
        if self._log_count > 7:
            self._log_text.delete("1.0", "2.0")
            self._log_count = 7
        self._log_text.see("end")
        self._log_text.config(state="disabled")

    # ── copy helpers ──

    def _copy_selection(self):
        try:
            text = self._log_text.get("sel.first", "sel.last")
        except tk.TclError:
            text = ""
        if not text and self._has_logs:
            text = self._log_text.get("1.0", "end-1c")
        if text:
            self.clipboard_clear()
            self.clipboard_append(text)

    def _copy_all(self):
        if not self._has_logs:
            return
        self.clipboard_clear()
        self.clipboard_append(self._log_text.get("1.0", "end-1c"))

    def _show_log_menu(self, event):
        try:
            self._log_menu.tk_popup(event.x_root, event.y_root)
        finally:
            self._log_menu.grab_release()

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
