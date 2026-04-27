# hdsign_watcher.py
# GUI watcher for HD Sign worksheet automation
# Dependencies: pip install watchdog qrcode[pil] Pillow pywin32

from __future__ import annotations

import collections
import ctypes
import json
import queue
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import tkinter as tk
import unicodedata
from datetime import date, timedelta
from tkinter import filedialog, messagebox, ttk
import urllib.error
import urllib.request
import zipfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from urllib.parse import quote, unquote, urlsplit, urlunsplit


def _safe_url(url: str) -> str:
    """URL 의 path/query/fragment 를 RFC 3986 안전 문자만 남기고 percent-encode.
    백엔드가 한글이 들어간 URL(예: '.../주문-260427-03.pdf')을 그대로 내려줘도
    urlopen 의 ASCII 인코딩 단계에서 'codec can't encode character' 로 죽는 걸 막는다."""
    if not url:
        return url
    try:
        u = urlsplit(url)
        path = quote(u.path, safe="/%")
        query = quote(u.query, safe="=&%+")
        fragment = quote(u.fragment, safe="%")
        return urlunsplit((u.scheme, u.netloc, path, query, fragment))
    except Exception:
        return url

import qrcode
from PIL import Image, ImageTk
from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

# PyMuPDF — 인쇄 다이얼로그 [기존 변경] 탭의 그리드 미리보기 썸네일 렌더에만 쓴다.
# 미설치 환경에서도 워처는 동작하도록 폴백(텍스트 카드)을 둔다.
try:
    import fitz  # type: ignore
except Exception:
    fitz = None  # type: ignore

# pyzbar — 인쇄된 PDF 안의 QR 을 디코드해 주문번호 자동 매칭에 쓴다.
# 미설치/디코드 실패 시 None 반환 → 다이얼로그가 평소처럼 수동 선택 모드로 뜬다.
try:
    from pyzbar.pyzbar import decode as pyzbar_decode  # type: ignore
except Exception:
    pyzbar_decode = None  # type: ignore

WATCH_DIR = Path(r"C:\Users\USER\Desktop\hdsign_orders")
DOWNLOADS_DIR = Path.home() / "Downloads"
DONE_DIR = WATCH_DIR / "done"
# PDF24(또는 다른 무인 PDF 프린터) 가 인쇄 PDF 를 떨어뜨리는 폴더.
# PDF24 자동 저장 프로파일에서 저장 폴더를 이 경로로, "저장 시 대화상자" 끄기.
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

# FlexSign 인쇄 다이얼로그가 자동으로 PDF24 를 선택하도록 워처가 임시로 기본 프린터를 전환한다.
# 시스템에 등록된 정확한 프린터 이름으로 맞춰야 함 (제어판 → 장치 및 프린터 에서 확인).
PDF24_PRINTER_NAME = "PDF24"

# 실제 종이 인쇄가 향할 프린터를 결정하는 규칙. 시스템 기본 프린터와 무관하게 여기로 보낸다.
# 노트북·사무실 PC 가 서로 다른 삼성 모델을 쓰므로, 정확 일치 후보 → 부분 일치 패턴 순으로
# 실제 설치된 프린터를 찾는다. 새 PC 가 생기면 후보 리스트에 추가만 하면 됨.
PAPER_PRINTER_CANDIDATES = [
    "Samsung X7600 Series",   # 노트북
    # 사무실 모델명 확인 시 여기에 추가
]
# 후보에 정확 일치하는 프린터가 없을 때 부분 일치(대소문자 무시)로 fallback. 빈 문자열이면 비활성.
PAPER_PRINTER_PATTERN = "Samsung"

_seen_zips: set[str] = set()
_seen_lock = threading.Lock()
_ui_queue: queue.Queue = queue.Queue()

# FlexSign 으로 보낸 주문들의 메타. 인쇄 PDF 가 떨어졌을 때 가장 최근 항목과 매칭한다.
# (deque 로 최대 20건만 유지 — 그 이상 한번에 처리할 일은 거의 없음)
# 워처 재시작 후에도 큐가 살아있도록 _RECENT_ORDERS_FILE 에 영속화. 이전 세션에서
# FlexSign 에 띄워놓고 인쇄만 안 한 주문도 매칭 다이얼로그가 뜨도록 보장.
_RECENT_ORDERS_FILE = WATCH_DIR / "state" / "recent_orders.json"
# 24시간 지난 항목은 인쇄 매칭 후보에서 제외 — 사무실에서 익일 처리하는 일은 드뭄.
_RECENT_ORDERS_TTL_SEC = 24 * 3600
_recent_orders: collections.deque = collections.deque(maxlen=20)
_recent_orders_lock = threading.Lock()
_seen_printed: set[str] = set()
# watchdog 이 같은 파일에 대해 on_created + on_moved 를 거의 동시에 두 번 보내는 경우가
# 있어서 dedup 체크와 set 추가 사이의 race 로 다이얼로그가 두 번 뜨는 문제가 있었다.
# 락으로 check-and-add 를 원자적으로 만들어 한 파일당 정확히 한 번만 처리하도록 보장.
_seen_printed_lock = threading.Lock()

# 워처가 PDF24 로 바꾸기 직전의 원래 기본 프린터. 인쇄 PDF 감지 시 여기로 복구.
_saved_default_printer: str | None = None
_printer_lock = threading.Lock()

# 사무실 네트워크 거래처 폴더 베이스 경로 등 외부 설정. 빌드 없이 사무실에서 한 줄
# 추가만으로 동작하도록 JSON 파일로 분리. 키 예시:
#   { "network_customer_base": "\\\\hd-server\\공용\\거래처" }
# 미설정/접근불가 시 워처는 로컬 converted/ 만 사용하는 기존 동작으로 폴백.
_CONFIG_FILE = WATCH_DIR / "state" / "config.json"


# ── 작업지시서 분배함 → 모바일 부서 태그 매핑 ─────────────────────────────
# 인쇄 다이얼로그에서 사무실 분배함 사진을 그대로 띄우고, 직원이 칸을 클릭해
# "이 지시서는 어느 칸에 꽂힌다"고 지정하면 → 해당 칸에 매핑된 부서 태그가 붙는다.
# 같은 지시서가 여러 칸에 꽂히는 경우(여러 부서를 거치는 간판) 다중 태그 허용.
#
# 분배함 사진은 scripts/assets/distribution.jpg (실제 사진 3510x5613).
# 좌표는 (left, top, right, bottom) — 사진 원본 픽셀 좌표 기준. 다이얼로그에서 표시할 때
# 비율 유지로 축소하면서 클릭 좌표를 원본 픽셀 좌표로 역변환해 어떤 칸인지 판정한다.
#
# 좌표가 실제 사진과 어긋나면 빌드 후 여기 숫자만 조정하면 됨. 칸 라벨 옆 mapped_dept 가
# 빈 문자열인 칸(배송2팀, 홍철웅팀장)은 사용 안 함 — 클릭해도 토글되지 않는다.
SLOT_LAYOUT_PHOTO_SIZE = (3510, 5613)  # distribution.jpg 원본 (가로, 세로)

# (slot_label, mapped_dept, (left, top, right, bottom))
# mapped_dept 가 빈 문자열이면 비활성 칸(클릭 무시).
SLOT_BOXES: list[tuple[str, str, tuple[int, int, int, int]]] = [
    ("캡/일체형작업실", "완조립부", (85, 215, 907, 1443)),
    ("시트/도안실", "완조립부", (941, 215, 1750, 1443)),
    ("에폭시실", "에폭시부", (1766, 208, 2613, 1436)),
    ("아크릴/실리콘네온", "CNC가공부", (2621, 208, 3460, 1436)),
    ("후레임실", "완조립부", (148, 1723, 950, 2813)),
    ("도장실", "도장부", (962, 1723, 1757, 2813)),
    ("레이져용접", "CNC가공부", (1752, 1723, 2564, 2813)),
    ("최창영부장", "CNC가공부", (2572, 1737, 3411, 2827)),
    ("조립부", "완조립부", (183, 3472, 950, 4488)),
    ("아크릴부(레이져)", "아크릴가공부(5층)", (976, 3458, 1702, 4474)),
    ("배송1팀", "배송팀", (1717, 3451, 2500, 4467)),
    ("배송2팀", "", (2509, 3444, 3300, 4460)),
    ("홍철웅팀장", "", (232, 4533, 967, 5480)),
    ("LED조립", "LED조립부", (990, 4533, 1716, 5480)),
    ("고무스카시(CNC)", "CNC가공부", (1745, 4519, 2485, 5466)),
    ("이휘원실장", "완조립부", (2502, 4519, 3249, 5466)),
]


def resource_path(rel: str) -> Path:
    """개발(.py 직접 실행) / PyInstaller 빌드 양쪽에서 동일하게 동작하는 리소스 경로 헬퍼.
    빌드 시 sys._MEIPASS 에 datas 가 풀리고, 개발 시엔 이 파일과 같은 폴더 기준."""
    base = getattr(sys, "_MEIPASS", None)
    if base:
        return Path(base) / rel
    return Path(__file__).resolve().parent / rel


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


def missing_required_apps() -> list[str]:
    missing = []
    if not is_running("Illustrator.exe"):
        missing.append("Adobe Illustrator")
    if not is_running("App.exe"):
        missing.append("FlexiSIGN")
    return missing


def check_prerequisites() -> bool:
    """Run from background thread. Uses ctypes MessageBox (thread-safe)."""
    missing = missing_required_apps()
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

# 백엔드 enum ↔ 한글 라벨. 메타데이터는 한글로 오므로 enum 으로 변환해서 PATCH 한다.
# 다이얼로그 드롭다운은 한글로 표시한다.
DELIVERY_ENUM_TO_KO = {
    "CARGO":       "화물 발송",
    "QUICK":       "퀵 발송",
    "DIRECT":      "직접 배송",
    "PICKUP":      "직접 수령",
    "LOCAL_CARGO": "지방화물차 배송",
}
DELIVERY_KO_TO_ENUM = {v: k for k, v in DELIVERY_ENUM_TO_KO.items()}


def _format_md(value) -> str:
    """ISO 날짜 또는 yyyy-MM-dd 문자열에서 MM-dd 만 추출."""
    if not value:
        return ""
    s = str(value).split("T")[0]
    parts = s.split("-")
    return f"{parts[1]}-{parts[2]}" if len(parts) >= 3 else s


def format_header_text(meta: dict) -> str:
    """중앙 박스용 한 줄 텍스트. 예: '04-24발주/04-25화물'.
    공백을 모두 제거하고 슬래시로 구분 — FlexSign 글자 메트릭 변환에서 공백 폭이
    크게 늘어나 회색 박스 밖으로 글씨가 밀려나는 문제 회피. 회사명/주소가 들어가는
    값은 따로 없으므로 공백을 다 빼도 의미 손실 없음."""
    parts = []
    order_md = _format_md(meta.get("createdAt"))
    if order_md:
        parts.append(f"{order_md}발주")
    due_md = _format_md(meta.get("dueDate"))
    delivery = DELIVERY_SHORT.get((meta.get("deliveryMethod") or "").strip(), "")
    if due_md:
        parts.append(f"{due_md}{delivery}" if delivery else due_md)
    return "/".join(parts).replace(" ", "") if parts else "-"


def format_left_text(meta: dict) -> str:
    """좌측 상단: 거래처명 + 거래처 전화번호. 전화번호의 모든 공백은 제거한다.
    거래처명이 비어 있으면 '거래처 미상' 으로 폴백 — 빈 칸이 박히는 것보다 의도가 분명."""
    company = (meta.get("companyName") or "").strip() or "거래처 미상"
    phone_raw = meta.get("phone") or ""
    phone = "".join(phone_raw.split())
    return f"{company}\n{phone}" if phone else company


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


def patch_due_date(order_number: str, new_due: date,
                   delivery_enum: str | None = None,
                   department_tags: list[str] | None = None) -> bool:
    """다이얼로그에서 확정한 최종 납기 일자(+선택적으로 배송방법/부서 태그)를 백엔드에 전달.
    delivery_enum: 백엔드 enum 명(CARGO/QUICK/DIRECT/PICKUP/LOCAL_CARGO). None/빈값이면 송신 생략.
    department_tags: 분배함 사진에서 직원이 클릭한 칸 → 매핑된 모바일 부서 태그(중복 제거).
        None 이면 키 자체를 송신하지 않아 백엔드는 기존 태그 유지. 빈 리스트 [] 는 명시적
        "태그 비우기" — 분배함을 모두 비활성으로 두고 적용한 경우."""
    if not order_number:
        return False
    url = f"{API_BASE}/api/public/orders/{quote(order_number, safe='')}/due-date"
    payload: dict = {"dueDate": new_due.isoformat()}
    if delivery_enum:
        payload["deliveryMethod"] = delivery_enum
    if department_tags is not None:
        payload["departmentTags"] = list(department_tags)
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp.read()
        parts = [f"납기 {new_due.isoformat()}"]
        if delivery_enum:
            parts.append(f"배송 {delivery_enum}")
        if department_tags is not None:
            parts.append("태그 " + (", ".join(department_tags) if department_tags else "(없음)"))
        ui_log(f"{order_number} {' / '.join(parts)} 로 업데이트")
        return True
    except urllib.error.HTTPError as e:
        ui_log(f"납기 업데이트 실패 ({e.code}): {order_number}")
    except Exception as e:
        ui_log(f"납기 업데이트 호출 실패: {e}")
    return False


def _save_recent_orders_unlocked() -> None:
    """_recent_orders 를 디스크에 직렬화. 호출자가 _recent_orders_lock 을 보유한
    상태여야 한다. 원자성 보장을 위해 .tmp 에 쓰고 replace."""
    try:
        _RECENT_ORDERS_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = _RECENT_ORDERS_FILE.with_suffix(".tmp")
        data = list(_recent_orders)
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        tmp.replace(_RECENT_ORDERS_FILE)
    except Exception as e:
        # 영속화 실패해도 메모리 큐는 유효 — 로그만 남기고 계속 진행.
        ui_log(f"인쇄 매칭 큐 저장 실패: {e}")


def load_recent_orders() -> None:
    """워처 시작 시 디스크에서 큐 복구. 파일 없거나 깨졌으면 조용히 빈 상태로 시작.
    TTL 지난 항목은 로드 시점에 걸러낸다."""
    try:
        raw = _RECENT_ORDERS_FILE.read_text(encoding="utf-8")
    except FileNotFoundError:
        return
    except Exception as e:
        ui_log(f"인쇄 매칭 큐 로드 실패(파일 읽기): {e}")
        return
    try:
        items = json.loads(raw)
        if not isinstance(items, list):
            return
    except Exception as e:
        ui_log(f"인쇄 매칭 큐 로드 실패(JSON): {e}")
        return
    now = time.time()
    cutoff = now - _RECENT_ORDERS_TTL_SEC
    with _recent_orders_lock:
        _recent_orders.clear()
        for it in items:
            if not isinstance(it, dict):
                continue
            ts = it.get("ts")
            if not isinstance(ts, (int, float)) or ts < cutoff:
                continue
            _recent_orders.append({
                "orderNumber": it.get("orderNumber") or "",
                "companyName": it.get("companyName") or "",
                "originalFileName": it.get("originalFileName") or "",
                "dueDate": it.get("dueDate") or "",
                "deliveryMethod": it.get("deliveryMethod") or "",
                "ts": float(ts),
            })
        _save_recent_orders_unlocked()
    if _recent_orders:
        ui_log(f"인쇄 매칭 큐 복구: {len(_recent_orders)}건")


def remember_order_for_print(order_number: str, company_name: str,
                             due_date_iso: str | None, delivery_enum: str | None,
                             original_file_name: str = ""):
    """FlexSign에 보낸 주문을 인쇄 매칭용 큐에 기록.
    인쇄 PDF가 떨어지면 가장 최근 항목을 꺼내 다이얼로그에 표시한다.
    delivery_enum 은 백엔드 enum 명(CARGO 등). 한글이 들어오면 변환되지 않으니 빈 값.
    original_file_name 은 ZIP 안의 원본 .ai 파일명(예: '0907 아크릴스카시발주.ai').
    [신규 작성] 탭에서 자동 생성된 print_*.pdf 대신 이 이름을 표시하기 위해 같이 보관."""
    with _recent_orders_lock:
        # 같은 주문이 또 처리될 수 있으니 같은 번호는 앞 항목을 제거하고 맨 뒤에 다시 넣는다.
        for existing in list(_recent_orders):
            if existing.get("orderNumber") == order_number:
                _recent_orders.remove(existing)
                break
        _recent_orders.append({
            "orderNumber": order_number,
            "companyName": company_name or "",
            "originalFileName": original_file_name or "",
            "dueDate": due_date_iso or "",
            "deliveryMethod": delivery_enum or "",
            "ts": time.time(),
        })
        _save_recent_orders_unlocked()


def list_recent_orders() -> list[dict]:
    """최근 처리한 주문을 최신순(가장 최근이 [0])으로 반환. 큐는 그대로 유지.
    인쇄 PDF 다이얼로그에서 직원이 어떤 주문에 매칭할지 직접 고르는 데 쓴다.
    TTL 지난 항목은 결과에서 제외 — 메모리에는 남겨둔다(다음 save 때 자연 정리)."""
    cutoff = time.time() - _RECENT_ORDERS_TTL_SEC
    with _recent_orders_lock:
        fresh = [o for o in _recent_orders if o.get("ts", 0) >= cutoff]
        return list(reversed(fresh))


def fetch_existing_worksheets() -> list[dict]:
    """공개 API 에서 IN_PROGRESS + PDF 부착된 작업지시서 목록을 가져온다.
    인쇄 다이얼로그 [기존 변경] 탭에서 어느 지시서를 갱신할지 그리드로 보여주는 용도.
    네트워크 실패 시 빈 리스트(다이얼로그는 신규 탭 위주로 표시)."""
    url = f"{API_BASE}/api/public/worksheets"
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        if isinstance(data, list):
            return data
        return []
    except Exception as e:
        ui_log(f"기존 지시서 목록 조회 실패: {e}")
        return []


# ── Network customer folder delivery ─────────────────────────────────────────

def _load_config() -> dict:
    """워처 외부 설정(JSON) 로드. 파일 없거나 깨졌으면 빈 dict — 기존 동작으로 폴백."""
    try:
        return json.loads(_CONFIG_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except Exception as e:
        ui_log(f"config.json 로드 실패: {e}")
        return {}


def _save_config(config: dict) -> bool:
    """config.json 에 원자적 쓰기. .tmp → replace 로 부분 쓰기 위험 회피.
    GUI [추적 폴더 변경] 같은 사용자 액션에서만 호출 — 실패 시 ui_log 로 보고."""
    try:
        _CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = _CONFIG_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(_CONFIG_FILE)
        return True
    except Exception as e:
        ui_log(f"config.json 저장 실패: {e}")
        return False


_FORBIDDEN_FS_CHARS = set('<>:"/\\|?*')


def _sanitize_folder_name(name: str) -> str:
    """Windows 폴더명 금지문자 치환 + 앞뒤 공백/마침표 제거.
    빈 문자열은 그대로 빈 문자열 반환 (호출자가 폴백)."""
    if not name:
        return ""
    cleaned = "".join("_" if c in _FORBIDDEN_FS_CHARS else c for c in name)
    return cleaned.strip().strip(".")


def _normalize_company_key(name: str) -> str:
    """거래처 폴더 매칭용 정규화 키. NFC + 모든 공백류 제거 + 소문자.
    윈도우 파일시스템이 NFD 로 저장하는 케이스 + 사람이 입력한 공백 차이를 흡수."""
    if not name:
        return ""
    n = unicodedata.normalize("NFC", name)
    n = "".join(n.split())  # 공백/탭/개행 모두 제거
    return n.lower()


def resolve_customer_folder(network_base: Path, network_folder_name: str,
                            company_name: str) -> Path:
    """네트워크 베이스 안에서 거래처 폴더 결정.
    1순위: networkFolderName (관리자가 거래처관리에서 명시 지정한 폴더명) 정확 일치
    2순위: companyName 정확 일치 (공백/대소문자/NFC 무시)
    매칭 실패 시 '<networkFolderName 또는 companyName> (자동생성)' 신규 경로 반환.
    스캔 실패(권한/네트워크 끊김) 시에도 자동생성 경로로 폴백."""
    primary_key = _normalize_company_key(network_folder_name)
    fallback_key = _normalize_company_key(company_name)
    label = (network_folder_name or "").strip() or (company_name or "").strip()
    safe_label = _sanitize_folder_name(label) or "(미지정)"
    fallback_new = network_base / f"{safe_label} (자동생성)"
    if not primary_key and not fallback_key:
        return fallback_new
    try:
        primary_hit = None
        fallback_hit = None
        for child in network_base.iterdir():
            if not child.is_dir():
                continue
            child_key = _normalize_company_key(child.name)
            if primary_key and child_key == primary_key:
                primary_hit = child
                break
            if fallback_key and child_key == fallback_key:
                fallback_hit = child
        if primary_hit is not None:
            return primary_hit
        if fallback_hit is not None:
            return fallback_hit
    except Exception as e:
        ui_log(f"거래처 폴더 스캔 실패({e}) — 자동생성 경로로 진행")
    return fallback_new


def resolve_network_order_folder(meta: dict, primary_ai_name: str | None) -> Path | None:
    """네트워크 거래처 폴더 안에 주문별 하위폴더를 만들고 그 경로 반환.
    구조: <network_base>/<거래처폴더>/<MM-DD<제목 또는 첫 .ai 파일명>>/
    폴더명 규칙: title > 첫 .ai 파일 stem > '제목없음', MM-DD 와 공백 없이 결합.
    한 주문에 .ai 가 여러 개여도 호출자가 이 폴더 한 곳에 모두 묶어 넣는다.
    네트워크 미설정/접근실패 시 None — 호출자가 로컬 converted/ 사용."""
    config = _load_config()
    base_str = (config.get("network_customer_base") or "").strip()
    if not base_str:
        return None
    network_base = Path(base_str)
    try:
        if not network_base.exists():
            ui_log(f"네트워크 베이스 폴더 접근 불가: {base_str} — 로컬만 사용")
            return None
    except Exception as e:
        ui_log(f"네트워크 베이스 확인 실패: {e} — 로컬만 사용")
        return None

    company = (meta.get("companyName") or "").strip()
    network_folder = (meta.get("networkFolderName") or "").strip()
    title = (meta.get("title") or "").strip()
    md = _format_md(meta.get("createdAt"))
    if not md:
        today = date.today()
        md = f"{today.month:02d}-{today.day:02d}"

    # 폴더명: title > 첫 .ai 파일 stem > '제목없음'. MM-DD 와는 공백 없이 결합.
    if title:
        name_part = title
    elif primary_ai_name:
        name_part = Path(primary_ai_name).stem or "제목없음"
    else:
        name_part = "제목없음"
    order_folder_raw = f"{md}{name_part}"
    order_folder_name = _sanitize_folder_name(order_folder_raw) or f"{md}제목없음"

    customer_folder = resolve_customer_folder(network_base, network_folder, company)
    is_new_customer = customer_folder.name.endswith("(자동생성)") and not customer_folder.exists()
    order_folder = customer_folder / order_folder_name
    try:
        order_folder.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        ui_log(f"네트워크 주문 폴더 생성 실패: {e} — 로컬만 사용")
        return None
    if is_new_customer:
        ui_log(f"거래처 폴더 신규 생성: {customer_folder.name}")
    return order_folder


def copy_ai_pair_to_network(order_folder: Path, original_ai: Path,
                            v8_ai: Path) -> Path | None:
    """원본 .ai + v8 .ai 를 미리 만들어둔 주문 폴더에 복사. v8 경로 반환.
    실패 시 None — 호출자가 로컬 v8 사용."""
    try:
        dst_orig = order_folder / original_ai.name
        shutil.copy2(str(original_ai), str(dst_orig))
        dst_v8 = order_folder / f"{original_ai.stem}_v8.ai"
        shutil.copy2(str(v8_ai), str(dst_v8))
    except Exception as e:
        ui_log(f"네트워크 복사 실패: {e} — 로컬 v8 사용")
        return None
    ui_log(f"네트워크 저장: {order_folder.parent.name} / {order_folder.name} / {original_ai.name}")
    return dst_v8


# ── Admin token + 거래처 폴더 목록 동기화 ────────────────────────────────────

# admin_username/admin_password 는 config.json 에 둔다. 토큰은 24h 유효(JwtUtil 기본값).
# 만료 30분 전부터 재로그인 — 시계 어긋남 보호.
_admin_token_cache: dict = {"token": None, "exp_ts": 0.0}
_admin_token_lock = threading.Lock()
_ADMIN_TOKEN_REFRESH_BEFORE_SEC = 30 * 60


def _admin_login(username: str, password: str) -> str | None:
    """관리자 로그인 → JWT 반환. 실패 시 None."""
    url = f"{API_BASE}/api/auth/login"
    body = json.dumps({"username": username, "password": password}).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data.get("token")
    except Exception as e:
        ui_log(f"관리자 로그인 실패: {e}")
        return None


def _get_admin_token() -> str | None:
    """캐시된 admin 토큰 반환. 없거나 곧 만료면 재로그인. config 미설정 시 None."""
    config = _load_config()
    username = (config.get("admin_username") or "").strip()
    password = (config.get("admin_password") or "")
    if not username or not password:
        return None
    now = time.time()
    with _admin_token_lock:
        token = _admin_token_cache.get("token")
        exp = _admin_token_cache.get("exp_ts", 0.0)
        if token and now < exp - _ADMIN_TOKEN_REFRESH_BEFORE_SEC:
            return token
        new_token = _admin_login(username, password)
        if not new_token:
            return None
        # JwtUtil 기본 만료 24h. 정확한 exp 파싱 대신 여유있게 23h 로 캐시.
        _admin_token_cache["token"] = new_token
        _admin_token_cache["exp_ts"] = now + 23 * 3600
        return new_token


def _list_network_folder_names() -> list[str] | None:
    """network_customer_base 디렉토리의 1단계 하위 폴더명 리스트.
    (자동생성) 접미사 폴더는 제외 — 워처가 매칭 실패로 만든 것일 수 있음.
    네트워크 미설정/접근실패 시 None."""
    config = _load_config()
    base_str = (config.get("network_customer_base") or "").strip()
    if not base_str:
        return None
    base = Path(base_str)
    try:
        if not base.exists():
            return None
        names = []
        for child in base.iterdir():
            if not child.is_dir():
                continue
            name = child.name
            if name.endswith("(자동생성)"):
                continue
            names.append(name)
        return sorted(names, key=_normalize_company_key)
    except Exception as e:
        ui_log(f"거래처 폴더 리스팅 실패: {e}")
        return None


def sync_network_folders_to_backend() -> bool:
    """현재 거래처 폴더 목록을 백엔드 캐시에 푸시. admin 인증 필요.
    성공 시 True. 폴더 미설정/네트워크 다운/인증 미설정 시 조용히 False."""
    folders = _list_network_folder_names()
    if folders is None:
        return False
    token = _get_admin_token()
    if not token:
        return False
    url = f"{API_BASE}/api/admin/network-folders/sync"
    body = json.dumps({"folders": folders}).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read()
        ui_log(f"거래처 폴더 동기화 완료: {len(folders)}개")
        # 백엔드가 단일 폴더 이름변경을 자동감지해 거래처 networkFolderName 을 갱신했으면
        # 결과를 노출 — 사용자가 거래처관리 탭을 다시 열기 전에 무슨 일이 일어났는지 보이게.
        try:
            payload = json.loads(raw.decode("utf-8"))
            rename = payload.get("rename") if isinstance(payload, dict) else None
            if isinstance(rename, dict):
                old = rename.get("oldName")
                new = rename.get("newName")
                updated = rename.get("updatedClients", 0)
                skipped = rename.get("skipped")
                if skipped == "newNameAlreadyUsed":
                    ui_log(f"폴더 이름변경 감지: '{old}' → '{new}' (신규명이 이미 다른 거래처에 사용 중 — 자동 매핑 보류, 거래처관리에서 정리 필요)")
                elif updated:
                    ui_log(f"폴더 이름변경 자동반영: '{old}' → '{new}' (거래처 {updated}건 업데이트)")
                else:
                    ui_log(f"폴더 이름변경 감지: '{old}' → '{new}' (해당 거래처 없음)")
        except Exception:
            pass
        return True
    except urllib.error.HTTPError as e:
        # 401 이면 캐시된 토큰 무효 — 다음 호출에서 재로그인 유도.
        if e.code in (401, 403):
            with _admin_token_lock:
                _admin_token_cache["token"] = None
        ui_log(f"거래처 폴더 동기화 실패 ({e.code})")
    except Exception as e:
        ui_log(f"거래처 폴더 동기화 오류: {e}")
    return False


def start_folder_sync_loop():
    """시작 시 1회 + 6시간 간격으로 거래처 폴더 동기화.
    빈도가 낮은 이유: 폴더 신규 생성은 잦지 않고, 사용자가 즉시 반영하고 싶을 때
    GUI [지금 동기화] 버튼으로 트리거할 수 있다."""
    def _run():
        while True:
            try:
                sync_network_folders_to_backend()
            except Exception as e:
                ui_log(f"폴더 동기화 루프 오류: {e}")
            time.sleep(6 * 3600)
    threading.Thread(target=_run, daemon=True).start()


def trigger_folder_sync_async():
    """GUI [지금 동기화] 버튼에서 호출. 백그라운드 스레드에서 1회 동기화."""
    def _run():
        ok = sync_network_folders_to_backend()
        if not ok:
            ui_log("거래처 폴더 동기화 실패 — config.json admin 계정/네트워크 베이스 확인")
    threading.Thread(target=_run, daemon=True).start()


def get_current_tracked_base() -> str:
    """GUI 라벨에 보여줄 현재 추적 베이스 경로. 미설정 시 빈 문자열."""
    return (_load_config().get("network_customer_base") or "").strip()


def change_tracked_folder_async(initial_dir: str | None = None):
    """GUI [추적 폴더 변경] 버튼에서 호출.
    1) 폴더 선택 다이얼로그 → 새 base 결정
    2) 검증: 존재 + 1단계 하위 폴더 카운트 (0이면 사용자 재확인)
    3) config.json 갱신 + 즉시 동기화 트리거
    UI 작업(다이얼로그/메시지박스)은 메인 스레드에서, 동기화는 백그라운드.
    """
    def _ask():
        chosen = filedialog.askdirectory(
            title="거래처 폴더 베이스 선택 (예: 2027년 거래처 폴더)",
            initialdir=initial_dir or get_current_tracked_base() or "",
            mustexist=True,
        )
        if not chosen:
            return  # 사용자 취소
        # filedialog 가 반환하는 경로는 forward slash. 그대로 Path 로 다룸.
        new_base = Path(chosen)
        try:
            children = [c for c in new_base.iterdir() if c.is_dir()]
        except Exception as e:
            messagebox.showerror("추적 폴더 변경 실패",
                                 f"폴더에 접근할 수 없습니다:\n{e}")
            return
        if len(children) == 0:
            if not messagebox.askyesno(
                "확인",
                f"선택한 폴더에 하위 거래처 폴더가 없습니다.\n\n{chosen}\n\n그래도 추적 대상으로 설정할까요?"):
                return

        config = _load_config()
        config["network_customer_base"] = str(new_base)
        if not _save_config(config):
            messagebox.showerror("저장 실패", "config.json 저장에 실패했습니다. 워처 로그를 확인해주세요.")
            return
        ui_log(f"추적 폴더 변경: {new_base.name} (하위 폴더 {len(children)}개)")
        _ui_queue.put(("refresh_tracked",))
        # 새 경로로 즉시 한 번 동기화 → 거래처관리 자동완성/일괄등록에 바로 반영.
        trigger_folder_sync_async()

    _ui_queue.put(("run", _ask))


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


def _get_default_printer() -> str | None:
    try:
        import win32print
        return win32print.GetDefaultPrinter()
    except Exception as e:
        ui_log(f"기본 프린터 조회 실패: {e}")
        return None


def _set_default_printer(name: str) -> bool:
    try:
        import win32print
        win32print.SetDefaultPrinter(name)
        return True
    except Exception as e:
        ui_log(f"기본 프린터 변경 실패 ({name}): {e}")
        return False


def switch_default_to_pdf24() -> None:
    """FlexSign 인쇄 다이얼로그가 PDF24 를 자동 선택하도록 임시 전환.
    이전 기본 프린터를 _saved_default_printer 에 보관하고, 인쇄 PDF 감지 시 복구한다.
    이미 PDF24 로 되어 있거나 PDF24 가 시스템에 없으면 아무 동작 안 함."""
    global _saved_default_printer
    with _printer_lock:
        current = _get_default_printer()
        if not current:
            return
        if current == PDF24_PRINTER_NAME:
            return
        # 이미 한 번 전환해 두고 아직 복구되지 않았다면, 원래 값을 덮어쓰지 않는다.
        if _saved_default_printer is None:
            _saved_default_printer = current
        if _set_default_printer(PDF24_PRINTER_NAME):
            ui_log(f"기본 프린터: {current} → {PDF24_PRINTER_NAME} (인쇄 후 자동 복구)")
        else:
            # 전환 실패 시 저장된 값도 의미 없으므로 비운다.
            _saved_default_printer = None


def restore_default_printer() -> None:
    """_process_printed_pdf 시작 시 호출 — 종이 인쇄 단계에서 원래 프린터로 가도록."""
    global _saved_default_printer
    with _printer_lock:
        if _saved_default_printer is None:
            return
        prev = _saved_default_printer
        _saved_default_printer = None
        if _set_default_printer(prev):
            ui_log(f"기본 프린터 복구: → {prev}")


def _list_installed_printers() -> list[str]:
    try:
        import win32print
        flags = win32print.PRINTER_ENUM_LOCAL | win32print.PRINTER_ENUM_CONNECTIONS
        printers = win32print.EnumPrinters(flags, None, 2)
        return [p["pPrinterName"] for p in printers]
    except Exception as e:
        ui_log(f"프린터 목록 조회 실패: {e}")
        return []


def resolve_paper_printer() -> str | None:
    """현재 PC 에 실제로 설치된 종이 프린터를 결정.
    1) PAPER_PRINTER_CANDIDATES 의 정확 일치를 우선 — 모델별 명시 지정.
    2) 후보가 없으면 PAPER_PRINTER_PATTERN 부분 일치(대소문자 무시) 로 첫 매치를 사용.
       PDF24 자체는 제외해서 "Samsung" 매칭이 가상 프린터로 가지 않게 한다.
    3) 그래도 없으면 None — 인쇄 보류."""
    installed = _list_installed_printers()
    if not installed:
        return None
    for name in PAPER_PRINTER_CANDIDATES:
        if name in installed:
            return name
    if PAPER_PRINTER_PATTERN:
        needle = PAPER_PRINTER_PATTERN.lower()
        for name in installed:
            if name == PDF24_PRINTER_NAME:
                continue
            if needle in name.lower():
                return name
    return None


def print_pdf_to_paper(pdf_path: Path) -> bool:
    """현재 PC 에 설치된 삼성 프린터로 직접 PDF 인쇄. 시스템 기본 프린터를 건드리지 않으므로
    노트북처럼 기본이 PDF24 로 잡혀 있어도 종이는 항상 삼성으로 간다.
    1차: ShellExecute "printto" — 프린터를 명시 지정해 PDF 핸들러에 전달.
    2차(폴백): 기본 프린터를 잠깐 그 프린터로 바꾼 뒤 "print" 동사 호출,
              스풀러가 작업을 큐에 넣을 시간을 두고 원래 프린터로 복구."""
    target = resolve_paper_printer()
    if not target:
        ui_log("종이 프린터를 찾지 못함 — PAPER_PRINTER_CANDIDATES 또는 PAPER_PRINTER_PATTERN 확인 필요")
        return False

    # 1차: printto 동사
    try:
        import win32api
        rc = win32api.ShellExecute(
            0, "printto", str(pdf_path), f'"{target}"', None, 0
        )
        if rc > 32:
            ui_log(f"종이 인쇄({target}) 전달: {pdf_path.name}")
            return True
        ui_log(f"printto 거부(rc={rc}) — 기본 프린터 임시 전환 방식으로 폴백")
    except Exception as e:
        ui_log(f"printto 예외: {e} — 기본 프린터 임시 전환 방식으로 폴백")

    # 2차: 기본 프린터 임시 전환
    with _printer_lock:
        prev = _get_default_printer()
        if not _set_default_printer(target):
            ui_log(f"종이 프린터({target}) 기본 설정 실패 — 인쇄 보류")
            return False
        try:
            ctypes.windll.shell32.ShellExecuteW(0, "print", str(pdf_path), None, None, 0)
            ui_log(f"종이 인쇄({target}) 전달(폴백): {pdf_path.name}")
            # ShellExecute 는 비동기 — 스풀러가 PDF 를 가져갈 시간을 둔다.
            time.sleep(2.0)
            return True
        finally:
            if prev and prev != target:
                _set_default_printer(prev)


# ── 인쇄 다이얼로그 ─────────────────────────────────────────────────────────

# 다이얼로그를 다시 열어도 같은 PDF 의 썸네일을 다시 받지 않도록 PIL.Image 단위로 캐시.
# (ImageTk.PhotoImage 는 메인 Tk 스레드에서만 만들 수 있어 여기엔 PIL 까지만 보관.)
_thumbnail_pil_cache: dict[str, "Image.Image"] = {}


def _start_thumbnail_loader(dlg, work_items: list[tuple[dict, "tk.Label"]],
                            target_width: int) -> None:
    """기존 변경 탭 그리드의 썸네일을 백그라운드에서 채워 넣는다.
    work_items: [(worksheet_dict, placeholder_label), ...]. 각 PDF URL 을 순차적으로 받아
    PyMuPDF 로 첫 페이지 렌더 → main thread 에서 ImageTk.PhotoImage 부착. 여러 카드를 동시에
    내려받지 않고 직렬로 처리해 저성능 PC 에서 UI 가 얼지 않도록.

    fitz 미설치 환경에서는 placeholder 그대로 둔다(텍스트 카드 폴백)."""
    label_by_order: dict[str, "tk.Label"] = {}
    for ws, label in work_items:
        on = ws.get("orderNumber") or ""
        if on:
            label_by_order[on] = label

    def _publish(order_num: str):
        def _apply():
            try:
                if not dlg.winfo_exists():
                    return
            except Exception:
                return
            label = label_by_order.get(order_num)
            if label is None:
                return
            try:
                if not label.winfo_exists():
                    return
            except Exception:
                return
            pil = _thumbnail_pil_cache.get(order_num)
            if pil is None:
                return
            try:
                photo = ImageTk.PhotoImage(pil)
                label.configure(image=photo, text="", bg="white")
                label.image = photo  # GC 방지: 라벨에 명시 참조 attach
            except Exception:
                pass
        try:
            dlg.after(0, _apply)
        except Exception:
            pass

    def _show_err(order_num: str, msg: str):
        """플레이스홀더 라벨에 실패 사유를 직접 적어 진단 단서를 남긴다.
        ui_log 만 남기면 직원이 사유를 못 보고 'PDF 가 안뜬다' 로만 인지하기 쉬움."""
        def _apply():
            label = label_by_order.get(order_num)
            if label is None:
                return
            try:
                if not label.winfo_exists():
                    return
                label.configure(text=msg, fg="#b91c1c")
            except Exception:
                pass
        try:
            dlg.after(0, _apply)
        except Exception:
            pass

    def _worker():
        for ws, _label in work_items:
            try:
                if not dlg.winfo_exists():
                    return
            except Exception:
                return
            order_num = ws.get("orderNumber") or ""
            if not order_num:
                continue
            if order_num in _thumbnail_pil_cache:
                _publish(order_num)
                continue
            raw_pdf_url = ws.get("worksheetPdfUrl") or ""
            if fitz is None:
                _show_err(order_num, "미리보기 라이브러리\n(pymupdf) 없음")
                continue
            if not raw_pdf_url:
                _show_err(order_num, "PDF URL 없음\n(아직 업로드 전)")
                continue
            # R2 public URL 직접 호출은 버킷 정책에 따라 403 이 떨어진다.
            # 백엔드 프록시(/api/public/worksheets/{orderNumber}/pdf) 가 모바일 뷰어와 동일하게
            # 우회해 주므로 그쪽을 사용 — 워처가 R2 권한 변경에 영향받지 않음.
            pdf_url = f"{API_BASE}/api/public/worksheets/{quote(order_num, safe='')}/pdf"
            try:
                with urllib.request.urlopen(_safe_url(pdf_url), timeout=20) as resp:
                    data = resp.read()
                doc = fitz.open(stream=data, filetype="pdf")
                try:
                    page = doc[0]
                    page_w = max(1.0, float(page.rect.width))
                    zoom = target_width / page_w
                    mat = fitz.Matrix(zoom, zoom)
                    pix = page.get_pixmap(matrix=mat, alpha=False)
                    pil = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
                finally:
                    doc.close()
                _thumbnail_pil_cache[order_num] = pil
                _publish(order_num)
            except Exception as e:
                ui_log(f"썸네일 렌더 실패 [{order_num}]: {e}")
                _show_err(order_num, f"렌더 실패\n{str(e)[:40]}")

    threading.Thread(target=_worker, daemon=True).start()


def _ask_print_match_blocking(orders: list[dict], pdf_path: Path,
                              existing_worksheets: list[dict],
                              qr_order_number: str | None = None) -> dict | None:
    """모달 다이얼로그: 방금 인쇄한 PDF 를 어느 작업에 어떻게 반영할지 결정한다.

    탭 두 개로 분기:
      [신규 작성] — 가장 최근에 처리된 주문(orders[0])에 자동 매칭. 거래처/파일명/주문번호
                     를 텍스트로 보여주고 최종납기일/배송만 입력.
      [기존 변경] — 진행중 작업지시서 그리드(3열 PDF 미리보기)에서 한 건을 골라
                     "납기/배송 변경" 또는 "지시서 내용 변경(텍스트 입력)" 선택.

    qr_order_number 가 주어지면(=인쇄 PDF 의 QR 인식 성공):
      - 그 주문이 existing_worksheets 에 이미 있으면(=기존 PDF 부착) → [기존 변경] 자동 진입
        + 해당 지시서 자동 선택 + "지시서 내용 변경" 라디오 자동 선택. 매칭된 PDF 를
        크게 띄워 사용자가 보면서 변경 메모를 작성한다.
      - existing 에 없고 orders 큐에 있으면(=신규 출력) → [신규 작성] 탭에 그 주문을 우선 노출.
      - 둘 다 매칭 실패 시 평소 다이얼로그 그대로(수동 선택).

    리턴값:
      None — 사용자 취소(Esc/X). 호출자는 종이 인쇄도 생략.
      {"order_number": None} — "이 인쇄본은 웹에 안 올림". 종이 인쇄만 진행.
      {
        "mode": "new" | "modify",
        "change_type": "delivery" | "content",
        "order_number": str,
        "day": int | None,                 # delivery 분기에서만 채움
        "current_due_iso": str,
        "delivery_method": str,            # delivery 분기에서만 채움
        "original_delivery_method": str,
        "content_changed": bool,           # content 분기 = True
        "change_note": str,                # content 분기에서 사용자가 입력한 변경 메모
        "department_tags": list[str],      # 분배함 클릭으로 결정
      }
    """
    BG = "#ffffff"
    BG_SOFT = "#fafafa"
    BORDER = "#e4e4e7"
    TITLE_FG = "#18181b"
    LABEL_FG = "#3f3f46"
    SUB_FG = "#71717a"
    ACCENT = "#16a34a"
    ACCENT_HOVER = "#15803d"

    # QR 매칭 결과 사전 분석. 기존 지시서에 있는 주문 → 변경 모드. 큐의 신규 → 신규 모드 + 우선노출.
    qr_matched_ws: dict | None = None
    qr_matched_recent: dict | None = None
    if qr_order_number:
        for w in existing_worksheets or []:
            if (w.get("orderNumber") or "") == qr_order_number:
                qr_matched_ws = w
                break
        if qr_matched_ws is None:
            for o in orders or []:
                if (o.get("orderNumber") or "") == qr_order_number:
                    qr_matched_recent = o
                    break

    # 신규 탭의 most_recent 는 보통 최근 큐 헤드. QR 이 큐 안의 다른 주문을 가리키면 그 주문으로 교체
    # (직원이 큐에 여러 주문 던져두고 늦게 인쇄한 경우 정확 매칭).
    if qr_matched_recent is not None:
        most_recent = qr_matched_recent
    else:
        most_recent = orders[0] if orders else None

    THUMB_W = 220
    THUMB_H = int(THUMB_W * 1.414)  # A4 portrait 비율

    result: dict = {"value": None}

    dlg = tk.Toplevel()
    dlg.title("웹에 변경사항 적용하기")
    dlg.configure(bg=BG)
    dlg.resizable(False, False)
    dlg.attributes("-topmost", True)
    # 좌측: 탭 영역(신규/기존) / 우측: 분배함 사진. 기존 720h → 880h 로 확장하여 그리드가
    # 한 화면에 6장 정도 들어오도록.
    dlg.geometry("1320x880")

    # ── 줌 토플레벨 공통 헬퍼 ───────────────────────────────────────
    # 인쇄 PDF / 매칭된 기존 지시서 둘 다 같은 패닝·스크롤·z-order 처리를 공유.
    # 메인 다이얼로그가 -topmost 라 줌이 클릭 한 번에 가려지는 문제 해결: 줌 열려있는 동안
    # 메인의 -topmost 를 끄고, 줌 닫으면 다시 켠다(분배함 클릭해도 줌 사진이 위에 그대로).
    def _show_zoom_image(title: str, pil_img):
        try:
            zoom_dlg = tk.Toplevel(dlg)
            zoom_dlg.title(title)
            zoom_dlg.configure(bg=BG)
            zoom_dlg.attributes("-topmost", True)
            try:
                dlg.attributes("-topmost", False)
            except Exception:
                pass

            # 창 크기 = PDF 렌더 이미지 크기 + 스크롤바 한 줄. 화면을 꽉 채우는
            # 85%×90% 고정 창은 PDF A4 비율 대비 좌우 여백이 너무 넓어서 분배함 옆에
            # 살짝 띄워놓고 보기가 어려움 → PDF 에 딱 맞춰 작게 띄우고, 사용자가 직접
            # 크기/위치를 조정해서 옆 자리에 놓을 수 있게 한다.
            sw = zoom_dlg.winfo_screenwidth()
            sh = zoom_dlg.winfo_screenheight()
            # 스크롤바(약 18px) + 윈도우 보더(약 16px). 안 맞아도 스크롤로 보이므로 여유는 작게.
            CHROME_W = 22
            CHROME_H = 22
            ww = min(int(sw * 0.95), pil_img.width + CHROME_W)
            wh = min(int(sh * 0.92), pil_img.height + CHROME_H)
            zoom_dlg.geometry(f"{ww}x{wh}+{(sw-ww)//2}+{(sh-wh)//2}")

            canvas_frame = tk.Frame(zoom_dlg, bg=BG)
            canvas_frame.pack(fill="both", expand=True)
            vbar = ttk.Scrollbar(canvas_frame, orient="vertical")
            hbar = ttk.Scrollbar(canvas_frame, orient="horizontal")
            cv = tk.Canvas(canvas_frame, bg="#3f3f46", highlightthickness=0,
                           yscrollcommand=vbar.set, xscrollcommand=hbar.set)
            vbar.config(command=cv.yview)
            hbar.config(command=cv.xview)
            vbar.pack(side="right", fill="y")
            hbar.pack(side="bottom", fill="x")
            cv.pack(side="left", fill="both", expand=True)

            photo = ImageTk.PhotoImage(pil_img)
            cv.create_image(0, 0, image=photo, anchor="nw")
            cv.configure(scrollregion=(0, 0, pil_img.width, pil_img.height))
            cv.image = photo  # GC 방지

            def _on_wheel(e):
                if e.state & 0x0001:
                    cv.xview_scroll(int(-e.delta / 120), "units")
                else:
                    cv.yview_scroll(int(-e.delta / 120), "units")
            cv.bind_all("<MouseWheel>", _on_wheel)

            def _on_press(e):
                cv.configure(cursor="fleur")
                cv.scan_mark(e.x, e.y)
            def _on_drag(e):
                cv.scan_dragto(e.x, e.y, gain=1)
            def _on_release(_e):
                cv.configure(cursor="")
            cv.configure(cursor="hand2")
            cv.bind("<ButtonPress-1>", _on_press)
            cv.bind("<B1-Motion>", _on_drag)
            cv.bind("<ButtonRelease-1>", _on_release)

            def _cleanup():
                try:
                    cv.unbind_all("<MouseWheel>")
                except Exception:
                    pass
                try:
                    dlg.attributes("-topmost", True)
                except Exception:
                    pass
                try:
                    zoom_dlg.destroy()
                except Exception:
                    pass
            zoom_dlg.protocol("WM_DELETE_WINDOW", _cleanup)
            zoom_dlg.bind("<Escape>", lambda _e: _cleanup())
            return zoom_dlg
        except Exception as e:
            ui_log(f"줌 윈도우 생성 실패: {e}")
            return None

    def _open_zoom_for_matched_ws(ws):
        """매칭된 기존 지시서의 PDF 를 별도 토플레벨에서 크게 표시.
        다운로드 + 렌더는 백그라운드에서 처리하여 다이얼로그 진입이 멈추지 않도록 한다."""
        if fitz is None or not ws:
            return
        order_num = (ws.get("orderNumber") or "").strip()
        if not order_num:
            return
        company = (ws.get("companyName") or "거래처 미상").strip()
        title = f"매칭된 지시서 — {company} / {order_num}"
        pdf_url = f"{API_BASE}/api/public/worksheets/{quote(order_num, safe='')}/pdf"

        def _worker():
            try:
                with urllib.request.urlopen(_safe_url(pdf_url), timeout=20) as resp:
                    data = resp.read()
                doc = fitz.open(stream=data, filetype="pdf")
                try:
                    page = doc[0]
                    page_w = max(1.0, float(page.rect.width))
                    sw = dlg.winfo_screenwidth()
                    target_w = max(800, int(sw * 0.55))
                    zoom = min(3.0, max(1.0, target_w / page_w))
                    mat = fitz.Matrix(zoom, zoom)
                    pix = page.get_pixmap(matrix=mat, alpha=False)
                    pil = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
                finally:
                    doc.close()
            except Exception as e:
                ui_log(f"매칭 지시서 PDF 다운로드 실패: {e}")
                return
            try:
                dlg.after(0, lambda: _show_zoom_image(title, pil))
            except Exception:
                pass

        threading.Thread(target=_worker, daemon=True).start()

    body = tk.Frame(dlg, bg=BG)
    body.pack(fill="both", expand=True)
    left = tk.Frame(body, bg=BG)
    left.pack(side="left", fill="both", expand=True)
    right = tk.Frame(body, bg=BG_SOFT, highlightbackground=BORDER, highlightthickness=1)
    right.pack(side="right", fill="y", padx=(0, 12), pady=12)

    # ── 헤더 ────────────────────────────────────────────────
    # 좌측: 타이틀/부제. 우측: QR 결과 배너(빈 공간 활용).
    header = tk.Frame(left, bg=BG)
    header.pack(fill="x", padx=22, pady=(18, 0))

    title_box = tk.Frame(header, bg=BG)
    title_box.pack(side="left", fill="x", expand=True)
    tk.Label(
        title_box, text="웹에 변경사항 적용하기",
        bg=BG, fg=TITLE_FG,
        font=("맑은 고딕", 15, "bold"), anchor="w",
    ).pack(fill="x")
    tk.Label(
        title_box,
        text="방금 인쇄한 PDF 를 거래처 작업현황 / 어드민 페이지에 반영합니다.",
        bg=BG, fg=SUB_FG,
        font=("맑은 고딕", 9), anchor="w",
    ).pack(fill="x", pady=(3, 0))

    # ── QR 인식 결과 배너 (헤더 우측) ───────────────────────
    # _apply_qr_routing 가 텍스트/색상을 채운다.
    qr_banner_holder = tk.Frame(header, bg=BG)
    qr_banner_var = tk.StringVar(value="")
    qr_banner_label = tk.Label(
        qr_banner_holder, textvariable=qr_banner_var,
        bg="#ecfdf5", fg="#065f46",
        font=("맑은 고딕", 11, "bold"),
        anchor="center", justify="left",
        padx=18, pady=12,
    )

    def _show_qr_banner(text: str, kind: str = "success"):
        """kind: 'success' | 'warn'. 'warn' 은 매칭 실패 — 옅은 노랑 배경."""
        if not text:
            qr_banner_holder.pack_forget()
            return
        if kind == "warn":
            qr_banner_label.configure(bg="#fef3c7", fg="#92400e",
                                     highlightbackground="#fcd34d")
        else:
            qr_banner_label.configure(bg="#d1fae5", fg="#065f46",
                                     highlightbackground="#6ee7b7")
        qr_banner_label.configure(highlightthickness=1)
        qr_banner_var.set(text)
        qr_banner_holder.pack(side="right", padx=(20, 0))
        qr_banner_label.pack()

    tk.Frame(left, bg=BORDER, height=1).pack(fill="x", padx=22, pady=(14, 0))

    def _day_from_iso(iso: str) -> str:
        if not iso:
            return ""
        try:
            return str(date.fromisoformat(iso).day)
        except ValueError:
            return ""

    # ── 탭 컨테이너 ─────────────────────────────────────────
    style = ttk.Style()
    try:
        style.configure("HD.TNotebook", background=BG, borderwidth=0)
        style.configure("HD.TNotebook.Tab",
                        padding=(18, 8), font=("맑은 고딕", 10, "bold"))
    except Exception:
        pass

    notebook = ttk.Notebook(left, style="HD.TNotebook")
    notebook.pack(fill="both", expand=True, padx=22, pady=(14, 0))

    new_tab = tk.Frame(notebook, bg=BG)
    modify_tab = tk.Frame(notebook, bg=BG)
    notebook.add(new_tab, text="신규 지시서 작성")
    notebook.add(modify_tab, text="기존 지시서 변경")

    def _force_dialog_redraw():
        """QR 자동 라우팅 직후 Windows 가 Tk 자식 위젯 paint 를 늦추는 경우가 있어
        클릭 없이도 현재 화면을 즉시 다시 그리도록 요청한다."""
        try:
            dlg.update_idletasks()
        except Exception:
            pass
        try:
            user32 = ctypes.windll.user32
            hwnd = int(dlg.winfo_id())
            hwnd = user32.GetParent(hwnd) or hwnd
            # RDW_INVALIDATE | RDW_ERASE | RDW_ALLCHILDREN | RDW_UPDATENOW
            user32.RedrawWindow(hwnd, None, None, 0x0001 | 0x0004 | 0x0080 | 0x0100)
            user32.UpdateWindow(hwnd)
        except Exception:
            pass
        try:
            dlg.update_idletasks()
        except Exception:
            pass

    def _schedule_dialog_redraw():
        for delay in (0, 40, 120, 300):
            try:
                dlg.after(delay, _force_dialog_redraw)
            except Exception:
                pass

    # ── [신규 작성] 탭 ─────────────────────────────────────
    new_day_var = tk.StringVar()
    new_delivery_var = tk.StringVar()
    new_day_entry: tk.Entry | None = None

    if most_recent is not None:
        # ── 좌·우 분할: 좌측 = 정보+필드, 우측 = PDF 미리보기 ──
        # 미리보기를 세로로 쌓으면 ②최종납기일 카드가 880px 다이얼로그 밖으로 밀려 잘림.
        # 가로 분할로 미리보기를 보면서 납기일/배송을 같은 화면에서 입력 가능.
        new_split = tk.Frame(new_tab, bg=BG)
        new_split.pack(fill="both", expand=True, pady=(14, 0))
        new_left_col = tk.Frame(new_split, bg=BG)
        new_left_col.pack(side="left", fill="both", expand=True)
        new_right_col = tk.Frame(new_split, bg=BG)
        new_right_col.pack(side="right", fill="y", padx=(14, 0))

        info_card = tk.Frame(new_left_col, bg=BG_SOFT,
                             highlightbackground=BORDER, highlightthickness=1)
        info_card.pack(fill="x")
        company = (most_recent.get("companyName") or "거래처 미상").strip()
        # 파일제목: 자동지시서 흐름이라면 ZIP 안의 원본 .ai 파일명을, 헤더-only/매칭 실패 시
        # 폴백으로 인쇄된 PDF 파일명(보통 'print_yyyymmdd_...flexiSign-...') 을 쓴다.
        # 확장자(.ai/.AI/.pdf)는 표시 단계에서 제거 — 사용자 식별에 불필요한 군더더기.
        original_name = (most_recent.get("originalFileName") or "").strip()
        if original_name:
            file_title = re.sub(r"\.ai$", "", original_name, flags=re.IGNORECASE)
        else:
            file_title = re.sub(r"\.pdf$", "", pdf_path.name, flags=re.IGNORECASE)
        info_text = f"{company}  /  {file_title}  /  {most_recent.get('orderNumber') or ''}"
        tk.Label(info_card, text="현재 지시서",
                 bg=BG_SOFT, fg=SUB_FG,
                 font=("맑은 고딕", 9), anchor="w").pack(fill="x", padx=14, pady=(10, 2))
        tk.Label(info_card, text=info_text,
                 bg=BG_SOFT, fg=TITLE_FG,
                 font=("맑은 고딕", 13, "bold"), anchor="w",
                 wraplength=420, justify="left"
                 ).pack(fill="x", padx=14, pady=(0, 12))

        # ── 인쇄된 PDF 미리보기(우측) ──────────────────────────
        # 클릭하거나 [확대] 누르면 별도 Toplevel 에서 더 크게(스크롤 가능) 본다.
        # 이전(420×594) 보다 살짝 작게 — 다이얼로그 880px 안에서 하단 [확인]/[취소]
        # 버튼이 잘리지 않도록 세로 약 50px 절약.
        PREVIEW_W = 380
        PREVIEW_H = int(PREVIEW_W * 1.414)
        preview_card = tk.Frame(new_right_col, bg=BG_SOFT,
                                highlightbackground=BORDER, highlightthickness=1)
        preview_card.pack()
        preview_inner = tk.Frame(preview_card, width=PREVIEW_W, height=PREVIEW_H,
                                 bg="#e4e4e7", cursor="hand2")
        preview_inner.pack_propagate(False)
        preview_inner.pack(padx=8, pady=(8, 4))
        preview_label = tk.Label(
            preview_inner, bg="#e4e4e7", fg=SUB_FG,
            font=("맑은 고딕", 11), text="미리보기 준비 중…",
            cursor="hand2",
        )
        preview_label.pack(fill="both", expand=True)

        # 우측에 [확대] 버튼 — 별도 창에서 큰 사이즈로 본다.
        preview_btn_row = tk.Frame(preview_card, bg=BG_SOFT)
        preview_btn_row.pack(fill="x", padx=8, pady=(0, 8))
        zoom_btn = tk.Button(
            preview_btn_row, text="🔍  크게 보기",
            font=("맑은 고딕", 10, "bold"),
            bg="#18181b", fg="white",
            activebackground="#27272a", activeforeground="white",
            relief="flat", padx=14, pady=6, bd=0, cursor="hand2",
        )
        zoom_btn.pack(side="right")

        def _open_zoom_window(_event=None):
            """인쇄된 PDF 첫 페이지를 별도 토플레벨에서 큰 해상도로 표시.
            공통 줌 헬퍼(_show_zoom_image)가 패닝/스크롤/z-order 를 모두 처리한다."""
            if fitz is None or not pdf_path.exists():
                return
            try:
                sw = dlg.winfo_screenwidth()
                target_w = max(900, int(sw * 0.85) - 80)
                doc = fitz.open(str(pdf_path))
                try:
                    page = doc[0]
                    page_w = max(1.0, float(page.rect.width))
                    zoom = min(3.0, target_w / page_w)
                    mat = fitz.Matrix(zoom, zoom)
                    pix = page.get_pixmap(matrix=mat, alpha=False)
                    pil = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
                finally:
                    doc.close()
                _show_zoom_image(f"미리보기 — {pdf_path.name}", pil)
            except Exception as e:
                ui_log(f"미리보기 확대 실패: {e}")

        zoom_btn.configure(command=_open_zoom_window)
        # 미리보기 영역 직접 클릭으로도 확대.
        preview_label.bind("<Button-1>", _open_zoom_window)
        preview_inner.bind("<Button-1>", _open_zoom_window)

        def _render_new_preview():
            if fitz is None:
                preview_label.configure(text="미리보기 라이브러리(pymupdf) 없음")
                zoom_btn.configure(state="disabled")
                return
            if not pdf_path.exists():
                preview_label.configure(text="PDF 파일을 찾을 수 없습니다")
                zoom_btn.configure(state="disabled")
                return
            try:
                doc = fitz.open(str(pdf_path))
                try:
                    page = doc[0]
                    page_w = max(1.0, float(page.rect.width))
                    zoom = PREVIEW_W / page_w
                    mat = fitz.Matrix(zoom, zoom)
                    pix = page.get_pixmap(matrix=mat, alpha=False)
                    pil = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
                finally:
                    doc.close()
                photo = ImageTk.PhotoImage(pil)
                preview_label.configure(image=photo, text="", bg="white")
                preview_label.image = photo  # GC 방지
            except Exception as e:
                preview_label.configure(text=f"미리보기 실패: {e}")
                zoom_btn.configure(state="disabled")
        # UI 스레드에서 즉시 시도 — 단일 PDF 라 렌더가 빠르고, 결과를 보면서 입력해야 하므로 동기.
        dlg.after(50, _render_new_preview)

        sec2 = tk.Frame(new_left_col, bg=BG)
        sec2.pack(fill="x", pady=(18, 0))
        tk.Label(sec2, text="② 최종납기일",
                 bg=BG, fg=TITLE_FG,
                 font=("맑은 고딕", 10, "bold"), anchor="w").pack(fill="x")

        fields_card = tk.Frame(sec2, bg=BG_SOFT,
                               highlightbackground=BORDER, highlightthickness=1)
        fields_card.pack(fill="x", pady=(8, 0))
        fields = tk.Frame(fields_card, bg=BG_SOFT)
        fields.pack(padx=14, pady=12, anchor="w")

        tk.Label(fields, text="납기", bg=BG_SOFT, fg=LABEL_FG,
                 font=("맑은 고딕", 10, "bold")).pack(side="left")
        new_day_var.set(_day_from_iso(most_recent.get("dueDate") or ""))
        new_day_entry = tk.Entry(
            fields, textvariable=new_day_var, width=4, justify="center",
            font=("맑은 고딕", 16, "bold"),
            relief="solid", bd=1, bg="white", highlightthickness=0,
        )
        new_day_entry.pack(side="left", padx=(8, 3))
        tk.Label(fields, text="일", bg=BG_SOFT, fg=LABEL_FG,
                 font=("맑은 고딕", 10)).pack(side="left", padx=(0, 22))

        tk.Label(fields, text="배송", bg=BG_SOFT, fg=LABEL_FG,
                 font=("맑은 고딕", 10, "bold")).pack(side="left")
        delivery_labels_in_order = list(DELIVERY_ENUM_TO_KO.values())
        new_delivery_var.set(
            DELIVERY_ENUM_TO_KO.get(most_recent.get("deliveryMethod") or "", "")
        )
        ttk.Combobox(
            fields, textvariable=new_delivery_var, state="readonly",
            values=delivery_labels_in_order, width=14,
            font=("맑은 고딕", 10),
        ).pack(side="left", padx=(8, 0))
    else:
        tk.Label(new_tab,
                 text="최근 처리한 주문이 없어 신규 작성 모드를 사용할 수 없습니다.\n"
                      "[기존 변경] 탭에서 갱신할 지시서를 골라주세요.",
                 bg=BG, fg=SUB_FG, font=("맑은 고딕", 10),
                 anchor="w", justify="left").pack(fill="x", padx=2, pady=24)

    # ── [기존 변경] 탭 ─────────────────────────────────────
    # 두 페이지: pick_page(그리드) → chosen_page(라디오+폼). pack/unpack 으로 토글.
    modify_state: dict = {"selected_ws": None, "change_type": None}
    chosen_widgets: dict = {}

    pick_page = tk.Frame(modify_tab, bg=BG)
    chosen_page = tk.Frame(modify_tab, bg=BG)

    def show_pick():
        chosen_page.pack_forget()
        pick_page.pack(fill="both", expand=True)

    def show_chosen():
        pick_page.pack_forget()
        chosen_page.pack(fill="both", expand=True)

    if not existing_worksheets:
        tk.Label(pick_page,
                 text="기존 작업지시서가 없습니다.\n신규 작성 탭을 사용하세요.",
                 bg=BG, fg=SUB_FG, font=("맑은 고딕", 10),
                 anchor="w", justify="left").pack(fill="x", padx=2, pady=24)
    else:
        tk.Label(pick_page, text="어느 지시서를 변경하시나요?",
                 bg=BG, fg=TITLE_FG,
                 font=("맑은 고딕", 11, "bold"), anchor="w"
                 ).pack(fill="x", pady=(14, 6))
        if fitz is None:
            tk.Label(pick_page,
                     text="(미리보기 라이브러리(pymupdf) 미설치 — 카드만 표시됩니다)",
                     bg=BG, fg=SUB_FG, font=("맑은 고딕", 9), anchor="w"
                     ).pack(fill="x", pady=(0, 4))

        # 스크롤 가능한 그리드 — Canvas + 내부 Frame 패턴.
        grid_outer = tk.Frame(pick_page, bg=BG)
        grid_outer.pack(fill="both", expand=True, pady=(0, 4))
        grid_canvas = tk.Canvas(grid_outer, bg=BG, highlightthickness=0)
        gscroll = ttk.Scrollbar(grid_outer, orient="vertical",
                                command=grid_canvas.yview)
        grid_canvas.configure(yscrollcommand=gscroll.set)
        grid_inner = tk.Frame(grid_canvas, bg=BG)
        inner_id = grid_canvas.create_window((0, 0), window=grid_inner, anchor="nw")
        grid_canvas.pack(side="left", fill="both", expand=True)
        gscroll.pack(side="right", fill="y")

        def _on_inner_configure(_e=None):
            grid_canvas.configure(scrollregion=grid_canvas.bbox("all"))
        def _on_canvas_configure(e):
            grid_canvas.itemconfig(inner_id, width=e.width)
        grid_inner.bind("<Configure>", _on_inner_configure)
        grid_canvas.bind("<Configure>", _on_canvas_configure)

        # 다이얼로그 위에 마우스가 있을 때만 휠 스크롤 — 다른 요소(콤보박스 등) 와의 충돌 회피.
        def _on_wheel(e):
            grid_canvas.yview_scroll(int(-e.delta / 120), "units")
        grid_canvas.bind("<Enter>",
                         lambda _e: grid_canvas.bind_all("<MouseWheel>", _on_wheel))
        grid_canvas.bind("<Leave>",
                         lambda _e: grid_canvas.unbind_all("<MouseWheel>"))

        cols = 3
        for col in range(cols):
            grid_inner.grid_columnconfigure(col, weight=1, uniform="card")

        thumbnail_work: list[tuple[dict, "tk.Label"]] = []

        def _on_pick(ws):
            modify_state["selected_ws"] = ws
            modify_state["change_type"] = None
            _refresh_chosen()
            show_chosen()

        for idx, ws in enumerate(existing_worksheets):
            r = idx // cols
            c = idx % cols
            card = tk.Frame(grid_inner, bg=BG_SOFT,
                            highlightbackground=BORDER, highlightthickness=1,
                            cursor="hand2")
            card.grid(row=r, column=c, padx=6, pady=6, sticky="nsew")

            thumb_frame = tk.Frame(card, width=THUMB_W, height=THUMB_H, bg="#e4e4e7")
            thumb_frame.pack_propagate(False)
            thumb_frame.pack(padx=8, pady=8)
            thumb_label = tk.Label(thumb_frame, bg="#e4e4e7",
                                   text="…" if fitz is not None else "(미리보기 없음)",
                                   fg=SUB_FG, font=("맑은 고딕", 11))
            thumb_label.pack(fill="both", expand=True)

            company = (ws.get("companyName") or "거래처 미상").strip()
            title = (ws.get("title") or "").strip()
            order_num = ws.get("orderNumber") or ""

            company_lbl = tk.Label(card, text=company, bg=BG_SOFT, fg=TITLE_FG,
                                   font=("맑은 고딕", 10, "bold"), anchor="w")
            company_lbl.pack(fill="x", padx=10)
            title_lbl = None
            if title:
                title_lbl = tk.Label(card, text=title, bg=BG_SOFT, fg=LABEL_FG,
                                     font=("맑은 고딕", 9), anchor="w",
                                     wraplength=THUMB_W)
                title_lbl.pack(fill="x", padx=10)
            order_lbl = tk.Label(card, text=order_num, bg=BG_SOFT, fg=SUB_FG,
                                 font=("맑은 고딕", 9), anchor="w")
            order_lbl.pack(fill="x", padx=10, pady=(0, 8))

            def _make_handler(ws_local):
                return lambda _e=None: _on_pick(ws_local)
            handler = _make_handler(ws)
            for w in (card, thumb_frame, thumb_label,
                      company_lbl, order_lbl):
                w.bind("<Button-1>", handler)
            if title_lbl is not None:
                title_lbl.bind("<Button-1>", handler)

            thumbnail_work.append((ws, thumb_label))

        _start_thumbnail_loader(dlg, thumbnail_work, THUMB_W)

    # chosen_page 빌더 — selected_ws 가 정해진 다음 호출. 기존 위젯을 모두 비우고 다시 그린다.
    def _refresh_chosen():
        for w in chosen_page.winfo_children():
            w.destroy()
        chosen_widgets.clear()
        ws = modify_state["selected_ws"]
        if ws is None:
            return

        company = (ws.get("companyName") or "거래처 미상").strip()
        title = (ws.get("title") or "").strip()
        order_num = ws.get("orderNumber") or ""

        # ── 상단 바: [← 다른 지시서] + 선택한 지시서 정보 ─────
        # 기존: 정보 카드 + 뒤로가기 버튼이 두 줄로 쌓여 세로 공간 낭비.
        # 변경: 한 줄에 좌측 뒤로가기, 우측 거래처/제목/주문번호 인라인 배치.
        topbar = tk.Frame(chosen_page, bg=BG)
        topbar.pack(fill="x", pady=(10, 0))

        tk.Button(topbar, text="◀  다른 지시서 선택",
                  command=lambda: show_pick(),
                  font=("맑은 고딕", 9, "bold"),
                  bg="#f4f4f5", fg=LABEL_FG,
                  activebackground=BORDER, activeforeground=TITLE_FG,
                  relief="flat", padx=14, pady=8, cursor="hand2", bd=0,
                  ).pack(side="left")

        info_box = tk.Frame(topbar, bg=BG)
        info_box.pack(side="left", padx=(16, 0), fill="x", expand=True)
        tk.Label(info_box, text=company,
                 bg=BG, fg=TITLE_FG,
                 font=("맑은 고딕", 13, "bold"),
                 anchor="w", wraplength=560, justify="left",
                 ).pack(fill="x")
        sub_parts = []
        if title:
            sub_parts.append(title)
        if order_num:
            sub_parts.append(order_num)
        if sub_parts:
            tk.Label(info_box, text="  ·  ".join(sub_parts),
                     bg=BG, fg=SUB_FG,
                     font=("맑은 고딕", 9),
                     anchor="w", wraplength=560, justify="left",
                     ).pack(fill="x", pady=(2, 0))

        # ── 통합 변경 폼 (납기/배송 + 내용 메모) ──────────────
        # 기존: 둘 중 하나만 라디오로 선택 → 둘 다 바뀌면 손볼 수 없음.
        # 변경: 한 카드에 납기·배송 줄 + 내용 메모 줄을 같이 표시. confirm 시
        #       각 필드가 원본과 다르면 그것만 반영(메모는 입력된 경우에만 contentChanged).
        # change_type 은 모드 전환 잔재 — 호출자가 이 다이얼로그 내부에서 분기에 안 쓰도록
        #       confirm 에서 무조건 채워 보낸다(resolve_new_due_date 는 입력=원본이면 멱등).
        modify_state["change_type"] = "combined"

        form_holder = tk.Frame(chosen_page, bg=BG)
        form_holder.pack(fill="x", pady=(8, 0))
        form_card = tk.Frame(form_holder, bg=BG_SOFT,
                             highlightbackground=BORDER, highlightthickness=1)
        form_card.pack(fill="x")
        chosen_widgets["form_card"] = form_card

        inner = tk.Frame(form_card, bg=BG_SOFT)
        inner.pack(fill="x", padx=14, pady=10)

        # 1행: 납기/배송 — 변경이 없으면 기본값 그대로 두면 됨(서버 PATCH 가 멱등).
        fields = tk.Frame(inner, bg=BG_SOFT)
        fields.pack(fill="x", anchor="w")
        tk.Label(fields, text="납기", bg=BG_SOFT, fg=LABEL_FG,
                 font=("맑은 고딕", 10, "bold")).pack(side="left")
        day_var_local = tk.StringVar(
            value=_day_from_iso(ws.get("dueDate") or ""))
        day_e = tk.Entry(
            fields, textvariable=day_var_local, width=4, justify="center",
            font=("맑은 고딕", 14, "bold"),
            relief="solid", bd=1, bg="white", highlightthickness=0,
        )
        day_e.pack(side="left", padx=(10, 3))
        tk.Label(fields, text="일", bg=BG_SOFT, fg=LABEL_FG,
                 font=("맑은 고딕", 10)).pack(side="left", padx=(0, 24))
        tk.Label(fields, text="배송", bg=BG_SOFT, fg=LABEL_FG,
                 font=("맑은 고딕", 10, "bold")).pack(side="left")
        delivery_var_local = tk.StringVar(
            value=DELIVERY_ENUM_TO_KO.get(ws.get("deliveryMethod") or "", "")
        )
        ttk.Combobox(
            fields, textvariable=delivery_var_local, state="readonly",
            values=list(DELIVERY_ENUM_TO_KO.values()), width=14,
            font=("맑은 고딕", 10),
        ).pack(side="left", padx=(10, 0))
        chosen_widgets["mod_day_var"] = day_var_local
        chosen_widgets["mod_delivery_var"] = delivery_var_local
        chosen_widgets["mod_day_entry"] = day_e
        day_e.bind("<Return>", confirm)

        # 2행: 변경된 내용 메모 — 비워두면 contentChanged 안 보냄.
        tk.Label(inner,
                 text="변경된 내용  (선택 — 입력 시 모바일 뷰어에서 PDF 탭하면 노출)",
                 bg=BG_SOFT, fg=SUB_FG,
                 font=("맑은 고딕", 9),
                 anchor="w").pack(fill="x", pady=(10, 3))
        note_text = tk.Text(inner, height=2, wrap="word",
                            relief="solid", bd=1,
                            font=("맑은 고딕", 10), bg="white",
                            highlightthickness=0)
        note_text.pack(fill="x")
        chosen_widgets["mod_note_text"] = note_text

        # 진입 시 포커스는 납기 입력 — 가장 자주 만지는 필드.
        day_e.focus_set()
        day_e.select_range(0, "end")
        day_e.icursor("end")

        # ── 매칭된 지시서 PDF 미리보기 (가운데 정렬, 폼 아래) ────
        # 폭 240 — 다이얼로그 880px 안에 헤더/통합폼/하단 버튼이 모두 잘림 없이 들어가는 한계 폭.
        # 더 키우면 하단 [웹에 적용/취소/종이만] 버튼이 밀려 안 보임.
        preview_pane = tk.Frame(chosen_page, bg=BG)
        preview_pane.pack(fill="both", expand=True, pady=(8, 0))

        PREVIEW_W_C = 240
        PREVIEW_H_C = int(PREVIEW_W_C * 1.414)
        preview_card = tk.Frame(preview_pane, bg=BG_SOFT,
                                highlightbackground=BORDER, highlightthickness=1)
        # anchor="n" 으로 위쪽 가운데 정렬 — 빈공간 안 생기게.
        preview_card.pack(anchor="n")
        preview_inner_c = tk.Canvas(preview_card,
                                    width=PREVIEW_W_C, height=PREVIEW_H_C,
                                    bg="#e4e4e7", highlightthickness=0,
                                    cursor="hand2")
        preview_inner_c.pack(padx=8, pady=(8, 4))
        preview_inner_c.create_text(
            PREVIEW_W_C // 2, PREVIEW_H_C // 2,
            text="미리보기 로딩 중…",
            fill=SUB_FG,
            font=("맑은 고딕", 11),
            anchor="center",
            tags=("preview_content",),
        )

        def _open_chosen_zoom(_e=None):
            _open_zoom_for_matched_ws(ws)
        preview_inner_c.bind("<Button-1>", _open_chosen_zoom)

        # 미리보기가 deferred paint 로 인해 첫 표시가 늦는 케이스를 대비해 안내 문구.
        # 사용자가 회색 화면에서 무한정 기다리지 않게 — "창 한 번 클릭하면 보입니다".
        tk.Label(
            preview_card,
            text="(미리보기가 안 보일 경우, 창을 한 번 클릭하면 보입니다)",
            bg=BG_SOFT, fg=SUB_FG,
            font=("맑은 고딕", 8),
            anchor="center",
            wraplength=PREVIEW_W_C,
            justify="center",
        ).pack(fill="x", padx=8, pady=(0, 4))

        zoom_row_c = tk.Frame(preview_card, bg=BG_SOFT)
        zoom_row_c.pack(fill="x", padx=8, pady=(0, 8))
        tk.Button(zoom_row_c, text="🔍  크게 보기",
                  command=_open_chosen_zoom,
                  font=("맑은 고딕", 9, "bold"),
                  bg="#18181b", fg="white",
                  activebackground="#27272a", activeforeground="white",
                  relief="flat", padx=12, pady=5, bd=0, cursor="hand2",
                  ).pack(side="right")

        preview_result_q: queue.Queue = queue.Queue(maxsize=1)

        def _force_chosen_preview_paint():
            def _tick():
                try:
                    if preview_inner_c.winfo_exists():
                        preview_inner_c.update_idletasks()
                        preview_inner_c.update()
                    if dlg.winfo_exists():
                        dlg.lift()
                        dlg.update_idletasks()
                except Exception:
                    pass
                _force_dialog_redraw()
            for delay in (0, 30, 120):
                try:
                    dlg.after(delay, _tick)
                except Exception:
                    pass

        def _set_chosen_preview_message(msg: str):
            try:
                if preview_inner_c.winfo_exists():
                    preview_inner_c.delete("preview_content")
                    preview_inner_c.create_text(
                        PREVIEW_W_C // 2, PREVIEW_H_C // 2,
                        text=msg,
                        fill=SUB_FG,
                        font=("맑은 고딕", 11),
                        anchor="center",
                        width=PREVIEW_W_C - 24,
                        tags=("preview_content",),
                    )
                _force_chosen_preview_paint()
            except Exception:
                pass

        def _apply_chosen_preview(pil):
            try:
                if not preview_inner_c.winfo_exists():
                    return
                photo = ImageTk.PhotoImage(pil, master=preview_inner_c)
                preview_inner_c.configure(bg="white")
                preview_inner_c.delete("preview_content")
                preview_inner_c.create_image(
                    PREVIEW_W_C // 2, 0,
                    image=photo,
                    anchor="n",
                    tags=("preview_content",),
                )
                preview_inner_c.image = photo  # GC 방지
                _force_chosen_preview_paint()
            except Exception:
                pass

        def _poll_chosen_preview():
            try:
                kind, payload = preview_result_q.get_nowait()
            except queue.Empty:
                try:
                    if preview_inner_c.winfo_exists():
                        dlg.after(60, _poll_chosen_preview)
                except Exception:
                    pass
                return
            if kind == "ok":
                _apply_chosen_preview(payload)
            else:
                _set_chosen_preview_message(str(payload))

        def _put_chosen_preview_result(kind: str, payload):
            try:
                preview_result_q.put_nowait((kind, payload))
            except queue.Full:
                pass

        def _load_chosen_preview():
            if fitz is None:
                _put_chosen_preview_result("error", "미리보기 라이브러리(pymupdf) 없음")
                return
            order_num_local = (ws.get("orderNumber") or "").strip()
            if not order_num_local:
                _put_chosen_preview_result("error", "주문번호 없음")
                return
            pdf_url = f"{API_BASE}/api/public/worksheets/{quote(order_num_local, safe='')}/pdf"
            try:
                with urllib.request.urlopen(_safe_url(pdf_url), timeout=20) as resp:
                    data = resp.read()
                doc = fitz.open(stream=data, filetype="pdf")
                try:
                    page = doc[0]
                    page_w = max(1.0, float(page.rect.width))
                    zoom = PREVIEW_W_C / page_w
                    mat = fitz.Matrix(zoom, zoom)
                    pix = page.get_pixmap(matrix=mat, alpha=False)
                    pil = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
                finally:
                    doc.close()
            except Exception as e:
                _put_chosen_preview_result("error", f"미리보기 실패: {e}")
                return
            _put_chosen_preview_result("ok", pil)

        dlg.after(60, _poll_chosen_preview)
        threading.Thread(target=_load_chosen_preview, daemon=True).start()

    show_pick()  # 시작은 그리드 페이지

    def _apply_qr_routing():
        """QR 디코드 결과를 다이얼로그 초기 상태에 반영.
        - existing_worksheets 매칭(=기존 변경): 모드 자동 진입 + 'content' 라디오 + 성공 배너.
          (이전엔 매칭된 PDF 를 자동으로 큰 창으로 띄웠으나, 작업자가 [변경된 내용] 메모를
           작성하려고 다이얼로그를 클릭하는 시점에 비동기로 줌 창이 떠올라 입력을 가리는
           문제가 있어 자동 줌은 제거 — [🔍 크게 보기] 버튼으로만 연다.)
        - QR 디코드는 됐지만 진행중 작업에서 매칭 실패: 신규 탭 + 실패 배너.
        - QR 디코드 자체가 실패(잘림/누락): 신규 탭 + 실패 배너."""
        if qr_matched_ws is not None:
            try:
                _show_qr_banner(
                    "QR코드 매칭에 성공했습니다. 작업중인 지시서를 수정합니다.",
                    kind="success",
                )
                notebook.select(modify_tab)
                modify_state["selected_ws"] = qr_matched_ws
                # 통합 폼이라 모드 분기 불필요 — _refresh_chosen 이 알아서 'combined' 로 세팅.
                _refresh_chosen()
                show_chosen()
                _schedule_dialog_redraw()
                target = chosen_widgets.get("mod_day_entry")
                if target is not None:
                    try:
                        target.focus_set()
                        target.select_range(0, "end")
                        target.icursor("end")
                    except Exception:
                        pass
            except Exception as e:
                ui_log(f"QR 자동 라우팅(변경) 실패: {e}")
        else:
            # QR 디코드 실패(잘림/누락) 또는 디코드는 됐지만 진행중 작업에 없음 → 신규 작성 흐름.
            try:
                _show_qr_banner(
                    "QR코드 매칭에 실패했습니다. 새로운 지시서를 작성합니다.",
                    kind="warn",
                )
                notebook.select(new_tab)
                _schedule_dialog_redraw()
            except Exception:
                pass

    # 다이얼로그가 매핑/포커스 잡히고 _grab_focus 까지 끝난 뒤에 라우팅 — 너무 일찍 부르면
    # notebook.select 가 첫 그리기 전에 호출돼 탭 전환이 보이지 않거나 _refresh_chosen 의
    # 위젯들이 부모 사이즈 0 으로 잡히는 문제 회피.
    dlg.after(200, _apply_qr_routing)

    # ── 우측 패널: 분배함 사진(클릭으로 칸 토글) ────────────
    photo_panel = tk.Frame(right, bg=BG_SOFT)
    photo_panel.pack(fill="both", expand=True, padx=14, pady=14)

    tk.Label(
        photo_panel, text="③ 어느 분배함 칸에 꽂으시나요?",
        bg=BG_SOFT, fg=TITLE_FG,
        font=("맑은 고딕", 10, "bold"), anchor="w",
    ).pack(fill="x")
    tk.Label(
        photo_panel,
        text="사무실 분배함 그림입니다. 해당 칸을 클릭해 표시하세요. 여러 칸 동시 선택 가능.",
        bg=BG_SOFT, fg=SUB_FG,
        font=("맑은 고딕", 9), anchor="w", justify="left", wraplength=350,
    ).pack(fill="x", pady=(2, 8))

    PHOTO_DISPLAY_WIDTH = 360
    src_w, src_h = SLOT_LAYOUT_PHOTO_SIZE
    photo_scale = PHOTO_DISPLAY_WIDTH / src_w
    display_h = int(src_h * photo_scale)

    slot_active: dict[str, bool] = {label: False for label, _, _ in SLOT_BOXES}

    photo_path = resource_path("assets/distribution.jpg")
    tk_img = None
    try:
        pil_img = Image.open(photo_path).convert("RGB")
        resample = getattr(Image, "Resampling", Image).LANCZOS
        pil_img = pil_img.resize((PHOTO_DISPLAY_WIDTH, display_h), resample)
        tk_img = ImageTk.PhotoImage(pil_img)
    except Exception as e:
        ui_log(f"분배함 사진 로드 실패({photo_path}): {e}")

    canvas = tk.Canvas(
        photo_panel, width=PHOTO_DISPLAY_WIDTH, height=display_h,
        bg="white", highlightthickness=1, highlightbackground=BORDER,
        cursor="hand2",
    )
    canvas.pack(pady=(4, 0))
    if tk_img is not None:
        canvas.create_image(0, 0, image=tk_img, anchor="nw")
        canvas.image = tk_img
    else:
        canvas.create_text(
            PHOTO_DISPLAY_WIDTH // 2, display_h // 2,
            text="분배함 사진 없음\n(scripts/assets/distribution.jpg)",
            fill=SUB_FG, font=("맑은 고딕", 10), justify="center",
        )

    overlay_ids: dict[str, list[int]] = {}

    def _box_disp(box):
        l, t, r, b = box
        return (l * photo_scale, t * photo_scale, r * photo_scale, b * photo_scale)

    def _redraw_slot(label, mapped_dept, box):
        for oid in overlay_ids.get(label, []):
            canvas.delete(oid)
        overlay_ids[label] = []
        if not mapped_dept or not slot_active.get(label):
            return
        dl, dt, dr, db = _box_disp(box)
        rid = canvas.create_rectangle(
            dl, dt, dr, db,
            outline=ACCENT, width=3, fill=ACCENT, stipple="gray50",
        )
        cx = (dl + dr) / 2
        cy = (dt + db) / 2
        tid = canvas.create_text(
            cx, cy, text="✓", fill="white",
            font=("맑은 고딕", 14, "bold"),
        )
        overlay_ids[label] = [rid, tid]

    def collect_dept_tags() -> list[str]:
        seen: set[str] = set()
        out: list[str] = []
        for label, mapped_dept, _box in SLOT_BOXES:
            if not mapped_dept:
                continue
            if slot_active.get(label) and mapped_dept not in seen:
                seen.add(mapped_dept)
                out.append(mapped_dept)
        return out

    summary_var = tk.StringVar(
        value="선택된 부서 없음 — 모바일 뷰어에서는 \"전체보기\"에서만 노출됩니다."
    )
    tk.Label(
        photo_panel, textvariable=summary_var,
        bg=BG_SOFT, fg=SUB_FG,
        font=("맑은 고딕", 9), anchor="w", justify="left", wraplength=350,
    ).pack(fill="x", pady=(8, 0))

    def _refresh_summary():
        tags = collect_dept_tags()
        if not tags:
            summary_var.set("선택된 부서 없음 — 모바일 뷰어에서는 \"전체보기\"에서만 노출됩니다.")
        else:
            summary_var.set("배부 부서: " + " · ".join(tags))

    def on_canvas_click(ev):
        if tk_img is None:
            return
        src_x = ev.x / photo_scale
        src_y = ev.y / photo_scale
        for label, mapped_dept, box in SLOT_BOXES:
            if not mapped_dept:
                continue
            l, t, r, b = box
            if l <= src_x <= r and t <= src_y <= b:
                slot_active[label] = not slot_active[label]
                _redraw_slot(label, mapped_dept, box)
                _refresh_summary()
                return

    canvas.bind("<Button-1>", on_canvas_click)

    # ── confirm/cancel/skip 콜백 ───────────────────────────
    # confirm 의 두 변종:
    #   - 기본(_event 만): 웹 적용 + 종이 인쇄 (skip_print=False)
    #   - skip_print=True: 웹 적용만, 종이 인쇄 생략
    # Enter 키/녹색 버튼 모두 기본 변종을 부르고, "웹에만 적용하고 인쇄안하기" 버튼만
    # skip_print=True 로 호출한다.
    def confirm(_event=None, skip_print=False):
        idx = notebook.index(notebook.select())
        if idx == 0:
            # [신규 작성] 탭
            if most_recent is None:
                return
            s = (new_day_var.get() or "").strip()
            if not s.isdigit():
                return
            d = int(s)
            if d < 1 or d > 31:
                return
            delivery_ko = (new_delivery_var.get() or "").strip()
            delivery_enum = DELIVERY_KO_TO_ENUM.get(delivery_ko, "")
            result["value"] = {
                "mode": "new",
                "change_type": "delivery",  # 신규는 사실상 납기/배송 흐름과 동일
                "order_number": most_recent["orderNumber"],
                "day": d,
                "current_due_iso": most_recent.get("dueDate") or "",
                "delivery_method": delivery_enum,
                "original_delivery_method": most_recent.get("deliveryMethod") or "",
                "content_changed": False,
                "change_note": "",
                "department_tags": collect_dept_tags(),
                "skip_print": bool(skip_print),
            }
            dlg.destroy()
            return

        # [기존 변경] 탭 — 통합 폼: 납기/배송 + 내용 메모를 한 번에.
        # 납기는 입력=원본이면 resolve_new_due_date 가 같은 날짜를 돌려주므로 PATCH 가 멱등.
        # 배송은 원본과 다를 때만 송신(_process_printed_pdf 단에서 비교).
        # 내용 메모는 비어있으면 contentChanged=False 로 처리해 모바일 알림이 안 뜨도록.
        ws = modify_state["selected_ws"]
        if ws is None:
            return
        day_var_local = chosen_widgets.get("mod_day_var")
        delivery_var_local = chosen_widgets.get("mod_delivery_var")
        if day_var_local is None or delivery_var_local is None:
            return
        s = (day_var_local.get() or "").strip()
        if not s.isdigit():
            return
        d = int(s)
        if d < 1 or d > 31:
            return
        delivery_ko = (delivery_var_local.get() or "").strip()
        delivery_enum = DELIVERY_KO_TO_ENUM.get(delivery_ko, "")
        note_widget = chosen_widgets.get("mod_note_text")
        note = ""
        if note_widget is not None:
            try:
                note = note_widget.get("1.0", "end-1c").strip()
            except Exception:
                note = ""
        result["value"] = {
            "mode": "modify",
            "change_type": "combined",
            "order_number": ws["orderNumber"],
            "day": d,
            "current_due_iso": ws.get("dueDate") or "",
            "delivery_method": delivery_enum,
            "original_delivery_method": ws.get("deliveryMethod") or "",
            "content_changed": bool(note),
            "change_note": note,
            "department_tags": collect_dept_tags(),
            "skip_print": bool(skip_print),
        }
        dlg.destroy()
        return

    def confirm_no_print(_event=None):
        confirm(skip_print=True)

    def cancel(_event=None):
        result["value"] = None
        dlg.destroy()

    def skip_upload(_event=None):
        # 종이 인쇄만 진행 — 웹에 안 올림.
        result["value"] = {"order_number": None}
        dlg.destroy()

    # ── 버튼 ──────────────────────────────────────────────
    tk.Frame(left, bg=BORDER, height=1).pack(fill="x", padx=22, pady=(20, 0))

    button_row = tk.Frame(left, bg=BG)
    button_row.pack(fill="x", padx=22, pady=(14, 16))

    # 좌측: 두 가지 보조 액션. (1) 웹 안 올리고 종이만, (2) 웹만 올리고 인쇄 안 함.
    tk.Button(
        button_row, text="웹에 올리지 않고 종이만 인쇄",
        command=skip_upload,
        font=("맑은 고딕", 9),
        bg="#f4f4f5", fg=SUB_FG,
        activebackground=BORDER, activeforeground=TITLE_FG,
        relief="flat", padx=12, pady=6, cursor="hand2", bd=0,
    ).pack(side="left")
    tk.Button(
        button_row, text="웹에만 적용하고 인쇄 안 함",
        command=confirm_no_print,
        font=("맑은 고딕", 9),
        bg="#f4f4f5", fg=SUB_FG,
        activebackground=BORDER, activeforeground=TITLE_FG,
        relief="flat", padx=12, pady=6, cursor="hand2", bd=0,
    ).pack(side="left", padx=(6, 0))

    tk.Button(
        button_row, text="취소", command=cancel,
        font=("맑은 고딕", 11),
        bg="#f4f4f5", fg=LABEL_FG,
        activebackground=BORDER, activeforeground=TITLE_FG,
        relief="flat", padx=22, pady=8, cursor="hand2",
        bd=0,
    ).pack(side="right", padx=(8, 0))
    tk.Button(
        button_row, text="✓  웹에 적용 & 인쇄하기", command=confirm,
        font=("맑은 고딕", 11, "bold"),
        bg=ACCENT, fg="white",
        activebackground=ACCENT_HOVER, activeforeground="white",
        relief="flat", padx=24, pady=8, cursor="hand2",
        bd=0,
    ).pack(side="right")

    # Enter/Esc 는 다이얼로그 어디에 포커스가 있어도 동작하도록 위젯별로도 바인딩.
    dlg.bind("<Return>", confirm)
    dlg.bind("<Escape>", cancel)
    if new_day_entry is not None:
        new_day_entry.bind("<Return>", confirm)
    dlg.protocol("WM_DELETE_WINDOW", cancel)

    def _grab_focus():
        """다이얼로그가 즉시 키보드를 받도록 강제. SetForegroundWindow 만으로는 다른
        프로세스가 foreground 를 점유하고 있을 때 무시되는 경우가 많아서, 점유 스레드에
        AttachThreadInput 으로 입력 큐를 붙인 뒤 SetForegroundWindow 를 호출하는 트릭이
        가장 확실. Tk Toplevel 의 winfo_id 는 내부 윈도우라 GetParent 로 실제 toplevel
        HWND 를 얻어야 한다."""
        try:
            dlg.deiconify()
            dlg.lift()
            dlg.update_idletasks()
        except Exception:
            pass
        try:
            import win32api
            user32 = ctypes.windll.user32
            kernel32 = ctypes.windll.kernel32

            # Alt 토글 — Windows foreground 잠금 1차 우회
            win32api.keybd_event(0x12, 0, 0, 0)
            win32api.keybd_event(0x12, 0, 0x0002, 0)

            tk_hwnd = int(dlg.winfo_id())
            toplevel = user32.GetParent(tk_hwnd) or tk_hwnd

            fg_hwnd = user32.GetForegroundWindow()
            if fg_hwnd and fg_hwnd != toplevel:
                # 점유 중인 창의 스레드에 입력 큐를 붙여 SetForegroundWindow 차단을 무력화
                fg_thread = user32.GetWindowThreadProcessId(fg_hwnd, None)
                cur_thread = kernel32.GetCurrentThreadId()
                if fg_thread and fg_thread != cur_thread:
                    user32.AttachThreadInput(cur_thread, fg_thread, True)
                    try:
                        user32.BringWindowToTop(toplevel)
                        user32.SetForegroundWindow(toplevel)
                        user32.SetActiveWindow(toplevel)
                    finally:
                        user32.AttachThreadInput(cur_thread, fg_thread, False)
                else:
                    user32.SetForegroundWindow(toplevel)
            else:
                user32.SetForegroundWindow(toplevel)
        except Exception:
            pass
        try:
            dlg.focus_force()
            target = None
            try:
                if notebook.select() == str(modify_tab):
                    candidate = chosen_widgets.get("mod_day_entry")
                    if candidate is not None and candidate.winfo_ismapped():
                        target = candidate
                elif new_day_entry is not None and new_day_entry.winfo_ismapped():
                    target = new_day_entry
            except Exception:
                target = None
            if target is not None:
                target.focus_set()
                target.select_range(0, "end")
                target.icursor("end")
            _schedule_dialog_redraw()
        except Exception:
            pass

    # 윈도우가 실제로 화면에 매핑되는 시점에 첫 시도. 그 전엔 SetForegroundWindow 가
    # 무시될 수 있어 after(50) 만으론 부족했음.
    def _on_first_map(_event=None):
        try:
            dlg.unbind("<Map>")
        except Exception:
            pass
        dlg.after(20, _grab_focus)
    dlg.bind("<Map>", _on_first_map)
    # 매핑 이벤트가 누락된 환경(드물게)에 대비해 시간차로 추가 시도.
    dlg.after(150, _grab_focus)
    dlg.after(400, _grab_focus)
    dlg.after(800, _grab_focus)
    dlg.grab_set()
    dlg.wait_window()
    return result["value"]


def _schedule_printed_pdf_cleanup(pdf_path: Path, delay_sec: int = 30):
    """종이 인쇄(ShellExecute)가 PDF 핸들을 닫을 시간을 벌고 백그라운드에서 unlink.
    실패 시 조용히 로그만 — 다음 인쇄 때까지 남아있어도 동작에는 영향 없음."""
    def _run():
        time.sleep(delay_sec)
        try:
            if pdf_path.exists():
                pdf_path.unlink()
                ui_log(f"인쇄 PDF 정리: {pdf_path.name}")
        except Exception as e:
            ui_log(f"인쇄 PDF 정리 실패: {pdf_path.name} ({e})")
    threading.Thread(target=_run, daemon=True).start()


def decode_pdf_qr(pdf_path: Path) -> str | None:
    """인쇄된 PDF 1페이지에서 QR 을 디코드해 주문번호를 반환. 실패/미설치 시 None.

    QR URL 은 워처가 박을 때 /p/{orderNumber} 형식 — 호스트는 무시하고 path 만 매칭한다
    (스테이징/로컬 호스트로 바뀌어도 인식). pyzbar 없거나 PDF 가 깨졌으면 호출자는
    QR 매칭 없이 평소 다이얼로그(수동 선택)로 폴백한다."""
    if pyzbar_decode is None:
        ui_log("QR 디코드 건너뜀: pyzbar 라이브러리 없음 (exe 빌드시 --collect-all pyzbar 필요)")
        return None
    if fitz is None:
        ui_log("QR 디코드 건너뜀: pymupdf(fitz) 라이브러리 없음")
        return None
    if not pdf_path.exists():
        return None
    try:
        doc = fitz.open(str(pdf_path))
        try:
            page = doc[0]
            # 200dpi — 100pt 기본 QR 도 깔끔히 인식. 더 키우면 인식률 향상보다 메모리만 늘어남.
            mat = fitz.Matrix(200 / 72, 200 / 72)
            pix = page.get_pixmap(matrix=mat, alpha=False)
            pil = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        finally:
            doc.close()
        # 그레이스케일이 zbar 인식률 가장 높음. FlexSign/PDF24 거치며 옅어진 셀도 거의 잡힌다.
        gray = pil.convert("L")
        results = pyzbar_decode(gray)
        if not results:
            ui_log(f"QR 디코드: PDF 안에서 QR 코드를 찾지 못함 ({pdf_path.name}, {pil.width}x{pil.height})")
            return None
        for r in results:
            try:
                data = r.data.decode("utf-8", errors="ignore")
            except Exception:
                continue
            m = re.search(r"/p/([^/?#\s]+)", data)
            if m:
                # QR 박을 때 quote(order_number, safe="") 로 URL-인코딩되어 들어가므로
                # 한글 주문번호("주문-260427-03" 등)면 %EC%A3%... 형태로 매치된다.
                # existing_worksheets 의 orderNumber 는 원본 텍스트라 unquote 후 비교해야 매칭 성공.
                try:
                    order = unquote(m.group(1)).strip()
                except Exception:
                    order = m.group(1).strip()
                if order:
                    return order
            else:
                ui_log(f"QR 디코드: /p/ 패턴 불일치 — 내용: {data[:80]!r}")
        return None
    except Exception as e:
        ui_log(f"QR 디코드 실패: {e}")
        return None


def _process_printed_pdf(pdf_path: Path):
    """인쇄 폴더에 새 PDF 가 떨어졌을 때 호출.
    드롭다운 다이얼로그로 어떤 주문에 매칭할지 직원이 선택.
    선택 결과:
      - 취소(Esc/X): 아무것도 안 함 (종이도 X)
      - "매칭 안 함": 종이만 인쇄
      - 주문 선택 + 일자: 납기 PATCH + PDF 덮어쓰기 + 종이 인쇄

    PDF 안의 QR 디코드에 성공하면 다이얼로그가 자동으로 매칭된 주문 탭/모드로 진입.
    QR 실패 시(미설치/인식불가)에는 매칭 없이 평소 다이얼로그를 그대로 띄운다.
    """
    key = str(pdf_path.resolve())
    # check-and-add 를 락으로 원자화 — watchdog 이 동일 파일에 대해 on_created/on_moved 를
    # 연달아 발사해 두 스레드가 동시에 진입하는 경우 다이얼로그가 두 번 뜨는 race 방지.
    with _seen_printed_lock:
        if key in _seen_printed:
            return
        _seen_printed.add(key)
    # 파일이 완전히 쓰여질 때까지 잠깐 대기 (PDF24 가 청크 단위로 쓸 수 있음)
    time.sleep(0.8)

    # PDF24 가 출력을 끝낸 시점이므로, 이후 종이 인쇄가 원래 프린터(삼성)로 가도록
    # 워처가 launch_flexsign 직전에 임시 전환했던 기본 프린터를 즉시 복구한다.
    restore_default_printer()

    orders = list_recent_orders()
    if not orders:
        # 매칭할 주문이 큐에 없으면 일단 종이만 인쇄. 직원이 따로 처리할 수 있도록 로그만 남김.
        ui_log(f"인쇄 PDF 감지 — 큐에 주문 없음, 종이 인쇄만 진행: {pdf_path.name}")
        print_pdf_to_paper(pdf_path)
        return

    # 다이얼로그 [기존 변경] 탭 그리드용 — UI 스레드 진입 전에 받아 둔다(API 가 느려도 UI 가 응답).
    existing_worksheets = fetch_existing_worksheets()

    # PDF 안의 QR 인식 시도 — 성공하면 다이얼로그가 자동 매칭/모드 분기.
    # 실패해도 흐름은 그대로(평소 수동 선택). UI 스레드 차단 회피로 이 단계에서 미리 처리.
    qr_order_number = decode_pdf_qr(pdf_path)
    if qr_order_number:
        ui_log(f"QR 인식: {qr_order_number}")

    holder: dict = {"value": None, "done": threading.Event()}

    def _ask_on_ui():
        try:
            holder["value"] = _ask_print_match_blocking(
                orders, pdf_path, existing_worksheets,
                qr_order_number=qr_order_number,
            )
        except Exception as e:
            # 다이얼로그 자체가 터지면 사용자가 취소한 것처럼 조용히 묻혀 PDF24 인쇄가 무위로 끝나므로,
            # UI 로그에 명시 — 'PDF24 보냈는데 왜 취소되지?' 류 디버깅을 위해 흔적 남김.
            ui_log(f"인쇄 매칭 다이얼로그 오류: {e}")
        finally:
            holder["done"].set()

    _ui_queue.put(("run", _ask_on_ui))
    holder["done"].wait()

    sel = holder["value"]
    if sel is None:
        ui_log(f"인쇄 — 사용자 취소: 종이 인쇄/업로드 모두 생략 ({pdf_path.name})")
        return

    order_number = sel.get("order_number")
    if order_number is None:
        ui_log(f"인쇄 — 매칭 안 함 선택, 종이 인쇄만 진행 ({pdf_path.name})")
        print_pdf_to_paper(pdf_path)
        return

    new_due = resolve_new_due_date(sel.get("current_due_iso", ""), sel["day"])
    # 배송방법은 다이얼로그에서 변경된 경우에만 함께 보낸다(원래 값과 같으면 생략).
    new_delivery = sel.get("delivery_method") or ""
    orig_delivery = sel.get("original_delivery_method") or ""
    delivery_to_send = new_delivery if (new_delivery and new_delivery != orig_delivery) else None
    # 부서 태그는 다이얼로그에서 항상 결정(아무 칸도 클릭 안 했으면 빈 리스트) →
    # patch 마다 함께 송신하여 "태그 비우기"도 명시적으로 표현.
    dept_tags = list(sel.get("department_tags") or [])
    patch_due_date(order_number, new_due, delivery_to_send, dept_tags)
    # 사용자가 다이얼로그에서 "지시서 내용 변경됨" 체크 시에만 contentChanged=true 송신.
    # change_note 도 함께 — 모바일 뷰어 탭하면 노출된다.
    upload_ok = upload_worksheet_pdf(order_number, pdf_path,
                                     content_changed=bool(sel.get("content_changed", False)),
                                     change_note=sel.get("change_note") or "")
    # "웹에만 적용하고 인쇄 안 함" 선택 시 종이 인쇄 단계를 건너뛴다 — 웹 적용만 끝.
    if sel.get("skip_print"):
        ui_log(f"인쇄 — '인쇄 안 함' 선택, 종이 인쇄 생략 ({pdf_path.name})")
    else:
        print_pdf_to_paper(pdf_path)
    # 업로드 성공 시 로컬 PDF 자동 삭제 — 웹(R2)에 보관됐으니 printed/ 누적 방지.
    # 종이 프린터(외부 리더)가 파일 핸들을 닫기 전에 지우면 인쇄 실패하므로 30초 지연.
    # 업로드 실패 시엔 보존 — 사용자가 수동 재업로드/검증할 수 있게.
    if upload_ok:
        _schedule_printed_pdf_cleanup(pdf_path)


class PrintedPdfHandler(FileSystemEventHandler):
    def _handle(self, src: Path):
        if src.suffix.lower() != ".pdf":
            return
        # 워처가 업로드 직전에 만드는 압축본(.min.pdf)이 같은 폴더로 들어와도 다이얼로그가
        # 다시 뜨지 않도록 방어. 압축본은 이미 temp 로 보내고 있지만, 누가 옛 빌드를
        # 사용하더라도 매칭 다이얼로그 중복은 막는다.
        if src.name.lower().endswith(".min.pdf"):
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
    # 줄바꿈은 JSX 의 \r (CR, paragraph break) 로 변환 — Illustrator textFrame 과
    # area text 모두 \r 을 표준 줄바꿈으로 인식한다. \n 만 넣으면 area text 에서
    # 줄바꿈이 안 되어 한 줄로 들어가는 케이스가 발생.
    return (s.replace("\\", "\\\\")
             .replace('"', '\\"')
             .replace("\r", "")
             .replace("\n", "\\r"))


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
        # 거래처 데이터에 두 가지 사전처리: (1) 텍스트 윤곽선화 — FlexSign 글자
        # 메트릭 차이로 자모가 벌어지는 문제를 거래처 원본 텍스트에도 회피.
        # (2) 최상위 그룹 한 겹 풀기 — FlexSign 에서 도면 전체가 한 덩어리로
        # 묶여 보이는 문제 회피. worksheet 레이어 추가 전에 수행하므로 우리가
        # 만들 워크시트 텍스트/그룹은 영향 없음.
        # 잠긴/숨김 레이어는 편집이 안 되므로 일괄 해제 후 작업, 끝나고 복구.
        "  var prevLock = []; var prevVis = [];"
        "  for (var li = 0; li < doc.layers.length; li++) {"
        "    var lyrT = doc.layers[li];"
        "    prevLock.push(lyrT.locked); prevVis.push(lyrT.visible);"
        "    try { lyrT.locked = false; lyrT.visible = true; } catch (e) {}"
        "  }"
        # createOutline 은 textFrame 을 group 으로 치환하면서 컬렉션이 변하므로
        # 원본 참조를 먼저 배열에 캡처해두고 처리한다.
        "  var origText = [];"
        "  for (var ti0 = 0; ti0 < doc.textFrames.length; ti0++) {"
        "    origText.push(doc.textFrames[ti0]);"
        "  }"
        "  for (var ti = 0; ti < origText.length; ti++) {"
        "    try { origText[ti].createOutline(); } catch (e) {}"
        "  }"
        # 클립그룹(마스크) 은 깨지면 안 되므로 스킵, 내부 중첩 그룹(로고 등
        # 의도된 그룹) 은 그대로 유지. 이중 처리 방지를 위해 처리 시점의 원본
        # 그룹만 배열에 캡처.
        "  for (var li2 = 0; li2 < doc.layers.length; li2++) {"
        "    var lyrG = doc.layers[li2];"
        "    var origGroups = [];"
        "    for (var gi0 = 0; gi0 < lyrG.groupItems.length; gi0++) {"
        "      origGroups.push(lyrG.groupItems[gi0]);"
        "    }"
        "    for (var gi = 0; gi < origGroups.length; gi++) {"
        "      var g = origGroups[gi];"
        "      if (g.clipped) continue;"
        "      try {"
        "        while (g.pageItems.length > 0) {"
        "          g.pageItems[0].moveBefore(g);"
        "        }"
        "        g.remove();"
        "      } catch (e) {}"
        "    }"
        "  }"
        # 레이어 잠금/표시 상태 복구.
        "  for (var li3 = 0; li3 < doc.layers.length && li3 < prevLock.length; li3++) {"
        "    try {"
        "      doc.layers[li3].visible = prevVis[li3];"
        "      doc.layers[li3].locked = prevLock[li3];"
        "    } catch (e) {}"
        "  }"
        "  var layer = doc.layers.add();"
        "  layer.name = 'worksheet';"
        # 대지(첫 번째 artboard) 와 실제 도면 bounds 둘 다 측정.
        "  var ab = doc.artboards[0].artboardRect;"
        "  var abLeft = ab[0], abTop = ab[1], abRight = ab[2], abBottom = ab[3];"
        "  var abWidth = abRight - abLeft;"
        "  var hasArt = doc.pageItems.length > 0;"
        "  var artLeft = abLeft, artTop = abTop, artRight = abRight, artBottom = abBottom, artWidth = abWidth;"
        "  if (hasArt) {"
        "    try {"
        "      var dbnd = doc.geometricBounds;"  # [left, top, right, bottom]
        "      artLeft = dbnd[0]; artTop = dbnd[1]; artRight = dbnd[2]; artBottom = dbnd[3];"
        "      artWidth = artRight - artLeft;"
        "      if (artWidth <= 0) artWidth = abWidth;"
        "    } catch (e) { hasArt = false; }"
        "  }"
        # 도면이 대지를 벗어나 있으면 대지를 도면 전체를 포함하도록 확장.
        # 이유: 워크시트가 대지 폭 기준으로 그려지므로, 대지 밖에 컨텐츠가 있는
        # 거래처 파일에서 그 부분이 누락되어 보이는 문제를 막기 위함.
        # (Illustrator 좌표계: top > bottom, left < right)
        "  if (hasArt) {"
        "    var needLeft = (artLeft < abLeft) ? artLeft : abLeft;"
        "    var needTop = (artTop > abTop) ? artTop : abTop;"
        "    var needRight = (artRight > abRight) ? artRight : abRight;"
        "    var needBottom = (artBottom < abBottom) ? artBottom : abBottom;"
        "    if (needLeft != abLeft || needTop != abTop || needRight != abRight || needBottom != abBottom) {"
        "      try {"
        "        doc.artboards[0].artboardRect = [needLeft, needTop, needRight, needBottom];"
        "        ab = doc.artboards[0].artboardRect;"
        "        abLeft = ab[0]; abTop = ab[1]; abRight = ab[2]; abBottom = ab[3];"
        "        abWidth = abRight - abLeft;"
        "      } catch (e) {}"
        "    }"
        "  }"
        # 워크시트가 대지 상단 폭을 꽉 채우도록 대지 폭(abWidth) 기준 10%.
        # 도면 크기와 무관하게 대지 기준으로 비례시켜야 작은 간판이든 큰 간판이든
        # 워크시트(QR/박스/거래처명)가 일관되게 상단을 차지한다.
        "  var qrSize = abWidth * 0.10;"
        "  if (qrSize < 60) qrSize = 60;"
        "  if (qrSize > 1500) qrSize = 1500;"
        "  var sc = qrSize / 90.0;"
        "  var margin = 18 * sc;"
        "  var bigFont = 26 * sc;"
        "  var noteFont = 13 * sc;"
        # 박스 높이는 폰트에 맞춰 꽉 차게(1.5배). 폭은 헤더 텍스트 측정 후
        # 결정 — 글씨가 박스 양옆을 거의 꽉 채우도록. (아래 헤더 생성 시점에 계산)
        "  var boxH = bigFont * 1.5;"
        "  var lineGap = 6 * sc;"
        # 색상 / 폰트 — 노트 사전 측정 단계에서도 동일 폰트를 적용해야 정확한 줄높이가 나온다.
        "  var blk = new RGBColor(); blk.red = 0; blk.green = 0; blk.blue = 0;"
        "  var boxFill = new RGBColor();"
        f"  boxFill.red = {fr}; boxFill.green = {fg}; boxFill.blue = {fb};"
        "  var boxStroke = new RGBColor();"
        f"  boxStroke.red = {sr}; boxStroke.green = {sg}; boxStroke.blue = {sb};"
        # FlexSign v8 호환성을 위해 굴림/돋움 우선 — 맑은 고딕은 메트릭 차이로
        # 자모가 벌어지거나 마지막 글자가 잘리는 문제 발생.
        "  var malgun = null;"
        "  var malgunNames = ['Gulim','GulimChe','굴림','굴림체','Dotum','DotumChe','돋움','돋움체','MalgunGothic','Malgun Gothic','맑은 고딕','맑은고딕'];"
        "  for (var mi = 0; mi < malgunNames.length && malgun == null; mi++) {"
        "    try { malgun = app.textFonts.getByName(malgunNames[mi]); } catch(e) { malgun = null; }"
        "  }"
        # ── 헤더 폭 사전 측정 → 박스 폭을 글씨에 꽉 맞춤 (좌우 padding 만 약간).
        # 측정용 프레임은 폭만 잰 뒤 즉시 제거하고, 실제 헤더는 아래에서 다시 만든다.
        f'  var headerStr = "{header_js}";'
        "  var headerWidth = bigFont * 6;"
        "  var measHdr = layer.textFrames.add();"
        "  measHdr.contents = headerStr;"
        "  measHdr.textRange.characterAttributes.size = bigFont;"
        "  if (malgun) measHdr.textRange.characterAttributes.textFont = malgun;"
        "  measHdr.position = [0, 0];"
        "  try {"
        "    var mhb = measHdr.geometricBounds;"
        "    headerWidth = mhb[2] - mhb[0];"
        "  } catch (e) {}"
        "  try { measHdr.remove(); } catch (e) {}"
        "  var boxPadX = bigFont * 0.7;"
        "  var boxW = headerWidth + boxPadX * 2;"
        "  var minBoxW = bigFont * 6;"
        "  if (boxW < minBoxW) boxW = minBoxW;"
        # ── 좌측 거래처명 폭 사전 측정 → 거래처명/헤더박스/QR 가 좁은 대지에서 겹치는 문제 회피.
        # 측정만 하고 즉시 제거 — 실제 좌측 텍스트는 아래에서 다시 만들어 위치를 잡는다.
        f'  var leftStr = "{left_js}";'
        "  var leftWidth = bigFont * 4;"
        "  var measLeft = layer.textFrames.add();"
        "  measLeft.contents = leftStr;"
        "  measLeft.textRange.characterAttributes.size = bigFont;"
        "  if (malgun) measLeft.textRange.characterAttributes.textFont = malgun;"
        "  measLeft.position = [0, 0];"
        "  try {"
        "    var mlbX = measLeft.geometricBounds;"
        "    leftWidth = mlbX[2] - mlbX[0];"
        "  } catch (e) {}"
        "  try { measLeft.remove(); } catch (e) {}"
        # 헤더박스는 캔버스 정중앙 정렬 — 좌(거래처)와 우(QR) 중 큰 쪽이 박스 한쪽 한계를 결정.
        # 좌+박스/2+margin+gap > abWidth/2 이거나 우측이 그렇다면 글씨/박스/QR 모두 동일 비율 s 로 축소.
        # margin·lineGap 은 sc 에 따라 자동으로 같이 줄어든다.
        "  var minGap = bigFont * 0.5;"
        "  var sideMax = (leftWidth > qrSize) ? leftWidth : qrSize;"
        "  var totalNeed = boxW / 2 + sideMax + margin + minGap;"
        "  if (totalNeed > abWidth / 2) {"
        "    var s = (abWidth / 2) / totalNeed;"
        "    if (s < 0.4) s = 0.4;"
        "    bigFont = bigFont * s;"
        "    noteFont = noteFont * s;"
        "    qrSize = qrSize * s;"
        "    sc = qrSize / 90.0;"
        "    margin = 18 * sc;"
        "    boxH = bigFont * 1.5;"
        "    lineGap = 6 * sc;"
        "    headerWidth = headerWidth * s;"
        "    leftWidth = leftWidth * s;"
        "    boxPadX = bigFont * 0.7;"
        "    boxW = headerWidth + boxPadX * 2;"
        "    minBoxW = bigFont * 6;"
        "    if (boxW < minBoxW) boxW = minBoxW;"
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
        # Illustrator 의 lines.length 는 도큐먼트가 compose 되기 전이라 0 을 돌려주는
        # 케이스가 잦다. 임시 프레임 측정에 의존하면 멀티라인 텍스트가 한 줄 분량으로
        # 짤려 들어가 실제 [추가물품]/[추가요청사항] 이 보이지 않는 사고가 난다.
        # 텍스트만 보고 단락(\\r) 수 + 단락별 wrap(글자수/한 줄 수용량) 으로 보수적으로 추정.
        "    var paras = noteTextStr.split('\\r');"
        "    var avgCharW = noteFont * 0.7;"
        "    var maxCharsPerLine = Math.max(1, Math.floor(noteTextW / avgCharW));"
        "    var totalLines = 0;"
        "    for (var k = 0; k < paras.length; k++) {"
        "      var pl = paras[k].length;"
        "      if (pl <= 0) totalLines += 1;"
        "      else totalLines += Math.ceil(pl / maxCharsPerLine);"
        "    }"
        "    var contentH = totalLines * noteFont * 1.4;"
        # 마지막 줄이 영역 밖으로 잘리는 케이스 방지 — 한 줄 높이만큼 안전 마진 추가.
        "    noteH = contentH + pad * 2 + noteFont;"
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
        "  var needAbBottom = abBottom;"
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
        "  if (needAbTop > abTop || needAbBottom < abBottom) {"
        "    try { doc.artboards[0].artboardRect = [abLeft, needAbTop, abRight, needAbBottom]; } catch (e) {}"
        "  }"
        # FlexSign 이 v8 AI 의 글자 메트릭을 다르게 해석해서 자모 사이가 벌어지는
        # 문제를 막기 위해 모든 텍스트(좌측, 헤더, 노트)를 윤곽선으로 변환한다.
        # 헤더 박스도 outline 하지 않으면 FlexSign 이 슬래시 양옆에 공백을 끼워넣어
        # 글씨가 회색 박스 밖으로 밀려난다. 사용자가 나중에 텍스트를 수정해야 할
        # 일이 생기면 삭제 후 다시 입력하는 워크플로로 처리.
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


def process_header_only_to_v8(ai_app, dst_path: Path,
                              qr_js_matrix: str,
                              header_text: str, left_text: str, note_text: str) -> bool:
    """헤더(QR + 박스 + 좌측텍스트 + 노트박스)만 빈 캔버스에 그린 v8 AI 저장.
    거래처 원본 AI 를 열지 않으므로 큰 파일에서 발생하는 Illustrator COM 타임아웃을 회피한다.
    사용자는 FlexSign 에서 이 헤더를 복사해 거래처 원본 캔버스에 붙여 인쇄 → PDF24 흐름으로 진입."""
    header_js = _js_escape(header_text)
    left_js = _js_escape(left_text)
    note_js = _js_escape(note_text)
    dst_js = str(dst_path).replace("\\", "/")

    fr, fg, fb = HEADER_BOX_FILL
    sr, sg, sb = HEADER_BOX_STROKE

    script = (
        "try {"
        f"  var dstPath = \"{dst_js}\";"
        "  var dstFile = new File(dstPath);"
        "  function k(p) { return p.toLowerCase().replace(/\\\\/g, '/'); }"
        "  for (var z = app.documents.length - 1; z >= 0; z--) {"
        "    var fp = k(app.documents[z].fullName.fsName);"
        "    if (fp == k(dstPath)) {"
        "      try { app.documents[z].close(SaveOptions.DONOTSAVECHANGES); } catch(e) {}"
        "    }"
        "  }"
        # 빈 캔버스 — abWidth*0.10 = 100pt QR 이라 가독성 적당. 높이는 노트량에 맞춰 아래에서 자른다.
        "  var W = 1000; var H = 600;"
        "  var doc = app.documents.add(DocumentColorSpace.RGB, W, H);"
        "  var layer = doc.layers.add();"
        "  layer.name = 'worksheet';"
        "  var ab = doc.artboards[0].artboardRect;"
        "  var abLeft = ab[0], abTop = ab[1], abRight = ab[2], abBottom = ab[3];"
        "  var abWidth = abRight - abLeft;"
        "  var qrSize = abWidth * 0.10;"
        "  if (qrSize < 60) qrSize = 60;"
        "  if (qrSize > 1500) qrSize = 1500;"
        "  var sc = qrSize / 90.0;"
        "  var margin = 18 * sc;"
        "  var bigFont = 26 * sc;"
        "  var noteFont = 13 * sc;"
        "  var boxH = bigFont * 1.5;"
        "  var lineGap = 6 * sc;"
        "  var blk = new RGBColor(); blk.red = 0; blk.green = 0; blk.blue = 0;"
        "  var boxFill = new RGBColor();"
        f"  boxFill.red = {fr}; boxFill.green = {fg}; boxFill.blue = {fb};"
        "  var boxStroke = new RGBColor();"
        f"  boxStroke.red = {sr}; boxStroke.green = {sg}; boxStroke.blue = {sb};"
        "  var malgun = null;"
        "  var malgunNames = ['Gulim','GulimChe','굴림','굴림체','Dotum','DotumChe','돋움','돋움체','MalgunGothic','Malgun Gothic','맑은 고딕','맑은고딕'];"
        "  for (var mi = 0; mi < malgunNames.length && malgun == null; mi++) {"
        "    try { malgun = app.textFonts.getByName(malgunNames[mi]); } catch(e) { malgun = null; }"
        "  }"
        # 헤더 폭 사전 측정 (글씨에 박스 폭 맞추기)
        f'  var headerStr = "{header_js}";'
        "  var headerWidth = bigFont * 6;"
        "  var measHdr = layer.textFrames.add();"
        "  measHdr.contents = headerStr;"
        "  measHdr.textRange.characterAttributes.size = bigFont;"
        "  if (malgun) measHdr.textRange.characterAttributes.textFont = malgun;"
        "  measHdr.position = [0, 0];"
        "  try {"
        "    var mhb = measHdr.geometricBounds;"
        "    headerWidth = mhb[2] - mhb[0];"
        "  } catch (e) {}"
        "  try { measHdr.remove(); } catch (e) {}"
        "  var boxPadX = bigFont * 0.7;"
        "  var boxW = headerWidth + boxPadX * 2;"
        "  var minBoxW = bigFont * 6;"
        "  if (boxW < minBoxW) boxW = minBoxW;"
        # 좌측 거래처명 폭 사전 측정 → 거래처/박스/QR 충돌 시 동일 비율 축소.
        f'  var leftStr = "{left_js}";'
        "  var leftWidth = bigFont * 4;"
        "  var measLeft = layer.textFrames.add();"
        "  measLeft.contents = leftStr;"
        "  measLeft.textRange.characterAttributes.size = bigFont;"
        "  if (malgun) measLeft.textRange.characterAttributes.textFont = malgun;"
        "  measLeft.position = [0, 0];"
        "  try {"
        "    var mlbX = measLeft.geometricBounds;"
        "    leftWidth = mlbX[2] - mlbX[0];"
        "  } catch (e) {}"
        "  try { measLeft.remove(); } catch (e) {}"
        "  var minGap = bigFont * 0.5;"
        "  var sideMax = (leftWidth > qrSize) ? leftWidth : qrSize;"
        "  var totalNeed = boxW / 2 + sideMax + margin + minGap;"
        "  if (totalNeed > abWidth / 2) {"
        "    var s = (abWidth / 2) / totalNeed;"
        "    if (s < 0.4) s = 0.4;"
        "    bigFont = bigFont * s;"
        "    noteFont = noteFont * s;"
        "    qrSize = qrSize * s;"
        "    sc = qrSize / 90.0;"
        "    margin = 18 * sc;"
        "    boxH = bigFont * 1.5;"
        "    lineGap = 6 * sc;"
        "    headerWidth = headerWidth * s;"
        "    leftWidth = leftWidth * s;"
        "    boxPadX = bigFont * 0.7;"
        "    boxW = headerWidth + boxPadX * 2;"
        "    minBoxW = bigFont * 6;"
        "    if (boxW < minBoxW) boxW = minBoxW;"
        "  }"
        # 노트 위치/크기 + 높이 사전 측정
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
        # convert_with_header 와 동일한 이유로 lines 측정 대신 단락 기반 추정 사용.
        "    var paras = noteTextStr.split('\\r');"
        "    var avgCharW = noteFont * 0.7;"
        "    var maxCharsPerLine = Math.max(1, Math.floor(noteTextW / avgCharW));"
        "    var totalLines = 0;"
        "    for (var k = 0; k < paras.length; k++) {"
        "      var pl = paras[k].length;"
        "      if (pl <= 0) totalLines += 1;"
        "      else totalLines += Math.ceil(pl / maxCharsPerLine);"
        "    }"
        "    var contentH = totalLines * noteFont * 1.4;"
        "    noteH = contentH + pad * 2 + noteFont;"
        "  }"
        # 빈 캔버스라 도면 침범 처리는 불필요. topY 는 abTop 그대로.
        "  var rightDepth = qrSize;"
        "  if (noteH > 0) rightDepth += lineGap + noteH;"
        "  var overlayDepth = (rightDepth > boxH) ? rightDepth : boxH;"
        "  var topY = abTop;"
        # 캔버스 높이를 헤더 컨텐츠에 맞춰 트림 — 빈 여백이 너무 크면 FlexSign 붙여넣기 시 거슬림.
        "  var needAbBottom = topY - (overlayDepth + margin * 2);"
        "  if (needAbBottom < abBottom) {"
        "    try { doc.artboards[0].artboardRect = [abLeft, abTop, abRight, needAbBottom]; } catch(e) {}"
        "    abBottom = needAbBottom;"
        "  }"
        # 좌측: 싸인월드 + 전화번호
        "  var leftTf = layer.textFrames.add();"
        f'  leftTf.contents = "{left_js}";'
        "  leftTf.textRange.characterAttributes.size = bigFont;"
        "  if (malgun) leftTf.textRange.characterAttributes.textFont = malgun;"
        "  leftTf.position = [0, 0];"
        "  var lb = leftTf.geometricBounds;"
        "  var leftTargetX = abLeft + margin;"
        "  var leftTargetTop = topY - margin;"
        "  leftTf.position = [leftTargetX - lb[0], leftTargetTop - lb[1]];"
        # 중앙: 박스 + 헤더 텍스트
        "  var centerX = (abLeft + abRight) / 2;"
        "  var boxLeft = centerX - boxW / 2;"
        "  var boxTop = topY - margin;"
        "  var box = layer.pathItems.rectangle(boxTop, boxLeft, boxW, boxH);"
        "  box.filled = true; box.fillColor = boxFill;"
        "  box.stroked = true; box.strokeColor = boxStroke;"
        "  box.strokeWidth = 0.5 * sc;"
        "  var headerTf = layer.textFrames.add();"
        f'  headerTf.contents = "{header_js}";'
        "  headerTf.textRange.characterAttributes.size = bigFont;"
        "  if (malgun) headerTf.textRange.characterAttributes.textFont = malgun;"
        "  headerTf.position = [0, 0];"
        "  var hb = headerTf.geometricBounds;"
        "  var glyphCx = (hb[0] + hb[2]) / 2;"
        "  var glyphCy = (hb[1] + hb[3]) / 2;"
        "  var boxCenterY = boxTop - boxH / 2;"
        "  headerTf.position = [centerX - glyphCx, boxCenterY - glyphCy];"
        # 우측: QR
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
        # QR 아래: 노트 박스
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
        # FlexSign 메트릭 회피 — 모든 텍스트(좌측/헤더/노트)를 윤곽선으로 변환.
        # 헤더를 outline 하지 않으면 FlexSign 이 슬래시 양옆 공백을 늘려 회색 박스 밖으로 밀어낸다.
        "  try { leftTf.createOutline(); } catch (e) {}"
        "  try { headerTf.createOutline(); } catch (e) {}"
        "  if (noteTfRef) { try { noteTfRef.createOutline(); } catch (e) {} }"
        # v8 저장 — 자동지시서작성과 달리 PDF 는 만들지 않는다.
        # 이 AI 는 "FlexSign 에서 복사해 거래처 캔버스에 붙이는" 중간물이고, 최종 PDF 는
        # 사용자가 인쇄 단계에서 PDF24 로 만들면 _process_printed_pdf 가 업로드한다.
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
            ui_log(f"Illustrator 헤더 처리 실패: {result}")
            return False
        return True
    except Exception as e:
        ui_log(f"DoJavaScript 호출 실패: {e}")
        return False


def convert_header_only(order_number: str, qr_js_matrix: str,
                        header_text: str, left_text: str, note_text: str) -> Path | None:
    """주문 정보로부터 헤더만 그린 AI v8 를 생성. 성공 시 경로, 실패 시 None."""
    try:
        import pythoncom
        import win32com.client as win32

        pythoncom.CoInitialize()
        ai_app = win32.GetActiveObject("Illustrator.Application")
        ai_app.UserInteractionLevel = -1

        out_dir = WATCH_DIR / "converted"
        out_dir.mkdir(exist_ok=True)
        ts = time.strftime("%y%m%d_%H%M%S")
        out_path = out_dir / f"{order_number}_헤더_{ts}.ai"

        if not process_header_only_to_v8(ai_app, out_path, qr_js_matrix,
                                         header_text, left_text, note_text):
            return None
        ui_log(f"{order_number} 헤더 AI 저장 완료")
        return out_path
    except Exception as e:
        ui_log(f"헤더 변환 실패: {e}")
        return None


def convert_ai_file(ai_path: Path, qr_js_matrix: str,
                    header_text: str, left_text: str, note_text: str
                    ) -> tuple[Path, Path] | None:
    """변환 성공 시 (AI v8 경로, PDF 경로) 튜플을 반환. 실패 시 None.
    Illustrator/FlexSign 실행 여부는 process_zip 진입 시점에 일괄 검사한다."""
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
        # 확장자 .ai (Illustrator v8): FlexSign 으로 임포트 시 화면 표시는 정상.
        # 직원이 회사 네트워크 폴더에 저장할 때 [다른 이름으로 저장 → FlexiSIGN(.fs)]
        # 한 번 클릭으로 .fs 로 저장한다.
        ts = time.strftime("%y%m%d_%H%M%S")
        out_path = out_dir / f"{ai_path.stem}_{ts}.ai"
        pdf_path = out_dir / f"{ai_path.stem}_{ts}.pdf"

        if not process_ai_to_v8(ai_app, ai_path, out_path, pdf_path, qr_js_matrix,
                                header_text, left_text, note_text):
            return None

        ui_log(f"{ai_path.name} v8/PDF 저장 완료")
        return out_path, pdf_path

    except Exception as e:
        ui_log(f"변환 실패: {e}")
        return None


_gs_path_cache: str | None | type(...) = ...  # 미탐색 sentinel: ...


def _find_ghostscript() -> str | None:
    """Ghostscript 실행파일 찾기 — PATH → 표준 설치 경로 → PDF24 번들 순서.
    한 번 찾은 결과는 모듈 캐시에 저장."""
    global _gs_path_cache
    if _gs_path_cache is not ...:
        return _gs_path_cache  # type: ignore[return-value]

    candidates: list[Path] = []
    # 1) PATH 검색
    for name in ("gswin64c.exe", "gswin32c.exe", "gs.exe"):
        try:
            r = subprocess.run(
                ["where", name], capture_output=True, text=True,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            if r.returncode == 0:
                first = r.stdout.strip().splitlines()
                if first:
                    candidates.append(Path(first[0].strip()))
        except Exception:
            pass

    # 2) 표준 설치 경로
    for base in (Path(r"C:\Program Files\gs"), Path(r"C:\Program Files (x86)\gs")):
        if base.exists():
            for sub in base.iterdir():
                if sub.is_dir():
                    for exe in ("gswin64c.exe", "gswin32c.exe"):
                        p = sub / "bin" / exe
                        if p.exists():
                            candidates.append(p)

    # 3) PDF24 번들 — 버전마다 위치가 달라서 glob 으로 탐색
    pdf24_bases = [
        Path(r"C:\Program Files\PDF24"),
        Path(r"C:\Program Files (x86)\PDF24"),
    ]
    for base in pdf24_bases:
        if base.exists():
            for exe_name in ("gs.exe", "gswin64c.exe", "gswin32c.exe"):
                for found in base.rglob(exe_name):
                    candidates.append(found)

    for c in candidates:
        if c.exists():
            _gs_path_cache = str(c)
            return _gs_path_cache

    _gs_path_cache = None
    return None


def compress_pdf_for_upload(src: Path) -> Path:
    """업로드 직전 PDF 다운샘플링. 벡터 텍스트는 유지한 채 이미지/스트림 압축.
    Ghostscript 가 없거나 압축 실패 시 원본 경로를 그대로 반환 (폴백)."""
    gs_exe = _find_ghostscript()
    if not gs_exe:
        ui_log("Ghostscript 미설치 — 원본 PDF 그대로 업로드 (압축 건너뜀)")
        return src

    # 압축본은 PRINTED_PDF_DIR 가 아닌 시스템 temp 에 쓴다.
    # 같은 폴더에 쓰면 watchdog 의 on_created 가 다시 발사돼 매칭 다이얼로그가 두 번 뜸.
    out = Path(tempfile.gettempdir()) / f"hdsign_{src.stem}.min.pdf"
    cmd = [
        gs_exe,
        "-sDEVICE=pdfwrite",
        "-dCompatibilityLevel=1.5",
        "-dPDFSETTINGS=/ebook",      # 150dpi 다운샘플링, JPEG 품질 적당, 벡터 보존
        "-dDetectDuplicateImages=true",
        "-dCompressFonts=true",
        "-dSubsetFonts=true",
        "-dNOPAUSE", "-dQUIET", "-dBATCH",
        f"-sOutputFile={out}",
        str(src),
    ]
    try:
        r = subprocess.run(
            cmd, capture_output=True, timeout=120,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        if r.returncode != 0 or not out.exists():
            ui_log(f"PDF 압축 실패(rc={r.returncode}) — 원본으로 업로드")
            return src
        # 압축이 오히려 커진 경우(이미 잘 압축된 PDF) 원본 사용
        if out.stat().st_size >= src.stat().st_size:
            try:
                out.unlink()
            except Exception:
                pass
            return src
        before_kb = src.stat().st_size // 1024
        after_kb = out.stat().st_size // 1024
        ui_log(f"PDF 압축: {before_kb}KB → {after_kb}KB ({100 - after_kb * 100 // max(before_kb, 1)}% 절감)")
        return out
    except subprocess.TimeoutExpired:
        ui_log("PDF 압축 타임아웃(120s) — 원본으로 업로드")
        return src
    except Exception as e:
        ui_log(f"PDF 압축 예외: {e} — 원본으로 업로드")
        return src


def upload_worksheet_pdf(order_number: str, pdf_path: Path,
                         content_changed: bool = False,
                         change_note: str = "") -> bool:
    """변환된 PDF를 백엔드에 업로드. 거래처 카드에 노출되는 단일 PDF로 덮어씀.
    업로드 직전 Ghostscript 로 다운샘플링해 용량을 줄인다 (텍스트는 벡터 유지).
    multipart/form-data 를 표준 라이브러리만으로 구성한다 (외부 의존성 추가 없음).

    content_changed=True 면 contentChanged=true 폼 필드를 함께 보내서 백엔드가
    "변경" 배지를 띄우게 한다. 사용자가 다이얼로그에서 [지시서 내용 변경] 분기를 골랐을 때만 True.
    change_note: 작업자가 입력한 변경 사항 텍스트. 모바일 뷰어에서 PDF 한번 탭 시 노출.
                 content_changed=True 이고 비어있지 않을 때만 폼에 포함한다(빈 문자열은 백엔드에서 클리어).
    """
    if not order_number or not pdf_path.exists():
        return False

    upload_path = compress_pdf_for_upload(pdf_path)
    cleanup_compressed = upload_path != pdf_path

    url = f"{API_BASE}/api/public/orders/{quote(order_number, safe='')}/worksheet-pdf"
    boundary = f"----hdsign{int(time.time()*1000)}"
    try:
        pdf_bytes = upload_path.read_bytes()
    except Exception as e:
        ui_log(f"PDF 읽기 실패: {e}")
        if cleanup_compressed:
            try:
                upload_path.unlink()
            except Exception:
                pass
        return False

    # contentChanged 필드는 사용자가 [지시서 내용 변경] 분기를 골랐을 때만 포함. 안 보내면 백엔드가
    # 단순 재인쇄로 간주해 worksheetUpdatedAt 갱신 안 함.
    extra_field = b""
    if content_changed:
        extra_field += (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="contentChanged"\r\n\r\n'
            f"true\r\n"
        ).encode("utf-8")
        # changeNote 는 contentChanged=true 일 때만 의미가 있다. 빈 문자열도 백엔드에서
        # null 로 저장되도록 그대로 보낸다(=내용은 바뀌었지만 별도 메모는 비움).
        note = (change_note or "").strip()
        if note:
            extra_field += (
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="changeNote"\r\n\r\n'
                f"{note}\r\n"
            ).encode("utf-8")

    file_head = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{pdf_path.name}"\r\n'
        "Content-Type: application/pdf\r\n\r\n"
    ).encode("utf-8")
    tail = f"\r\n--{boundary}--\r\n".encode("utf-8")
    body = extra_field + file_head + pdf_bytes + tail

    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    req.add_header("Content-Length", str(len(body)))
    ok = False
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            resp.read()
        ui_log(f"{order_number} PDF 업로드 완료")
        ok = True
    except urllib.error.HTTPError as e:
        ui_log(f"PDF 업로드 실패 ({e.code}): {order_number}")
    except Exception as e:
        ui_log(f"PDF 업로드 호출 실패: {e}")
    finally:
        if cleanup_compressed:
            try:
                upload_path.unlink()
            except Exception:
                pass
    return ok


def _dismiss_flexsign_alerts(main_hwnd: int) -> int:
    """FlexSign 콜드 스타트 시 뜨는 '(null) file not found or wrong.' 경고창을 닫는다.
    이 모달이 떠 있으면 메인 창이 foreground 로 못 올라오고 Ctrl+O 도 흡수돼서
    [파일 열기] 자동화가 깨진다. 메인 창과 동일 PID + class '#32770' +
    텍스트에 'file not found' 또는 '(null)' 포함인 창만 PostMessage(WM_CLOSE) 로
    닫는다 (사용자가 직접 띄운 다른 모달은 보존). 반환값은 닫은 창 수.
    """
    if not main_hwnd:
        return 0
    user32 = ctypes.windll.user32
    user32.GetWindowThreadProcessId.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32)]
    user32.GetWindowThreadProcessId.restype = ctypes.c_uint32
    user32.GetClassNameW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_int]
    user32.GetClassNameW.restype = ctypes.c_int
    user32.IsWindowVisible.argtypes = [ctypes.c_void_p]
    user32.IsWindowVisible.restype = ctypes.c_bool
    user32.PostMessageW.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p]
    user32.PostMessageW.restype = ctypes.c_bool
    user32.GetWindowTextLengthW.argtypes = [ctypes.c_void_p]
    user32.GetWindowTextLengthW.restype = ctypes.c_int
    user32.GetWindowTextW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_int]
    user32.GetWindowTextW.restype = ctypes.c_int

    pid_buf = ctypes.c_uint32(0)
    user32.GetWindowThreadProcessId(main_hwnd, ctypes.byref(pid_buf))
    target_pid = pid_buf.value
    if not target_pid:
        return 0

    WM_CLOSE = 0x0010
    WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)

    def _read_text(h) -> str:
        try:
            length = user32.GetWindowTextLengthW(h)
            if not length:
                return ""
            buf = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(h, buf, length + 1)
            return buf.value or ""
        except Exception:
            return ""

    def _gather_static_text(h) -> str:
        parts: list[str] = []
        cls_buf = ctypes.create_unicode_buffer(64)

        def _cb_child(child, _lp):
            try:
                user32.GetClassNameW(child, cls_buf, 64)
                if cls_buf.value.lower() == "static":
                    t = _read_text(child)
                    if t:
                        parts.append(t)
            except Exception:
                pass
            return True

        try:
            user32.EnumChildWindows(h, WNDENUMPROC(_cb_child), 0)
        except Exception:
            pass
        return " | ".join(parts)

    targets: list = []

    def _scan(hwnd, _lparam):
        try:
            if not user32.IsWindowVisible(hwnd):
                return True
            cls = ctypes.create_unicode_buffer(64)
            user32.GetClassNameW(hwnd, cls, 64)
            if cls.value != "#32770":
                return True
            wpid = ctypes.c_uint32(0)
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(wpid))
            if wpid.value != target_pid:
                return True
            combined = (_read_text(hwnd) + " " + _gather_static_text(hwnd)).lower()
            if "file not found" in combined or "(null)" in combined:
                targets.append(hwnd)
        except Exception:
            pass
        return True

    try:
        user32.EnumWindows(WNDENUMPROC(_scan), 0)
    except Exception:
        return 0

    closed = 0
    for h in targets[:10]:  # 안전망 — 비정상적으로 많이 매치되면 컷오프
        try:
            if user32.PostMessageW(h, WM_CLOSE, None, None):
                closed += 1
        except Exception:
            pass
    return closed


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


def _open_file_via_menu(hwnd: int, file_path: Path) -> bool:
    """FlexSign 창에 [파일 → 열기] 메뉴를 키보드로 시뮬레이션해 .ai 를
    untitled .fs 도큐먼트로 임포트시킨다. 드래그앤드롭 방식은 .ai 도큐먼트로
    잡혀 [Save] 시 .ai 로 저장되지만, [Open] 메뉴로 열면 새 .fs 로 잡혀
    [Save] 한 번이면 .fs 로 저장된다.
    동작 순서: 창 활성화 → Ctrl+O → (다이얼로그) 클립보드에 경로 복사 → Ctrl+V → Enter.
    """
    try:
        import win32api
        import win32clipboard
    except Exception as e:
        ui_log(f"win32 모듈 로드 실패: {e}")
        return False

    user32 = ctypes.windll.user32
    VK_CONTROL = 0x11
    VK_RETURN = 0x0D
    VK_MENU = 0x12  # Alt
    KEYEVENTF_KEYUP = 0x0002

    def _press(vk: int) -> None:
        win32api.keybd_event(vk, 0, 0, 0)
        win32api.keybd_event(vk, 0, KEYEVENTF_KEYUP, 0)

    def _chord(modifier: int, key: int) -> None:
        win32api.keybd_event(modifier, 0, 0, 0)
        _press(key)
        win32api.keybd_event(modifier, 0, KEYEVENTF_KEYUP, 0)

    def _force_foreground() -> bool:
        """Windows foreground stealing 보호 우회 + 검증.
        Alt 토글로 SetForegroundWindow 차단 해제 → 호출 → 실제 활성화 확인.
        가짜로 다른 창에 키 보내는 것을 방지하기 위해 검증 단계가 핵심."""
        if user32.IsIconic(hwnd):
            user32.ShowWindow(hwnd, 9)  # SW_RESTORE
            time.sleep(0.2)
        for _ in range(3):
            # Alt 키 1회 토글 → OS 의 foreground 잠금 해제 트릭
            win32api.keybd_event(VK_MENU, 0, 0, 0)
            win32api.keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0)
            try:
                user32.BringWindowToTop(hwnd)
                user32.SetForegroundWindow(hwnd)
            except Exception:
                pass
            time.sleep(0.3)
            if user32.GetForegroundWindow() == hwnd:
                return True
            time.sleep(0.25)
        return False

    def _wait_for_open_dialog(timeout: float = 3.0) -> int:
        """Ctrl+O 가 메뉴 단축키로 인식되면 표준 파일 열기 다이얼로그(class "#32770")가
        떠서 foreground 를 가져간다. 이 검증 없이 그냥 sleep 후 Ctrl+V 를 보내면
        Ctrl+O 가 캔버스에 흡수된 경우 경로 텍스트가 캔버스에 그대로 붙는 사고가 난다.
        다이얼로그 hwnd 를 반환하거나, 시간 안에 안 나타나면 0 을 반환해 호출자가 중단."""
        end = time.time() + timeout
        buf = ctypes.create_unicode_buffer(64)
        while time.time() < end:
            fg = user32.GetForegroundWindow()
            if fg and fg != hwnd:
                user32.GetClassNameW(fg, buf, 64)
                if buf.value == "#32770":
                    return fg
            time.sleep(0.12)
        return 0

    # 클립보드 백업 (사용자가 다른 데서 쓰던 내용 복원하기 위함)
    prev_clip = ""
    try:
        win32clipboard.OpenClipboard()
        try:
            if win32clipboard.IsClipboardFormatAvailable(13):  # CF_UNICODETEXT
                prev_clip = win32clipboard.GetClipboardData(13) or ""
        finally:
            win32clipboard.CloseClipboard()
    except Exception:
        prev_clip = ""

    try:
        # 0) FlexSign 콜드 스타트 직후의 '(null) file not found or wrong.' 모달 두 개를
        #    선제로 닫는다. 떠 있으면 메인 창이 foreground 로 못 올라오고 Ctrl+O 도
        #    흡수돼 자동화가 깨진다. 두 번째 모달이 늦게 뜨는 케이스 대비 한 번 더 시도.
        dismissed = _dismiss_flexsign_alerts(hwnd)
        if dismissed:
            ui_log(f"FlexSign 시작 경고창 {dismissed}개 자동 닫음")
            time.sleep(0.5)
            extra = _dismiss_flexsign_alerts(hwnd)
            if extra:
                ui_log(f"FlexSign 시작 경고창 {extra}개 추가 닫음")
                time.sleep(0.4)

        # 1) 창 활성화 보장 — 검증까지 통과해야 키 입력을 시작한다.
        if not _force_foreground():
            ui_log("FlexSign 창을 foreground 로 가져오지 못함 — 메뉴 자동화 중단")
            return False
        time.sleep(0.4)

        # 2) Ctrl+O — 파일 열기 다이얼로그. 다이얼로그가 실제로 떴는지 폴링해서
        # 확인한다. 캔버스/도구에 포커스가 있어 단축키가 흡수된 케이스를 방지.
        # 한 번 실패하면 캔버스 클릭 같은 다른 이벤트 없이 한 번 더 재시도.
        dlg_hwnd = 0
        for attempt in range(2):
            _chord(VK_CONTROL, ord('O'))
            dlg_hwnd = _wait_for_open_dialog(timeout=3.0)
            if dlg_hwnd:
                break
            ui_log(f"Ctrl+O 후 다이얼로그 미감지 — 재시도 {attempt + 1}/2")
            # 재시도 전에 메인 창에 다시 foreground 보장
            if not _force_foreground():
                break
            time.sleep(0.4)
        if not dlg_hwnd:
            ui_log("파일 열기 다이얼로그가 끝내 나타나지 않음 — 캔버스 오입력 방지를 위해 중단")
            return False

        # 다이얼로그가 이미 foreground 이지만, 다이얼로그 안의 파일이름 입력칸에
        # 키 입력이 정확히 가도록 한 번 더 명시.
        try:
            user32.SetForegroundWindow(dlg_hwnd)
        except Exception:
            pass
        time.sleep(0.25)

        # 3) 파일 경로를 클립보드에 복사 후 Ctrl+V
        # 절대경로는 따옴표로 감싸야 다이얼로그 시작 폴더와 무관하게 그 파일로 직행한다.
        # 미감싼 경로는 공백/한글이 섞이면 옛날 #32770 다이얼로그(FlexSign 6.6 등)가
        # 토큰을 분리해 검색하려다 "파일 없음" 으로 실패하는 케이스가 있다.
        clip_path = f'"{file_path}"'
        win32clipboard.OpenClipboard()
        try:
            win32clipboard.EmptyClipboard()
            win32clipboard.SetClipboardText(clip_path, 13)  # CF_UNICODETEXT
        finally:
            win32clipboard.CloseClipboard()
        time.sleep(0.3)
        _chord(VK_CONTROL, ord('V'))
        # 긴 한글 경로를 다이얼로그가 해석하는 데 시간 필요.
        time.sleep(0.5)

        # 4) Enter — 열기 확정
        _press(VK_RETURN)
        time.sleep(0.7)
        return True
    except Exception as e:
        ui_log(f"FlexSign 메뉴 열기 실패: {e}")
        return False
    finally:
        # 클립보드 원복
        try:
            win32clipboard.OpenClipboard()
            try:
                win32clipboard.EmptyClipboard()
                if prev_clip:
                    win32clipboard.SetClipboardText(prev_clip, 13)
            finally:
                win32clipboard.CloseClipboard()
        except Exception:
            pass


def launch_flexsign(file_path: Path):
    ui_log(f"FlexSign 전달 시도: {file_path.name}")
    hwnd = 0
    try:
        hwnd = _find_flexsign_hwnd()
    except Exception as e:
        ui_log(f"FlexSign 창 검색 실패: {e}")

    # FlexSign 창이 없으면 워처가 자동으로 띄운다. 이때 명령행 인자로 file_path 를
    # 넘기면 .ai 도큐먼트로 잡혀 .fs 저장이 안 되므로, 빈 인스턴스로만 띄우고
    # 창이 뜨면 그 위에 [파일 → 열기] 시뮬레이션을 적용한다.
    if not hwnd:
        if not Path(FLEXSIGN_EXE).exists():
            ui_log(f"FlexSign 실행파일을 찾을 수 없습니다: {FLEXSIGN_EXE}")
            return
        try:
            subprocess.Popen([FLEXSIGN_EXE])
            ui_log("FlexSign 자동 실행 — 창 뜰 때까지 대기")
        except Exception as e:
            ui_log(f"FlexSign 실행 실패: {e}")
            return
        # 창 뜨길 polling (최대 ~30초)
        for _ in range(60):
            time.sleep(0.5)
            try:
                hwnd = _find_flexsign_hwnd()
            except Exception:
                hwnd = 0
            if hwnd:
                break
        if not hwnd:
            ui_log("FlexSign 창을 찾지 못함 — 수동으로 파일을 열어주세요")
            return
        # 창이 막 떠서 메뉴/단축키가 안정화될 때까지 잠시 더 기다림
        time.sleep(1.5)

    # FlexSign 인쇄 다이얼로그가 PDF24 를 자동 선택하도록 기본 프린터를 임시 전환.
    # 인쇄 PDF 가 PRINTED_PDF_DIR 에 떨어지면 _process_printed_pdf 시작부에서
    # restore_default_printer() 가 원래(삼성) 프린터로 즉시 복구한다.
    switch_default_to_pdf24()

    ui_log(f"FlexSign 창(HWND={hwnd}) — [파일 → 열기] 시뮬레이션")
    ok = _open_file_via_menu(hwnd, file_path)
    if ok:
        ui_log(f"FlexSign에 전달 완료: {file_path.name}")
        return

    # 메뉴 자동화 실패 시 fallback — .ai 도큐먼트로 잡히지만 화면 표시는 됨.
    ui_log("메뉴 열기 실패 — 드롭 방식으로 폴백")
    try:
        ok2 = _post_drop_files(hwnd, str(file_path))
    except Exception as e:
        ui_log(f"드롭 메시지 실패: {e}")
        ok2 = False
    if ok2:
        try:
            if ctypes.windll.user32.IsIconic(hwnd):
                ctypes.windll.user32.ShowWindow(hwnd, 9)
            ctypes.windll.user32.SetForegroundWindow(hwnd)
        except Exception:
            pass
        ui_log(f"FlexSign에 드롭 전달: {file_path.name}")
    else:
        ui_log(f"드롭 실패 — 수동으로 파일을 열어주세요: {file_path}")


# ── ZIP processing ────────────────────────────────────────────────────────────

def process_zip(zip_path: Path):
    key = str(zip_path.resolve())
    with _seen_lock:
        if key in _seen_zips:
            return
        _seen_zips.add(key)

    # 작업 시작 전에 Illustrator/FlexSign 모두 실행 중인지 확인.
    # 둘 중 하나라도 없으면 ai→fs 자동화가 깨지므로(콜드 부팅된 FlexSign은
    # 도큐먼트 인식이 불안정) 처리 상태로 넘어가지 않고 사용자에게 안내한 뒤,
    # ZIP 을 그대로 두고 _seen_zips 에서 빼서 재시도(같은 파일 재저장 또는
    # 어드민에서 다시 받기)할 수 있게 한다.
    missing = missing_required_apps()
    if missing:
        apps = ", ".join(missing)
        ui_log(f"{zip_path.name} 처리 보류 — 미실행: {apps}")
        ui_alert(
            "프로그램 실행 필요",
            f"아래 프로그램이 실행 중이 아닙니다:\n\n  • " + "\n  • ".join(missing)
            + "\n\n먼저 실행한 뒤 어드민에서 [지시서 작성하기] 를 다시 눌러주세요.",
        )
        _seen_zips.discard(key)
        return

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

    # 헤더-only 모드 — 자동지시서작성 실패 시 폴백. 거래처 원본을 다시 열지 않고
    # 빈 캔버스에 헤더(QR + 박스 + 좌측텍스트 + 노트박스)만 그려 FlexSign 에 띄운다.
    # 사용자는 그 헤더를 복사해 거래처 원본 캔버스에 붙여 인쇄 → PDF24 흐름으로 진입.
    if meta.get("headerOnly"):
        qr_js = qr_matrix_js(EVIDENCE_URL_BASE + quote(order_number, safe=""))
        out = convert_header_only(order_number, qr_js,
                                  header_text, left_text, note_text)
        if out:
            launch_flexsign(out)
            # 인쇄 매칭 큐에 등록 — 사용자가 PDF24 로 인쇄하면 자동지시서작성 흐름과 동일하게
            # 다이얼로그가 떠서 이 주문에 매칭. acknowledged 호출 X (이미 IN_PROGRESS).
            delivery_ko = (meta.get("deliveryMethod") or "").strip()
            delivery_enum = DELIVERY_KO_TO_ENUM.get(delivery_ko, "")
            remember_order_for_print(
                order_number, company,
                (str(meta.get("dueDate")).split("T")[0] if meta.get("dueDate") else ""),
                delivery_enum,
            )
        # JSON 만 들어 있는 ZIP 이라 추출 폴더는 그대로 청소.
        try:
            shutil.rmtree(str(temp_dir), ignore_errors=True)
        except Exception:
            pass
        DONE_DIR.mkdir(exist_ok=True)
        dest = DONE_DIR / zip_path.name
        if dest.exists():
            dest.unlink()
        shutil.move(str(zip_path), str(dest))
        ui_status("watching", "지시서가 도착하면 자동으로 열어드립니다")
        return

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
    # 네트워크 거래처 폴더로 모두 복사됐는지 추적 — 모두 성공한 경우만 추출 폴더 청소.
    # 한 건이라도 실패하면 원본을 추출 폴더에 남겨 사용자가 수동 복구 가능하게.
    all_network_ok = True
    if not ai_files:
        ui_log(f"{order_number}: AI 파일 없음 — 확인 필요")
    else:
        # 한 주문의 모든 .ai 를 같은 폴더에 묶기 위해 첫 파일 기준으로 폴더를 한 번만 결정.
        primary_ai_name = ai_files[0].name
        network_order_folder = resolve_network_order_folder(meta, primary_ai_name)
        if network_order_folder is None:
            all_network_ok = False
        for ai_file in ai_files:
            converted = convert_ai_file(Path(ai_file), qr_js,
                                        header_text, left_text, note_text)
            if converted:
                ai_out, _pdf_out = converted
                # 네트워크 거래처/주문 폴더에 원본 + v8 복사. 성공 시 그 v8 경로를
                # FlexSign 에 열어주면 [Save .fs] 가 같은 폴더에 자동으로 떨어진다.
                # 실패 시 None — 로컬 converted/ v8 로 폴백.
                network_v8 = None
                if network_order_folder is not None:
                    network_v8 = copy_ai_pair_to_network(network_order_folder,
                                                         Path(ai_file), ai_out)
                    if network_v8 is None:
                        all_network_ok = False
                flex_target = network_v8 if network_v8 is not None else ai_out
                launch_flexsign(flex_target)
                any_converted = True
            else:
                all_network_ok = False

    if any_converted:
        notify_worksheet_acknowledged(order_number)
        # 거래처 작업현황에 노출되는 지시서 PDF 는 "완성본" 만 보여야 한다.
        # 즉, 직원이 FlexSign에서 [인쇄] 를 눌러 PRINTED_PDF_DIR 에 PDF 가 떨어진
        # 시점에 _process_printed_pdf 가 업로드한다.
        # 여기서(자동작성 직후)는 아직 작업 전 시안이므로 절대 업로드하지 않는다.
        # 인쇄 PDF 가 떨어지면 매칭할 수 있도록 큐에 등록.
        delivery_ko = (meta.get("deliveryMethod") or "").strip()
        delivery_enum = DELIVERY_KO_TO_ENUM.get(delivery_ko, "")
        # 인쇄 매칭 다이얼로그 [신규 작성] 탭에서 표시할 원본 파일명. 다중 .ai 면 첫 파일 기준.
        primary_name = ai_files[0].name if ai_files else ""
        remember_order_for_print(
            order_number,
            company,
            (str(meta.get("dueDate")).split("T")[0] if meta.get("dueDate") else ""),
            delivery_enum,
            primary_name,
        )

    DONE_DIR.mkdir(exist_ok=True)
    dest = DONE_DIR / zip_path.name
    if dest.exists():
        dest.unlink()
    shutil.move(str(zip_path), str(dest))

    # 모든 변환 + 네트워크 복사가 성공하면 추출 폴더 청소 — 원본은 네트워크에
    # 보관되었으니 로컬에 잔류시킬 이유가 없다. 한 건이라도 실패하면 보존(수동 복구용).
    if any_converted and all_network_ok:
        try:
            shutil.rmtree(str(extract_dir), ignore_errors=True)
        except Exception:
            pass

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

        # Action row — 거래처 폴더 목록을 즉시 백엔드에 동기화 (관리자 모달 자동완성 용도)
        act = tk.Frame(self._card, bg=self.CARD)
        act.pack(fill="x", padx=24, pady=(12, 0))
        sync_btn = tk.Button(
            act, text="거래처 폴더 동기화",
            bg="#f4f4f5", fg="#3f3f46",
            activebackground="#e4e4e7",
            font=("맑은 고딕", 9),
            relief="flat", bd=0, highlightthickness=0,
            cursor="hand2", padx=12, pady=6,
            command=trigger_folder_sync_async,
        )
        sync_btn.pack(side="left")
        change_btn = tk.Button(
            act, text="추적 폴더 변경",
            bg="#f4f4f5", fg="#3f3f46",
            activebackground="#e4e4e7",
            font=("맑은 고딕", 9),
            relief="flat", bd=0, highlightthickness=0,
            cursor="hand2", padx=12, pady=6,
            command=change_tracked_folder_async,
        )
        change_btn.pack(side="left", padx=(8, 0))

        # 현재 추적 경로를 작게 표시 — 매년 1월 폴더 옮긴 후 사장님이 확인 용도.
        self._tracked_lbl = tk.Label(
            self._card, text="", bg=self.CARD, fg="#a1a1aa",
            font=("맑은 고딕", 8), anchor="w", justify="left",
            wraplength=360,
        )
        self._tracked_lbl.pack(fill="x", padx=24, pady=(6, 0))
        self._refresh_tracked_label()

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

    def _refresh_tracked_label(self):
        """현재 추적 경로 라벨 갱신. config.json 미설정이면 안내 문구."""
        path = get_current_tracked_base()
        if path:
            self._tracked_lbl.config(text=f"추적 중: {path}")
        else:
            self._tracked_lbl.config(text="추적 폴더 미설정 — [추적 폴더 변경]으로 지정해주세요.")

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
                elif item[0] == "refresh_tracked":
                    self.after(0, self._refresh_tracked_label)
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

            # 이전 세션의 인쇄 매칭 큐 복구 — 워처가 잠깐 꺼졌다 켜져도 다이얼로그가 뜨도록.
            load_recent_orders()

            for existing in WATCH_DIR.glob("*_지시서.zip"):
                threading.Thread(target=process_zip, args=(existing,), daemon=True).start()

            self._observer = Observer()
            self._observer.schedule(ZipHandler(WATCH_DIR), str(WATCH_DIR), recursive=False)
            self._observer.schedule(ZipHandler(DOWNLOADS_DIR), str(DOWNLOADS_DIR), recursive=False)
            # 무인 PDF 프린터(Bullzip 등)가 떨어뜨리는 인쇄 PDF 감시.
            self._observer.schedule(PrintedPdfHandler(), str(PRINTED_PDF_DIR), recursive=False)
            self._observer.start()

            start_ping_server()

            # 거래처 폴더 목록을 백엔드에 주기적으로 푸시 — 관리자 모달 자동완성용.
            start_folder_sync_loop()

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
