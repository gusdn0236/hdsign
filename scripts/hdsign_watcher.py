# hdsign_watcher.py
# GUI watcher for HD Sign worksheet automation
# Dependencies: pip install watchdog qrcode[pil] Pillow pywin32

from __future__ import annotations

import collections
import ctypes
import json
import queue
import shutil
import struct
import subprocess
import threading
import time
import tkinter as tk
from datetime import date, timedelta
from tkinter import messagebox
import urllib.error
import urllib.request
import zipfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from urllib.parse import quote

import qrcode
from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

WATCH_DIR = Path(r"C:\Users\USER\Desktop\hdsign_orders")
DOWNLOADS_DIR = Path.home() / "Downloads"
DONE_DIR = WATCH_DIR / "done"
# Bullzip(또는 다른 무인 PDF 프린터) 가 인쇄 PDF 를 떨어뜨리는 폴더.
# Bullzip 설정에서 "Folder" 를 이 경로로 맞추고 "Show save as dialog" 끄기.
PRINTED_PDF_DIR = WATCH_DIR / "printed"
FLEXSIGN_EXE = r"C:\Users\USER\Desktop\FlexiSIGN 6.6\Program\App.exe"
EVIDENCE_URL_BASE = "https://hdsigncraft.com/p/"
API_BASE = "https://hdsign-production.up.railway.app"

# 관리자 페이지가 "이 워처가 켜져 있는지"만 확인하는 ping 엔드포인트.
# 127.0.0.1에만 바인딩되므로 외부에서 접근 불가.
PING_PORT = 5577

# 작업지시서 상단 박스 색상 (RGB 0~255). 작성자별로 색을 바꿔쓰려면 여기만 수정.
HEADER_BOX_FILL = (220, 220, 220)     # 연한 회색
HEADER_BOX_STROKE = (130, 130, 130)   # 박스 테두리

_seen_zips: set[str] = set()
_seen_lock = threading.Lock()
_ui_queue: queue.Queue = queue.Queue()

# FlexSign 으로 보낸 주문들의 메타. 인쇄 PDF 가 떨어졌을 때 가장 최근 항목과 매칭한다.
# (deque 로 최대 20건만 유지 — 그 이상 한번에 처리할 일은 거의 없음)
_recent_orders: collections.deque = collections.deque(maxlen=20)
_recent_orders_lock = threading.Lock()
_seen_printed: set[str] = set()


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
    # 거래처가 본 "직접 배송"은 우리 입장에선 납품이라 지시서에는 "납"으로만 표기.
    # "직접 수령"과 헷갈리지 않게 한 글자로 줄여 사용한다.
    "직접 배송": "납",
    "직접 수령": "찾으러오심",
    "지방화물차 배송": "상차",
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
    """좌측 상단: 싸인월드 + 거래처 전화번호. 전화번호의 모든 공백은 제거한다."""
    phone_raw = meta.get("phone") or ""
    phone = "".join(phone_raw.split())
    return "싸인월드\n" + phone if phone else "싸인월드"


class _PingHandler(BaseHTTPRequestHandler):
    """관리자 페이지가 fetch 한 번 보내서 워처 실행 여부를 확인하기 위한 핸들러."""

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Cache-Control", "no-store")

    def do_GET(self):  # noqa: N802 (BaseHTTPRequestHandler 규약)
        if self.path == "/ping":
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"ok":true,"app":"hdsign_worksheet"}')
        else:
            self.send_response(404)
            self._cors()
            self.end_headers()

    def do_OPTIONS(self):  # noqa: N802
        self.send_response(204)
        self._cors()
        self.end_headers()

    def log_message(self, *args, **kwargs):
        # 기본 로깅 비활성화 — UI 로그를 어지럽히지 않는다.
        pass


def start_ping_server():
    def _run():
        try:
            srv = HTTPServer(("127.0.0.1", PING_PORT), _PingHandler)
            srv.serve_forever()
        except OSError as e:
            ui_log(f"ping 서버 시작 실패(포트 {PING_PORT} 사용 중?): {e}")
        except Exception as e:
            ui_log(f"ping 서버 오류: {e}")

    threading.Thread(target=_run, daemon=True).start()


def notify_worksheet_acknowledged(order_number: str):
    """변환 성공 후 백엔드에 알려 주문을 RECEIVED → IN_PROGRESS로 전환시킨다.
    워처가 켜져 있을 때만 이 호출이 일어나므로, 곧 그것이 'QR이 실제로 박혔다'는 신호다."""
    if not order_number:
        return
    url = f"{API_BASE}/api/public/orders/{quote(order_number, safe='')}/worksheet-acknowledged"
    try:
        req = urllib.request.Request(url, method="POST")
        with urllib.request.urlopen(req, timeout=10) as resp:
            resp.read()
        ui_log(f"{order_number} 작업중으로 전환 알림 완료")
    except urllib.error.HTTPError as e:
        ui_log(f"작업중 전환 실패 ({e.code}): {order_number}")
    except Exception as e:
        ui_log(f"작업중 전환 호출 실패: {e}")


def patch_due_date(order_number: str, new_due: date) -> bool:
    """다이얼로그에서 확정한 최종 납기 일자를 백엔드에 전달."""
    if not order_number:
        return False
    url = f"{API_BASE}/api/public/orders/{quote(order_number, safe='')}/due-date"
    body = json.dumps({"dueDate": new_due.isoformat()}).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp.read()
        ui_log(f"{order_number} 납기 {new_due.isoformat()} 로 업데이트")
        return True
    except urllib.error.HTTPError as e:
        ui_log(f"납기 업데이트 실패 ({e.code}): {order_number}")
    except Exception as e:
        ui_log(f"납기 업데이트 호출 실패: {e}")
    return False


def remember_order_for_print(order_number: str, company_name: str, due_date_iso: str | None):
    """FlexSign에 보낸 주문을 인쇄 매칭용 큐에 기록.
    인쇄 PDF가 떨어지면 가장 최근 항목을 꺼내 다이얼로그에 표시한다."""
    with _recent_orders_lock:
        # 같은 주문이 또 처리될 수 있으니 같은 번호는 앞 항목을 제거하고 맨 뒤에 다시 넣는다.
        for existing in list(_recent_orders):
            if existing.get("orderNumber") == order_number:
                _recent_orders.remove(existing)
                break
        _recent_orders.append({
            "orderNumber": order_number,
            "companyName": company_name or "",
            "dueDate": due_date_iso or "",
            "ts": time.time(),
        })


def pop_recent_order() -> dict | None:
    """가장 최근 FlexSign 에 보낸 주문을 꺼낸다 (있으면 큐에서 제거)."""
    with _recent_orders_lock:
        try:
            return _recent_orders.pop()
        except IndexError:
            return None


def resolve_new_due_date(current_iso: str, day_input: int) -> date:
    """입력 일자를 기준 납기로부터 가장 자연스러운 날짜로 해석.
    같은 달 day_input 이 기준일보다 앞이면(=과거) 다음 달로 넘긴다.
    current_iso 가 비면 오늘을 기준으로 한다."""
    base = date.today()
    if current_iso:
        try:
            base = date.fromisoformat(current_iso)
        except ValueError:
            pass
    year, month = base.year, base.month
    if day_input < base.day:
        # 다음 달로 롤오버
        if month == 12:
            year += 1
            month = 1
        else:
            month += 1
    # 해당 월의 마지막 날을 넘으면 클램프
    try:
        return date(year, month, day_input)
    except ValueError:
        # 예: 2월 30일 → 그 달 마지막 날
        # 단순화: 다음 달 1일로 가서 1일 빼면 마지막 날
        if month == 12:
            next_first = date(year + 1, 1, 1)
        else:
            next_first = date(year, month + 1, 1)
        return next_first - timedelta(days=1)


def print_pdf_to_default_printer(pdf_path: Path) -> bool:
    """ShellExecute "print" 동사로 PDF를 윈도우 기본 프린터에 보낸다.
    기본 프린터는 [윈도우 설정 → 프린터 및 스캐너] 에서 삼성으로 지정해 두면 된다."""
    try:
        ctypes.windll.shell32.ShellExecuteW(0, "print", str(pdf_path), None, None, 0)
        ui_log(f"종이 인쇄 전달: {pdf_path.name}")
        return True
    except Exception as e:
        ui_log(f"종이 인쇄 실패: {e}")
        return False


# ── 인쇄 다이얼로그 ─────────────────────────────────────────────────────────

def _ask_due_date_blocking(company_name: str, current_due_iso: str) -> int | None:
    """모달 다이얼로그: 거래처명만 표시 + 일자 입력칸. Enter 확정, Esc 취소.
    리턴값: 사용자가 입력한 day(int) 또는 None(취소)."""
    # Tkinter 메인 루프 안에서만 안전하게 만들 수 있으므로, 이 함수는 UI 큐를 통해 호출됨.
    result: dict = {"day": None}

    base_day = ""
    if current_due_iso:
        try:
            base_day = str(date.fromisoformat(current_due_iso).day)
        except ValueError:
            base_day = ""

    dlg = tk.Toplevel()
    dlg.title("최종 납기")
    dlg.configure(bg="white")
    dlg.resizable(False, False)
    dlg.attributes("-topmost", True)
    dlg.geometry("280x140")

    tk.Label(
        dlg, text=company_name or "주문 확인",
        bg="white", fg="#18181b",
        font=("맑은 고딕", 13, "bold"),
    ).pack(pady=(18, 0))
    tk.Label(
        dlg, text="최종 납품날짜를 입력해주세요",
        bg="white", fg="#71717a",
        font=("맑은 고딕", 9),
    ).pack(pady=(2, 6))

    frame = tk.Frame(dlg, bg="white")
    frame.pack()
    var = tk.StringVar(value=base_day)
    entry = tk.Entry(
        frame, textvariable=var, width=4, justify="center",
        font=("맑은 고딕", 18, "bold"), relief="solid", bd=1,
    )
    entry.pack(side="left", padx=(0, 4))
    tk.Label(frame, text="일", bg="white", fg="#3f3f46",
             font=("맑은 고딕", 13)).pack(side="left")

    def confirm(_event=None):
        s = var.get().strip()
        if not s.isdigit():
            return
        d = int(s)
        if d < 1 or d > 31:
            return
        result["day"] = d
        dlg.destroy()

    def cancel(_event=None):
        result["day"] = None
        dlg.destroy()

    dlg.bind("<Return>", confirm)
    dlg.bind("<Escape>", cancel)
    dlg.protocol("WM_DELETE_WINDOW", cancel)

    # 포커스 + 전체 선택 → 그대로 Enter 도, 숫자 타닥 입력도 모두 자연스럽게.
    dlg.after(50, lambda: (entry.focus_set(), entry.select_range(0, "end"), entry.icursor("end")))
    dlg.grab_set()
    dlg.wait_window()
    return result["day"]


def _process_printed_pdf(pdf_path: Path):
    """인쇄 폴더에 새 PDF 가 떨어졌을 때 호출.
    가장 최근 주문과 매칭 → 다이얼로그 → 납기 PATCH + PDF 업로드(덮어쓰기) → 종이 인쇄."""
    key = str(pdf_path.resolve())
    if key in _seen_printed:
        return
    _seen_printed.add(key)
    # 파일이 완전히 쓰여질 때까지 잠깐 대기 (Bullzip 이 청크 단위로 쓸 수 있음)
    time.sleep(0.8)

    order = pop_recent_order()
    if not order:
        ui_log("인쇄 PDF 감지 — 매칭할 주문이 없어 무시")
        return
    order_number = order["orderNumber"]
    company = order.get("companyName", "")
    current_due = order.get("dueDate", "")

    # 다이얼로그는 메인 루프에서 모달로 띄워야 안전 — UI 큐로 전환.
    holder: dict = {"day": None, "done": threading.Event()}

    def _ask_on_ui():
        try:
            holder["day"] = _ask_due_date_blocking(company, current_due)
        finally:
            holder["done"].set()

    _ui_queue.put(("run", _ask_on_ui))
    holder["done"].wait()

    if holder["day"] is None:
        ui_log(f"{order_number} 인쇄 — 사용자가 일자 입력 취소(업로드/PATCH 생략)")
    else:
        new_due = resolve_new_due_date(current_due, holder["day"])
        patch_due_date(order_number, new_due)
        upload_worksheet_pdf(order_number, pdf_path)

    # 무인 PDF 프린터 라우팅: 항상 종이 인쇄까지 자동 진행.
    print_pdf_to_default_printer(pdf_path)


class PrintedPdfHandler(FileSystemEventHandler):
    def _handle(self, src: Path):
        if src.suffix.lower() != ".pdf":
            return
        if src.parent != PRINTED_PDF_DIR:
            return
        threading.Thread(target=_process_printed_pdf, args=(src,), daemon=True).start()

    def on_created(self, event):
        if not event.is_directory:
            self._handle(Path(event.src_path))

    def on_moved(self, event):
        self._handle(Path(event.dest_path))


def format_note_text(meta: dict) -> str:
    """우측 QR 아래: 주문번호 + 추가물품 + 추가요청사항.
    매칭 혼선을 막기 위해 주문번호는 항상 맨 위에 출력한다."""
    sections = []
    order_number = (meta.get("orderNumber") or "").strip()
    if order_number:
        sections.append(f"[주문번호] {order_number}")
    items_raw = (meta.get("additionalItems") or "").strip()
    if items_raw:
        # 프론트에서 ", " 로 join 해서 보내므로 다시 풀어 한 줄씩 표시한다.
        items_lines = [s.strip() for s in items_raw.split(",") if s.strip()]
        items_block = "\n".join(f"· {line}" for line in items_lines)
        sections.append(f"■ 추가물품\n{items_block}")
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


def process_ai_to_v8(ai_app, src_path: Path, dst_path: Path, pdf_path: Path,
                     qr_js_matrix: str,
                     header_text: str, left_text: str, note_text: str) -> bool:
    """
    JSX 한 번의 트랜잭션으로 open → worksheet 레이어 추가(QR + 주문정보 박스)
    → 같은 도큐먼트로 PDF + v8 SaveAs → close까지 전부 수행.
    PDF 는 거래처 모바일 화면에서 무한 확대해도 깨지지 않게 보여주기 위함이고,
    v8 는 FlexSign 전달용. 한 트랜잭션 안에서 둘 다 만들어야 doc 참조 꼬임이 없다.
    """
    header_js = _js_escape(header_text)
    left_js = _js_escape(left_text)
    note_js = _js_escape(note_text)
    src_js = str(src_path).replace("\\", "/")
    dst_js = str(dst_path).replace("\\", "/")
    pdf_js = str(pdf_path).replace("\\", "/")

    fr, fg, fb = HEADER_BOX_FILL
    sr, sg, sb = HEADER_BOX_STROKE

    script = (
        "try {"
        f"  var srcPath = \"{src_js}\";"
        f"  var dstPath = \"{dst_js}\";"
        f"  var pdfPath = \"{pdf_js}\";"
        "  var srcFile = new File(srcPath);"
        "  var dstFile = new File(dstPath);"
        "  var pdfFile = new File(pdfPath);"
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
        # 대지(첫 번째 artboard) 기준 위치, 도면(geometricBounds) 기준 크기 — 분리.
        # 이유: 거래처가 같은 템플릿 대지에 작은/큰 간판을 그려 보내기 때문에
        # 대지 폭으로 스케일하면 작은 간판에서 글씨가 너무 크고, 큰 간판에선 너무 작게 보였다.
        "  var ab = doc.artboards[0].artboardRect;"
        "  var abLeft = ab[0], abTop = ab[1], abRight = ab[2];"
        "  var abWidth = abRight - abLeft;"
        # 실제 도면 영역(있으면)을 측정해 사이즈 기준과 충돌 검사 둘 다에 사용.
        "  var hasArt = doc.pageItems.length > 0;"
        "  var artLeft = abLeft, artTop = abTop, artRight = abRight, artBottom = ab[3], artWidth = abWidth;"
        "  if (hasArt) {"
        "    try {"
        "      var dbnd = doc.geometricBounds;"  # [left, top, right, bottom]
        "      artLeft = dbnd[0]; artTop = dbnd[1]; artRight = dbnd[2]; artBottom = dbnd[3];"
        "      artWidth = artRight - artLeft;"
        "      if (artWidth <= 0) artWidth = abWidth;"
        "    } catch (e) { hasArt = false; }"
        "  }"
        # QR은 도면 폭의 8% (50~1000pt 사이) — 도면이 크면 QR/글씨/박스도 같이 커진다.
        "  var qrSize = artWidth * 0.08;"
        "  if (qrSize < 50) qrSize = 50;"
        "  if (qrSize > 1000) qrSize = 1000;"
        "  var sc = qrSize / 90.0;"
        "  var margin = 18 * sc;"
        "  var bigFont = 26 * sc;"
        "  var noteFont = 13 * sc;"
        # 박스 높이는 폰트에 맞춰 꽉 차게(1.25배). 너비는 대지의 약 45% — 시각적으로
        # 가운데를 확실히 점유하도록. 단, 텍스트가 들어갈 최소폭은 보장.
        "  var boxH = bigFont * 1.25;"
        "  var boxW = abWidth * 0.45;"
        "  var minBoxW = bigFont * 12;"
        "  if (boxW < minBoxW) boxW = minBoxW;"
        "  var lineGap = 6 * sc;"
        # 색상 / 폰트 — 노트 사전 측정 단계에서도 동일 폰트를 적용해야 정확한 줄높이가 나온다.
        "  var blk = new RGBColor(); blk.red = 0; blk.green = 0; blk.blue = 0;"
        "  var boxFill = new RGBColor();"
        f"  boxFill.red = {fr}; boxFill.green = {fg}; boxFill.blue = {fb};"
        "  var boxStroke = new RGBColor();"
        f"  boxStroke.red = {sr}; boxStroke.green = {sg}; boxStroke.blue = {sb};"
        "  var malgun = null;"
        "  var malgunNames = ['MalgunGothic','MalgunGothicRegular','MalgunGothic-Regular','Malgun Gothic','맑은 고딕','맑은고딕'];"
        "  for (var mi = 0; mi < malgunNames.length && malgun == null; mi++) {"
        "    try { malgun = app.textFonts.getByName(malgunNames[mi]); } catch(e) { malgun = null; }"
        "  }"
        # ── 노트 박스의 가로 위치 / 너비를 미리 결정해 두고, 텍스트 컨텐츠 높이도 사전 측정.
        # 이 값을 워크시트 전체 깊이 계산에 포함해야, 노트가 길어 도면을 침범할 때
        # 워크시트 폼을 충분히 위로 올릴 수 있다.
        f'  var noteTextStr = "{note_js}";'
        "  var pad = 6 * sc;"
        "  var qrOriginX = abRight - margin - qrSize;"
        "  var noteW = qrSize * 1.9;"
        "  var noteRight = qrOriginX + qrSize;"
        "  var noteLeft = noteRight - noteW;"
        "  if (noteLeft < abLeft + margin + boxW / 2) {"
        "    noteLeft = qrOriginX;"
        "    noteW = qrSize;"
        "  }"
        "  var noteTextW = noteW - pad * 2;"
        "  var noteTextLeft = noteLeft + pad;"
        "  var noteH = 0;"
        "  if (noteTextStr.length > 0) {"
        "    var tmpY = abTop;"
        "    var tmpPath = layer.pathItems.add();"
        "    tmpPath.filled = false; tmpPath.stroked = false;"
        "    tmpPath.setEntirePath(["
        "      [noteTextLeft, tmpY],"
        "      [noteTextLeft + noteTextW, tmpY],"
        "      [noteTextLeft + noteTextW, tmpY - 5000],"
        "      [noteTextLeft, tmpY - 5000]"
        "    ]);"
        "    tmpPath.closed = true;"
        "    var tmpTf = layer.textFrames.areaText(tmpPath);"
        "    tmpTf.contents = noteTextStr;"
        "    tmpTf.textRange.characterAttributes.size = noteFont;"
        "    if (malgun) tmpTf.textRange.characterAttributes.textFont = malgun;"
        "    var contentH = noteFont * 1.4;"
        "    try {"
        "      var tfLines = tmpTf.lines;"
        "      if (tfLines.length > 0) {"
        "        contentH = tfLines[0].geometricBounds[1] - tfLines[tfLines.length - 1].geometricBounds[3];"
        "      }"
        "    } catch (e) {}"
        "    noteH = contentH + pad * 2;"
        "    try { tmpTf.remove(); } catch (e) {}"
        "    try { tmpPath.remove(); } catch (e) {}"
        "  }"
        # 워크시트 전체 깊이 = max(우측 컬럼: QR + 노트, 중앙 컬럼: 헤더박스). 이 깊이만큼
        # 도면 위쪽으로 띄워야 한다. 폼 자체는 항상 우측·중앙 상단에 고정.
        "  var rightDepth = qrSize;"
        "  if (noteH > 0) rightDepth += lineGap + noteH;"
        "  var overlayDepth = (rightDepth > boxH) ? rightDepth : boxH;"
        "  var overlayHeight = overlayDepth + margin * 2;"
        "  var topY = abTop;"
        "  if (hasArt && artTop > abTop - overlayHeight) {"
        "    topY = artTop + overlayHeight + margin;"
        "  }"
        "  var needAbTop = (topY > abTop) ? (topY + margin) : abTop;"
        "  var needAbBottom = ab[3];"
        # 노트가 너무 길어 대지 하단을 넘어가면 그만큼 대지를 키운다.
        "  if (noteH > 0) {"
        "    var preNoteBot = topY - margin - qrSize - lineGap - noteH;"
        "    if (preNoteBot - margin < needAbBottom) needAbBottom = preNoteBot - margin;"
        "  }"
        # ── 좌측 상단: 싸인월드 + 거래처 전화번호 ──
        # 폰트마다 ascender/descender 가 달라 position만으로는 위치가 흔들리므로,
        # 폰트 적용 후 geometricBounds 로 실제 좌상단을 재기준 잡는다.
        "  var leftTf = layer.textFrames.add();"
        f'  leftTf.contents = "{left_js}";'
        "  leftTf.textRange.characterAttributes.size = bigFont;"
        "  if (malgun) leftTf.textRange.characterAttributes.textFont = malgun;"
        "  leftTf.position = [0, 0];"
        "  var lb = leftTf.geometricBounds;"  # [left, top, right, bottom]
        "  var leftTargetX = abLeft + margin;"
        "  var leftTargetTop = topY - margin;"
        "  leftTf.position = [leftTargetX - lb[0], leftTargetTop - lb[1]];"
        # ── 중앙 상단: 박스 + 발주/배송 텍스트 ──
        "  var centerX = (abLeft + abRight) / 2;"
        "  var boxLeft = centerX - boxW / 2;"
        "  var boxTop = topY - margin;"
        "  var box = layer.pathItems.rectangle(boxTop, boxLeft, boxW, boxH);"
        "  box.filled = true; box.fillColor = boxFill;"
        "  box.stroked = true; box.strokeColor = boxStroke;"
        "  box.strokeWidth = 0.5 * sc;"
        # 박스 텍스트는 실제 glyph bounds 중심을 측정한 뒤
        # 박스 정중앙으로 옮겨야 정확히 가운데 들어간다. 폰트는 측정 전에 설정.
        "  var headerTf = layer.textFrames.add();"
        f'  headerTf.contents = "{header_js}";'
        "  headerTf.textRange.characterAttributes.size = bigFont;"
        "  if (malgun) headerTf.textRange.characterAttributes.textFont = malgun;"
        "  headerTf.position = [0, 0];"
        "  var hb = headerTf.geometricBounds;"  # [left, top, right, bottom]
        "  var glyphCx = (hb[0] + hb[2]) / 2;"
        "  var glyphCy = (hb[1] + hb[3]) / 2;"
        "  var boxCenterY = boxTop - boxH / 2;"
        "  headerTf.position = [centerX - glyphCx, boxCenterY - glyphCy];"
        # ── 우측 상단: QR ── (qrOriginX는 사전에 정의됨)
        "  var qrOriginY = topY - margin;"
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
        # ── QR 아래: 추가물품/추가요청사항 폼 박스 (항상 우측 상단 고정) ──
        # 충돌은 위에서 topY 를 올려 처리했으므로 여기선 단순히 측정한 높이로 배치만 한다.
        "  var noteTfRef = null;"
        "  if (noteH > 0) {"
        "    var noteTop = qrOriginY - qrSize - lineGap;"
        "    var notePath = layer.pathItems.add();"
        "    notePath.filled = false; notePath.stroked = false;"
        "    notePath.setEntirePath(["
        "      [noteTextLeft, noteTop - pad],"
        "      [noteTextLeft + noteTextW, noteTop - pad],"
        "      [noteTextLeft + noteTextW, noteTop - noteH + pad],"
        "      [noteTextLeft, noteTop - noteH + pad]"
        "    ]);"
        "    notePath.closed = true;"
        "    var noteTf = layer.textFrames.areaText(notePath);"
        "    noteTf.contents = noteTextStr;"
        "    noteTf.textRange.characterAttributes.size = noteFont;"
        "    if (malgun) noteTf.textRange.characterAttributes.textFont = malgun;"
        "    noteTfRef = noteTf;"
        "    var noteBox = layer.pathItems.rectangle(noteTop, noteLeft, noteW, noteH);"
        "    noteBox.filled = false;"
        "    noteBox.stroked = true;"
        "    noteBox.strokeColor = boxStroke;"
        "    noteBox.strokeWidth = 0.5 * sc;"
        "  }"
        # 워크시트 요소들이 원래 대지 밖으로 밀려난 경우 대지를 그만큼 확장.
        # 위/아래 양쪽 변동을 한 번에 반영한다.
        "  if (needAbTop > abTop || needAbBottom < ab[3]) {"
        "    try { doc.artboards[0].artboardRect = [abLeft, needAbTop, abRight, needAbBottom]; } catch (e) {}"
        "  }"
        # FlexSign 가 v8 AI 의 글자 메트릭을 다르게 해석해서 자모 사이가 벌어지는
        # 문제를 막으려면, 저장 전에 모든 텍스트를 윤곽선(아웃라인)으로 변환해야
        # 한다. 변환 후엔 폰트 의존이 사라져 어떤 프로그램에서 열어도 모양이
        # 그대로 유지된다.
        "  try { leftTf.createOutline(); } catch (e) {}"
        "  try { headerTf.createOutline(); } catch (e) {}"
        "  if (noteTfRef) { try { noteTfRef.createOutline(); } catch (e) {} }"
        # PDF 먼저 저장 — 모바일 거래처 페이지에서 무한 확대해도 깨지지 않는 벡터 PDF.
        # preserveEditability=false 로 print-ready 사이즈로 압축한다.
        "  try {"
        "    var pdfOpts = new PDFSaveOptions();"
        "    pdfOpts.compatibility = PDFCompatibility.ACROBAT7;"
        "    pdfOpts.preserveEditability = false;"
        "    pdfOpts.viewAfterSaving = false;"
        "    doc.saveAs(pdfFile, pdfOpts);"
        "  } catch (e) {}"
        # 그 다음 v8 — 이 호출 후엔 doc 의 정체성이 .ai 로 바뀌므로 PDF 가 먼저여야 한다.
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
                    header_text: str, left_text: str, note_text: str
                    ) -> tuple[Path, Path] | None:
    """변환 성공 시 (AI v8 경로, PDF 경로) 튜플을 반환. 실패 시 None."""
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
        pdf_path = out_dir / f"{ai_path.stem}_{ts}.pdf"

        if not process_ai_to_v8(ai_app, ai_path, out_path, pdf_path, qr_js_matrix,
                                header_text, left_text, note_text):
            return None

        ui_log(f"{ai_path.name} v8/PDF 저장 완료")
        return out_path, pdf_path

    except Exception as e:
        ui_log(f"변환 실패: {e}")
        return None


def upload_worksheet_pdf(order_number: str, pdf_path: Path) -> bool:
    """변환된 PDF를 백엔드에 업로드. 거래처 카드에 노출되는 단일 PDF로 덮어씀.
    multipart/form-data 를 표준 라이브러리만으로 구성한다 (외부 의존성 추가 없음)."""
    if not order_number or not pdf_path.exists():
        return False
    url = f"{API_BASE}/api/public/orders/{quote(order_number, safe='')}/worksheet-pdf"
    boundary = f"----hdsign{int(time.time()*1000)}"
    try:
        pdf_bytes = pdf_path.read_bytes()
    except Exception as e:
        ui_log(f"PDF 읽기 실패: {e}")
        return False

    head = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{pdf_path.name}"\r\n'
        "Content-Type: application/pdf\r\n\r\n"
    ).encode("utf-8")
    tail = f"\r\n--{boundary}--\r\n".encode("utf-8")
    body = head + pdf_bytes + tail

    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    req.add_header("Content-Length", str(len(body)))
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            resp.read()
        ui_log(f"{order_number} PDF 업로드 완료")
        return True
    except urllib.error.HTTPError as e:
        ui_log(f"PDF 업로드 실패 ({e.code}): {order_number}")
    except Exception as e:
        ui_log(f"PDF 업로드 호출 실패: {e}")
    return False


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
    any_converted = False
    pdf_to_upload: Path | None = None
    if not ai_files:
        ui_log(f"{order_number}: AI 파일 없음 — 확인 필요")
    else:
        for ai_file in ai_files:
            converted = convert_ai_file(Path(ai_file), qr_js,
                                        header_text, left_text, note_text)
            if converted:
                ai_out, pdf_out = converted
                launch_flexsign(ai_out)
                # 한 주문에 AI가 여러 개여도 PDF 는 마지막 것 1개만 거래처에 노출.
                pdf_to_upload = pdf_out
                any_converted = True

    if any_converted:
        notify_worksheet_acknowledged(order_number)
        if pdf_to_upload is not None:
            upload_worksheet_pdf(order_number, pdf_to_upload)
        # 인쇄 PDF 가 떨어지면 매칭할 수 있도록 큐에 등록.
        remember_order_for_print(
            order_number,
            company,
            (str(meta.get("dueDate")).split("T")[0] if meta.get("dueDate") else ""),
        )

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
                elif item[0] == "run":
                    # 워커 스레드가 모달 다이얼로그를 띄워야 할 때 사용.
                    fn = item[1]
                    self.after(0, fn)
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
            PRINTED_PDF_DIR.mkdir(parents=True, exist_ok=True)

            for existing in WATCH_DIR.glob("*_지시서.zip"):
                threading.Thread(target=process_zip, args=(existing,), daemon=True).start()

            self._observer = Observer()
            self._observer.schedule(ZipHandler(WATCH_DIR), str(WATCH_DIR), recursive=False)
            self._observer.schedule(ZipHandler(DOWNLOADS_DIR), str(DOWNLOADS_DIR), recursive=False)
            # 무인 PDF 프린터(Bullzip 등)가 떨어뜨리는 인쇄 PDF 감시.
            self._observer.schedule(PrintedPdfHandler(), str(PRINTED_PDF_DIR), recursive=False)
            self._observer.start()

            start_ping_server()

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
