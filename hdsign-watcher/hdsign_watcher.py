# hdsign_watcher.py
# GUI watcher for HD Sign worksheet automation
# Dependencies: pip install watchdog qrcode[pil] Pillow pywin32

from __future__ import annotations

import collections
import ctypes
import encodings.idna  # PyInstaller onefile: keep HTTPS host-name codec available.
import json
import os
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
import uuid
try:
    import winsound  # Windows 표준 — 새 주문 알림음 재생. 다른 OS 에서 import 단계에서 죽지 않게 가드.
except Exception:
    winsound = None  # type: ignore
from datetime import date, timedelta
from tkinter import filedialog, messagebox, ttk
import io
import ssl
import urllib.error
import urllib.request
import zipfile

# ── SSL: certifi 번들로 검증 ───────────────────────────────────────────────
# 사장님 노트북은 윈도우 인증서 저장소가 최신이라 default https context 로도 통하지만,
# 다른 사무실 PC(Windows Update 안 돌린 상태) 는 Railway HTTPS 체인의 루트/중간 CA 가
# 없거나 frozen Python 의 ssl 이 윈도우 store + AIA 페치를 제대로 못 함.
# → certifi 번들을 default https context 로 박아 모든 urlopen 호출이 통과되도록 한다.
# (개별 urlopen 에 context= 를 다 붙이는 대신 default 만 갈아끼움 — 13개 호출 + 미래 호출 자동 적용)
try:
    import certifi
    _CERTIFI_PATH = certifi.where()
    def _certifi_https_context() -> ssl.SSLContext:
        return ssl.create_default_context(cafile=_CERTIFI_PATH)
    ssl._create_default_https_context = _certifi_https_context  # type: ignore[attr-defined]
except Exception:  # noqa: BLE001 — certifi 미설치/번들 누락 시 시스템 인증서로 폴백
    pass
from http.server import BaseHTTPRequestHandler, HTTPServer

import easyform  # 이지폼 자동기입(명세서 → 이지폼 셀 자동입력). 워처가 호스트(같은 프로세스).
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
from PIL import Image, ImageTk, ImageOps, ImageFilter
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
    try:
        from pyzbar.pyzbar import ZBarSymbol as _ZBarSymbol  # type: ignore
        _ZBAR_QR_ONLY = [_ZBarSymbol.QRCODE]
    except Exception:
        _ZBAR_QR_ONLY = None  # 구버전 pyzbar — 심볼 제한 없이 호출
except Exception:
    pyzbar_decode = None  # type: ignore
    _ZBAR_QR_ONLY = None  # type: ignore

# OpenCV — zbar(pyzbar) 와 다른 알고리즘이라 한쪽이 놓친 QR 을 다른 쪽이 잡는 경우가 흔하다.
# 인쇄→PDF24→재디코드 경로에서 셀이 뭉개진 QR 보강용. 없으면 조용히 건너뜀(번들 필수 아님).
try:
    import cv2  # type: ignore
    import numpy as _np  # type: ignore
except Exception:
    cv2 = None  # type: ignore
    _np = None  # type: ignore

# 사무실 PC 마다 Windows 계정명이 다르므로 Path.home() 으로 동적으로 결정.
# 어떤 계정에서 실행해도 그 사람 바탕화면 아래 hdsign_orders 폴더가 만들어진다.
WATCH_DIR = Path.home() / "Desktop" / "hdsign_orders"
DOWNLOADS_DIR = Path.home() / "Downloads"
DONE_DIR = WATCH_DIR / "done"
# PDF24(또는 다른 무인 PDF 프린터) 가 인쇄 PDF 를 떨어뜨리는 폴더.
# PDF24 자동 저장 프로파일에서 저장 폴더를 이 경로로, "저장 시 대화상자" 끄기.
PRINTED_PDF_DIR = WATCH_DIR / "printed"

# FlexSign 실행파일 위치는 PC 마다 다르므로 자동 탐색 + config.json 우선 정책.
# 1순위: config.json 의 flexsign_exe (사용자가 GUI [FlexSign 위치 지정] 으로 직접 지정)
# 2순위: 아래 후보 경로에서 첫 발견 — 보통의 FlexSign 설치 위치들.
# 못 찾으면 launch_flexsign() 이 안내 메시지 + GUI 버튼으로 위치 지정을 유도.
FLEXSIGN_PATH_CANDIDATES = [
    Path.home() / "Desktop" / "FlexiSIGN 6.6" / "Program" / "App.exe",
    Path("C:/Program Files/SAi/FlexiSIGN 6.6/Program/App.exe"),
    Path("C:/Program Files (x86)/SAi/FlexiSIGN 6.6/Program/App.exe"),
    Path("C:/FlexiSIGN 6.6/Program/App.exe"),
]


def find_flexsign_exe() -> str | None:
    """FlexSign 실행파일 경로 탐색. config.json 우선, 없으면 기본 후보 스캔.
    찾으면 절대경로 문자열 반환, 못 찾으면 None."""
    cfg = _load_config()
    cfg_path = (cfg.get("flexsign_exe") or "").strip()
    if cfg_path and Path(cfg_path).exists():
        return cfg_path
    for candidate in FLEXSIGN_PATH_CANDIDATES:
        try:
            if candidate.exists():
                return str(candidate)
        except Exception:
            continue
    return None


def _runtime_dir() -> Path:
    """워처 본체가 위치한 폴더. PyInstaller 빌드면 sys.executable 옆, .py 직접 실행이면 스크립트 폴더.
    SumatraPDF 처럼 워처와 같이 배포되는 포터블 도구를 찾을 때 기준점."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def find_sumatra_exe() -> str | None:
    """SumatraPDF 실행파일 경로 탐색.
    1순위: config.json 의 sumatra_exe (사용자 직접 지정)
    2순위: 워처 exe 옆에 같이 배포된 포터블 (SumatraPDF.exe / sumatra/SumatraPDF.exe)
    3순위: 일반 설치 위치 (Program Files)
    못 찾으면 None — 호출자가 ShellExecute 폴백.
    """
    cfg = _load_config()
    cfg_path = (cfg.get("sumatra_exe") or "").strip()
    if cfg_path and Path(cfg_path).exists():
        return cfg_path
    rt = _runtime_dir()
    candidates = [
        rt / "SumatraPDF.exe",
        rt / "sumatra" / "SumatraPDF.exe",
        rt / "sumatra" / "SumatraPDF-64.exe",
        Path("C:/Program Files/SumatraPDF/SumatraPDF.exe"),
        Path("C:/Program Files (x86)/SumatraPDF/SumatraPDF.exe"),
    ]
    for c in candidates:
        try:
            if c.exists():
                return str(c)
        except Exception:
            continue
    return None
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
# 분배함 사진은 hdsign-watcher/assets/distribution.jpg (실제 사진 3510x5613).
# 좌표는 (left, top, right, bottom) — 사진 원본 픽셀 좌표 기준. 다이얼로그에서 표시할 때
# 비율 유지로 축소하면서 클릭 좌표를 원본 픽셀 좌표로 역변환해 어떤 칸인지 판정한다.
#
# 좌표가 실제 사진과 어긋나면 빌드 후 여기 숫자만 조정하면 됨. 칸 라벨 옆 mapped_dept 가
# 빈 문자열인 칸은 비활성 — 모든 칸을 사용한다면 mapped_dept 만 채워주면 즉시 클릭 가능.
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
    ("배송2팀", "배송팀", (2509, 3444, 3300, 4460)),
    ("홍철웅팀장", "완조립부", (232, 4533, 967, 5480)),
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


# Windows 파일명 금지문자 + 제어문자. PDF24 가 출력 파일명을 도큐먼트 제목에서 가져가는데
# 거래처 AI 파일명에 이런 문자가 섞여 있으면 PDF24 가 ErrorCode=123 (ERROR_INVALID_NAME) 으로 실패.
# 끝 공백·점도 Windows 가 허용 안 함. 길이도 NTFS 컴포넌트 한계(255) 보다 훨씬 보수적으로 80 자로 제한.
_BAD_FILENAME_CHARS_RE = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def safe_filename_stem(stem: str, max_len: int = 80) -> str:
    """Windows / PDF24 안전 파일명(stem) 생성. 비어 있거나 모두 잘려나가면 'file' 폴백."""
    s = _BAD_FILENAME_CHARS_RE.sub("_", stem)
    s = s.strip().rstrip(". ")
    if len(s) > max_len:
        s = s[:max_len].rstrip(". ")
    return s if s else "file"


# ── UI helpers (thread-safe) ────────────────────────────────────────────────

def ui_log(msg: str):
    _ui_queue.put(("log", msg))


def ui_status(state: str, detail: str = ""):
    _ui_queue.put(("status", state, detail))


def ui_alert(title: str, message: str):
    _ui_queue.put(("alert", title, message))


# ── 도장/창식별 진단 로그(디스크) ─────────────────────────────────────────────
# 화면 로그(ui_log)는 Tk Text 7줄만 보여주고 사라져 사후 추적이 안 된다. 인쇄 때 .fs 식별·
# UID 도장 결과/사유를 %LOCALAPPDATA%\HDSignWorksheet\stamp.log 에 영구 기록해, "어느 PC가
# 왜 도장을 못 찍었는지"(창 제목에 .fs 없음 / 후보 0건 / 모호 N건 등)를 로그만 보고 판정한다.
# 현장 에이전트의 agent.log 와 같은 패턴. 어떤 실패도 인쇄 흐름엔 영향 주지 않는다.
_DIAG_LOG_PATH: Path | None = None


def _diag_log_path() -> Path:
    global _DIAG_LOG_PATH
    if _DIAG_LOG_PATH is None:
        base = os.environ.get("LOCALAPPDATA") or os.environ.get("TEMP") or tempfile.gettempdir()
        d = Path(base) / "HDSignWorksheet"
        try:
            d.mkdir(parents=True, exist_ok=True)
        except Exception:
            d = Path(base)
        _DIAG_LOG_PATH = d / "stamp.log"
    return _DIAG_LOG_PATH


def _diag_log(msg: str) -> None:
    """진단 한 줄을 디스크 로그에 append. 1MB 넘으면 비우고 다시 시작. 실패는 조용히 무시."""
    try:
        p = _diag_log_path()
        try:
            if p.exists() and p.stat().st_size > 1_000_000:
                p.write_text("", encoding="utf-8")
        except Exception:
            pass
        with open(p, "a", encoding="utf-8") as f:
            f.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n")
    except Exception:
        pass


def _stamp_log(msg: str) -> None:
    """화면(ui_log) + 디스크(_diag_log) 양쪽에 남긴다 — 도장/창식별 진단 전용."""
    ui_log(msg)
    _diag_log(msg)


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
    ok, message = check_illustrator_com_ready()
    if not ok:
        ctypes.windll.user32.MessageBoxW(
            0,
            message,
            "HD사인 지시서 프로그램 - Illustrator 연결 실패",
            0x30,  # MB_ICONWARNING
        )
        return False
    return True


# ── QR & formatting ──────────────────────────────────────────────────────────

def qr_matrix_js(url: str) -> str:
    """
    URL을 인코딩한 QR 매트릭스를 JS 2차원 배열 리터럴 문자열로 반환.
    Illustrator ExtendScript에서 각 검은 모듈을 사각형 path로 그리는 데 사용.
    ERROR_CORRECT_Q(25%) — 자동작성 지시서의 QR 도 FlexSign→PDF24 인쇄 후 다시 디코드되므로
    qr_to_clipboard 와 동일하게 오류정정을 올려 셀 경계가 뭉개져도 복원 여지를 키운다.
    """
    qr = qrcode.QRCode(
        error_correction=qrcode.constants.ERROR_CORRECT_Q,
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


def qr_to_clipboard(order_number: str) -> None:
    """수동 작성 지시서용 — QR(주문 추적 URL) + 주문번호 텍스트를 EMF 로 빌드해
    Windows 클립보드에 CF_ENHMETAFILE 로 올린다. 사용자가 FlexSign 에서 Ctrl+V 하면
    Illustrator → FlexSign 클립보드 경로와 동일하게 벡터로 들어옴.

    자동지시서작성/QR재생성 과 달리 .ai 파일도 만들지 않고 FlexSign 도 띄우지 않는다 —
    "이미 거래처 .fs 를 손으로 그려놓은 상태에서 QR 만 한 덩어리 붙이고 싶다" 가 유스케이스.
    """
    if not order_number:
        raise ValueError("order_number 비어 있음")

    # 자동지시서/헤더-only 와 동일한 추적 URL — QR 코드 한 개로 흐름이 어느 경로로 들어와도 같은
    # /p/{orderNumber} 모바일 카메라 페이지로 이어진다.
    url = EVIDENCE_URL_BASE + quote(order_number, safe="")
    # ERROR_CORRECT_Q(25%) — M(15%) 에서 올림. FlexSign→PDF24 렌더 + (작업자가 캔버스에서
    # 축소) 과정에서 셀 경계가 뭉개져도 pyzbar 가 복원할 여지를 키운다. URL 이 짧아 버전은
    # 여전히 낮게 유지되므로 셀이 과하게 작아지지 않는다.
    qr = qrcode.QRCode(
        error_correction=qrcode.constants.ERROR_CORRECT_Q,
        box_size=1, border=2,
    )
    qr.add_data(url)
    qr.make()
    matrix = qr.get_matrix()
    n = len(matrix)
    if n == 0:
        raise RuntimeError("QR 매트릭스 비어 있음")

    # 물리 크기 (HIMETRIC, 1 = 0.01mm) — 정사각형. FlexSign 이 EMF 를 자기 기본 박스(1:1)에
    # non-uniform 으로 늘려 붙이는 경우가 있어 비정사각 캔버스는 QR 셀까지 직사각형이 됨.
    # 캔버스를 정사각으로 만들고 그 안에 QR + 주문번호 둘 다 배치하면 어떤 스케일링에도
    # QR 셀은 정사각으로 유지된다.
    # 80mm — 60mm 도 인쇄 후 축소되면 pyzbar 가 셀 격자를 놓치는 사례가 있어 첫 붙여넣기
    # 사이즈를 더 키운다. 작업자가 FlexSign 에서 더 크게/작게 줄여 쓸 수 있지만, 기본값이
    # 클수록 인쇄→PDF24→재디코드 경로에서 모듈 픽셀 수가 넉넉해진다.
    total_w = 8000  # 80mm
    total_h = 8000  # 80mm

    # 내부 logical 좌표 — 1000 × 1000 정사각 그리드.
    grid_w = 1000
    grid_h = 1000
    # QR 영역: 위쪽 800 px(80%) 정사각형. 좌우 가운데 정렬.
    qr_box_size = 800
    qr_box_left = (grid_w - qr_box_size) // 2  # 100
    qr_box_top = 30                              # 위 약간 여백
    # 주문번호 텍스트 영역: QR 아래.
    text_band_h = 130
    text_top = qr_box_top + qr_box_size + 20  # 850

    gdi32 = ctypes.windll.gdi32
    user32 = ctypes.windll.user32

    # 64-bit Windows 에서 HDC/HGDIOBJ/HENHMETAFILE 은 모두 8바이트 포인터.
    # ctypes 기본 c_int (4바이트) 로 처리되면 핸들이 잘려 SelectObject/CloseEMF 가 실패함.
    # 사용하는 함수 전부에 argtypes/restype 명시.
    HDC = ctypes.c_void_p
    HGDIOBJ = ctypes.c_void_p
    HENHMETAFILE = ctypes.c_void_p
    HFONT = ctypes.c_void_p

    class RECT(ctypes.Structure):
        _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                    ("right", ctypes.c_long), ("bottom", ctypes.c_long)]

    user32.GetDC.argtypes = [ctypes.c_void_p]
    user32.GetDC.restype = HDC
    user32.ReleaseDC.argtypes = [ctypes.c_void_p, HDC]
    user32.ReleaseDC.restype = ctypes.c_int

    gdi32.CreateEnhMetaFileW.argtypes = [HDC, ctypes.c_wchar_p, ctypes.POINTER(RECT), ctypes.c_wchar_p]
    gdi32.CreateEnhMetaFileW.restype = HDC
    gdi32.CloseEnhMetaFile.argtypes = [HDC]
    gdi32.CloseEnhMetaFile.restype = HENHMETAFILE
    gdi32.DeleteEnhMetaFile.argtypes = [HENHMETAFILE]
    gdi32.DeleteEnhMetaFile.restype = ctypes.c_int

    gdi32.GetStockObject.argtypes = [ctypes.c_int]
    gdi32.GetStockObject.restype = HGDIOBJ
    gdi32.SelectObject.argtypes = [HDC, HGDIOBJ]
    gdi32.SelectObject.restype = HGDIOBJ
    gdi32.DeleteObject.argtypes = [HGDIOBJ]
    gdi32.DeleteObject.restype = ctypes.c_int

    gdi32.Rectangle.argtypes = [HDC, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int]
    gdi32.Rectangle.restype = ctypes.c_int

    gdi32.CreateFontW.argtypes = [
        ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
        ctypes.c_uint, ctypes.c_uint, ctypes.c_uint, ctypes.c_uint, ctypes.c_uint,
        ctypes.c_uint, ctypes.c_uint, ctypes.c_uint, ctypes.c_wchar_p,
    ]
    gdi32.CreateFontW.restype = HFONT

    gdi32.SetTextAlign.argtypes = [HDC, ctypes.c_uint]
    gdi32.SetTextAlign.restype = ctypes.c_uint
    gdi32.SetTextColor.argtypes = [HDC, ctypes.c_uint]
    gdi32.SetTextColor.restype = ctypes.c_uint
    gdi32.SetBkMode.argtypes = [HDC, ctypes.c_int]
    gdi32.SetBkMode.restype = ctypes.c_int
    gdi32.BeginPath.argtypes = [HDC]
    gdi32.BeginPath.restype = ctypes.c_int
    gdi32.EndPath.argtypes = [HDC]
    gdi32.EndPath.restype = ctypes.c_int
    gdi32.FillPath.argtypes = [HDC]
    gdi32.FillPath.restype = ctypes.c_int
    gdi32.ExtTextOutW.argtypes = [
        HDC, ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_void_p,
        ctypes.c_wchar_p, ctypes.c_uint, ctypes.c_void_p,
    ]
    gdi32.ExtTextOutW.restype = ctypes.c_int

    bounds = RECT(0, 0, total_w, total_h)

    ref_dc = user32.GetDC(None)
    if not ref_dc:
        raise RuntimeError("GetDC(NULL) 실패")
    try:
        emf_dc = gdi32.CreateEnhMetaFileW(ref_dc, None, ctypes.byref(bounds), "HD Sign\0QR Stamp\0\0")
    finally:
        user32.ReleaseDC(None, ref_dc)
    if not emf_dc:
        raise RuntimeError("CreateEnhMetaFile 실패")

    BLACK_BRUSH = 4
    NULL_BRUSH = 5
    NULL_PEN = 8
    black_brush = gdi32.GetStockObject(BLACK_BRUSH)
    null_brush = gdi32.GetStockObject(NULL_BRUSH)
    null_pen = gdi32.GetStockObject(NULL_PEN)

    # 보이지 않는 정사각 바운딩 — rclBounds 가 캔버스 전체(0,0)-(1000,1000) 가 되도록 강제.
    # 이게 없으면 GDI 가 실제 그려진 도형(QR+텍스트)만 둘러싸는 직사각형으로 bounds 를 잡고,
    # FlexSign 이 그 직사각 bounds 를 자기 박스에 fit 하면서 QR 셀이 늘어남.
    gdi32.SelectObject(emf_dc, null_brush)
    gdi32.SelectObject(emf_dc, null_pen)
    gdi32.Rectangle(emf_dc, 0, 0, grid_w, grid_h)

    # QR 셀 — 정사각 영역 800×800 안에 그린다. 셀 크기 = 800/N (정사각).
    gdi32.SelectObject(emf_dc, black_brush)
    cell = qr_box_size / n
    for y in range(n):
        for x in range(n):
            if matrix[y][x]:
                x1 = qr_box_left + int(x * cell)
                y1 = qr_box_top + int(y * cell)
                x2 = qr_box_left + int((x + 1) * cell) + 1
                y2 = qr_box_top + int((y + 1) * cell) + 1
                gdi32.Rectangle(emf_dc, x1, y1, x2, y2)

    # 주문번호 텍스트 — QR 아래 가운데. BeginPath/ExtTextOut/EndPath/FillPath 로 글리프를
    # vector outline 으로 EMF 에 기록 → 폰트 없는 환경/FlexSign 의 텍스트 객체 변환 이슈를
    # 우회. 결과는 검은 도형 덩어리.
    FW_BOLD = 700
    DEFAULT_CHARSET = 1
    font_height = -text_band_h  # 음수: character height
    hfont = gdi32.CreateFontW(
        font_height, 0, 0, 0, FW_BOLD, 0, 0, 0,
        DEFAULT_CHARSET, 0, 0, 0, 0, "맑은 고딕",
    )
    old_font = None
    try:
        if hfont:
            old_font = gdi32.SelectObject(emf_dc, hfont)
            TA_CENTER = 6  # TA_TOP = 0
            gdi32.SetTextAlign(emf_dc, TA_CENTER)
            gdi32.SetTextColor(emf_dc, 0)
            gdi32.SetBkMode(emf_dc, 1)  # TRANSPARENT
            gdi32.BeginPath(emf_dc)
            gdi32.ExtTextOutW(
                emf_dc, grid_w // 2, text_top,
                0, None, order_number, len(order_number), None,
            )
            gdi32.EndPath(emf_dc)
            gdi32.FillPath(emf_dc)
    finally:
        if old_font is not None:
            gdi32.SelectObject(emf_dc, old_font)
        if hfont:
            gdi32.DeleteObject(hfont)

    hemf = gdi32.CloseEnhMetaFile(emf_dc)
    if not hemf:
        raise RuntimeError("CloseEnhMetaFile 실패")

    # 클립보드 — 다른 프로세스가 점유 중이면 OpenClipboard 가 실패하므로 짧은 재시도.
    import win32clipboard
    CF_ENHMETAFILE = 14

    opened = False
    try:
        last_err: Exception | None = None
        for _ in range(20):
            try:
                win32clipboard.OpenClipboard()
                opened = True
                break
            except Exception as e:
                last_err = e
                time.sleep(0.05)
        if not opened:
            gdi32.DeleteEnhMetaFile(hemf)
            raise RuntimeError(f"클립보드 열기 실패: {last_err}")
        win32clipboard.EmptyClipboard()
        # SetClipboardData 호출 후 hemf 소유권은 OS 로 이전 — 이쪽에서 DeleteEnhMetaFile 호출 X.
        win32clipboard.SetClipboardData(CF_ENHMETAFILE, hemf)
    finally:
        if opened:
            try:
                win32clipboard.CloseClipboard()
            except Exception:
                pass


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
    # 인쇄 시점에 배송 방법 미정인 경우 — 어드민에서 나중에 변경.
    "TBD":         "배송 추후결정",
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
    """관리자 페이지가 fetch 한 번 보내서 워처 실행 여부를 확인하기 위한 핸들러.
    POST /clip-qr?order=... 도 받음 — 수동 지시서용 QR 클립보드 복사."""

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-HDSign-Field")
        self.send_header("Cache-Control", "no-store")

    def _send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802 (BaseHTTPRequestHandler 규약)
        if self.path == "/ping":
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"ok":true,"app":"hdsign_worksheet"}')
        elif self.path == "/easyform/probe":
            # 이지폼 자동기입 feature-detect — 관리자 명세서작성 모달이 호출.
            self._send_json(200, easyform.handle_probe())
        else:
            self.send_response(404)
            self._cors()
            self.end_headers()

    def do_POST(self):  # noqa: N802
        from urllib.parse import urlparse, parse_qs
        parsed = urlparse(self.path)
        if parsed.path == "/easyform/fill":
            # 명세서 grid 를 받아 스테이징(arm)만 — 실제 기입은 사용자가 '채우기' 버튼/F6.
            try:
                length = int(self.headers.get("Content-Length") or "0")
                raw = self.rfile.read(length) if length > 0 else b""
                body = json.loads(raw.decode("utf-8")) if raw else {}
            except Exception:
                self._send_json(400, {"staged": False, "message": "본문 파싱 실패"})
                return
            status, payload = easyform.handle_fill(body)
            self._send_json(status, payload)
            return
        if parsed.path == "/clip-qr":
            qs = parse_qs(parsed.query)
            order = (qs.get("order") or [""])[0].strip()
            company = (qs.get("company") or [""])[0].strip()
            if not order:
                self.send_response(400)
                self._cors()
                self.end_headers()
                return
            try:
                qr_to_clipboard(order)
                # company 가 같이 오면 인쇄 매칭 큐에 등록 — PDF24 로 인쇄가 떨어지면
                # [신규 작성] 탭이 이 주문을 자동 매칭한다. 납기/배송은 매칭 다이얼로그에서 입력.
                if company:
                    remember_order_for_print(order, company, "", "", "")
                ui_log(f"{order} QR 클립보드 복사 완료 — FlexSign 에서 Ctrl+V")
                self.send_response(200)
                self._cors()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"ok":true}')
            except Exception as e:
                ui_log(f"QR 클립보드 복사 실패 ({order}): {e}")
                self.send_response(500)
                self._cors()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                try:
                    self.wfile.write(json.dumps({"ok": False, "error": str(e)}).encode("utf-8"))
                except Exception:
                    pass
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


def patch_due_date(order_number: str, new_due: date | None,
                   delivery_enum: str | None = None,
                   department_tags: list[str] | None = None,
                   department_slots: list[str] | None = None) -> bool:
    """다이얼로그에서 확정한 최종 납기 일자(+선택적으로 배송방법/부서 태그/슬롯 라벨)를 백엔드에 전달.
    new_due: None 이면 dueDate 키를 보내지 않음 — 분배함 슬롯/태그만 갱신하는 흐름(신규 작성
        탭에서 dueDate 가 이미 createQrOnlyOrder 로 저장된 뒤 슬롯만 추가 갱신할 때)에 사용.
    delivery_enum: 백엔드 enum 명(CARGO/QUICK/DIRECT/PICKUP/LOCAL_CARGO). None/빈값이면 송신 생략.
    department_tags: 분배함 사진에서 직원이 클릭한 칸 → 매핑된 모바일 부서 태그(중복 제거).
        None 이면 키 자체를 송신하지 않아 백엔드는 기존 태그 유지. 빈 리스트 [] 는 명시적
        "태그 비우기" — 분배함을 모두 비활성으로 두고 적용한 경우.
    department_slots: 직원이 실제 클릭한 분배함 슬롯 라벨. 부서 단위로는 같지만 슬롯이 다른
        경우(예: '시트/도안실' vs '캡/일체형작업실' 모두 완조립부)를 구분하기 위해 라벨 그대로
        저장해둔다 — 다음에 같은 지시서를 다이얼로그에 다시 띄울 때 정확히 그 슬롯에만 ✓
        복원하기 위함. tags 와 동일 시맨틱(None=미송신, []=비우기)."""
    if not order_number:
        return False
    url = f"{API_BASE}/api/public/orders/{quote(order_number, safe='')}/due-date"
    payload: dict = {}
    if new_due is not None:
        payload["dueDate"] = new_due.isoformat()
    if delivery_enum:
        payload["deliveryMethod"] = delivery_enum
    if department_tags is not None:
        payload["departmentTags"] = list(department_tags)
    if department_slots is not None:
        payload["departmentSlots"] = list(department_slots)
    if not payload:
        # 보낼 게 하나도 없으면 호출 자체 생략 — 백엔드가 400 으로 친절히 거부하긴 하지만
        # 굳이 네트워크를 태우지 않는다.
        return True
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp.read()
        parts = []
        if new_due is not None:
            parts.append(f"납기 {new_due.isoformat()}")
        if delivery_enum:
            parts.append(f"배송 {delivery_enum}")
        if department_tags is not None:
            parts.append("태그 " + (", ".join(department_tags) if department_tags else "(없음)"))
        if department_slots is not None:
            parts.append("슬롯 " + (", ".join(department_slots) if department_slots else "(없음)"))
        ui_log(f"{order_number} {' / '.join(parts) or '(빈 갱신)'} 로 업데이트")
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
    """진행중/대기중 작업지시서 목록 — 인쇄 다이얼로그 [기존 변경] 탭의 그리드/검색용.

    옛 구현은 /api/public/worksheets (IN_PROGRESS + PDF 있는 것만). 그러면 RECEIVED + 빈 PDF
    주문(거래처 발주만 들어온 상태에서 사용자가 일러스트로 직접 그린 케이스)은 후보에서
    빠져 QR 매칭 실패 → 신규 흐름으로 잘못 라우팅됐다. admin /api/admin/orders 로 전환해
    COMPLETED/휴지통/견적 외 모든 ORDER 주문을 워처가 후보로 가지게 변경.

    응답 필드는 OrderDto.Response — 다이얼로그가 사용하는 키와 차이가 있는 것은
    public 응답 형식으로 normalize(특히 clientCompanyName → companyName).
    admin 토큰 없거나 호출 실패 시 옛 public 엔드포인트로 폴백."""
    token = _get_admin_token()
    if token:
        url = f"{API_BASE}/api/admin/orders"
        req = urllib.request.Request(url, method="GET")
        req.add_header("Authorization", f"Bearer {token}")
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            if not isinstance(data, list):
                return []
            result: list[dict] = []
            for o in data:
                if (o.get("status") or "") == "COMPLETED":
                    continue
                if o.get("deletedAt"):
                    continue
                # 견적(QUOTE) 은 종이 인쇄 매칭 대상이 아님 — ORDER 만.
                if (o.get("requestType") or "") not in ("", "ORDER"):
                    continue
                due = o.get("dueDate")
                result.append({
                    "orderNumber": o.get("orderNumber"),
                    "title": o.get("title"),
                    # admin: clientCompanyName → 다이얼로그 코드는 companyName 키를 본다.
                    "companyName": o.get("clientCompanyName"),
                    "dueDate": str(due) if due else None,
                    "dueTime": o.get("dueTime"),
                    "deliveryMethod": o.get("deliveryMethod"),
                    "worksheetPdfUrl": o.get("worksheetPdfUrl"),
                    "worksheetThumbnailUrl": o.get("worksheetThumbnailUrl"),
                    "worksheetUpdatedAt": o.get("worksheetUpdatedAt"),
                    "worksheetChangeNote": o.get("worksheetChangeNote"),
                    "departmentTags": o.get("departmentTags") or [],
                    "departmentSlots": o.get("departmentSlots") or [],
                    "evidenceLastUploadedAt": o.get("evidenceLastUploadedAt"),
                    "status": o.get("status"),
                })
            return result
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                with _admin_token_lock:
                    _admin_token_cache["token"] = None
            ui_log(f"admin 지시서 목록 조회 실패(HTTP {e.code}) — public 으로 폴백")
        except Exception as e:
            ui_log(f"admin 지시서 목록 조회 실패: {e} — public 으로 폴백")

    # 폴백 — admin 토큰 없거나 admin 호출 실패: 옛 public 엔드포인트(IN_PROGRESS + PDF 있는 것만).
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


def fetch_public_worksheet_detail(order_number: str) -> dict | None:
    """QR 로 읽은 주문번호 1건을 공개 엔드포인트에서 직접 조회.

    PC별 admin 계정 설정이 없거나 로컬 인쇄 매칭 큐가 비어 있으면 전체 목록 기반 매칭이
    실패할 수 있다. /api/public/worksheets/{orderNumber} 는 PDF 가 아직 안 붙은 주문도
    orderNumber 로 조회하므로, QR 을 읽은 순간의 최후 안전망으로 쓴다.
    """
    order_number = (order_number or "").strip()
    if not order_number:
        return None
    url = f"{API_BASE}/api/public/worksheets/{quote(order_number, safe='')}"
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return data if isinstance(data, dict) else None
    except urllib.error.HTTPError as e:
        if e.code != 404:
            ui_log(f"QR 주문 단건 조회 실패(HTTP {e.code}): {order_number}")
        return None
    except Exception as e:
        ui_log(f"QR 주문 단건 조회 실패: {order_number} ({e})")
        return None


# 인쇄 QR 디코드 실패 / [QR 코드 만들기] 재발급으로 생기는 "납기·지시서 없는 빈 발주(고아 카드)"
# 를 막기 위한 유틸. 최근에 [QR 코드 만들기] 또는 clip-qr 로 발급됐는데 아직 인쇄 PDF 가
# 안 올라온(=worksheetPdfUrl 없음) 빈 발주만 골라낸다. 인쇄 시 QR 인식이 실패해도 "혹시
# 이 발주인가요?" 로 되묻고, 다이얼로그에서는 "방금 만든 빈 발주가 있어요" 경고를 띄우는 데 쓴다.
# 같은 작업의 디자인 작업이 몇 시간 걸릴 수 있어(QR 발급 → 디자인 → 인쇄) 6시간으로 잡는다.
# 너무 좁으면 디코드 실패 시 "방금 만든 빈 발주가 있어요" 안내가 사라져 고아 카드가 또 생긴다.
_RECENT_QR_ONLY_WINDOW_SEC = 6 * 60 * 60


def recent_incomplete_qr_only_orders(existing_worksheets: list[dict] | None = None,
                                     within_sec: int = _RECENT_QR_ONLY_WINDOW_SEC) -> list[dict]:
    """최근 within_sec 내 [QR 코드 만들기]/clip-qr 로 발급됐는데 아직 지시서 PDF 가 안 붙은 빈 발주.

    list_recent_orders() 항목 중 originalFileName(=.ai ZIP 자동작성 표식)도, dueDate 도 없는
    것만 후보로 잡고, 백엔드 admin 주문 목록에서 worksheetPdfUrl 이 비어 있는지 한 번 더 확인한다.
    existing_worksheets 를 넘기면 그걸로 판정(추가 API 호출 없음), 안 넘기면 fetch 한다.
    반환은 최신순([0] 이 가장 최근), 각 항목에 'ageSec'(발급 후 경과 초) 키를 더해 돌려준다."""
    now = time.time()
    cutoff = now - within_sec
    cand = [
        dict(o, ageSec=max(0.0, now - float(o.get("ts", 0) or 0)))
        for o in list_recent_orders()
        if float(o.get("ts", 0) or 0) >= cutoff
        and not (o.get("originalFileName") or "").strip()
        and not (o.get("dueDate") or "").strip()
    ]
    if not cand:
        return []
    if existing_worksheets is None:
        try:
            existing_worksheets = fetch_existing_worksheets()
        except Exception:
            existing_worksheets = []
    by_num = {w.get("orderNumber"): w for w in (existing_worksheets or [])}
    out: list[dict] = []
    for o in cand:
        w = by_num.get(o.get("orderNumber"))
        if w is None:
            # admin 주문 목록에 없음 = 이미 COMPLETED/휴지통 등 → 이어쓸 대상 아님.
            continue
        if (w.get("worksheetPdfUrl") or "").strip():
            continue  # 이미 지시서가 올라옴 = 완료된 발주.
        out.append(o)
    return out


def _humanize_age_sec(sec: float) -> str:
    sec = int(sec)
    if sec < 60:
        return f"{sec}초 전"
    if sec < 3600:
        return f"{sec // 60}분 전"
    return f"{sec // 3600}시간 전"


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


_COMPANY_CONTACT_SUFFIX_RE = re.compile(r"^(?P<company>.+?)\((?P<contact>[^()]{1,50})\)\s*$")


def _split_company_contact_label(name: str) -> tuple[str, str]:
    raw = (name or "").strip()
    if not raw:
        return "", ""
    match = _COMPANY_CONTACT_SUFFIX_RE.match(raw)
    if not match:
        return raw, ""
    company = match.group("company").strip()
    contact = match.group("contact").strip()
    return company or raw, contact


def _customer_folder_name_candidates(network_folder_name: str, company_name: str) -> list[str]:
    candidates: list[str] = []
    seen: set[str] = set()
    for raw in (network_folder_name, company_name):
        raw = (raw or "").strip()
        root, _contact = _split_company_contact_label(raw)
        for name in (root, raw):
            key = _normalize_company_key(name)
            if key and key not in seen:
                candidates.append(name.strip())
                seen.add(key)
    return candidates


_CONTACT_TITLE_SUFFIX_RE = re.compile(
    r"(대표님?|사장님?|부사장님?|전무님?|상무님?|이사님?|부장님?|차장님?|과장님?|대리님?|주임님?|실장님?|팀장님?|매니저님?|님)$"
)


def _contact_folder_part(name: str) -> str:
    """주문 폴더명에 붙일 담당자명. '정미나차장님' -> '정미나'."""
    compact = "".join((name or "").strip().split())
    if not compact:
        return ""
    stripped = _CONTACT_TITLE_SUFFIX_RE.sub("", compact)
    return stripped or compact


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
    candidates = _customer_folder_name_candidates(network_folder_name, company_name)
    if candidates:
        label = candidates[0]
    candidate_keys = [_normalize_company_key(name) for name in candidates]
    safe_label = _sanitize_folder_name(label) or "(미지정)"
    fallback_new = network_base / f"{safe_label} (자동생성)"
    if not candidate_keys:
        return fallback_new
    try:
        primary_hit = None
        fallback_hit = None
        for child in network_base.iterdir():
            if not child.is_dir():
                continue
            child_key = _normalize_company_key(child.name)
            if child_key in candidate_keys:
                return child
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
    contact_raw = (meta.get("contactName") or "").strip()
    if not contact_raw:
        _company_root, contact_raw = _split_company_contact_label(company)
    if not contact_raw:
        _network_root, contact_raw = _split_company_contact_label(network_folder)
    contact_part = _contact_folder_part(contact_raw)
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
    if contact_part:
        name_part = f"{name_part}({contact_part})"
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
        # 네트워크 폴더에 떨어지는 사본도 동일하게 위생화 — 거래처가 PC에서 더블클릭해 열 때 안전.
        # v8 사본은 언더스코어 없이 "...v8.ai" 로 — 직원 식별성 + 파일명 짧게.
        safe_orig_stem = safe_filename_stem(original_ai.stem)
        dst_orig = order_folder / f"{safe_orig_stem}{original_ai.suffix}"
        shutil.copy2(str(original_ai), str(dst_orig))
        dst_v8 = order_folder / f"{safe_orig_stem}v8.ai"
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


_DEFAULT_ADMIN_USERNAME = "hdno88"
_DEFAULT_ADMIN_PASSWORD = "hdno0958"


def _get_admin_token() -> str | None:
    """캐시된 admin 토큰 반환. 없거나 곧 만료면 재로그인. config 미설정 시 fallback 계정 사용."""
    config = _load_config()
    username = (config.get("admin_username") or "").strip() or _DEFAULT_ADMIN_USERNAME
    password = (config.get("admin_password") or "") or _DEFAULT_ADMIN_PASSWORD
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


def change_flexsign_path_async():
    """GUI [FlexSign 위치 지정] 버튼에서 호출.
    파일 선택 다이얼로그로 App.exe 를 직접 골라 config.json 에 저장.
    빌드된 워처가 새 PC 에서 처음 실행될 때 한 번만 누르면 됨."""
    def _ask():
        # 보통 FlexSign 폴더는 Desktop 또는 Program Files 에 있음.
        existing = _load_config().get("flexsign_exe", "")
        initial = str(Path(existing).parent) if existing and Path(existing).exists() \
            else str(Path.home() / "Desktop")
        chosen = filedialog.askopenfilename(
            title="FlexSign App.exe 선택",
            initialdir=initial,
            filetypes=[("FlexSign 실행파일", "App.exe"), ("실행파일", "*.exe"), ("모든 파일", "*.*")],
        )
        if not chosen:
            return
        chosen_path = Path(chosen)
        if not chosen_path.exists():
            messagebox.showerror("FlexSign 위치 지정 실패", f"선택한 파일이 없습니다:\n{chosen}")
            return
        if chosen_path.name.lower() != "app.exe":
            if not messagebox.askyesno(
                "확인",
                f"선택한 파일이 App.exe 가 아닙니다.\n\n{chosen_path.name}\n\n그래도 사용할까요?"):
                return
        config = _load_config()
        config["flexsign_exe"] = str(chosen_path)
        if not _save_config(config):
            messagebox.showerror("저장 실패", "config.json 저장에 실패했습니다. 워처 로그를 확인해주세요.")
            return
        ui_log(f"FlexSign 위치 지정: {chosen_path}")
        messagebox.showinfo("FlexSign 위치 지정 완료", f"FlexSign 위치가 저장되었습니다.\n\n{chosen_path}")

    _ui_queue.put(("run", _ask))


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


def open_qr_create_dialog_async(*, print_routing_context: dict | None = None):
    """GUI [QR 코드 만들기] 버튼에서 호출.
    독립 다이얼로그로 거래처를 검색해 빈 발주를 발급하고 그 QR 을 클립보드에 복사한다.
    인쇄 다이얼로그(_ask_print_match_blocking) 와 분리된 흐름 — 사용자는 FlexSign 에서
    지시서를 그리기 *전에* 이 버튼을 눌러 QR 부터 받고, 캔버스에 붙인 뒤 디자인을 시작.
    그러면 첫 인쇄 PDF 에 이미 QR 이 박혀있어 매칭 다이얼로그가 곧장 [기존 변경] 으로 진입한다.

    print_routing_context: PDF 가 QR 없이 인쇄되어 _process_printed_pdf 에서 진입할 때만
    전달. 다이얼로그에 [기존지시서 변경하기] 버튼을 띄우고, 종료 시 ctx["result"] 채운 뒤
    ctx["done"].set(). 형태:
        {
          "pdf_path": Path,
          "orders": list[dict], "existing_worksheets": list[dict],
          "clients_for_new": list[dict],
          "result": dict,            # 다이얼로그가 채움
          "done": threading.Event(), # 다이얼로그가 set
        }
    result["action"] ∈ {"qr_created", "modify_existing", "cancel"}.
    "modify_existing" 이면 result["sel"] 에 _ask_print_match_blocking 결과 dict 들어감."""
    ctx = print_routing_context
    # _signal 을 _open 외부에 둬서 _open 초기화 도중에 예외가 나도 워커가 영구 블록되지 않게 한다.
    signaled = {"flag": False}

    def _signal(action: str, **extra):
        """ctx 가 있을 때만 의미 있음. 한 번만 set — 중복 호출 방어."""
        if ctx is None or signaled["flag"]:
            return
        signaled["flag"] = True
        payload = {"action": action}
        payload.update(extra)
        ctx["result"] = payload
        done_evt = ctx.get("done")
        if done_evt is not None:
            done_evt.set()

    def _open():
        # 거래처 목록 — 모달 띄우기 전에 백그라운드로 받아두면 첫 화면 빠르게 뜬다.
        # 실패 시 빈 리스트로 진행 — 다이얼로그 안에서 안내 표시.
        clients = _fetch_admin_clients() or []
        sorted_clients = sorted(
            clients, key=lambda c: (c.get("companyName") or "").lower()
        )

        # _process_printed_pdf 에서 띄워둔 "처리 중" 창이 있으면 — 이제 거래처 목록도 다 받았으니 닫는다.
        if ctx is not None:
            _bc = ctx.get("busy_close")
            if callable(_bc):
                try:
                    _bc()
                except Exception:
                    pass

        BG = "#ffffff"
        BG_SOFT = "#fafafa"
        BORDER = "#e4e4e7"
        TITLE_FG = "#18181b"
        SUB_FG = "#71717a"
        ACCENT = "#10b981"

        dlg = tk.Toplevel()
        dlg.title("QR 코드 만들기")
        dlg.configure(bg=BG)
        dlg.resizable(False, False)
        dlg.attributes("-topmost", True)
        DLG_W, DLG_H = 380, 480
        try:
            sw = dlg.winfo_screenwidth()
            sh = dlg.winfo_screenheight()
            x = (sw - DLG_W) // 2
            y = (sh - DLG_H) // 2
            dlg.geometry(f"{DLG_W}x{DLG_H}+{x}+{y}")
        except Exception:
            dlg.geometry(f"{DLG_W}x{DLG_H}")

        body = tk.Frame(dlg, bg=BG)
        body.pack(fill="both", expand=True, padx=14, pady=14)

        tk.Label(body, text="QR 코드 만들기",
                 bg=BG, fg=TITLE_FG,
                 font=("맑은 고딕", 13, "bold"), anchor="w"
                 ).pack(fill="x")
        tk.Label(body,
                 text="거래처를 골라 Enter — 새 발주번호의 QR 이 클립보드에 복사됩니다.\n"
                      "FlexSign 캔버스에 Ctrl+V 로 붙이고 지시서를 그린 뒤 인쇄하세요.",
                 bg=BG, fg=SUB_FG, font=("맑은 고딕", 9),
                 anchor="w", justify="left", wraplength=DLG_W - 28
                 ).pack(fill="x", pady=(4, 10))

        # ── 최근에 발급했는데 아직 지시서가 안 올라온 빈 발주 경고 ──────────────
        # 같은 작업을 (QR 인식 실패 등으로) 또 발급하면 고아 카드가 누적된다 → 새로 고르기 전에
        # "방금 만든 빈 발주가 있어요" 를 보여주고, 같은 작업이면 그 QR 을 다시 복사하게 한다.
        # 단, _process_printed_pdf 가 이미 "이 빈 발주 맞습니까?" 를 물어보고 사용자가 [아니오]
        # 한 직후라면(skip_recent_qr_warning) 같은 경고를 또 띄우지 않는다 — 창이 두 번 뜨는 셈.
        if ctx is not None and ctx.get("skip_recent_qr_warning"):
            _recent_open = []
        else:
            try:
                _recent_open = recent_incomplete_qr_only_orders()
            except Exception:
                _recent_open = []
        if _recent_open:
            warn = tk.Frame(body, bg="#fffbeb",
                            highlightbackground="#f59e0b", highlightthickness=1)
            warn.pack(fill="x", pady=(0, 10))
            tk.Label(warn, text="⚠ 최근 발급한 빈 발주가 있습니다",
                     bg="#fffbeb", fg="#92400e", font=("맑은 고딕", 9, "bold"),
                     anchor="w").pack(fill="x", padx=10, pady=(8, 2))
            tk.Label(warn,
                     text="같은 작업이면 새로 발급하지 말고 아래 QR 을 다시 복사해 쓰세요.",
                     bg="#fffbeb", fg="#92400e", font=("맑은 고딕", 8),
                     anchor="w", justify="left", wraplength=DLG_W - 48).pack(fill="x", padx=10, pady=(0, 4))
            for _ro in _recent_open[:3]:
                _rline = tk.Frame(warn, bg="#fffbeb")
                _rline.pack(fill="x", padx=10, pady=(0, 6))
                tk.Label(_rline,
                         text=f"{_ro.get('orderNumber')}  ·  {_ro.get('companyName') or '-'}  ·  {_humanize_age_sec(_ro.get('ageSec', 0))}",
                         bg="#fffbeb", fg="#78350f", font=("맑은 고딕", 8),
                         anchor="w").pack(side="left", fill="x", expand=True)

                def _make_recopy(num, comp):
                    def _do(_e=None):
                        if submitting["flag"]:
                            return
                        submitting["flag"] = True
                        ok = False
                        try:
                            qr_to_clipboard(num)
                            ok = True
                        except Exception as e:
                            ui_log(f"QR 클립보드 복사 실패 ({num}): {e}")
                        try:
                            dlg.destroy()
                        except Exception:
                            pass
                        if ok:
                            messagebox.showinfo(
                                "QR 코드 복사 완료",
                                f"기존 빈 발주 {num} 의 QR 을 다시 복사했습니다.\n\n"
                                f"FlexSign 캔버스에 Ctrl+V 로 붙여넣고 지시서를 그린 뒤\n"
                                f"인쇄하시면 자동으로 매칭됩니다.\n\n"
                                f"※ 이 창을 닫으면 FlexSign 으로 자동 전환됩니다.")
                            _focus_flexisign_window_async()
                        else:
                            messagebox.showwarning(
                                "QR 클립보드 복사 실패",
                                f"발주번호 {num} 의 QR 복사에 실패했습니다.\n어드민 페이지에서 다시 발급해주세요.")
                        _signal("qr_created", order_number=num)
                    return _do

                tk.Button(_rline, text="이 QR 다시 복사",
                          bg="#f59e0b", fg="white", font=("맑은 고딕", 8, "bold"),
                          relief="flat", bd=0, padx=8, pady=3, cursor="hand2",
                          activebackground="#d97706", activeforeground="white",
                          command=_make_recopy((_ro.get("orderNumber") or "").strip(),
                                               (_ro.get("companyName") or "").strip())
                          ).pack(side="right", padx=(6, 0))

        search_var = tk.StringVar()
        search_entry = tk.Entry(body, textvariable=search_var,
                                font=("맑은 고딕", 11), bg="white",
                                relief="solid", bd=1, highlightthickness=0)
        search_entry.pack(fill="x")
        tk.Label(body, text="거래처 / 별칭 / 담당자 검색",
                 bg=BG, fg=SUB_FG, font=("맑은 고딕", 8),
                 anchor="w").pack(fill="x", pady=(2, 6))

        list_outer = tk.Frame(body, bg=BG, highlightbackground=BORDER, highlightthickness=1)
        list_outer.pack(fill="both", expand=True)
        canvas = tk.Canvas(list_outer, bg="white", highlightthickness=0)
        scroll = ttk.Scrollbar(list_outer, orient="vertical", command=canvas.yview)
        canvas.configure(yscrollcommand=scroll.set)
        canvas.pack(side="left", fill="both", expand=True)
        scroll.pack(side="right", fill="y")
        inner = tk.Frame(canvas, bg="white")
        inner_id = canvas.create_window((0, 0), window=inner, anchor="nw")
        inner.bind("<Configure>",
                   lambda e: canvas.configure(scrollregion=canvas.bbox("all")))
        canvas.bind("<Configure>",
                    lambda e: canvas.itemconfig(inner_id, width=e.width))

        submitting = {"flag": False}
        filtered: list[dict] = []

        def _finish_with_order(order_num: str, company: str, *, newly_created: bool):
            """발주번호 확정 후 공통 마무리 — QR 클립보드 복사 + 안내 + (인쇄흐름) 신호."""
            qr_copy_ok = False
            try:
                qr_to_clipboard(order_num)
                qr_copy_ok = True
            except Exception as e:
                ui_log(f"QR 클립보드 복사 실패 ({order_num}): {e}")
            try:
                dlg.destroy()
            except Exception:
                pass
            if qr_copy_ok:
                head = ("발주번호 " + order_num + " 의 QR 이 클립보드에 복사되었습니다."
                        if newly_created
                        else "기존 빈 발주 " + order_num + " 의 QR 을 다시 복사했습니다.")
                messagebox.showinfo(
                    "QR 코드 복사 완료",
                    f"{head}\n\n"
                    f"FlexSign 캔버스에 Ctrl+V 로 붙여넣고 지시서를 그린 뒤\n"
                    f"인쇄하시면 자동으로 매칭됩니다.\n\n"
                    f"※ 이 창을 닫으면 FlexSign 으로 자동 전환됩니다.",
                )
                _focus_flexisign_window_async()
            else:
                messagebox.showwarning(
                    "QR 클립보드 복사 실패",
                    f"발주번호 {order_num} 는 {'등록' if newly_created else '확인'}됐지만 QR 복사에 실패했습니다.\n"
                    f"어드민 페이지에서 QR 을 다시 발급해 사용해주세요.",
                )
            # 인쇄 흐름에서 진입한 경우만 의미 — _process_printed_pdf 가 깨어나
            # 종이/업로드 생략 + 임시 PDF 정리로 빠진다.
            _signal("qr_created", order_number=order_num)

        def _on_pick(client):
            if submitting["flag"]:
                return
            client_id = client.get("id")
            if client_id is None:
                return
            company_disp = (client.get("companyName") or "").strip() or "(이름 없음)"

            # ── 거래처 확인 + 최근 빈 발주 중복 경고 ────────────────────────────
            # 거래처를 클릭하자마자 카드를 만들어버리면 잘못 골랐을 때 곧장 고아 카드가 된다.
            # 또 같은 작업을 (QR 인식 실패 등으로) 또 발급하면 고아 카드가 누적된다 → 발급 전에
            # "이 거래처 맞나요?" 를 묻고, 최근에 같은 거래처로 발급한 빈 발주가 있으면 강하게 경고.
            try:
                recent_same = [
                    o for o in recent_incomplete_qr_only_orders()
                    if (o.get("companyName") or "").strip() == (client.get("companyName") or "").strip()
                ]
            except Exception:
                recent_same = []
            if recent_same:
                m = recent_same[0]
                # 기본 포커스 버튼([예])은 "기존 빈 발주 재사용" — 흔한 케이스(인쇄 QR 인식 실패로
                # 같은 작업을 또 발급하려는 상황)이자 안전한 쪽이라 Enter/실수 클릭이 고아 카드를
                # 만들지 않게 한다. 정말 다른 새 작업일 때만 [아니오] 로 새 발주를 만든다.
                ans = messagebox.askyesnocancel(
                    "거래처 확인 — 중복 발급 주의",
                    f"「{company_disp}」\n\n"
                    f"⚠ {_humanize_age_sec(m.get('ageSec', 0))} 이미 이 거래처로 빈 발주 "
                    f"{m.get('orderNumber')} 를 발급했고 아직 지시서가 안 올라왔습니다.\n\n"
                    f"이 인쇄/디자인이 그 발주의 작업입니까?\n\n"
                    f"• [예]  → {m.get('orderNumber')} 의 QR 을 다시 복사 (새 카드 안 만듦) — 보통 이거\n"
                    f"• [아니오] → 완전히 다른 새 작업이라 새 발주번호를 발급\n"
                    f"• [취소] → 닫기",
                    parent=dlg,
                )
                if ans is None:  # 취소
                    return
                if ans is True:  # 기존 발주 QR 재복사 — 새 카드 안 만듦
                    submitting["flag"] = True
                    _finish_with_order((m.get("orderNumber") or "").strip(),
                                       (m.get("companyName") or company_disp).strip(),
                                       newly_created=False)
                    return
                # ans is False → 아래로 진행해 새 발주 발급
            else:
                if not messagebox.askyesno(
                    "거래처 확인",
                    f"「{company_disp}」\n\n이 거래처로 새 발주번호 QR 을 발급할까요?",
                    parent=dlg,
                ):
                    return

            submitting["flag"] = True
            try:
                created = _create_qr_only_order(int(client_id))
                if not created or not created.get("orderNumber"):
                    submitting["flag"] = False
                    messagebox.showerror(
                        "발주 발급 실패",
                        "빈 발주 생성에 실패했습니다.\n잠시 후 다시 시도하거나 워처 로그/백엔드 로그를 확인해주세요.",
                        parent=dlg,
                    )
                    return
                order_num = (created.get("orderNumber") or "").strip()
                company = (created.get("clientCompanyName")
                           or client.get("companyName") or "").strip()
                ui_log(f"{order_num} ({company}) 빈 주문 발급 완료")
                # 인쇄 매칭 큐에 등록 — 다음 인쇄에서 QR 인식이 실패해도 "이 발주인가요?" 로 되묻고,
                # [QR 코드 만들기] 를 또 열면 "방금 만든 빈 발주가 있어요" 경고를 띄울 수 있게.
                remember_order_for_print(order_num, company, "", "", "")
                _finish_with_order(order_num, company, newly_created=True)
            except Exception as e:
                submitting["flag"] = False
                ui_log(f"QR 코드 만들기 중 오류: {e}")
                messagebox.showerror(
                    "오류",
                    f"발주 발급 중 오류가 발생했습니다.\n{e}",
                    parent=dlg,
                )

        def _filter():
            q = (search_var.get() or "").strip().lower()
            if not q:
                return sorted_clients[:30]
            def _hit(c):
                hay = " ".join([
                    str(c.get("companyName") or ""),
                    str(c.get("networkFolderName") or ""),
                    str(c.get("aliases") or ""),
                    str(c.get("contactName") or ""),
                ]).lower()
                return q in hay
            return [c for c in sorted_clients if _hit(c)][:30]

        # 키보드 네비게이션 — 검색창에서 ↓/↑ 로 행 이동, Enter 로 선택. 클릭도 그대로 동작.
        # _render 가 매번 다시 그리기 때문에 행 위젯 참조를 캐시해 _apply_highlight 가 빠르게.
        selected_idx = {"value": 0}
        row_widgets: list[tuple[tk.Frame, tk.Label]] = []

        def _apply_highlight():
            for i, (row, lbl) in enumerate(row_widgets):
                if i == selected_idx["value"]:
                    row.configure(bg="#f0fdf4")
                    lbl.configure(bg="#f0fdf4",
                                  font=("맑은 고딕", 10, "bold"))
                else:
                    row.configure(bg="white")
                    lbl.configure(bg="white",
                                  font=("맑은 고딕", 10, "normal"))

        def _scroll_to_selected():
            if not row_widgets:
                return
            idx = selected_idx["value"]
            if not (0 <= idx < len(row_widgets)):
                return
            try:
                canvas.update_idletasks()
                row, _ = row_widgets[idx]
                row_y = row.winfo_y()
                row_h = row.winfo_height()
                canvas_h = canvas.winfo_height()
                inner_h = inner.winfo_height()
                if inner_h <= canvas_h:
                    return
                top_y = canvas.yview()[0] * inner_h
                bottom_y = top_y + canvas_h
                if row_y < top_y:
                    canvas.yview_moveto(row_y / inner_h)
                elif row_y + row_h > bottom_y:
                    canvas.yview_moveto((row_y + row_h - canvas_h) / inner_h)
            except Exception:
                pass

        def _move_selection(delta: int):
            if not filtered:
                return "break"
            new_idx = max(0, min(len(filtered) - 1,
                                 selected_idx["value"] + delta))
            if new_idx != selected_idx["value"]:
                selected_idx["value"] = new_idx
                _apply_highlight()
                _scroll_to_selected()
            return "break"

        def _render():
            for child in inner.winfo_children():
                child.destroy()
            row_widgets.clear()
            items = _filter()
            filtered.clear()
            filtered.extend(items)
            # 검색어 바뀔 때마다 첫 행으로 리셋 — 직원이 글자 더 치고 ↓ 누르면 다시 처음부터.
            selected_idx["value"] = 0
            if not items:
                tk.Label(inner,
                         text="검색 결과 없음" if search_var.get().strip() else "거래처 없음",
                         bg="white", fg=SUB_FG, font=("맑은 고딕", 10)
                         ).pack(pady=12)
                return
            for c in items:
                row = tk.Frame(inner, bg="white", cursor="hand2")
                row.pack(fill="x", padx=8, pady=2)
                name = c.get("companyName") or "-"
                contact = (c.get("contactName") or "").strip()
                row_text = f"{name}    {contact}".strip()
                lbl = tk.Label(row, text=row_text, bg="white", fg=TITLE_FG,
                               font=("맑은 고딕", 10, "normal"),
                               anchor="w")
                lbl.pack(side="left", fill="x", expand=True, padx=8, pady=6)
                row_widgets.append((row, lbl))

                def _make(c_local):
                    return lambda _e=None: _on_pick(c_local)
                handler = _make(c)
                row.bind("<Button-1>", handler)
                lbl.bind("<Button-1>", handler)
            _apply_highlight()

        search_var.trace_add("write", lambda *_: _render())
        _render()

        def _on_enter(_e=None):
            if not filtered:
                return "break"
            idx = selected_idx["value"]
            if 0 <= idx < len(filtered):
                _on_pick(filtered[idx])
            return "break"
        search_entry.bind("<Return>", _on_enter)
        search_entry.bind("<Down>", lambda _e: _move_selection(1))
        search_entry.bind("<Up>", lambda _e: _move_selection(-1))

        # 인쇄 흐름에서 진입했을 때만 [기존지시서 변경하기] 버튼 표시 — QR 이 있는데 인식이
        # 안 된 드문 경우(찢김/색상/스캔 노이즈 등)에만 사용. 클릭하면 이 다이얼로그를 닫고
        # _ask_print_match_blocking 으로 위임 — qr_order_number=None 이라 자동으로
        # [기존 변경] 탭이 선택된다.
        if ctx is not None:
            def _on_modify_existing():
                try:
                    dlg.destroy()
                except Exception:
                    pass
                sel = None
                try:
                    sel = _ask_print_match_blocking(
                        ctx.get("orders") or [],
                        ctx["pdf_path"],
                        ctx.get("existing_worksheets") or [],
                        qr_order_number=None,
                        clients_for_new=ctx.get("clients_for_new") or [],
                        intent=ctx.get("intent") or "web_print",
                    )
                except Exception as e:
                    ui_log(f"[기존지시서 변경하기] 다이얼로그 오류: {e}")
                _signal("modify_existing", sel=sel)

            tk.Button(
                body, text="기존지시서 변경하기 (QR 인식 안 됨)",
                bg="#ffffff", fg="#52525b",
                activebackground="#f4f4f5", activeforeground="#18181b",
                font=("맑은 고딕", 9),
                relief="solid", bd=1, cursor="hand2",
                padx=12, pady=8,
                command=_on_modify_existing,
            ).pack(fill="x", pady=(8, 0))

        def _on_cancel(_e=None):
            # 사용자 취소(X / Esc) — 인쇄 흐름에서 들어온 경우 종이/업로드 모두 생략.
            _signal("cancel")
            try:
                dlg.destroy()
            except Exception:
                pass
        dlg.bind("<Escape>", _on_cancel)
        dlg.protocol("WM_DELETE_WINDOW", _on_cancel)

        # 인쇄 다이얼로그(_ask_print_match_blocking)가 grab_set() 으로 입력을 잡고 있는
        # 상태에서 [QR 코드 만들기 열기] 로 진입하면, 여기서 grab 을 가져와야 사용자가
        # 검색창에 글자를 칠 수 있다. 매핑 직후에 시도(아직 viewable 이 아니면 실패).
        def _take_grab():
            try:
                dlg.grab_set()
            except Exception:
                pass
        try:
            dlg.after(50, search_entry.focus_set)
            dlg.after(60, _take_grab)
        except Exception:
            pass

    def _open_safe():
        try:
            _open()
        except Exception as e:
            ui_log(f"[QR 코드 만들기] 다이얼로그 초기화 실패: {e}")
            # ctx 가 있으면 워커 스레드가 done.wait() 에 걸려있다 — 반드시 cancel 신호.
            _signal("cancel")

    _ui_queue.put(("run", _open_safe))


# ── 새 발주/견적 알림 ───────────────────────────────────────────────────────
# 백엔드 /api/admin/orders 를 30초 간격으로 폴링해 새 주문(발주/견적)이 들어오면
# 작업장 PC 에서 사운드 + 창 raise + 빨간 배너로 즉시 인지하게 한다.
# 첫 실행 시 baseline 만 잡아서 과거 주문이 한꺼번에 알림으로 쏟아지지 않도록.
_ORDER_ALERT_STATE_FILE = WATCH_DIR / "state" / "order_alert.json"
_ORDER_ALERT_INTERVAL_SEC = 30


def _load_alert_state() -> dict:
    try:
        return json.loads(_ORDER_ALERT_STATE_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except Exception as e:
        ui_log(f"order_alert state 로드 실패: {e}")
        return {}


def _save_alert_state(state: dict) -> None:
    try:
        _ORDER_ALERT_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = _ORDER_ALERT_STATE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(_ORDER_ALERT_STATE_FILE)
    except Exception as e:
        ui_log(f"order_alert state 저장 실패: {e}")


def _get_notify_enabled() -> bool:
    val = _load_config().get("notify_orders")
    return True if val is None else bool(val)


def _set_notify_enabled(enabled: bool) -> None:
    cfg = _load_config()
    cfg["notify_orders"] = bool(enabled)
    _save_config(cfg)


def _get_notify_sound_enabled() -> bool:
    val = _load_config().get("notify_sound")
    return True if val is None else bool(val)


def _set_notify_sound_enabled(enabled: bool) -> None:
    cfg = _load_config()
    cfg["notify_sound"] = bool(enabled)
    _save_config(cfg)


def _fetch_admin_orders() -> list[dict] | None:
    """admin 토큰으로 /api/admin/orders 호출. 실패 시 None.
    백엔드가 createdAt 내림차순으로 반환하므로 첫 항목이 최신."""
    token = _get_admin_token()
    if not token:
        return None
    url = f"{API_BASE}/api/admin/orders"
    req = urllib.request.Request(url, method="GET")
    req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return data if isinstance(data, list) else None
    except urllib.error.HTTPError as e:
        # 401 이면 토큰 캐시 무효화 → 다음 호출에서 재로그인.
        if e.code in (401, 403):
            with _admin_token_lock:
                _admin_token_cache["token"] = None
        return None
    except Exception:
        return None


def _fetch_admin_clients() -> list[dict] | None:
    """admin 토큰으로 /api/admin/clients 호출 — 분배함 사진 다이얼로그 [신규 작성] 탭의
    "큐가 비어있을 때 거래처 검색 → 새 빈 주문 발급" 흐름에 사용. ACTIVE/PENDING_SIGNUP 만 반환."""
    token = _get_admin_token()
    if not token:
        return None
    url = f"{API_BASE}/api/admin/clients"
    req = urllib.request.Request(url, method="GET")
    req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        if not isinstance(data, list):
            return None
        return [c for c in data if c.get("status") in ("ACTIVE", "PENDING_SIGNUP")]
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            with _admin_token_lock:
                _admin_token_cache["token"] = None
        return None
    except Exception:
        return None


def _create_qr_only_order(client_id: int,
                          due_iso: str | None = None,
                          delivery_enum: str | None = None,
                          delivery_address: str | None = None) -> dict | None:
    """admin 토큰으로 POST /api/admin/orders/qr-only — 빈 주문(번호만 부여) 생성.
    어드민의 옛 [기존지시서에 QR코드만 생성] 패널이 호출하던 엔드포인트와 동일.
    워처 [신규 작성] 폼에서 입력한 납기/배송도 같이 보내 한 번에 채운다.
    due_iso: 'YYYY-MM-DD' 또는 None/빈값. delivery_enum: 백엔드 enum 명 또는 None/빈값.
    응답 dict (orderNumber, clientCompanyName 등) 반환. 실패 시 None."""
    token = _get_admin_token()
    if not token:
        ui_log("빈 주문 생성 실패: admin 토큰 없음(config.json 의 admin_username/password 확인).")
        return None
    from urllib.parse import urlencode
    params: list[tuple[str, str]] = [("clientId", str(int(client_id)))]
    if due_iso:
        params.append(("dueDate", due_iso))
    if delivery_enum:
        params.append(("deliveryMethod", delivery_enum))
    if delivery_address:
        params.append(("deliveryAddress", delivery_address))
    url = f"{API_BASE}/api/admin/orders/qr-only?{urlencode(params)}"
    req = urllib.request.Request(url, method="POST", data=b"")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return data if isinstance(data, dict) else None
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            with _admin_token_lock:
                _admin_token_cache["token"] = None
        # 백엔드 에러 메시지를 로그에 남겨 디버깅 가능하게(특히 500 시 스택트레이스 단서).
        body_excerpt = ""
        try:
            raw = e.read()
            if raw:
                body_excerpt = raw.decode("utf-8", errors="replace").strip()
                if len(body_excerpt) > 500:
                    body_excerpt = body_excerpt[:500] + "…"
        except Exception:
            pass
        if body_excerpt:
            ui_log(f"빈 주문 생성 실패(HTTP {e.code}): {e.reason} — {body_excerpt}")
        else:
            ui_log(f"빈 주문 생성 실패(HTTP {e.code}): {e.reason}")
        return None
    except Exception as e:
        ui_log(f"빈 주문 생성 실패: {e}")
        return None


def play_alert_sound() -> None:
    """시스템 알림음 비동기 재생. winsound 없는 환경(예: 다른 OS)에서는 무시."""
    if winsound is None:
        return
    try:
        winsound.PlaySound("SystemExclamation",
                           winsound.SND_ALIAS | winsound.SND_ASYNC)
    except Exception:
        pass


def _request_type_label(req_type: str | None) -> str:
    return {
        "QUOTE": "견적요청",
        "ORDER": "발주",
    }.get((req_type or "").upper(), "신규 작업")


def format_order_alert(order: dict) -> tuple[str, str]:
    """주문 dict → (배너 제목, 본문) 튜플.
    제목엔 발주/견적 구분, 본문엔 거래처 · 작업명 · 주문번호."""
    rt = _request_type_label(order.get("requestType"))
    company = (order.get("clientCompanyName") or "").strip() or "(거래처 미상)"
    title_text = (order.get("title") or "").strip()
    order_no = (order.get("orderNumber") or "").strip()
    parts = [company]
    if title_text:
        parts.append(title_text)
    if order_no:
        parts.append(f"#{order_no}")
    return f"새 {rt}", " · ".join(parts)


def start_order_alert_loop():
    """30초 간격으로 admin orders 폴링 → 새 주문 감지 시 UI 큐로 알림 전달.
    config 의 admin_username/password 가 없으면 조용히 대기. 설정 추가 후 자동 활성."""
    def _run():
        # baseline: state 파일이 비어 있으면 첫 폴링에서 현재 최신 id 만 잡고 알림은 생략.
        state = _load_alert_state()
        last_seen_id = state.get("last_seen_id")
        first_pass = last_seen_id is None

        while True:
            try:
                if not _get_notify_enabled():
                    time.sleep(_ORDER_ALERT_INTERVAL_SEC)
                    continue
                orders = _fetch_admin_orders()
                if not orders:
                    time.sleep(_ORDER_ALERT_INTERVAL_SEC)
                    continue

                # createdAt 내림차순 — orders[0] 이 최신.
                top_id = orders[0].get("id") or 0
                if first_pass:
                    last_seen_id = top_id
                    _save_alert_state({"last_seen_id": last_seen_id})
                    first_pass = False
                else:
                    new_orders = [
                        o for o in orders
                        if (o.get("id") or 0) > (last_seen_id or 0)
                        and not o.get("deletedAt")
                    ]
                    if new_orders:
                        # 오래된 → 최신 순으로 알림(작업 흐름이 자연스럽도록).
                        for o in reversed(new_orders):
                            title_text, body = format_order_alert(o)
                            _ui_queue.put(("notify_order", title_text, body))
                        last_seen_id = top_id
                        _save_alert_state({"last_seen_id": last_seen_id})
            except Exception as e:
                ui_log(f"새 주문 알림 루프 오류: {e}")
            time.sleep(_ORDER_ALERT_INTERVAL_SEC)

    threading.Thread(target=_run, daemon=True).start()


def resolve_new_due_date_md(current_iso: str, month_input: int, day_input: int) -> date:
    """월+일을 명시적으로 입력받는 폼용 — 연도는 '오늘' 기준으로 정하고, 입력한 월/일이 올해
    기준으로 이미 지났으면(=오늘보다 과거) 다음 해로 롤오버. 잘못된 조합(2/30 등)은 그 달 말일로 클램프.

    current_iso(현재 납기)는 연도 기준으로 쓰지 않는다(인자는 호출부 호환을 위해 유지). 예전엔
    current_iso 를 기준으로 '입력<현재납기면 내년'으로 굴려서, 납기를 *현재보다 이른 날*로 당기면
    멀쩡한 가까운 미래인데도 내년으로 넘어갔다(실측 버그: 06-14→06-11 입력이 2027-06-11 로 저장,
    05-22→05-20 이 2027-05-20 으로 저장). 기준을 오늘로 바꿔 '이미 지난 날짜만' 내년으로 민다."""
    today = date.today()
    year = today.year

    def _clamped(y: int, m: int, d: int) -> date:
        try:
            return date(y, m, d)
        except ValueError:
            # 잘못된 월/일 조합 — 해당 월 말일로 클램프
            if m == 12:
                next_first = date(y + 1, 1, 1)
            else:
                next_first = date(y, m + 1, 1)
            return next_first - timedelta(days=1)

    candidate = _clamped(year, month_input, day_input)
    if candidate < today:
        # 입력 월/일이 올해 기준 이미 지났음 → 같은 월/일의 내년.
        candidate = _clamped(year + 1, month_input, day_input)
    return candidate


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
    """시스템 기본 프린터를 PDF24 로 전환 — 워처 실행 동안 계속 유지.
    이전 기본 프린터를 _saved_default_printer 에 보관해 워처 종료 시 on_close 에서 복구.
    이미 PDF24 로 되어 있으면 무동작. PDF24 가 시스템에 없으면 명확한 경고 로그.
    종이 인쇄(print_pdf_to_paper)는 시스템 기본과 무관하게 삼성으로 직접 가므로
    PDF24 가 상시 기본이어도 종이 출력에 영향 없음."""
    global _saved_default_printer
    with _printer_lock:
        current = _get_default_printer()
        if not current:
            return
        if current == PDF24_PRINTER_NAME:
            return
        # PDF24 미설치를 직접 확인해 사용자에게 또렷한 안내 — SetDefaultPrinter 가 실패해도
        # 메시지가 모호해서 'PDF24 설치/이름 확인' 단계로 유도하기 어려움.
        installed = _list_installed_printers()
        if installed and PDF24_PRINTER_NAME not in installed:
            ui_log(
                f"⚠ PDF24 프린터를 못 찾음 — FlexSign 인쇄가 PDF24 로 가지 않습니다. "
                f"제어판 → 장치 및 프린터에서 'PDF24' 이름 확인 (현재 설치 목록: {', '.join(installed)})"
            )
            return
        # 이미 한 번 전환해 두고 아직 복구되지 않았다면, 원래 값을 덮어쓰지 않는다.
        if _saved_default_printer is None:
            _saved_default_printer = current
        if _set_default_printer(PDF24_PRINTER_NAME):
            ui_log(f"기본 프린터: {current} → {PDF24_PRINTER_NAME} (워처 종료 시 자동 복구)")
        else:
            # 전환 실패 시 저장된 값도 의미 없으므로 비운다.
            _saved_default_printer = None


def restore_default_printer() -> None:
    """워처 종료(on_close) 시 호출 — 시작할 때 보관해둔 원래 기본 프린터로 복구."""
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


def print_pdf_to_paper(pdf_path: Path, copies: int = 1) -> bool:
    """현재 PC 에 설치된 삼성 프린터로 직접 PDF 인쇄. 시스템 기본 프린터를 건드리지 않으므로
    노트북처럼 기본이 PDF24 로 잡혀 있어도 종이는 항상 삼성으로 간다.
    0차(권장): SumatraPDF — 무음 + 인쇄 후 자동종료. 한PDF/Acrobat 같은 무거운 핸들러를 우회.
    1차: ShellExecute "printto" — OS 기본 PDF 핸들러에 위임. SumatraPDF 미설치 시 폴백.
    2차: 기본 프린터를 잠깐 그 프린터로 바꾼 뒤 "print" 동사 호출.

    copies: 인쇄 매수. SumatraPDF 는 -print-settings "<N>x" 로 한 번에 처리.
            ShellExecute 폴백은 N 회 반복 호출."""
    if copies < 1:
        # 다이얼로그 [✓ 적용하기] 미클릭 = 매수 0 = 의도적 인쇄 생략. 호출자에게는
        # 실패가 아니라 "정상적으로 아무 일도 안 했다" 고 True 로 알린다.
        return True

    target = resolve_paper_printer()
    if not target:
        ui_log("종이 프린터를 찾지 못함 — PAPER_PRINTER_CANDIDATES 또는 PAPER_PRINTER_PATTERN 확인 필요")
        return False

    # 0차: SumatraPDF — 핸들러 매개 없이 직접 프린터로 보냄. 기존 한PDF/Adobe 가 매번 로드되며
    # 발생하던 1~5초 지연이 사라지고, -exit-on-print 로 파일 핸들도 즉시 해제됨.
    # 매수는 -print-settings "<N>x" 가 일부 프린터 드라이버에서 무시되는 사례가 있어
    # 호출 자체를 N 회 반복하는 방식으로 통일 — 한 호출당 ~0.3초라 3~5장도 1~2초 수준.
    sumatra = find_sumatra_exe()
    if sumatra:
        try:
            ok_count = 0
            for i in range(copies):
                rc = subprocess.run(
                    [
                        sumatra,
                        "-print-to", target,
                        "-print-settings", "color",
                        "-silent",
                        "-exit-on-print",
                        str(pdf_path),
                    ],
                    creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0,
                    timeout=60,
                ).returncode
                if rc == 0:
                    ok_count += 1
                else:
                    ui_log(f"SumatraPDF 종료코드 {rc} ({i+1}/{copies})")
            if ok_count == copies:
                ui_log(f"종이 인쇄({target}) 전달[Sumatra/color×{copies}]: {pdf_path.name}")
                return True
            if ok_count > 0:
                ui_log(f"SumatraPDF 부분 성공 {ok_count}/{copies} — printto 폴백")
        except Exception as e:
            ui_log(f"SumatraPDF 호출 실패: {e} — printto 폴백")

    # 1차: printto 동사 — 핸들러 자체에는 매수 옵션이 없으므로 N 회 호출.
    try:
        import win32api
        ok_any = False
        for i in range(copies):
            rc = win32api.ShellExecute(
                0, "printto", str(pdf_path), f'"{target}"', None, 0
            )
            if rc > 32:
                ok_any = True
            else:
                ui_log(f"printto 거부(rc={rc}, {i+1}/{copies}) — 폴백 검토")
        if ok_any:
            ui_log(f"종이 인쇄({target}) 전달[{copies}회]: {pdf_path.name}")
            return True
    except Exception as e:
        ui_log(f"printto 예외: {e} — 기본 프린터 임시 전환 방식으로 폴백")

    # 2차: 기본 프린터 임시 전환
    with _printer_lock:
        prev = _get_default_printer()
        if not _set_default_printer(target):
            ui_log(f"종이 프린터({target}) 기본 설정 실패 — 인쇄 보류")
            return False
        try:
            for _ in range(copies):
                ctypes.windll.shell32.ShellExecuteW(0, "print", str(pdf_path), None, None, 0)
                # ShellExecute 는 비동기 — 스풀러가 PDF 를 가져갈 시간을 둔다.
                time.sleep(2.0)
            ui_log(f"종이 인쇄({target}) 전달(폴백×{copies}): {pdf_path.name}")
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
            # 1차: 백엔드 썸네일 프록시(/api/public/worksheets/{n}/thumbnail) — 가장 빠름.
            # R2 가 워처 PC 의 직접 GET 을 403 으로 막는 환경(=일부 사무실 PC) 에서도 백엔드를 거쳐
            # 항상 받을 수 있다. PDF 다운로드+렌더 대비 5~10배 빠르게 표시.
            thumb_proxy_url = f"{API_BASE}/api/public/worksheets/{quote(order_num, safe='')}/thumbnail"
            try:
                with urllib.request.urlopen(_safe_url(thumb_proxy_url), timeout=10) as resp:
                    data = resp.read()
                pil = Image.open(io.BytesIO(data))
                # 비율 유지 리사이즈 — target_width 안 넘게.
                pil.thumbnail((target_width, target_width * 4), Image.LANCZOS)
                _thumbnail_pil_cache[order_num] = pil
                _publish(order_num)
                continue
            except urllib.error.HTTPError as e:
                # 404 (worksheetThumbnailUrl 미생성 옛 데이터) 는 정상 — PDF 폴백 조용히.
                # 그 외(500/배드 게이트웨이/네트워크) 는 로그.
                if e.code != 404:
                    ui_log(f"썸네일 프록시 실패 [{order_num}]: HTTP {e.code} — PDF 폴백")
            except Exception as e:
                ui_log(f"썸네일 프록시 실패 [{order_num}]: {e} — PDF 폴백")

            # 2차: PDF 받아 PyMuPDF 로 첫 페이지 렌더 — 옛 데이터(thumbnailUrl 미생성) 폴백.
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
                              qr_order_number: str | None = None,
                              clients_for_new: list[dict] | None = None,
                              intent: str = "web_print") -> dict | None:
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
        "department_tags": list[str],      # 분배함 클릭으로 결정된 모바일 부서(중복 제거)
        "department_slots": list[str],     # 직원이 클릭한 슬롯 라벨(부서가 같아도 슬롯이 다른 경우 구분용)
      }
    """
    # Zinc + emerald 베이스 — 모노톤에 메인 액션만 포인트 그린.
    BG = "#ffffff"          # 다이얼로그·헤더·탭 배경(순백)
    BG_SOFT = "#fafafa"     # 카드/섹션 배경(살짝 톤다운)
    BG_CARD = "#ffffff"     # 입력 카드(흰색 — BG_SOFT 위에 띄움)
    BORDER = "#e4e4e7"      # 보더/구분선
    TITLE_FG = "#18181b"    # 제목·강조 텍스트
    LABEL_FG = "#3f3f46"    # 일반 라벨
    SUB_FG = "#71717a"      # 보조/설명 텍스트
    ACCENT = "#10b981"      # 메인 액션(에메랄드)
    ACCENT_HOVER = "#059669"

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

    # 우측 slots_col(폭 ~310)을 통째로 pick_page 가 차지 — 1열 × 큰 썸네일.
    THUMB_W = 220
    THUMB_H = int(THUMB_W * 1.414)  # A4 portrait 비율

    result: dict = {"value": None}

    dlg = tk.Toplevel()
    dlg.title("웹에 변경사항 적용하기")
    dlg.configure(bg=BG)
    dlg.resizable(False, False)
    dlg.attributes("-topmost", True)

    # 최종 의도(intent) — form_col 하단 라디오로 사용자가 결정한다. 호출자는 기본값 'web_print'
    # 로 dialog 를 열고, 사용자가 web_only / paper_only 로 바꾸면 confirm() 결과에 반영된다.
    intent_var = tk.StringVar(
        value=intent if intent in ("web_print", "web_only", "paper_only") else "web_print"
    )
    # 세로형 — 메인은 ③ 분배함 사진. 사용자는 이 다이얼로그를 화면 좌측 끝에 붙이고
    # 우측 빈 공간에 FlexiSign 지시서를 띄워 확대해 보면서 어느 칸에 꽂을지 결정한다.
    # 좁은 폭(440)이면 1920px 모니터에서도 FlexiSign 영역 1480px 가 확보됨.
    # 2단 세로 — 좌측 form_col(폼+버튼) 260, 우측 slots_col(분배함+매수) ~340.
    # ③ 분배함 사진이 메인 시각 요소라 우측 단 폭과 다이얼로그 세로를 사진에 맞춰 잡음.
    # 폭 660 으로 1920px 모니터에 FlexiSign 1260px 확보(여전히 충분).
    DLG_W = 660
    dlg.update_idletasks()
    sw = dlg.winfo_screenwidth()
    sh = dlg.winfo_screenheight()
    # photo 320 wide → height 511. 매수 ~170, 헤더/패딩 ~80 → DLG_H ~870 필요.
    # 사진을 메인으로 키우라는 요청이라 세로 800~920 사이로 클램프.
    DLG_H = min(920, max(800, sh - 50))
    # 화면 우측 끝 + 세로 중앙 도킹.
    dlg_x = max(0, sw - DLG_W)
    dlg_y = max(20, (sh - DLG_H) // 2)
    dlg.geometry(f"{DLG_W}x{DLG_H}+{dlg_x}+{dlg_y}")
    # ③ 분배함 사진 — 우측 컬럼(약 340px) 거의 꽉 채워 320 폭(높이 511). 메인 시각 요소.
    PHOTO_DISPLAY_WIDTH = 320

    # PDF 미리보기/줌 헬퍼는 폐기 — 작업자가 FlexiSign 에서 직접 확대해 보면서 분배함을
    # 결정하는 워크플로로 바뀌었기 때문. 이 다이얼로그는 분배함/매수/폼만 담당.

    body = tk.Frame(dlg, bg=BG)
    body.pack(fill="both", expand=True)
    # 단일 컬럼 — 헤더 → 노트북(폼) → ③ 분배함 사진 → ④ 매수 → 액션 버튼.
    # 분배함 사진은 화면 가운데 메인 시각 요소. 이전 우측 분리 패널은 폐기.
    left = tk.Frame(body, bg=BG)
    left.pack(side="left", fill="both", expand=True)

    # ── 헤더 ────────────────────────────────────────────────
    header = tk.Frame(left, bg=BG)
    header.pack(fill="x", padx=14, pady=(12, 0))

    tk.Label(
        header, text="웹에 변경사항 적용하기",
        bg=BG, fg=TITLE_FG,
        font=("맑은 고딕", 13, "bold"), anchor="w",
    ).pack(fill="x")
    tk.Label(
        header,
        text="좌측 폼 작성 → 우측 분배함 클릭 → 매수 적용",
        bg=BG, fg=SUB_FG,
        font=("맑은 고딕", 9), anchor="w",
    ).pack(fill="x", pady=(2, 0))

    # ── QR 인식 결과 배너 (헤더 아래, 전체 폭) ───────────────
    # 세로형이라 헤더 우측에 못 들어감 → 별도 줄로 분리. _apply_qr_routing 가 채운다.
    qr_banner_holder = tk.Frame(left, bg=BG)
    qr_banner_var = tk.StringVar(value="")
    qr_banner_label = tk.Label(
        qr_banner_holder, textvariable=qr_banner_var,
        bg="#ecfdf5", fg="#065f46",
        font=("맑은 고딕", 10, "bold"),
        anchor="center", justify="left",
        padx=12, pady=8, wraplength=420,
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
        # 헤더 바로 아래(구분선 위)에 끼워 넣기 — 안 그러면 dynamic pack 이 맨 아래로 감.
        qr_banner_holder.pack(fill="x", padx=14, pady=(8, 0),
                              before=header_divider)
        qr_banner_label.pack(fill="x")

    header_divider = tk.Frame(left, bg=BORDER, height=1)
    header_divider.pack(fill="x", padx=14, pady=(10, 0))

    def _day_from_iso(iso: str) -> str:
        if not iso:
            return ""
        try:
            return str(date.fromisoformat(iso).day)
        except ValueError:
            return ""

    def _month_from_iso(iso: str) -> str:
        if not iso:
            return ""
        try:
            return str(date.fromisoformat(iso).month)
        except ValueError:
            return ""

    _WD_KO = ["월", "화", "수", "목", "금", "토", "일"]

    def _format_md_preview(month_str: str, day_str: str, base_iso: str) -> str:
        """월+일 입력으로부터 최종 납기 미리보기 — '→ 12월 15일 (화)'.
        년은 base_iso 기준이고, 입력 날짜가 base 보다 과거면 다음 해로 롤오버."""
        ms = (month_str or "").strip()
        ds = (day_str or "").strip()
        if not (ms.isdigit() and ds.isdigit()):
            return ""
        m, d = int(ms), int(ds)
        if not (1 <= m <= 12 and 1 <= d <= 31):
            return ""
        try:
            resolved = resolve_new_due_date_md(base_iso, m, d)
        except Exception:
            return ""
        return f"→ {resolved.month}월 {resolved.day}일 ({_WD_KO[resolved.weekday()]})"

    # ── 탭 컨테이너 ─────────────────────────────────────────
    # 세로형 — notebook 은 폼 영역만 담당. 높이를 제한해 그 아래의 ③ 분배함 사진이
    # 메인 시각 요소가 되도록 유지. pick_page 의 worksheet 그리드는 자체 스크롤로 처리.
    style = ttk.Style()
    try:
        style.configure("HD.TNotebook", background=BG, borderwidth=0)
        style.configure("HD.TNotebook.Tab",
                        padding=(14, 6), font=("맑은 고딕", 10, "bold"))
    except Exception:
        pass

    # ── 본문 2단 분할 ────────────────────────────────────
    # 좌측(form_col): notebook(신규/기존 폼). 우측(slots_col): ③ 분배함 + ④ 매수.
    body_split = tk.Frame(left, bg=BG)
    body_split.pack(fill="both", expand=True, padx=14, pady=(10, 0))

    form_col = tk.Frame(body_split, bg=BG, width=260)
    form_col.pack_propagate(False)
    form_col.pack(side="left", fill="y")

    slots_col = tk.Frame(body_split, bg=BG)
    slots_col.pack(side="left", fill="both", expand=True, padx=(12, 0))

    notebook = ttk.Notebook(form_col, style="HD.TNotebook")
    notebook.pack(fill="both", expand=True)

    new_tab = tk.Frame(notebook, bg=BG)
    modify_tab = tk.Frame(notebook, bg=BG)
    notebook.add(new_tab, text="신규 작성")
    notebook.add(modify_tab, text="기존 변경")

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
    # 두 가지 흐름:
    #   (A) qr_order_number 가 있고 most_recent 가 있는 = 자동작성 + 큐 매칭. 거래처/주문번호는
    #       이미 결정. 직원이 입력할 건 납기/배송 뿐 → [✓ 적용] 누르면 그대로 R2 업로드.
    #   (B) qr_order_number 가 없는 = FlexSign 손작업 신규 지시서. 거래처 검색 + 납기/배송 입력 +
    #       분배함 클릭 → [✓ 적용] 누르면 백엔드에 빈 주문(거래처+납기+배송+분배함 슬롯) 생성 +
    #       QR + 발주번호를 클립보드에 복사. 본 PDF 는 R2 업로드 X — QR 없는 PDF 가 그대로
    #       올라가면 모바일 워커가 QR 못 읽으므로, 사용자가 클립보드 QR 을 FlexSign 에 붙여
    #       저장 후 재인쇄하면 그 두 번째 인쇄가 자동 매칭되어 R2 업로드 된다.
    new_day_var = tk.StringVar()
    new_month_var = tk.StringVar()
    new_delivery_var = tk.StringVar()
    new_day_entry: tk.Entry | None = None

    if qr_order_number is not None and most_recent is not None:
        # ── (A) 자동작성 + 큐 매칭 — 거래처/주문번호는 결정. 납기/배송만 입력. ───
        info_card = tk.Frame(new_tab, bg=BG_SOFT,
                             highlightbackground=BORDER, highlightthickness=1)
        info_card.pack(fill="x", pady=(10, 0))
        company = (most_recent.get("companyName") or "거래처 미상").strip()
        # 파일제목: 자동지시서 흐름이라면 ZIP 안의 원본 .ai 파일명을, 헤더-only/매칭 실패 시
        # 폴백으로 인쇄된 PDF 파일명. 확장자는 표시 단계에서 제거.
        original_name = (most_recent.get("originalFileName") or "").strip()
        if original_name:
            file_title = re.sub(r"\.ai$", "", original_name, flags=re.IGNORECASE)
        else:
            file_title = re.sub(r"\.pdf$", "", pdf_path.name, flags=re.IGNORECASE)
        info_text = f"{company}  /  {file_title}  /  {most_recent.get('orderNumber') or ''}"
        tk.Label(info_card, text="현재 지시서",
                 bg=BG_SOFT, fg=SUB_FG,
                 font=("맑은 고딕", 9), anchor="w").pack(fill="x", padx=12, pady=(8, 1))
        tk.Label(info_card, text=info_text,
                 bg=BG_SOFT, fg=TITLE_FG,
                 font=("맑은 고딕", 10, "bold"), anchor="w",
                 wraplength=250, justify="left"
                 ).pack(fill="x", padx=12, pady=(0, 8))

        sec2 = tk.Frame(new_tab, bg=BG)
        sec2.pack(fill="x", pady=(10, 0))
        tk.Label(sec2, text="② 최종납기일",
                 bg=BG, fg=TITLE_FG,
                 font=("맑은 고딕", 10, "bold"), anchor="w").pack(fill="x")

        fields_card = tk.Frame(sec2, bg=BG_SOFT,
                               highlightbackground=BORDER, highlightthickness=1)
        fields_card.pack(fill="x", pady=(8, 0))
        fields = tk.Frame(fields_card, bg=BG_SOFT)
        fields.pack(padx=14, pady=(12, 4), anchor="w", fill="x")

        tk.Label(fields, text="납기", bg=BG_SOFT, fg=LABEL_FG,
                 font=("맑은 고딕", 10, "bold")).pack(side="left")
        _new_base_iso = most_recent.get("dueDate") or ""
        new_month_var.set(_month_from_iso(_new_base_iso))
        new_day_var.set(_day_from_iso(_new_base_iso))

        new_month_entry = tk.Entry(
            fields, textvariable=new_month_var, width=3, justify="center",
            font=("맑은 고딕", 13, "bold"),
            relief="solid", bd=1, bg="white", highlightthickness=0,
        )
        new_month_entry.pack(side="left", padx=(6, 2))
        tk.Label(fields, text="월", bg=BG_SOFT, fg=LABEL_FG,
                 font=("맑은 고딕", 10)).pack(side="left", padx=(0, 4))
        new_day_entry = tk.Entry(
            fields, textvariable=new_day_var, width=3, justify="center",
            font=("맑은 고딕", 13, "bold"),
            relief="solid", bd=1, bg="white", highlightthickness=0,
        )
        new_day_entry.pack(side="left", padx=(0, 2))
        tk.Label(fields, text="일", bg=BG_SOFT, fg=LABEL_FG,
                 font=("맑은 고딕", 10)).pack(side="left")
        new_due_preview = tk.Label(
            fields_card, text="", bg=BG_SOFT, fg="#0f766e",
            font=("맑은 고딕", 10, "bold"), anchor="w",
        )
        new_due_preview.pack(fill="x", padx=14, pady=(0, 4))

        # 월 입력이 1~12 의 유효한 값이 되면 자동으로 일 입력으로 포커스 이동.
        def _maybe_advance_month_to_day(*_):
            s = (new_month_var.get() or "").strip()
            if s.isdigit():
                v = int(s)
                if 1 <= v <= 12 and (len(s) == 2 or v >= 2):
                    new_day_entry.focus_set()
                    new_day_entry.select_range(0, "end")
            _refresh_new_due_preview()

        def _refresh_new_due_preview(*_):
            new_due_preview.config(
                text=_format_md_preview(new_month_var.get(), new_day_var.get(), _new_base_iso)
            )

        new_month_var.trace_add("write", _maybe_advance_month_to_day)
        new_day_var.trace_add("write", _refresh_new_due_preview)
        _refresh_new_due_preview()

        new_delivery_section = tk.Frame(fields_card, bg=BG_SOFT)
        new_delivery_section.pack(fill="x", padx=14, pady=(0, 10))
        tk.Label(new_delivery_section, text="배송", bg=BG_SOFT, fg=LABEL_FG,
                 font=("맑은 고딕", 10, "bold"), anchor="w").pack(fill="x")
        new_delivery_var.set(
            DELIVERY_ENUM_TO_KO.get(most_recent.get("deliveryMethod") or "", "")
        )
        new_delivery_btns: dict[str, tk.Button] = {}

        def _set_new_delivery(label: str):
            new_delivery_var.set(label)
            for k, btn in new_delivery_btns.items():
                if k == label:
                    btn.config(bg="#0f766e", fg="white", relief="solid")
                else:
                    btn.config(bg="white", fg=LABEL_FG, relief="solid")

        new_delivery_grid = tk.Frame(new_delivery_section, bg=BG_SOFT)
        new_delivery_grid.pack(fill="x", pady=(4, 0))
        new_delivery_grid.columnconfigure(0, weight=1, uniform="dlv")
        new_delivery_grid.columnconfigure(1, weight=1, uniform="dlv")
        for i, label in enumerate(DELIVERY_ENUM_TO_KO.values()):
            r, c = i // 2, i % 2
            b = tk.Button(
                new_delivery_grid, text=label,
                font=("맑은 고딕", 9),
                bg="white", fg=LABEL_FG,
                relief="solid", bd=1,
                padx=4, pady=3,
                command=lambda lbl=label: _set_new_delivery(lbl),
                cursor="hand2",
            )
            b.grid(row=r, column=c, sticky="ew",
                   padx=(0 if c == 0 else 4), pady=2)
            new_delivery_btns[label] = b
        if new_delivery_var.get():
            _set_new_delivery(new_delivery_var.get())
    elif qr_order_number is not None:
        # ── (A') QR 디코드 됐는데 most_recent 가 비어있는 매우 드문 엣지 — 폴백 안내. ──
        tk.Label(new_tab, text="이 인쇄본의 QR 매칭 정보가 부족합니다.",
                 bg=BG, fg=TITLE_FG, font=("맑은 고딕", 11, "bold"),
                 anchor="w", justify="left", wraplength=240,
                 ).pack(fill="x", padx=2, pady=(10, 4))
        tk.Label(new_tab,
                 text="[기존 변경] 탭에서 작업 지시서를 직접 골라 진행해 주세요.",
                 bg=BG, fg=SUB_FG, font=("맑은 고딕", 9),
                 anchor="w", justify="left", wraplength=240,
                 ).pack(fill="x", padx=2, pady=(0, 8))
    else:
        # ── (B) QR 없는 첫 인쇄 — 거래처/발주 발급 흐름은 메인 GUI [QR 코드 만들기] 가 담당. ──
        # 인쇄 다이얼로그 안에서는 발주를 만들지 않는다. 사용자는 한 단계 뒤로 돌아가
        # 메인의 [QR 코드 만들기] 로 발주번호를 만들고 FlexSign 에 붙여넣은 뒤 다시 인쇄해야 한다.
        # 또는 [기존 변경] 탭에서 이미 등록된 작업을 골라 매칭할 수도 있음.
        tk.Label(new_tab, text="QR 이 없는 인쇄본",
                 bg=BG, fg=TITLE_FG,
                 font=("맑은 고딕", 11, "bold"), anchor="w"
                 ).pack(fill="x", padx=2, pady=(10, 4))
        tk.Label(new_tab,
                 text="이 PDF 안에서 QR 코드를 찾지 못했습니다.\n\n"
                      "[QR 코드 만들기] 버튼으로 발주번호 QR 을 먼저 만든 뒤\n"
                      "FlexSign 에 붙여넣고 다시 인쇄해주세요.\n\n"
                      "또는 우측 [기존 변경] 탭에서 이미 등록된 작업지시서를\n"
                      "직접 선택해 매칭할 수 있습니다.",
                 bg=BG, fg=SUB_FG, font=("맑은 고딕", 9),
                 anchor="w", justify="left", wraplength=240
                 ).pack(fill="x", padx=2, pady=(0, 10))

        def _on_open_qr_create():
            # 인쇄 다이얼로그를 그대로 둔 채 별도 모달을 띄움. 사용자가 거기서 QR 만들고
            # FlexSign 으로 돌아가 작업할 수 있도록 한다.
            try:
                open_qr_create_dialog_async()
            except Exception as e:
                ui_log(f"[QR 코드 만들기] 열기 실패: {e}")

        tk.Button(
            new_tab, text="QR 코드 만들기 열기",
            bg="#10b981", fg="white",
            activebackground="#059669", activeforeground="white",
            font=("맑은 고딕", 10, "bold"),
            relief="flat", bd=0, padx=14, pady=8, cursor="hand2",
            command=_on_open_qr_create,
        ).pack(fill="x", padx=2, pady=(0, 6))

    # ── [기존 변경] 탭 ─────────────────────────────────────
    # 두 페이지: pick_page(그리드) → chosen_page(라디오+폼). pack/unpack 으로 토글.
    modify_state: dict = {"selected_ws": None, "change_type": None}
    chosen_widgets: dict = {}

    # chosen_page 는 form_col(modify_tab) 안에 항상 존재 — 폼 입력은 좌측에서 받는다.
    # pick_page 는 slots_col 의 photo_panel 과 sibling — "다른 지시서" 누르면 토글.
    # 이렇게 하면 썸네일이 우측 슬롯 영역(약 310px)을 꽉 채워 크게 보이고,
    # 지시서 선택 후엔 다시 photo_panel(분배함 사진) 로 돌아온다.
    chosen_page = tk.Frame(modify_tab, bg=BG)
    chosen_page.pack(fill="both", expand=True)
    # ws 미선택 상태의 안내 — _refresh_chosen 이 chosen_page 자식을 다 지우므로 자동 사라짐.
    tk.Label(chosen_page,
             text="→ 우측에서 작업할 지시서를 선택하세요",
             bg=BG, fg=SUB_FG, font=("맑은 고딕", 10),
             anchor="w", justify="left", wraplength=240,
             ).pack(fill="x", padx=8, pady=24)
    # pick_page 는 slots_col 자식 — photo_panel 과 sibling. 토글로 보이거나 숨김.
    pick_page = tk.Frame(slots_col, bg=BG)

    def show_pick_in_slots():
        """우측 slots_col 을 사진 → 큰 썸네일 그리드로 전환."""
        try:
            photo_panel.pack_forget()
            pick_page.pack(fill="both", expand=True)
        except Exception:
            pass

    def show_photo_in_slots():
        """우측 slots_col 을 큰 썸네일 그리드 → 분배함 사진으로 복귀."""
        try:
            pick_page.pack_forget()
            photo_panel.pack(fill="both", expand=True)
        except Exception:
            pass

    # 호환 alias — 기존 호출자가 show_pick/show_chosen 으로 부르므로 유지.
    show_pick = show_pick_in_slots
    show_chosen = show_photo_in_slots

    if not existing_worksheets:
        tk.Label(pick_page,
                 text="기존 작업지시서가 없습니다.\n신규 작성 탭을 사용하세요.",
                 bg=BG, fg=SUB_FG, font=("맑은 고딕", 10),
                 anchor="w", justify="left").pack(fill="x", padx=2, pady=24)
    else:
        # ── pick_page 헤더 (뒤로가기 + 안내) ─────────────
        pick_header = tk.Frame(pick_page, bg=BG)
        pick_header.pack(fill="x", padx=10, pady=(8, 4))
        tk.Button(pick_header, text="◀ 뒤로",
                  command=show_photo_in_slots,
                  font=("맑은 고딕", 9, "bold"),
                  bg="#f4f4f5", fg=LABEL_FG,
                  activebackground=BORDER, activeforeground=TITLE_FG,
                  relief="flat", padx=10, pady=4, cursor="hand2", bd=0,
                  ).pack(side="left")
        tk.Label(pick_header, text="어느 지시서를 변경하시나요?",
                 bg=BG, fg=TITLE_FG,
                 font=("맑은 고딕", 10, "bold"), anchor="w"
                 ).pack(side="left", padx=(10, 0))

        # 거래처/제목/주문번호 검색 — 입력 즉시 그리드 다시 렌더. 캐시된 썸네일은 즉시 재표시.
        # QR 없는 PDF (옛 데이터 정정) 케이스에서 사용자가 그 worksheet 을 빠르게 찾을 수 있게.
        pick_search_var = tk.StringVar()
        pick_search_entry = tk.Entry(pick_page, textvariable=pick_search_var,
                                     font=("맑은 고딕", 10), bg="white",
                                     relief="solid", bd=1, highlightthickness=0)
        pick_search_entry.pack(fill="x", padx=10, pady=(0, 4))
        tk.Label(pick_page, text="거래처 / 제목 / 주문번호 검색",
                 bg=BG, fg=SUB_FG, font=("맑은 고딕", 8),
                 anchor="w").pack(fill="x", padx=14, pady=(0, 4))

        # 스크롤 가능한 그리드 — Canvas + 내부 Frame 패턴(검색 시에도 같은 캔버스 재사용).
        grid_outer = tk.Frame(pick_page, bg=BG)
        grid_outer.pack(fill="both", expand=True, padx=8, pady=(0, 8))
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

        cols = 1  # slots_col(310) 가 통째로 pick_page 가 되어 한 카드 풀폭으로 크게.
        grid_inner.grid_columnconfigure(0, weight=1, uniform="card")

        def _on_pick(ws):
            modify_state["selected_ws"] = ws
            modify_state["change_type"] = None
            _refresh_chosen()
            show_chosen()
            # 카드 클릭으로 지시서를 고르면 그 지시서에 저장돼 있던 분배함 ✓ 도 같이 복원.
            # (QR 자동 라우팅과 동일한 UX — '불러오면 이전 분배 그대로 보임'.)
            _restore_dept_tags(ws)

        def _filter_pick_items():
            q = (pick_search_var.get() or "").strip().lower()
            if not q:
                return existing_worksheets
            def _hit(w):
                hay = " ".join([
                    str(w.get("companyName") or ""),
                    str(w.get("title") or ""),
                    str(w.get("orderNumber") or ""),
                ]).lower()
                return q in hay
            return [w for w in existing_worksheets if _hit(w)]

        def _render_pick_grid():
            for child in grid_inner.winfo_children():
                child.destroy()
            items = _filter_pick_items()
            if not items:
                tk.Label(grid_inner,
                         text="검색 결과 없음" if pick_search_var.get().strip() else "표시할 지시서 없음",
                         bg=BG, fg=SUB_FG, font=("맑은 고딕", 10)).grid(
                    row=0, column=0, padx=12, pady=24, sticky="w")
                return
            thumbnail_work: list[tuple[dict, "tk.Label"]] = []
            for idx, ws in enumerate(items):
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

        pick_search_var.trace_add("write", lambda *_: _render_pick_grid())
        _render_pick_grid()

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

        # ── 상단 바: 좁은 폼 컬럼(290px)이라 세로 배치 — 위 뒤로가기, 아래 정보 카드 ─
        topbar = tk.Frame(chosen_page, bg=BG)
        topbar.pack(fill="x", pady=(8, 0))

        tk.Button(topbar, text="◀  다른 지시서",
                  command=lambda: show_pick(),
                  font=("맑은 고딕", 9, "bold"),
                  bg="#f4f4f5", fg=LABEL_FG,
                  activebackground=BORDER, activeforeground=TITLE_FG,
                  relief="flat", padx=10, pady=5, cursor="hand2", bd=0,
                  ).pack(side="left")

        info_box = tk.Frame(chosen_page, bg=BG_SOFT,
                            highlightbackground=BORDER, highlightthickness=1)
        info_box.pack(fill="x", pady=(8, 0))
        tk.Label(info_box, text=company,
                 bg=BG_SOFT, fg=TITLE_FG,
                 font=("맑은 고딕", 10, "bold"),
                 anchor="w", wraplength=240, justify="left",
                 ).pack(fill="x", padx=10, pady=(8, 0))
        sub_parts = []
        if title:
            sub_parts.append(title)
        if order_num:
            sub_parts.append(order_num)
        if sub_parts:
            tk.Label(info_box, text="  ·  ".join(sub_parts),
                     bg=BG_SOFT, fg=SUB_FG,
                     font=("맑은 고딕", 9),
                     anchor="w", wraplength=240, justify="left",
                     ).pack(fill="x", padx=10, pady=(0, 8))
        else:
            # padding 만 잡아주기 — 회사 라벨 아래 여백.
            tk.Frame(info_box, bg=BG_SOFT, height=8).pack(fill="x")

        # ── QR 없는 PDF (옛 데이터 정정) 분기 ──────────────────
        # PDF 안에 QR 이 없을 땐 라디오/입력으로 R2 업로드하면 잘못된 동작이라(QR 없는 PDF 가
        # 그대로 올라감), 단지 "이 worksheet 의 QR 만 클립보드에 복사" 흐름으로 대체.
        # 사용자는 FlexSign 캔버스에 Ctrl+V 후 다시 인쇄 → 두 번째 인쇄는 QR 박혀 있어
        # 자동 매칭 → 정상 R2 업로드.
        if qr_order_number is None:
            qr_box = tk.Frame(chosen_page, bg=BG_SOFT,
                              highlightbackground=BORDER, highlightthickness=1)
            qr_box.pack(fill="x", pady=(8, 0))
            tk.Label(qr_box, text="이 지시서가 맞습니까?",
                     bg=BG_SOFT, fg=TITLE_FG,
                     font=("맑은 고딕", 11, "bold"), anchor="w",
                     wraplength=240, justify="left",
                     ).pack(fill="x", padx=12, pady=(10, 4))
            tk.Label(qr_box,
                     text="[예] 누르면 이 주문의 QR 이 클립보드에 복사됩니다.\n"
                          "FlexSign 캔버스에 Ctrl+V 후 다시 인쇄하세요.",
                     bg=BG_SOFT, fg=SUB_FG, font=("맑은 고딕", 9),
                     wraplength=240, justify="left", anchor="w",
                     ).pack(fill="x", padx=12, pady=(0, 8))

            def _on_qr_copy_yes(_event=None):
                order_num = ws.get("orderNumber") or ""
                if not order_num:
                    return
                result["value"] = {"qr_only_copy": True, "order_number": order_num}
                dlg.destroy()

            yes_btn = tk.Button(qr_box, text="예 — QR 복사하기",
                                bg=ACCENT, fg="white",
                                font=("맑은 고딕", 11, "bold"),
                                relief="flat", bd=0, padx=14, pady=10,
                                cursor="hand2",
                                activebackground=ACCENT_HOVER,
                                activeforeground="white",
                                command=_on_qr_copy_yes)
            yes_btn.pack(fill="x", padx=12, pady=(0, 12))
            chosen_widgets["qr_only_yes_btn"] = yes_btn
            return  # 라디오/입력 폼은 그리지 않고 종료

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
        _mod_base_iso = ws.get("dueDate") or ""
        month_var_local = tk.StringVar(value=_month_from_iso(_mod_base_iso))
        day_var_local = tk.StringVar(value=_day_from_iso(_mod_base_iso))

        month_e = tk.Entry(
            fields, textvariable=month_var_local, width=3, justify="center",
            font=("맑은 고딕", 13, "bold"),
            relief="solid", bd=1, bg="white", highlightthickness=0,
        )
        month_e.pack(side="left", padx=(6, 2))
        tk.Label(fields, text="월", bg=BG_SOFT, fg=LABEL_FG,
                 font=("맑은 고딕", 10)).pack(side="left", padx=(0, 4))
        day_e = tk.Entry(
            fields, textvariable=day_var_local, width=3, justify="center",
            font=("맑은 고딕", 13, "bold"),
            relief="solid", bd=1, bg="white", highlightthickness=0,
        )
        day_e.pack(side="left", padx=(0, 2))
        tk.Label(fields, text="일", bg=BG_SOFT, fg=LABEL_FG,
                 font=("맑은 고딕", 10)).pack(side="left")
        # 납기 미리보기 — 별도 줄(좁은 form_col 에서 짤림 방지).
        mod_due_preview = tk.Label(
            inner, text="", bg=BG_SOFT, fg="#0f766e",
            font=("맑은 고딕", 10, "bold"), anchor="w",
        )
        mod_due_preview.pack(fill="x", pady=(2, 0))

        def _refresh_mod_due_preview(*_):
            mod_due_preview.config(
                text=_format_md_preview(month_var_local.get(), day_var_local.get(), _mod_base_iso)
            )

        def _maybe_advance_month_to_day_mod(*_):
            s = (month_var_local.get() or "").strip()
            if s.isdigit():
                v = int(s)
                if 1 <= v <= 12 and (len(s) == 2 or v >= 2):
                    day_e.focus_set()
                    day_e.select_range(0, "end")
            _refresh_mod_due_preview()

        month_var_local.trace_add("write", _maybe_advance_month_to_day_mod)
        day_var_local.trace_add("write", _refresh_mod_due_preview)
        _refresh_mod_due_preview()

        # 배송 — 좁은 form_col(260)에 5개 버튼 모두 보이게 라벨 위, 2열 grid 아래.
        delivery_section = tk.Frame(inner, bg=BG_SOFT)
        delivery_section.pack(fill="x", pady=(8, 0))
        tk.Label(delivery_section, text="배송", bg=BG_SOFT, fg=LABEL_FG,
                 font=("맑은 고딕", 10, "bold"), anchor="w").pack(fill="x")
        delivery_var_local = tk.StringVar(
            value=DELIVERY_ENUM_TO_KO.get(ws.get("deliveryMethod") or "", "")
        )
        mod_delivery_btns: dict[str, tk.Button] = {}

        def _set_mod_delivery(label: str):
            delivery_var_local.set(label)
            for k, btn in mod_delivery_btns.items():
                if k == label:
                    btn.config(bg="#0f766e", fg="white", relief="solid")
                else:
                    btn.config(bg="white", fg=LABEL_FG, relief="solid")

        delivery_grid = tk.Frame(delivery_section, bg=BG_SOFT)
        delivery_grid.pack(fill="x", pady=(4, 0))
        delivery_grid.columnconfigure(0, weight=1, uniform="dlv_m")
        delivery_grid.columnconfigure(1, weight=1, uniform="dlv_m")
        for i, label in enumerate(DELIVERY_ENUM_TO_KO.values()):
            r, c = i // 2, i % 2
            b = tk.Button(
                delivery_grid, text=label,
                font=("맑은 고딕", 9),
                bg="white", fg=LABEL_FG,
                relief="solid", bd=1,
                padx=4, pady=3,
                command=lambda lbl=label: _set_mod_delivery(lbl),
                cursor="hand2",
            )
            b.grid(row=r, column=c, sticky="ew",
                   padx=(0 if c == 0 else 4), pady=2)
            mod_delivery_btns[label] = b
        if delivery_var_local.get():
            _set_mod_delivery(delivery_var_local.get())

        chosen_widgets["mod_month_var"] = month_var_local
        chosen_widgets["mod_day_var"] = day_var_local
        chosen_widgets["mod_delivery_var"] = delivery_var_local
        chosen_widgets["mod_day_entry"] = day_e
        chosen_widgets["mod_month_entry"] = month_e
        month_e.bind("<Return>", confirm)
        day_e.bind("<Return>", confirm)

        # 2행: 변경된 내용 메모 — 비워두면 contentChanged 안 보냄.
        tk.Label(inner,
                 text="변경된 내용 (선택 — 모바일 뷰어 노출)",
                 bg=BG_SOFT, fg=SUB_FG,
                 font=("맑은 고딕", 9),
                 anchor="w", wraplength=220).pack(fill="x", pady=(10, 3))
        note_text = tk.Text(inner, height=2, wrap="word",
                            relief="solid", bd=1,
                            font=("맑은 고딕", 10), bg="white",
                            highlightthickness=0)
        note_text.pack(fill="x")
        chosen_widgets["mod_note_text"] = note_text
        # 이전에 저장한 변경사항 메모 복원 — 분배함 ✓ 와 같은 UX("불러오면 이전 입력 그대로").
        # 직원이 그대로 두면 동일 노트가 재업로드돼 모바일 변경 배지/뷰어 노트가 유지되고,
        # 수정/삭제하면 그 변경분이 새로 반영된다.
        saved_note = (ws.get("worksheetChangeNote") or "").strip()
        if saved_note:
            note_text.insert("1.0", saved_note)

        # 진입 시 포커스 — 월이 비어 있으면 월부터, 아니면 일에 포커스(가장 자주 바뀌는 값).
        if not (month_var_local.get() or "").strip():
            month_e.focus_set()
            month_e.select_range(0, "end")
            month_e.icursor("end")
        else:
            day_e.focus_set()
            day_e.select_range(0, "end")
            day_e.icursor("end")

        # 매칭된 지시서 PDF 미리보기는 폐기 — 작업자가 FlexiSign 에서 직접 확대해 보고
        # 분배함을 결정하므로, 다이얼로그 안에 미리보기를 두면 세로 공간만 잡아먹는다.

    # 초기 상태는 photo_panel(분배함 사진). 기존 변경 탭에서 ws 가 안 골라져 있으면
    # 탭 전환 핸들러가 자동으로 pick_page 로 토글 (아래 _on_tab_change 참고).

    def _on_tab_change(_event=None):
        try:
            sel = notebook.select()
            if sel == str(modify_tab) and modify_state.get("selected_ws") is None:
                show_pick_in_slots()
            else:
                show_photo_in_slots()
        except Exception:
            pass

    notebook.bind("<<NotebookTabChanged>>", _on_tab_change)

    def _apply_qr_routing():
        """QR 디코드 결과를 다이얼로그 초기 상태에 반영.
        - existing_worksheets 매칭(=기존 변경): 모드 자동 진입 + 'content' 라디오 + 성공 배너.
          (이전엔 매칭된 PDF 를 자동으로 큰 창으로 띄웠으나, 작업자가 [변경된 내용] 메모를
           작성하려고 다이얼로그를 클릭하는 시점에 비동기로 줌 창이 떠올라 입력을 가리는
           문제가 있어 자동 줌은 제거 — [🔍 크게 보기] 버튼으로만 연다.)
        - 인쇄 매칭 큐 매칭(=접수단계 첫 지시서): 신규 탭 + 성공 배너.
          most_recent 가 이미 그 주문으로 교체되어 있으니 그대로 [확인] 만 누르면 된다.
        - QR 디코드 자체 실패 또는 진행중/큐 어디에도 없음: 신규 탭 + 실패 배너."""
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
                # 이전에 저장한 분배함 ✓ 복원 — 직원이 다시 칸을 안 누르면 동일 분배 유지.
                _restore_dept_tags(qr_matched_ws)
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
        elif qr_matched_recent is not None:
            # 접수단계 주문 — 아직 worksheet PDF 가 없으니 existing_worksheets 에는 없지만
            # 큐(=clip-qr 호출 시 등록)에는 있다. 신규 탭으로 보내되 배너는 success 톤으로.
            try:
                _show_qr_banner(
                    "QR코드 매칭에 성공했습니다. 첫 지시서를 등록합니다.",
                    kind="success",
                )
                notebook.select(new_tab)
                _schedule_dialog_redraw()
            except Exception as e:
                ui_log(f"QR 자동 라우팅(신규) 실패: {e}")
        else:
            # QR 디코드 실패(잘림/누락) 또는 디코드는 됐지만 진행중/큐 어디에도 없음.
            # qr_order_number 가 없는(=PDF 에 QR 자체가 없음) 케이스는 [기존 변경] 탭으로 보내
            # 사용자가 등록된 지시서 중에서 직접 매칭하거나 [QR 코드 만들기] 로 가게 한다.
            # qr_order_number 가 있는데 매칭 실패한 케이스는 [신규 작성] 폴백 안내 탭.
            try:
                if qr_order_number is None:
                    _show_qr_banner(
                        "이 인쇄본에 QR 이 없습니다. 메인 [QR 코드 만들기] 로 먼저 QR 을 만들어 주세요.",
                        kind="warn",
                    )
                    notebook.select(modify_tab)
                else:
                    _show_qr_banner(
                        "QR 매칭 실패 — 등록된 지시서가 아닙니다.",
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

    # ── ③ 분배함 사진 + ④ 인쇄 매수 (우측 컬럼) ─────────────
    # 분배함 사진이 메인 — 헤더/안내 라벨 없이 사진 자체가 압도적이게.
    # 작업자는 FlexiSign 을 좌측에 띄워두고 이 사진에서 칸을 클릭한다.
    photo_panel = tk.Frame(slots_col, bg=BG_SOFT,
                           highlightbackground=BORDER, highlightthickness=1)
    photo_panel.pack(fill="both", expand=True)

    # PHOTO_DISPLAY_WIDTH 는 다이얼로그 진입 시점에 결정됨(위쪽 참조).
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
            text="분배함 사진 없음\n(hdsign-watcher/assets/distribution.jpg)",
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

    def collect_dept_slots() -> list[str]:
        """직원이 클릭한 슬롯 라벨 그대로(예: '시트/도안실'). 같은 부서 매핑 슬롯이 여러 개일 때
        '어느 칸에 꽂았는지' 까지 보존해 다음 회차에 정확 복원하기 위해 별도 수집."""
        out: list[str] = []
        for label, mapped_dept, _box in SLOT_BOXES:
            if mapped_dept and slot_active.get(label):
                out.append(label)
        return out

    summary_var = tk.StringVar(
        value="선택된 부서 없음 — 모바일 뷰어에서는 \"전체보기\"에서만 노출됩니다."
    )
    tk.Label(
        photo_panel, textvariable=summary_var,
        bg=BG_SOFT, fg=SUB_FG,
        font=("맑은 고딕", 9), anchor="w", justify="left", wraplength=320,
    ).pack(fill="x", padx=10, pady=(6, 2))

    # ── ④ 인쇄 매수 ────────────────────────────────────
    # 두 개의 독립된 [✓ 적용] 버튼 — 분배함과 더뽑기를 따로 적용. 둘 다 적용해야
    # 합산된 매수가 확정 총합으로 잡힌다(분배만 / 더뽑기만 / 둘 다 자유롭게).
    # [↺ 초기화] 는 두 확정값을 0 으로 되돌리고 더뽑기 입력도 0 으로 클리어 —
    # 슬롯 클릭(부서 분배)은 건드리지 않는다.
    # 전체를 한 Frame 으로 묶어 photo_panel 하단에 pack(side="bottom") — 좌측 form_col
    # 액션 버튼과 같은 baseline 정렬을 위해.
    quantity_section = tk.Frame(photo_panel, bg=BG_SOFT)
    quantity_section.pack(side="bottom", fill="x")

    tk.Frame(quantity_section, bg=BORDER, height=1).pack(fill="x", padx=12, pady=(0, 6))

    tk.Label(
        quantity_section, text="④ 인쇄 매수",
        bg=BG_SOFT, fg=TITLE_FG,
        font=("맑은 고딕", 10, "bold"), anchor="w",
    ).pack(fill="x", padx=12)

    copies_extra_var = tk.StringVar(value="0")
    # 적용된(확정) 매수 — 두 슬롯이 합산되어 총 매수가 됨. 액션 버튼은 이 합만 본다.
    committed = {"slot": 0, "extra": 0}

    def _calc_copies() -> tuple[int, int]:
        """(slot_n, extra_n) — 라이브 슬롯 칸 수와 더뽑기 입력값. 둘 다 0 이상."""
        slot_n = sum(
            1 for label, mapped, _ in SLOT_BOXES
            if mapped and slot_active.get(label)
        )
        try:
            extra_n = int((copies_extra_var.get() or "0").strip() or "0")
        except ValueError:
            extra_n = 0
        if extra_n < 0:
            extra_n = 0
        return slot_n, extra_n

    def _committed_total() -> int:
        return committed["slot"] + committed["extra"]

    # ── 분배함 적용 카드 ─────────────────────────────
    slot_card = tk.Frame(quantity_section, bg="white",
                         highlightbackground=BORDER, highlightthickness=1)
    slot_card.pack(fill="x", padx=12, pady=(6, 4))
    slot_inner = tk.Frame(slot_card, bg="white")
    slot_inner.pack(fill="x", padx=10, pady=6)

    tk.Label(slot_inner, text="분배함",
             bg="white", fg=SUB_FG,
             font=("맑은 고딕", 9)).pack(side="left")
    slot_count_lbl = tk.Label(
        slot_inner, text="0칸",
        bg="white", fg=TITLE_FG,
        font=("맑은 고딕", 13, "bold"),
    )
    slot_count_lbl.pack(side="left", padx=(6, 0))

    def _apply_slot(_event=None):
        slot_n, _ = _calc_copies()
        committed["slot"] = slot_n
        _refresh_total_lbl()
        _refresh_slot_apply_btn()

    slot_apply_btn = tk.Button(
        slot_inner, text="✓ 적용", command=_apply_slot,
        font=("맑은 고딕", 9, "bold"),
        bg=ACCENT, fg="white",
        activebackground=ACCENT_HOVER, activeforeground="white",
        relief="flat", padx=12, pady=4, cursor="hand2", bd=0,
    )
    slot_apply_btn.pack(side="right")

    # ── 더뽑기 적용 카드 ─────────────────────────────
    extra_card = tk.Frame(quantity_section, bg="white",
                          highlightbackground=BORDER, highlightthickness=1)
    extra_card.pack(fill="x", padx=12, pady=(0, 4))
    extra_inner = tk.Frame(extra_card, bg="white")
    extra_inner.pack(fill="x", padx=10, pady=6)

    tk.Label(extra_inner, text="더뽑기",
             bg="white", fg=SUB_FG,
             font=("맑은 고딕", 9)).pack(side="left")
    extra_entry = tk.Entry(
        extra_inner, textvariable=copies_extra_var, width=4, justify="center",
        font=("맑은 고딕", 12, "bold"),
        relief="solid", bd=1, bg="#fafafa", highlightthickness=0,
    )
    extra_entry.pack(side="left", padx=(6, 3))
    tk.Label(extra_inner, text="장",
             bg="white", fg=SUB_FG,
             font=("맑은 고딕", 9)).pack(side="left")

    def _apply_extra(_event=None):
        _, extra_n = _calc_copies()
        committed["extra"] = extra_n
        _refresh_total_lbl()
        _refresh_extra_apply_btn()

    extra_apply_btn = tk.Button(
        extra_inner, text="✓ 적용", command=_apply_extra,
        font=("맑은 고딕", 9, "bold"),
        bg=ACCENT, fg="white",
        activebackground=ACCENT_HOVER, activeforeground="white",
        relief="flat", padx=12, pady=4, cursor="hand2", bd=0,
    )
    extra_apply_btn.pack(side="right")

    # ── 총 매수 + 초기화 ─────────────────────────────
    total_row = tk.Frame(quantity_section, bg=BG_SOFT)
    total_row.pack(fill="x", padx=12, pady=(6, 10))

    total_count_lbl = tk.Label(
        total_row, text="총 0장이 인쇄됩니다",
        bg=BG_SOFT, fg=ACCENT,
        font=("맑은 고딕", 12, "bold"), anchor="w",
    )
    total_count_lbl.pack(side="left")

    def _reset_copies(_event=None):
        committed["slot"] = 0
        committed["extra"] = 0
        copies_extra_var.set("0")
        _refresh_total_lbl()
        _refresh_slot_apply_btn()
        _refresh_extra_apply_btn()

    reset_btn = tk.Button(
        total_row, text="↺ 초기화", command=_reset_copies,
        font=("맑은 고딕", 9),
        bg=BG_SOFT, fg=SUB_FG,
        activebackground=BORDER, activeforeground=TITLE_FG,
        relief="flat", padx=8, pady=2, cursor="hand2", bd=0,
    )
    reset_btn.pack(side="right")

    def _refresh_total_lbl():
        try:
            total_count_lbl.config(text=f"총 {_committed_total()}장이 인쇄됩니다")
        except Exception:
            pass

    def _refresh_slot_apply_btn():
        slot_n, _ = _calc_copies()
        try:
            if slot_n != committed["slot"]:
                slot_apply_btn.config(text="✓ 적용",
                                      bg=ACCENT, fg="white",
                                      activebackground=ACCENT_HOVER)
            else:
                slot_apply_btn.config(text="적용됨",
                                      bg="#f4f4f5", fg=SUB_FG,
                                      activebackground=BORDER)
        except Exception:
            pass

    def _refresh_extra_apply_btn():
        _, extra_n = _calc_copies()
        try:
            if extra_n != committed["extra"]:
                extra_apply_btn.config(text="✓ 적용",
                                       bg=ACCENT, fg="white",
                                       activebackground=ACCENT_HOVER)
            else:
                extra_apply_btn.config(text="적용됨",
                                       bg="#f4f4f5", fg=SUB_FG,
                                       activebackground=BORDER)
        except Exception:
            pass

    def _refresh_copies(*_):
        """슬롯 클릭/더뽑기 입력 시 호출 — 칸수 라벨과 두 적용 버튼 dirty 갱신."""
        slot_n, _ = _calc_copies()
        try:
            slot_count_lbl.config(text=f"{slot_n}칸")
        except Exception:
            pass
        _refresh_slot_apply_btn()
        _refresh_extra_apply_btn()

    copies_extra_var.trace_add("write", _refresh_copies)
    _refresh_slot_apply_btn()
    _refresh_extra_apply_btn()

    def _refresh_summary():
        tags = collect_dept_tags()
        if not tags:
            summary_var.set("선택된 부서 없음 — 모바일 뷰어에서는 \"전체보기\"에서만 노출됩니다.")
        else:
            summary_var.set("배부 부서: " + " · ".join(tags))
        # 분배함 클릭 시 칸 수 라벨과 적용 대기 표시도 같이 갱신.
        _refresh_copies()

    def _restore_dept_tags(ws):
        """선택된 작업지시서의 저장된 분배 선택을 분배함 그림에 ✓ 로 복원.
        우선순위:
          1) departmentSlots (라벨 단위) — 직원이 실제 클릭한 칸만 정확히 켠다.
          2) departmentTags (부서 단위) — 구버전 데이터(slots 미저장)에서만 폴백.
             부서 매핑 슬롯이 여러 개면 모두 켜져 보일 수 있으므로 직원이 필요 시 토글.
        다른 카드를 다시 골랐을 때 잔상이 남지 않도록 모든 슬롯을 먼저 끄고 다시 그린다."""
        ws = ws or {}
        saved_slots = ws.get("departmentSlots") or []
        saved_tags = ws.get("departmentTags") or []
        # slots 가 한 개라도 저장돼 있으면 그것만 신뢰 — tags 폴백은 신규 슬롯 도입 전 데이터 전용.
        use_slots = bool(saved_slots)
        slot_set = set(saved_slots)
        tag_set = set(saved_tags)
        for label, mapped_dept, box in SLOT_BOXES:
            if not mapped_dept:
                slot_active[label] = False
            elif use_slots:
                slot_active[label] = label in slot_set
            else:
                slot_active[label] = mapped_dept in tag_set
            _redraw_slot(label, mapped_dept, box)
        _refresh_summary()

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
        # 라디오에서 [종이만 인쇄] 를 골랐다면 매칭/납기 검증 없이 종이만 출력하고 끝낸다.
        # 호출 측은 sel.get("order_number") is None + intent=="paper_only" 로 알아챈다.
        if intent_var.get() == "paper_only":
            paper_copies = _committed_total()
            if paper_copies <= 0:
                # 분배함 슬롯을 안 눌러 매수가 0 인데 [✓ 종이만 인쇄] 를 눌렀음 — 그냥 진행하면
                # 0장이 인쇄되어 사용자는 "왜 안 나오지?" 가 됨. 명시적으로 알리고 막는다.
                try:
                    messagebox.showwarning(
                        "매수 미입력",
                        "종이 인쇄 매수가 0장입니다.\n\n"
                        "우측 분배함에서 슬롯을 클릭해 매수를 정한 뒤\n"
                        "다시 [✓ 종이만 인쇄] 를 눌러주세요.",
                    )
                except Exception:
                    pass
                return
            result["value"] = {
                "order_number": None,
                "intent": "paper_only",
                "copies": paper_copies,
                "skip_print": False,
                "department_tags": [],
                "department_slots": [],
            }
            dlg.destroy()
            return

        idx = notebook.index(notebook.select())
        if idx == 0:
            # ── [신규 작성] 탭 ──────────────────────────────
            if qr_order_number is None:
                # (B) QR 없는 첫 인쇄 — Enter/[✓ 적용] 누르면 검색 결과 첫 거래처에 발주.
                # 기본은 거래처 행 클릭 또는 검색창 Enter 로 처리되지만, [✓ 적용] 버튼을
                # 눌렀을 때도 같은 동작이 일어나도록 처리.
                # (이 분기에서는 new_form_state 사용 안 함 — 클릭=즉시 발주 흐름이라 보관 상태가 없음.)
                return

            # (A) qr_order_number 있음 — 자동작성 + 큐 매칭. 기존 흐름.
            if most_recent is None:
                return
            ms = (new_month_var.get() or "").strip()
            ds = (new_day_var.get() or "").strip()
            if not (ms.isdigit() and ds.isdigit()):
                return
            m, d = int(ms), int(ds)
            if not (1 <= m <= 12 and 1 <= d <= 31):
                return
            delivery_ko = (new_delivery_var.get() or "").strip()
            delivery_enum = DELIVERY_KO_TO_ENUM.get(delivery_ko, "")
            total_copies = _committed_total()
            if intent_var.get() == "web_print" and total_copies <= 0:
                # [웹반영 & 인쇄] 인데 매수 0 — 그대로 진행하면 웹만 반영되고 종이는 안 나옴.
                # 사용자는 "왜 종이가 안 나오지?" 함정에 빠지므로 명시적으로 알리고 막는다.
                try:
                    messagebox.showwarning(
                        "매수 미입력",
                        "종이 인쇄 매수가 0장입니다.\n\n"
                        "우측 분배함에서 슬롯을 클릭해 매수를 정한 뒤\n"
                        "다시 [✓ 웹에 적용 & 인쇄] 를 눌러주세요.\n\n"
                        "(종이 없이 웹에만 반영하려면 [웹반영만] 으로 바꿔주세요.)",
                    )
                except Exception:
                    pass
                return
            result["value"] = {
                "mode": "new",
                "change_type": "delivery",  # 신규는 사실상 납기/배송 흐름과 동일
                "order_number": most_recent["orderNumber"],
                "month": m,
                "day": d,
                "current_due_iso": most_recent.get("dueDate") or "",
                "delivery_method": delivery_enum,
                "original_delivery_method": most_recent.get("deliveryMethod") or "",
                "content_changed": False,
                "change_note": "",
                "department_tags": collect_dept_tags(),
                "department_slots": collect_dept_slots(),
                "skip_print": bool(skip_print),
                "copies": total_copies,
                "intent": intent_var.get(),
            }
            dlg.destroy()
            return

        # ── [기존 변경] 탭 ──────────────────────────────
        if qr_order_number is None:
            # PDF 에 QR 미박힘 — 사용자가 그리드에서 골라 선택한 worksheet 의 QR 만 복사.
            ws_sel = modify_state.get("selected_ws")
            target_order = (ws_sel or {}).get("orderNumber") or ""
            target_order = target_order.strip() if isinstance(target_order, str) else ""
            if not target_order:
                return
            result["value"] = {"qr_only_copy": True, "order_number": target_order}
            dlg.destroy()
            return

        # [기존 변경] 탭 — 통합 폼: 납기/배송 + 내용 메모를 한 번에.
        # 납기는 입력=원본이면 resolve_new_due_date 가 같은 날짜를 돌려주므로 PATCH 가 멱등.
        # 배송은 원본과 다를 때만 송신(_process_printed_pdf 단에서 비교).
        # 내용 메모는 비어있으면 contentChanged=False 로 처리해 모바일 알림이 안 뜨도록.
        ws = modify_state["selected_ws"]
        if ws is None:
            return
        month_var_local = chosen_widgets.get("mod_month_var")
        day_var_local = chosen_widgets.get("mod_day_var")
        delivery_var_local = chosen_widgets.get("mod_delivery_var")
        if month_var_local is None or day_var_local is None or delivery_var_local is None:
            return
        ms = (month_var_local.get() or "").strip()
        ds = (day_var_local.get() or "").strip()
        if not (ms.isdigit() and ds.isdigit()):
            return
        m, d = int(ms), int(ds)
        if not (1 <= m <= 12 and 1 <= d <= 31):
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
        # 다이얼로그 진입 시 prefill 된 이전 메모 — confirm 시점에 사용자가 손댔는지 비교한다.
        original_note = (ws.get("worksheetChangeNote") or "").strip()
        # 사용자가 prefill 된 이전 메모를 그대로 두고 confirm 했으면 단순 재인쇄로 본다 —
        # 백엔드가 DB 노트를 비우지 않고(=다음 회차 prefill 보존), worksheetUpdatedAt 도 갱신 안 함.
        # 메모를 수정/추가했거나 비웠으면 의미 있는 변경으로 처리(기존 로직).
        note_unchanged = bool(note) and note == original_note
        content_changed = bool(note) and not note_unchanged
        total_copies_m = _committed_total()
        if intent_var.get() == "web_print" and total_copies_m <= 0:
            # [웹반영 & 인쇄] 인데 매수 0 — 신규 탭과 같은 가드.
            try:
                messagebox.showwarning(
                    "매수 미입력",
                    "종이 인쇄 매수가 0장입니다.\n\n"
                    "우측 분배함에서 슬롯을 클릭해 매수를 정한 뒤\n"
                    "다시 [✓ 웹에 적용 & 인쇄] 를 눌러주세요.\n\n"
                    "(종이 없이 웹에만 반영하려면 [웹반영만] 으로 바꿔주세요.)",
                )
            except Exception:
                pass
            return
        result["value"] = {
            "mode": "modify",
            "change_type": "combined",
            "order_number": ws["orderNumber"],
            "month": m,
            "day": d,
            "current_due_iso": ws.get("dueDate") or "",
            "delivery_method": delivery_enum,
            "original_delivery_method": ws.get("deliveryMethod") or "",
            "content_changed": content_changed,
            "change_note": note,
            "preserve_note": note_unchanged,
            "department_tags": collect_dept_tags(),
            "department_slots": collect_dept_slots(),
            "skip_print": bool(skip_print),
            "copies": total_copies_m,
            "intent": intent_var.get(),
        }
        dlg.destroy()
        return

    def cancel(_event=None):
        result["value"] = None
        dlg.destroy()

    # ── 액션 버튼 (form_col 하단) ────────────────────────
    # form_col 폭 260 — 메인 액션을 풀 폭으로, 보조 3개를 한 줄로.
    # form_col 안에 두면 빈 여백이 줄고 폼-액션 동선이 같은 컬럼에서 이어짐.
    # pack(side="bottom") 은 먼저 pack 한 게 바닥 — btns_section 먼저, divider 그 위, intent 라디오 그 위.
    btns_section = tk.Frame(form_col, bg=BG)
    btns_section.pack(side="bottom", fill="x", pady=(0, 4))
    tk.Frame(form_col, bg=BORDER, height=1).pack(side="bottom", fill="x", pady=(8, 6))

    # 인쇄 의도 — 최종 결정. 세그먼트 버튼 3개 ([웹반영&인쇄/웹반영만/종이만]) 중 하나 선택.
    # 캐시·첫 모달 의도 없이 매번 이 자리에서 결정 → 직전 선택이 굳어지는 사고 방지.
    intent_section = tk.Frame(form_col, bg=BG)
    intent_section.pack(side="bottom", fill="x", pady=(2, 0))
    tk.Label(intent_section, text="처리 방식",
             bg=BG, fg=LABEL_FG, font=("맑은 고딕", 9, "bold"),
             anchor="w").pack(fill="x", pady=(0, 5))

    seg_row = tk.Frame(intent_section, bg=BG)
    seg_row.pack(fill="x")

    # 세그먼트 버튼 — 선택 시 색 칠. (val, 라벨, 선택색).
    _SEG_DEFS = [
        ("web_print",  "웹반영 & 인쇄", "#10b981"),  # 에메랄드
        ("web_only",   "웹반영만",       "#2563eb"),  # 블루
        ("paper_only", "종이만",         "#52525b"),  # 다크그레이
    ]
    _seg_widgets: dict = {}  # val -> (frame, label, selected_bg)

    def _on_seg_click(val):
        intent_var.set(val)

    for _i, (_val, _txt, _on_bg) in enumerate(_SEG_DEFS):
        _pad_right = (0, 0) if _i == len(_SEG_DEFS) - 1 else (0, 5)
        _fr = tk.Frame(seg_row, bg=BG_SOFT, cursor="hand2",
                       highlightbackground=BORDER, highlightthickness=1)
        _fr.pack(side="left", fill="both", expand=True, padx=_pad_right)
        _lbl = tk.Label(_fr, text=_txt, bg=BG_SOFT, fg=LABEL_FG,
                        font=("맑은 고딕", 10, "bold"),
                        padx=4, pady=9, cursor="hand2")
        _lbl.pack(fill="both", expand=True)
        _seg_widgets[_val] = (_fr, _lbl, _on_bg)
        _fr.bind("<Button-1>", lambda _e, v=_val: _on_seg_click(v))
        _lbl.bind("<Button-1>", lambda _e, v=_val: _on_seg_click(v))

    def _refresh_seg_visuals(*_a):
        cur = intent_var.get()
        for val, (fr, lbl, on_bg) in _seg_widgets.items():
            if val == cur:
                fr.configure(bg=on_bg, highlightbackground=on_bg, highlightthickness=1)
                lbl.configure(bg=on_bg, fg="white")
            else:
                fr.configure(bg=BG_SOFT, highlightbackground=BORDER, highlightthickness=1)
                lbl.configure(bg=BG_SOFT, fg=LABEL_FG)
    intent_var.trace_add("write", _refresh_seg_visuals)
    _refresh_seg_visuals()

    # 1행: 메인 액션 — 풀 폭, 강조. 라벨은 intent 라디오를 따라 동적으로 바뀐다.
    _INTENT_BTN_LABEL = {
        "web_print": "✓ 웹에 적용 & 인쇄",
        "web_only": "✓ 웹에만 적용",
        "paper_only": "✓ 종이만 인쇄",
    }
    _main_btn = tk.Button(
        btns_section, text=_INTENT_BTN_LABEL.get(intent_var.get(), "✓ 적용하기"),
        command=confirm,
        font=("맑은 고딕", 11, "bold"),
        bg=ACCENT, fg="white",
        activebackground=ACCENT_HOVER, activeforeground="white",
        relief="flat", padx=10, pady=9, cursor="hand2", bd=0,
    )
    _main_btn.pack(fill="x")

    def _refresh_main_label(*_a):
        try:
            _main_btn.config(text=_INTENT_BTN_LABEL.get(intent_var.get(), "✓ 적용하기"))
        except Exception:
            pass
    intent_var.trace_add("write", _refresh_main_label)

    # 2행: 보조 액션은 [취소] 만 — [종이만 인쇄]/[웹만 적용] 은 위 라디오로 통합.
    sec_row = tk.Frame(btns_section, bg=BG)
    sec_row.pack(fill="x", pady=(6, 0))
    tk.Button(
        sec_row, text="취소", command=cancel,
        font=("맑은 고딕", 9),
        bg=BG_SOFT, fg=LABEL_FG,
        activebackground=BORDER, activeforeground=TITLE_FG,
        relief="flat", pady=6, cursor="hand2", bd=0,
    ).pack(fill="x")

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


def _schedule_printed_pdf_cleanup(pdf_path: Path, delay_sec: int = 10):
    """종이 인쇄가 PDF 핸들을 닫을 시간을 벌고 백그라운드에서 unlink.
    SumatraPDF -exit-on-print 흐름에선 거의 즉시 핸들이 풀리므로 10초면 충분.
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


def _fs_stem_from_title(title: str) -> str:
    """FlexiSIGN 창 제목에서 '<파일명>.fs' 의 stem 을 뽑는다. 못 뽑으면 "".

    FlexiSIGN 은 보통 문서를 'FlexiSIGN - [<파일명>.fs]' 로 [...] 감싸 표시하는데, 파일명
    자체가 '[변환됨]' 같은 대괄호를 포함할 수 있다(.ai 를 변환해 저장한 거래처는 실제 디스크
    파일명에 '[변환됨]' 이 박혀 있다 — 예: '...-내,외부 [변환됨].fs'). 옛 추출 정규식은 '[' ']'
    를 통째로 제외해 '.fs' 바로 앞이 ']' 이면 매칭에 실패 → stem 미검출 → 인쇄 PDF 리네임도
    .fs UID 스탬프도 조용히 스킵됐다(현장 [FS에서 열기] 가 시각값 폴더만 여는 원인).

    그래서 ① 제목 끝의 [...] 래퍼를 먼저 벗겨 그 안의 '<...>.fs' 를 잡고(대괄호 포함 허용),
    ② 래퍼가 없는 다른 표기('<파일명>.fs - FlexiSIGN')는 대괄호 없는 기존 패턴으로 폴백한다.
    """
    t = (title or "").strip()
    if not t:
        return ""
    # ① 'App - [ ... .fs ]' 래퍼: 끝의 ']' 까지 통째로 잡아 안쪽 '<...>.fs' 추출(브래킷 허용).
    m = re.search(r'\[(.+\.fs)\]\s*$', t, re.IGNORECASE)
    if not m:
        # ② 래퍼 없는 제목 — 경로/금지문자·대괄호 없는 통상 파일명(옛 동작 유지).
        m = re.search(r'([^\\/:*?"<>|\r\n\[\]]+\.fs)', t, re.IGNORECASE)
    if not m:
        return ""
    return Path(m.group(1).strip()).stem.strip()


def _flexisign_window_status() -> tuple[str, str | None, int]:
    """현재 FlexiSIGN(App.exe) 창들 EnumWindows + 제목 분석 → (status, stem, hwnd).

    반환 status:
      - 'saved': 어느 FlexiSIGN 창 제목에 '.fs' 가 박혀 있음 → 그 stem 사용.
      - 'unsaved': FlexiSIGN 창은 떠 있는데 제목 어디에도 '.fs' 가 없음. 보통은 진짜
        새(저장 안 된) 도큐먼트지만, FlexiSIGN 버전/설정에 따라 확장자를 표시하지 않을
        수도 있어 무조건 미저장이라고 단정하지 않는다(호출 측이 사용자 입력을 신뢰).
        stem=None, hwnd=Ctrl+S 타겟(최상단 FlexiSIGN 창).
      - 'no_window': FlexiSIGN 자체가 안 떠 있음. stem=None, hwnd=0. (다른 앱 인쇄로 추정)

    NOTE(2026-05-14): 옛 '*' 더티 마커 감지(_title_has_dirty_marker) 는 제거. FlexiSIGN 은
      실제로 '*' 표기를 쓰지 않으며, 가끔 다른 이유로 '*' 가 보이면 "이미 저장했는데?" 함정만
      유발했다. 이제 .fs 가 제목에 있으면 무조건 'saved' 로 본다.

    창 제목은 윈도우가 UTF-16 으로 다루므로 인코딩이 깨지지 않는다 → 'saved' 일 땐 이 stem 으로
    인쇄 PDF 를 리네임하면 현장 에이전트가 거래처 폴더의 .fs 를 이름으로 정확 매칭(±30분 mtime
    폴백 불필요). .fs 후보가 여럿이면(여러 문서를 열어둠) Z-order 첫 매칭(=가장 최근 활성) 을
    채택하되 전부 로그.
    """
    try:
        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32
        user32.GetWindowTextLengthW.restype = ctypes.c_int
        user32.GetWindowTextLengthW.argtypes = [ctypes.c_void_p]
        user32.GetWindowTextW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_int]
        user32.IsWindowVisible.argtypes = [ctypes.c_void_p]
        user32.GetWindowThreadProcessId.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
        kernel32.OpenProcess.restype = ctypes.c_void_p
        kernel32.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
        kernel32.QueryFullProcessImageNameW.argtypes = [
            ctypes.c_void_p, ctypes.c_ulong, ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_ulong)]
        kernel32.CloseHandle.argtypes = [ctypes.c_void_p]

        flex_exe = ""
        try:
            p = find_flexsign_exe()
            flex_exe = Path(p).name if p else ""
        except Exception:
            flex_exe = ""
        flex_exe = (flex_exe or "App.exe").lower()

        def _proc_path(pid: int) -> str:
            h = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
            if not h:
                return ""
            try:
                buf = ctypes.create_unicode_buffer(32768)
                size = ctypes.c_ulong(32768)
                if kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
                    return buf.value or ""
            finally:
                kernel32.CloseHandle(h)
            return ""

        # (hwnd_int, title) 튜플 목록. EnumWindows = Z-order(최상단부터).
        windows: list[tuple[int, str]] = []
        WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)

        def _cb(hwnd, _lparam):
            try:
                if not user32.IsWindowVisible(hwnd):
                    return True
                n = user32.GetWindowTextLengthW(hwnd)
                if n <= 0:
                    return True
                buf = ctypes.create_unicode_buffer(n + 1)
                user32.GetWindowTextW(hwnd, buf, n + 1)
                title = (buf.value or "").strip()
                if not title:
                    return True
                pid = ctypes.c_ulong(0)
                user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
                exe_path = _proc_path(pid.value).lower()
                if not exe_path:
                    return True
                base = exe_path.rsplit("\\", 1)[-1]
                if base != flex_exe and "flexi" not in exe_path:
                    return True
                # ctypes 콜백의 hwnd 는 c_void_p — Ctrl+S 송신 시 user32.SetForegroundWindow 가
                # 받을 수 있는 정수형으로 박제(아래에서 c_void_p 로 다시 감싸 호출한다).
                try:
                    h_int = int(hwnd) if hwnd is not None else 0
                except Exception:
                    try:
                        h_int = ctypes.cast(hwnd, ctypes.c_void_p).value or 0
                    except Exception:
                        h_int = 0
                windows.append((h_int, title))
            except Exception:
                pass
            return True

        user32.EnumWindows(WNDENUMPROC(_cb), 0)
        if not windows:
            return ("no_window", None, 0)

        # 제목에서 '<파일명>.fs' stem 추출(_fs_stem_from_title) — '[변환됨]' 등 파일명 속
        # 대괄호까지 포함해 잡는다. 경로 포함이면 basename 만.
        # (stem, hwnd, title) — Z-order 보존. 미저장(더티) 마커 감지는 더 이상 안 함
        # (FlexiSIGN 은 '*' 같은 표기를 안 씀 — 옛 가설은 폐기).
        ordered: list[tuple[str, int, str]] = []
        for h_int, t in windows:
            stem = _fs_stem_from_title(t)
            if stem and not any(s == stem for s, _, _ in ordered):
                ordered.append((stem, h_int, t))
        titles_only = [w[1] for w in windows]
        # 디스크 로그에도 남김 — 도장 실패 시 '제목에 .fs 가 정말 없었는지'를 사후에 본다.
        _stamp_log(f"FlexiSIGN 창 제목 {titles_only!r} → .fs 후보 {[s for s, _, _ in ordered]!r}")
        if ordered:
            first_stem, first_hwnd, _first_title = ordered[0]
            if len(ordered) > 1:
                _stamp_log(f"FlexiSIGN 열린 .fs 여럿 — 최상단 창의 '{first_stem}' 채택")
            return ("saved", first_stem, first_hwnd)
        # 창은 있는데 .fs 가 한 군데도 없음 — 진짜 새(저장 안 된) 도큐먼트일 수도 있고,
        # FlexiSIGN 버전이 확장자를 숨기는 설정일 수도 있다. 호출 측은 사용자가 인쇄를
        # 눌렀다는 사실을 신뢰해 그대로 진행한다(stem 만 None — PDF 리네임 폴백).
        _diag_log(f"→ 미저장 판정(제목에 .fs 없음): {titles_only!r}")
        return ("unsaved", None, windows[0][0])
    except Exception as e:
        ui_log(f"FlexiSIGN 창 상태 읽기 실패: {e}")
        return ("no_window", None, 0)


def _flexisign_window_status_quick(tries: int = 3, gap: float = 0.12) -> tuple[str, str | None, int]:
    """_flexisign_window_status 를 짧게 몇 번 재시도해 stem 을 잡는다.

    인쇄 직후엔 인쇄 다이얼로그가 잠깐 최상단이거나 FlexiSIGN 창 제목이 갱신 중이라 첫 읽기가
    빗나갈 수 있다 → stem 을 못 잡으면 아주 짧게 재시도. stem 을 잡는 즉시 반환하고, 전체 대기
    상한이 작아(기본 3회×0.12s ≈ 최대 0.24s) 인쇄 흐름을 느리게 하지 않는다. 끝까지 못 잡으면
    예전과 똑같이 (unsaved/no_window) 를 돌려준다 — 차단 없이 조용히 폴백(시각값 그대로 진행).
    """
    status, stem, hwnd = _flexisign_window_status()
    attempt = 1
    while stem is None and attempt < tries:
        time.sleep(gap)
        status, stem, hwnd = _flexisign_window_status()
        attempt += 1
    if attempt > 1:
        _diag_log(f"창 제목 재시도 {attempt}회 → status={status} stem={stem!r}")
    return status, stem, hwnd


def _flexisign_document_stem() -> str | None:
    """저장된 FlexiSIGN 도큐먼트의 stem 을 창 제목에서 읽어 반환. 저장 안 됐거나 창이 없으면 None.

    내부적으로 _flexisign_window_status 를 호출 — 기존 호출부 호환용 래퍼.
    """
    status, stem, _ = _flexisign_window_status()
    return stem if status == "saved" else None


def _dialog_title_looks_like_save_as(title: str) -> bool:
    """Win32 공용 #32770 중 '새 이름으로 저장' 계열만 True.

    FlexiSIGN 의 인쇄/열기/경고창도 같은 #32770 클래스라 클래스명만 보면
    기존 지시서 웹반영 흐름을 새 지시서 Save As 로 오인할 수 있다.
    """
    t = (title or "").strip().lower()
    if not t:
        return False
    blockers = (
        "print", "printer", "printing", "인쇄",
        "open", "열기",
        "warning", "error", "alert", "확인", "경고", "오류",
    )
    if any(x in t for x in blockers):
        return False
    markers = (
        "save as", "save file", "save .fs",
        "다른 이름으로 저장", "파일 저장",
    )
    return any(x in t for x in markers)


def _flexisign_save_as_dialog_present() -> bool:
    """FlexiSIGN 위에 Save As(다른 이름으로 저장) 다이얼로그가 떠 있는지 감지.

    Ctrl+S 가 새 도큐먼트에 송신되면 FlexiSIGN 이 Save As 다이얼로그(Win32 표준 클래스
    '#32770')를 띄우고 사용자가 파일명을 직접 입력해야 한다. 이 함수가 True 면 사용자가
    파일명 입력 중이라고 판단해 워처는 그 입력이 끝날 때까지 대기 모달을 띄운다.

    기존(이미 저장된) 도큐먼트에 Ctrl+S 를 보내면 다이얼로그는 안 뜨고 즉시 saved →
    이 함수는 False 를 반환하므로 워처는 그대로 통과한다.
    """
    try:
        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32
        user32.IsWindowVisible.argtypes = [ctypes.c_void_p]
        user32.GetClassNameW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_int]
        user32.GetWindowThreadProcessId.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
        user32.GetWindowTextLengthW.restype = ctypes.c_int
        user32.GetWindowTextLengthW.argtypes = [ctypes.c_void_p]
        user32.GetWindowTextW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_int]
        kernel32.OpenProcess.restype = ctypes.c_void_p
        kernel32.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
        kernel32.QueryFullProcessImageNameW.argtypes = [
            ctypes.c_void_p, ctypes.c_ulong, ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_ulong)]
        kernel32.CloseHandle.argtypes = [ctypes.c_void_p]

        flex_exe = "App.exe"
        try:
            p = find_flexsign_exe()
            if p:
                flex_exe = Path(p).name
        except Exception:
            pass
        flex_exe_lower = flex_exe.lower()

        found = [False]
        WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)

        def _cb(hwnd, _lparam):
            try:
                if not user32.IsWindowVisible(hwnd):
                    return True
                class_buf = ctypes.create_unicode_buffer(256)
                user32.GetClassNameW(hwnd, class_buf, 256)
                # Win32 표준 다이얼로그. Save As/Open/Print 등 공용 컨트롤이 모두 '#32770'.
                if class_buf.value != "#32770":
                    return True
                title = ""
                try:
                    n = user32.GetWindowTextLengthW(hwnd)
                    if n > 0:
                        title_buf = ctypes.create_unicode_buffer(n + 1)
                        user32.GetWindowTextW(hwnd, title_buf, n + 1)
                        title = title_buf.value or ""
                except Exception:
                    title = ""
                if not _dialog_title_looks_like_save_as(title):
                    return True
                pid = ctypes.c_ulong(0)
                user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
                h = kernel32.OpenProcess(0x1000, False, pid.value)  # PROCESS_QUERY_LIMITED_INFORMATION
                if not h:
                    return True
                try:
                    buf = ctypes.create_unicode_buffer(32768)
                    size = ctypes.c_ulong(32768)
                    if kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
                        exe = (buf.value or "").rsplit("\\", 1)[-1].lower()
                        if exe == flex_exe_lower or "flexi" in (buf.value or "").lower():
                            found[0] = True
                            return False  # 발견 → 열거 중단
                finally:
                    kernel32.CloseHandle(h)
            except Exception:
                pass
            return True

        user32.EnumWindows(WNDENUMPROC(_cb), 0)
        return found[0]
    except Exception as e:
        ui_log(f"Save As 다이얼로그 감지 예외: {e}")
        return False


def _force_flexisign_foreground(hwnd: int, timeout_ms: int = 600) -> bool:
    """FlexiSIGN 창을 포그라운드로 끌어와 GetForegroundWindow == hwnd 로 검증.

    Alt 토글로 OS foreground 잠금 해제 + 점유 스레드 AttachThreadInput 으로
    SetForegroundWindow 차단 우회 + 검증 루프(짧은 슬립). 검증 실패 시 False —
    이 경우 호출 측은 글로벌 Ctrl+S 송신을 *건너뛰어야* 한다(브라우저 등 다른
    창에 키가 잘못 박혀 페이지 새로고침/저장 다이얼로그가 뜨는 사고 방지)."""
    try:
        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32
        import win32api
        VK_MENU = 0x12
        KEYEVENTF_KEYUP = 0x0002
        if user32.IsIconic(hwnd):
            user32.ShowWindow(hwnd, 9)  # SW_RESTORE
            time.sleep(0.08)
        deadline = time.time() + timeout_ms / 1000.0
        attempt = 0
        while time.time() < deadline:
            attempt += 1
            if user32.GetForegroundWindow() == hwnd:
                return True
            # Alt 1회 토글 — 다른 프로세스가 foreground 잠금을 걸어둔 상태에서도
            # SetForegroundWindow 를 통과시키는 잘 알려진 트릭.
            win32api.keybd_event(VK_MENU, 0, 0, 0)
            win32api.keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0)
            fg = user32.GetForegroundWindow()
            cur_thread = kernel32.GetCurrentThreadId()
            attached = False
            fg_thread = 0
            try:
                if fg and fg != hwnd:
                    fg_thread = user32.GetWindowThreadProcessId(fg, None)
                    if fg_thread and fg_thread != cur_thread:
                        user32.AttachThreadInput(cur_thread, fg_thread, True)
                        attached = True
                user32.BringWindowToTop(hwnd)
                user32.SetForegroundWindow(hwnd)
                user32.SetActiveWindow(hwnd)
            finally:
                if attached:
                    user32.AttachThreadInput(cur_thread, fg_thread, False)
            time.sleep(0.04 if attempt <= 2 else 0.08)
        return user32.GetForegroundWindow() == hwnd
    except Exception as e:
        ui_log(f"FlexiSIGN 포그라운드 전환 예외: {e}")
        return False


def _focus_flexisign_window_async() -> None:
    """QR 클립보드 복사 안내 모달 [확인] 직후 호출 — FlexiSIGN 창을 포그라운드로 자동 전환.

    이유: 클립보드 복사 후 사용자가 워처 창에서 Ctrl+V 를 누르면 빈 클립보드가 박히거나
    엉뚱한 곳에 붙어 빈 껍데기 지시서가 생기던 사고가 있었음. 사용자가 "확인" 만 누르면
    바로 Ctrl+V 가 FlexiSIGN 캔버스에 박히도록 강제 포커스 전환.

    데몬 스레드로 비동기 실행 — UI 스레드 막지 않게(_force_flexisign_foreground 가
    최대 ~600ms sleep 루프).
    """
    def _do():
        try:
            status, _stem, hwnd = _flexisign_window_status()
            if status == "no_window" or not hwnd:
                ui_log("FlexiSIGN 창 없음 — QR 복사 후 포커스 전환 생략")
                return
            ok = _force_flexisign_foreground(hwnd, timeout_ms=800)
            ui_log(f"QR 복사 후 FlexiSIGN 포커스 전환 — {'성공' if ok else '실패(다른 창이 점유)'}")
        except Exception as e:
            ui_log(f"QR 복사 후 FlexiSIGN 포커스 전환 예외: {e}")
    threading.Thread(target=_do, daemon=True).start()


def _show_qr_copy_done_and_focus_flex(title: str, msg: str) -> None:
    """QR 클립보드 복사 완료 안내 모달 → 사용자 [확인] 직후 FlexiSIGN 포커스 자동 전환.
    showinfo 가 모달이라 사용자가 [확인] 누를 때까지 블록되고, 닫히는 즉시 FlexiSIGN 으로 점프."""
    def _do():
        try:
            messagebox.showinfo(title, msg)
        finally:
            _focus_flexisign_window_async()
    _ui_queue.put(("run", _do))


def _send_save_keystroke_to(hwnd: int) -> bool:
    """FlexiSIGN 창을 포그라운드로 잠그고 Ctrl+S 송신. 검증 실패 시 송신 안 함.

    keybd_event 는 글로벌 키 이벤트라 *현재* 포그라운드 창이 받는다. 사용자가
    매칭 다이얼로그 [✓ 적용] 직후 다른 창(브라우저 등)을 클릭해 포그라운드를
    뺏긴 상태라면 Ctrl+S 가 그 창에 박혀 페이지 새로고침/저장 다이얼로그가 뜨고
    FlexiSIGN 은 저장되지 않는다. 그래서 *반드시* 검증된 foreground 상태에서만
    키를 보낸다."""
    if not _force_flexisign_foreground(hwnd):
        ui_log("FlexiSIGN 포그라운드 검증 실패 — Ctrl+S 송신 건너뜀(다른 창 오송신 방지)")
        return False
    try:
        user32 = ctypes.windll.user32
        VK_CONTROL = 0x11
        VK_S = 0x53
        KEYEVENTF_KEYUP = 0x0002
        user32.keybd_event(VK_CONTROL, 0, 0, 0)
        time.sleep(0.04)
        user32.keybd_event(VK_S, 0, 0, 0)
        time.sleep(0.04)
        user32.keybd_event(VK_S, 0, KEYEVENTF_KEYUP, 0)
        user32.keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0)
        ui_log("FlexiSIGN 에 Ctrl+S 송신 (포그라운드 검증 완료)")
        return True
    except Exception as e:
        ui_log(f"FlexiSIGN Ctrl+S 송신 실패: {e}")
        return False


def _show_combined_done_modal(alert_kind: str, ops_msg: str) -> None:
    """자동저장 결과 + 처리 결과를 한 모달에 합쳐서 사용자에게 띄움.

    - alert_kind=='saved' : 정보 모달, "FlexiSIGN 자동 저장 완료" + ops_msg
    - alert_kind=='failed': 경고 모달, "자동 저장 실패 — 직접 저장 필요" + ops_msg
    - alert_kind==''      : 정보 모달, ops_msg 만 (no_window/unsaved 분기)
    """
    if alert_kind == 'saved':
        title = "처리 완료"
        body = f"FlexiSIGN 자동 저장 완료.\n{ops_msg}"
        fn = messagebox.showinfo
    elif alert_kind == 'failed':
        title = "처리 완료 (저장 확인 필요)"
        body = (
            "FlexiSIGN 자동 저장에 실패했습니다.\n"
            "[✓ 적용] 직후 다른 창으로 포커스가 옮겨갔을 수 있습니다.\n"
            "FlexiSIGN 으로 돌아가 Ctrl+S 로 직접 저장해주세요.\n\n"
            f"{ops_msg}"
        )
        fn = messagebox.showwarning
    else:
        title = "처리 완료"
        body = ops_msg
        fn = messagebox.showinfo
    _ui_queue.put((
        "run",
        lambda t=title, b=body, f=fn: f(t, b),
    ))


def _show_save_wait_window() -> tuple[dict, threading.Event]:
    """새 도큐먼트 Save As 다이얼로그가 떴을 때만 띄우는 안내창. (holder, cancel_event) 반환.

    사용자가 FlexiSIGN 의 Save As 창에서 파일명을 입력 → 저장 → 다이얼로그 닫힘 까지 대기.
    cancel_event 가 set 되면 사용자가 [취소] 누른 것. 호출 측은 폴링 끝나면
    _close_save_wait_window(holder) 호출.
    """
    holder: dict = {"win": None}
    cancel_event = threading.Event()

    def _show():
        try:
            w = tk.Toplevel()
            w.title("지시서 제목 입력 대기")
            w.configure(bg="#ffffff")
            w.resizable(False, False)
            try:
                w.attributes("-topmost", True)
            except Exception:
                pass
            fr = tk.Frame(w, bg="#ffffff")
            fr.pack(padx=26, pady=20)
            tk.Label(fr, text="새 지시서 — 제목을 입력해 주세요",
                     bg="#ffffff", fg="#18181b", font=("맑은 고딕", 13, "bold"),
                     anchor="w").pack(fill="x")
            tk.Label(fr,
                     text="FlexiSIGN '다른 이름으로 저장' 창에서 파일명을 입력 → 저장하면\n"
                          "자동으로 다음 단계(웹 업로드/인쇄)가 이어집니다.",
                     bg="#ffffff", fg="#3f3f46", font=("맑은 고딕", 10),
                     justify="left", anchor="w").pack(fill="x", pady=(6, 12))
            pb = ttk.Progressbar(fr, mode="indeterminate", length=360)
            pb.pack(fill="x")
            try:
                pb.start(12)
            except Exception:
                pass
            btns = tk.Frame(fr, bg="#ffffff")
            btns.pack(fill="x", pady=(12, 0))

            def _do_cancel():
                cancel_event.set()
                try:
                    w.destroy()
                except Exception:
                    pass

            tk.Button(btns, text="취소 — 인쇄 중단", command=_do_cancel,
                      font=("맑은 고딕", 9), bg="#e4e4e7", fg="#18181b",
                      activebackground="#d4d4d8", relief="flat", bd=0, padx=12, pady=6,
                      cursor="hand2").pack(side="right")
            w.protocol("WM_DELETE_WINDOW", _do_cancel)
            w.update_idletasks()
            ww, wh = w.winfo_reqwidth(), w.winfo_reqheight()
            sw, _sh = w.winfo_screenwidth(), w.winfo_screenheight()
            # 화면 상단 가운데 — FlexiSIGN Save As 캔버스 영역을 가리지 않도록.
            w.geometry(f"{ww}x{wh}+{(sw - ww) // 2}+30")
            holder["win"] = w
        except Exception as e:
            ui_log(f"저장 대기 창 표시 오류: {e}")

    _ui_queue.put(("run", _show))
    return holder, cancel_event


def _close_save_wait_window(holder: dict):
    def _do():
        w = holder.get("win")
        if w is None:
            return
        holder["win"] = None
        try:
            w.destroy()
        except Exception:
            pass

    _ui_queue.put(("run", _do))


def _auto_save_flexisign_for_print(
    pdf_path: Path,
    prior_status: str = '',
    prior_stem: str | None = None,
) -> tuple[bool, str]:
    """인쇄 PDF 감지 시 호출 — FlexiSIGN 도큐먼트 자동 Ctrl+S 저장.

    반환 (계속진행, alert_kind).
      - 계속진행=False : 사용자가 대기 모달에서 [취소] / 타임아웃 (새 도큐먼트의 Save As
        다이얼로그 케이스에서만 발생) — 호출 측은 PDF 삭제 + 업로드/인쇄 모두 생략.
      - alert_kind:
          ''       : 안내 안 띄움 (no_window — 다른 앱 인쇄로 추정)
          'saved'  : Ctrl+S 송신 성공
          'failed' : 포그라운드 검증 실패로 Ctrl+S 송신 못 함 — 경고 토스트

    prior_status / prior_stem: _ask_print_intent_modal 직전에 한 번 더 관측한 FlexiSIGN
      창 상태. 현재 검사에서 stem 을 못 잡을 때 폴백으로 쓴다.

    동작 정책(2026-05-14):
      - 항상 Ctrl+S 한 번 송신. 이미 깨끗하게 저장된 상태면 FlexiSIGN 이 무동작이라 즉시 통과.
        미저장 변경이 있는 기존 .fs 면 자동저장. 둘 다 사용자 개입 없이 진행.
      - 진짜 새(이름 없는) 도큐먼트의 경우에만 FlexiSIGN 이 Save As 다이얼로그를 띄움.
        워처는 그 다이얼로그를 감지하면 "지시서 제목 입력 대기" 모달을 띄우고, 사용자가
        파일명 입력 → 저장 → 다이얼로그 닫힘 을 기다린다.
      - 옛 '*' 더티 마커 / '제목에 .fs 없으면 무조건 unsaved' 로 모달을 띄우던 가설은 폐기.
        "이미 저장했는데?" 함정만 발생.
    """
    status, stem, hwnd = _flexisign_window_status()
    if status == "no_window":
        ui_log("FlexiSIGN 창 없음 — 다른 앱 인쇄로 추정, Ctrl+S 생략")
        return True, ''

    effective_stem = stem or prior_stem

    # Ctrl+S 송신 — 이미 저장된 상태면 무동작, 미저장 변경 있는 .fs 면 자동저장,
    # 진짜 새 도큐먼트면 FlexiSIGN 이 Save As 다이얼로그를 띄움.
    if hwnd:
        send_ok = _send_save_keystroke_to(hwnd)
        if not send_ok:
            ui_log("FlexiSIGN — Ctrl+S 포그라운드 검증 실패, 그대로 진행")
            return True, 'failed'

    # 이미 .fs 이름이 잡힌 기존 지시서는 Ctrl+S 만으로 저장이 끝난다. 이 상태에서
    # FlexiSIGN 인쇄/경고 같은 다른 #32770 창이 잠깐 남아 있어도 새 지시서 Save As 로
    # 기다리면 웹반영이 멈추므로, 이름 있는 문서는 Save As 감시를 하지 않는다.
    if effective_stem:
        ui_log(f"FlexiSIGN Ctrl+S 송신 — '{effective_stem}.fs' 저장 처리")
        return True, 'saved'

    # Save As 다이얼로그가 떴는지 짧게 폴링. 떴으면 사용자가 파일명 입력 중 → 대기 모달.
    # 안 떴으면(보통의 경우 — 이미 저장된 .fs 또는 변경분 자동저장) 즉시 통과.
    # 0.1s × 12 = 1.2s 예산: Save As 는 거의 즉시 뜨고, 이 정도면 잡힌다.
    save_as_open = False
    for _ in range(12):
        time.sleep(0.1)
        if _flexisign_save_as_dialog_present():
            save_as_open = True
            break

    if not save_as_open:
        ui_log("FlexiSIGN Ctrl+S 송신 — Save As 미발생, stem 미상으로 진행")
        return True, 'saved'

    # Save As 다이얼로그 열림 — 사용자에게 제목 입력 안내. 다이얼로그가 닫힐 때까지 대기.
    ui_log("FlexiSIGN — Save As 다이얼로그 감지, 사용자 파일명 입력 대기 모달 띄움")
    wait_holder, cancel_evt = _show_save_wait_window()
    deadline = time.time() + 180  # 3분
    saved_after: str | None = None
    try:
        while time.time() < deadline:
            if cancel_evt.is_set():
                break
            # 다이얼로그가 사라졌으면 저장(또는 사용자 직접 취소) 완료로 판정.
            if not _flexisign_save_as_dialog_present():
                # 짧게 더 기다린 뒤 .fs 잡히는지 확인 — 저장 완료라면 제목이 업데이트됨.
                time.sleep(0.2)
                s2, st2, _ = _flexisign_window_status()
                if s2 == "saved" and st2:
                    saved_after = st2
                break
            time.sleep(0.3)
    finally:
        _close_save_wait_window(wait_holder)

    if cancel_evt.is_set():
        ui_log(f"인쇄 — Save As 대기 중 사용자 [취소] : PDF 삭제 ({pdf_path.name})")
        try:
            if pdf_path.exists():
                pdf_path.unlink()
        except Exception as e:
            ui_log(f"PDF 삭제 실패: {e}")
        return False, ''

    if saved_after:
        ui_log(f"인쇄 — FlexiSIGN Save As 완료('{saved_after}.fs') → 평소 흐름 진행")
    else:
        ui_log("인쇄 — Save As 다이얼로그 사라짐(저장됐는지 확인 못함), stem 미상으로 진행")
    return True, 'saved'


def _rename_printed_pdf_to_original(pdf_path: Path, order_number: str,
                                    doc_stem: str | None = None) -> Path:
    """인쇄 PDF 를 가능하면 원본 도큐먼트명 stem 으로 리네임해서 반환.

    배경: PDF24 자동저장 파일명을 시각값(%y%m%d_%H%M%S)으로 두면 ASCII 라 ErrorCode 123
    (한글 도큐먼트 제목이 FlexSign→PDF24 구간에서 깨져 ERROR_INVALID_NAME) 이 원천 차단되지만,
    그 대신 PDF 파일명에 원본 정보가 사라진다. 그래서 워처가 깔끔한 원본명을 직접 붙인다 —
    업로드되는 originalPdfFilename 이 깔끔해야 현장 에이전트가 거래처 폴더의 .fs 를 이름으로
    정확 매칭(시각 ±30분 mtime 폴백 불필요)한다.

    이름 출처 우선순위:
      ① 인쇄 시점에 캡처한 FlexiSIGN 도큐먼트 stem(doc_stem)  (사무실 대다수 — 거래처 .fs 에
         헤더만 붙여 인쇄). doc_stem 이 없으면 지금 창 제목에서 다시 읽는다(폴백).
      ② 인쇄 매칭 큐(remember_order_for_print)의 원본 .ai 명  (워처가 .ai 를 FlexiSIGN 에 넣은 자동작성 흐름)
    둘 다 없거나 리네임 실패 시 원래 경로 그대로 반환 — 그 경우 현장 에이전트의 PDF24 시각형 폴백이 받는다.

    doc_stem 을 .fs UID 스탬프(_resolve_and_stamp_printed_fs)와 같은 출처로 받으면, 썸네일 PDF
    이름과 못 박는 .fs 가 같은 도큐먼트를 가리켜 '썸네일 ≠ 열리는 파일' 어긋남을 막는다."""
    try:
        new_stem = ""
        fs_stem = (doc_stem or "").strip() or _flexisign_document_stem()
        if fs_stem:
            new_stem = safe_filename_stem(fs_stem)
        if not new_stem:
            for o in list_recent_orders():
                if (o.get("orderNumber") or "") == order_number:
                    orig = (o.get("originalFileName") or "").strip()
                    if orig:
                        new_stem = safe_filename_stem(Path(orig).stem)
                    break
        if not new_stem or new_stem == pdf_path.stem:
            return pdf_path
        new_path = pdf_path.with_name(f"{new_stem}.pdf")
        if new_path.exists() and new_path.resolve() != pdf_path.resolve():
            new_path = pdf_path.with_name(f"{new_stem}_{time.strftime('%H%M%S')}.pdf")
        # 리네임하면 watchdog 이 새 파일에 대해 on_moved/on_created 를 쏴 _process_printed_pdf 가
        # 다시 호출된다 → 매칭 다이얼로그 중복. 새 경로 키를 미리 _seen_printed 에 넣어 차단.
        with _seen_printed_lock:
            _seen_printed.add(str(new_path.resolve()))
        pdf_path.rename(new_path)
        ui_log(f"인쇄 PDF 리네임: {pdf_path.name} → {new_path.name}")
        return new_path
    except Exception as e:
        ui_log(f"인쇄 PDF 리네임 실패(원래 이름으로 업로드): {e}")
        return pdf_path


# .fs 파일에 박는 NTFS Alternate Data Stream 이름. 이 스트림에 인쇄마다 새로 발급한
# UID(uuid hex) 를 적어두면, 현장 에이전트가 파일명·시각이 아니라 이 UID 로 .fs 를 찾는다.
# ADS 는 같은 NTFS 볼륨(이 회사의 \\Main\현대공유 SMB 공유 포함) 안에서 파일을 rename·이동해도
# 따라다닌다(검증 완료 2026-06-15). exFAT/FAT 로 복사하거나 zip·메일로 보내면 소실되지만,
# 거래처 폴더 안에서의 통상적인 이름변경·정리에는 견딘다. FlexiSIGN 이 .fs 본 스트림을 열어
# 둔 상태에서도 별도 named stream 쓰기는 충돌하지 않는다(검증 완료).
_FS_UID_STREAM = "hdsign.fsuid"


def _write_fs_uid_ads(fs_file: Path) -> str:
    """fs_file 에 새 UID 를 발급해 NTFS ADS(hdsign.fsuid)로 기록하고 그 UID 를 반환.
    기록 실패(비-NTFS 대상·권한·잠금 등)면 "" 반환 — 호출자는 UID 없이 경로만 전송한다.

    인쇄마다 새 UID 를 발급해 덮어쓴다(last-print-wins). 주문번호와 무관한 전역 고유값이라
    주문을 지우고 다시 만들어도 옛 스탬프와 충돌하지 않는다."""
    uid = uuid.uuid4().hex
    try:
        with open(f"{fs_file}:{_FS_UID_STREAM}", "w", encoding="utf-8") as f:
            f.write(uid)
        return uid
    except Exception as e:
        ui_log(f"인쇄 .fs UID 스탬프 실패({fs_file.name}: {e}) → UID 미전송, 경로만 사용")
        return ""


def _resolve_and_stamp_printed_fs(order_number: str, doc_stem: str | None = None) -> tuple[str, str]:
    """인쇄된 지시서에 대응하는 .fs 를 거래처 폴더에서 단일 확정하고, 그 파일에 UID(ADS)를
    박은 뒤 (전체경로, UID) 를 반환. 확정 못 하면 ("", "") — 현장은 originalPdfFilename 폴백.

    현장 에이전트 [FS에서 열기] 가 이 UID 로 .fs 를 찾으므로, 파일명을 바꾸거나 폴더 안에서
    옮겨도 정확히 매칭된다(이름 추측·시각값 ±30분 폴백·퍼지매칭 불필요). 한 폴더에 .fs 가
    여럿이어도 지시서마다 자기 파일을 못 박는다.

    doc_stem: 인쇄 시점에 캡처해 둔 FlexiSIGN 도큐먼트 stem(권장 — 인쇄 후 사용자가 다른
      창으로 전환해도 인쇄한 그 문서를 가리킴). None 이면 지금 창 제목에서 다시 읽는다(폴백).

    아래를 모두 만족할 때만 확정:
      - 인쇄한 도큐먼트의 .fs stem 을 알 수 있음
      - config 의 network_customer_base 가 설정돼 있고 거래처 폴더가 실재
      - 그 거래처 폴더(하위 포함)에 <stem>.fs 가 존재 (여럿이면 가장 최근 수정본 채택)
    후보가 0개면 ("", "") (이름 불일치/미저장 → 현장 이름매칭 폴백).

    어떤 경우에도 예외를 밖으로 던지지 않는다 — 실패 시 ("", "") 반환, 인쇄/업로드 흐름은 진행.
    """
    try:
        _diag_log(f"── 도장 시작 order={order_number} doc_stem={doc_stem!r}")
        fs_stem = (doc_stem or "").strip() or _flexisign_document_stem()
        if not fs_stem:
            _stamp_log(f"인쇄 .fs[{order_number}] — FlexiSIGN 에서 저장된 .fs stem 을 못 읽음(미저장/제목에 .fs 없음) → UID/경로 미전송")
            return "", ""
        base_str = (_load_config().get("network_customer_base") or "").strip()
        if not base_str:
            _diag_log(f"인쇄 .fs[{order_number}] — network_customer_base 미설정 → 미전송")
            return "", ""
        detail = fetch_public_worksheet_detail(order_number)
        if not detail:
            _diag_log(f"인쇄 .fs[{order_number}] — 주문 detail 조회 실패 → 미전송")
            return "", ""
        network_folder = (detail.get("networkFolderName") or "").strip()
        company = (detail.get("companyName") or "").strip()
        if not network_folder and not company:
            _diag_log(f"인쇄 .fs[{order_number}] — networkFolderName·companyName 둘 다 빔 → 미전송")
            return "", ""
        customer_folder = resolve_customer_folder(Path(base_str), network_folder, company)
        if not customer_folder.exists():
            _stamp_log(f"인쇄 .fs[{order_number}] — 거래처 폴더 없음({customer_folder}) → UID/경로 미전송")
            return "", ""
        target = unicodedata.normalize("NFC", fs_stem).casefold()
        hits = [
            p for p in customer_folder.rglob("*.fs")
            if p.is_file() and unicodedata.normalize("NFC", p.stem).casefold() == target
        ]
        if hits:
            if len(hits) == 1:
                fs_path = hits[0]
            else:
                # 같은 이름 .fs 가 거래처 폴더(하위 포함)에 여럿 — '시트커팅'·'종이도안' 같은 범용
                # 파일명이나 차수별 폴더에 같은 발주명을 재사용한 경우. 예전엔 '모호'라 포기했지만,
                # 인쇄한 그 문서가 보통 '방금 작업/저장한' 것이므로 **가장 최근 수정본을 채택**한다
                # (현장 find_fs_file 의 중복 stem 처리와 동일 규칙 → 사무실·현장 일관). 한 파일에만
                # UID 가 박히고 현장 [FS에서 열기] 는 그 UID 로 정확히 그 파일을 여니 결과는 명확하다.
                def _mtime(p: Path) -> float:
                    try:
                        return p.stat().st_mtime
                    except Exception:
                        return 0.0
                fs_path = max(hits, key=_mtime)
                _stamp_log(f"인쇄 .fs[{order_number}] — '{fs_stem}.fs' {len(hits)}개 중 최신 수정본 채택: {fs_path}")
                _diag_log("   후보(최신순): " + " | ".join(
                    str(p) for p in sorted(hits, key=_mtime, reverse=True)[:8]) + (" …" if len(hits) > 8 else ""))
            uid = _write_fs_uid_ads(fs_path)
            _stamp_log(f"인쇄 .fs[{order_number}] 확정: {fs_path} (UID={uid or '미발급'})")
            return str(fs_path), uid
        _stamp_log(f"인쇄 .fs[{order_number}] — 거래처 폴더에 '{fs_stem}.fs' 없음 → UID/경로 미전송, 현장 폴백")
        return "", ""
    except Exception as e:
        _stamp_log(f"인쇄 .fs[{order_number}] 확정 실패: {e}")
        return "", ""


def _qr_order_from_payload(data: str) -> str | None:
    """QR 페이로드 문자열에서 /p/{orderNumber} 를 추출해 주문번호 반환. 패턴 불일치면 None.

    워처가 QR 박을 때 quote(order_number, safe="") 로 URL-인코딩되어 들어가므로 한글 주문번호
    ("주문-260427-03" 등)면 %EC%A3%... 형태. existing_worksheets 의 orderNumber 는 원본
    텍스트라 unquote 후 비교해야 매칭. 인코딩 안 된 원본이 와도 unquote 는 그대로 돌려준다."""
    if not data:
        return None
    m = re.search(r"/p/([^/?#\s]+)", data)
    if not m:
        return None
    try:
        order = unquote(m.group(1)).strip()
    except Exception:
        order = m.group(1).strip()
    return order or None


def _otsu_threshold(gray: "Image.Image") -> "Image.Image":
    """PIL 만으로 Otsu 이진화 — 히스토그램에서 클래스간 분산이 최대가 되는 임계값으로 자른다.
    안티얼라이싱으로 회색 그라데이션이 낀 QR 셀 경계를 한 임계로 깔끔히 가르는 데 효과적."""
    hist = gray.histogram()[:256]
    total = sum(hist)
    if total == 0:
        return gray
    sum_all = sum(i * hist[i] for i in range(256))
    sum_bg = 0.0
    w_bg = 0
    max_var = -1.0
    thresh = 128
    for t in range(256):
        w_bg += hist[t]
        if w_bg == 0:
            continue
        w_fg = total - w_bg
        if w_fg == 0:
            break
        sum_bg += t * hist[t]
        m_bg = sum_bg / w_bg
        m_fg = (sum_all - sum_bg) / w_fg
        var_between = w_bg * w_fg * (m_bg - m_fg) ** 2
        if var_between > max_var:
            max_var = var_between
            thresh = t
    return gray.point(lambda v, th=thresh: 255 if v >= th else 0, mode="L")


def _pyzbar_decode_qr(img):
    """pyzbar 호출 — 가능하면 QRCODE 심볼로만 제한(다른 1D 바코드 오탐/낭비 제거)."""
    if _ZBAR_QR_ONLY is not None:
        try:
            return pyzbar_decode(img, symbols=_ZBAR_QR_ONLY)
        except Exception:
            pass
    return pyzbar_decode(img)


def _cv2_decode_qr(pil) -> str | None:
    """OpenCV QRCodeDetector — zbar 가 놓친 케이스 보강(알고리즘이 달라 상호 보완). cv2 없으면 None."""
    if cv2 is None or _np is None:
        return None
    try:
        arr = _np.array(pil.convert("L"))
        det = cv2.QRCodeDetector()
    except Exception:
        return None
    try:
        data, _pts, _st = det.detectAndDecode(arr)
        o = _qr_order_from_payload(data or "")
        if o:
            return o
    except Exception:
        pass
    try:
        ok, datas, _pts, _st = det.detectAndDecodeMulti(arr)
        if ok and datas:
            for data in datas:
                o = _qr_order_from_payload(data or "")
                if o:
                    return o
    except Exception:
        pass
    return None


def _decode_qr_from_pil(pil: "Image.Image", *, tag: str = "") -> str | None:
    """한 장의 PIL 이미지에서 QR 디코드 시도 — 여러 전처리 변형으로 pyzbar, 그래도 실패면 cv2.
    찾으면 주문번호, 못 찾으면 None."""
    if pyzbar_decode is not None:
        gray = pil.convert("L")
        big = gray.width * gray.height > 3000 * 4000  # 600dpi A4 급 — 확대는 비용 과해 생략
        ac = ImageOps.autocontrast(gray, cutoff=2)
        blurred = gray.filter(ImageFilter.GaussianBlur(radius=1))
        variants: list[tuple[str, Image.Image]] = [
            ("gray", gray),
            ("otsu", _otsu_threshold(gray)),
            ("th128", gray.point(lambda v: 255 if v >= 128 else 0, mode="L")),
            ("th100", gray.point(lambda v: 255 if v >= 100 else 0, mode="L")),
            ("th170", gray.point(lambda v: 255 if v >= 170 else 0, mode="L")),
            ("autocontrast", ac),
            ("autocontrast_otsu", _otsu_threshold(ac)),
            ("blur_th", blurred.point(lambda v: 255 if v >= 128 else 0, mode="L")),
        ]
        if not big:
            variants.append(("upscale2x", gray.resize((gray.width * 2, gray.height * 2), Image.BICUBIC)))
        for vname, img in variants:
            try:
                results = _pyzbar_decode_qr(img)
            except Exception as e:
                ui_log(f"QR 디코드 pyzbar 실패({tag} {vname}): {e}")
                continue
            for r in results or []:
                try:
                    data = r.data.decode("utf-8", errors="ignore")
                except Exception:
                    continue
                o = _qr_order_from_payload(data)
                if o:
                    return o
                ui_log(f"QR 디코드: /p/ 패턴 불일치 ({tag} {vname}) — 내용: {data[:80]!r}")
    # pyzbar 가 다 놓쳤거나 미설치 → OpenCV 로 한 번 더.
    return _cv2_decode_qr(pil)


def _qr_shape_present_cv2(pil: "Image.Image") -> bool:
    """cv2.QRCodeDetector.detect() — corner 패턴만 찾고 디코드는 안 한다(decode 보다 훨씬 싸다).
    QR 모양 자체가 없으면 False → 호출 측이 슬로우 변형 스윕을 건너뛰도록 신호."""
    if cv2 is None or _np is None:
        return False
    try:
        arr = _np.array(pil.convert("L"))
        det = cv2.QRCodeDetector()
        ok, _pts = det.detect(arr)
        return bool(ok)
    except Exception:
        return False


def decode_pdf_qr(pdf_path: Path) -> str | None:
    """인쇄된 PDF 에서 QR 을 디코드해 주문번호를 반환. 실패/미설치 시 None.

    QR URL 은 워처가 박을 때 /p/{orderNumber} 형식 — 호스트는 무시하고 path 만 매칭한다
    (스테이징/로컬 호스트로 바뀌어도 인식). pyzbar/cv2 모두 없거나 PDF 가 깨졌으면 호출자는
    QR 매칭 없이 평소 다이얼로그(수동 선택)로 폴백한다.

    2단 구조 — 신규 지시서(QR 없음) 처리 속도 회복:
      [Fast pass] 전 페이지 300dpi gray 한 번씩만 pyzbar 시도 + cv2.detect 코너 검사.
        ・pyzbar 가 디코드하면 즉시 반환 (대부분의 깨끗한 QR 케이스)
        ・어느 페이지에서도 cv2 코너 검출이 안 되면 "QR 부재" 로 판단해 슬로우 스윕 생략
      [Slow sweep] cv2 가 코너는 잡았지만 pyzbar 가 못 풀었을 때만 진입 — FlexSign→PDF24
        경로에서 모듈 경계가 뭉개진 케이스 보강(예: 진성커뮤니티 11-19 같은 큰 도면).
        ・200/300/400/600dpi 재렌더 + 8가지 전처리 변형 + OpenCV detectAndDecode 폴백
        ・최종 실패 시 첫 렌더 이미지를 state/qr_debug/<stem>.png 로 덤프
    """
    if pyzbar_decode is None and cv2 is None:
        ui_log("QR 디코드 건너뜀: pyzbar/opencv 라이브러리 없음 (exe 빌드시 --collect-all pyzbar 등 필요)")
        return None
    if fitz is None:
        ui_log("QR 디코드 건너뜀: pymupdf(fitz) 라이브러리 없음")
        return None
    if not pdf_path.exists():
        return None

    DPIS = (300, 200, 400, 600)
    try:
        doc = fitz.open(str(pdf_path))
    except Exception as e:
        ui_log(f"QR 디코드 실패(PDF 열기): {e}")
        return None

    debug_image: Image.Image | None = None
    last_size: tuple[int, int] | None = None
    try:
        # ── Fast pass: 페이지별 300dpi 한 번씩만 시도, cv2 코너 검출 동시 수행. ──
        any_qr_shape = False
        for page_idx in range(doc.page_count):
            try:
                page = doc[page_idx]
                mat = fitz.Matrix(300 / 72, 300 / 72)
                pix = page.get_pixmap(matrix=mat, alpha=False)
                pil = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
            except Exception as e:
                ui_log(f"QR 디코드 fast 렌더 실패(p{page_idx}): {e}")
                continue
            last_size = (pil.width, pil.height)
            if debug_image is None:
                debug_image = pil
            # 1) pyzbar 빠른 1샷 (gray, 변형 없음)
            if pyzbar_decode is not None:
                try:
                    results = _pyzbar_decode_qr(pil.convert("L"))
                    for r in results or []:
                        try:
                            data = r.data.decode("utf-8", errors="ignore")
                        except Exception:
                            continue
                        o = _qr_order_from_payload(data)
                        if o:
                            return o
                except Exception as e:
                    ui_log(f"QR fast pyzbar 실패(p{page_idx}): {e}")
            # 2) cv2 코너 검출 (decode 안 함, 빠름) — 모양만이라도 보이면 슬로우 스윕 가치 있음
            if not any_qr_shape and _qr_shape_present_cv2(pil):
                any_qr_shape = True
                ui_log(f"QR fast: 코너 검출됨(p{page_idx}) — 디코드는 슬로우 스윕에서 재시도")

        if not any_qr_shape:
            ui_log(f"QR 디코드: 사전 스캔으로 QR 부재 확인 ({pdf_path.name}) — 슬로우 스윕 생략")
            return None

        # ── Slow sweep: 코너는 검출됐는데 디코드 못한 케이스만 진입 ──
        for page_idx in range(doc.page_count):
            try:
                page = doc[page_idx]
            except Exception as e:
                ui_log(f"QR 디코드 페이지 로드 실패(p{page_idx}): {e}")
                continue
            for dpi in DPIS:
                try:
                    mat = fitz.Matrix(dpi / 72, dpi / 72)
                    pix = page.get_pixmap(matrix=mat, alpha=False)
                    pil = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
                except Exception as e:
                    ui_log(f"QR 디코드 렌더 실패(p{page_idx} {dpi}dpi): {e}")
                    continue
                last_size = (pil.width, pil.height)
                o = _decode_qr_from_pil(pil, tag=f"p{page_idx} {dpi}dpi")
                if o:
                    return o
    finally:
        try:
            doc.close()
        except Exception:
            pass

    # 모든 페이지/DPI/변형에서 실패 — 디버그 이미지를 남겨 사용자가 직접 검증할 수 있게 한다.
    size_str = f"{last_size[0]}x{last_size[1]}" if last_size else "?"
    if debug_image is not None:
        try:
            debug_dir = WATCH_DIR / "state" / "qr_debug"
            debug_dir.mkdir(parents=True, exist_ok=True)
            debug_path = debug_dir / f"{pdf_path.stem}.png"
            debug_image.save(debug_path, "PNG")
            ui_log(f"QR 디코드: PDF 안에서 QR 코드를 찾지 못함 ({pdf_path.name}, {size_str}). 디버그: {debug_path}")
        except Exception as e:
            ui_log(f"QR 디코드: PDF 안에서 QR 코드를 찾지 못함 ({pdf_path.name}, {size_str}). 디버그 저장 실패: {e}")
    else:
        ui_log(f"QR 디코드: PDF 안에서 QR 코드를 찾지 못함 ({pdf_path.name})")
    return None


# ── 인쇄 의도(intent) 선택 — 2단계 분리 ────────────────────────────────────────
# 인쇄 누르면 매번 [💾 웹 작업으로 진행] / [🖨 종이만 인쇄] 두 옵션의 필터 모달만 뜬다.
# 종이만이면 fast path 로 빠르게 종이만 출력하고 끝. 웹 작업으로 가면 QR 감지 + 매칭
# 다이얼로그로 진행하고, 거기서 [웹반영&인쇄 / 웹반영만 / 종이만] 라디오로 최종 의도를 고른다.
# (캐시는 없음 — 매번 사용자가 직접 결정해야 직전 의도가 굳어지는 사고가 없음.)
_INTENT_LABEL = {
    "web_print": "웹반영 & 인쇄",
    "web_only": "웹반영만",
    "paper_only": "종이 인쇄만",
}


def _ask_print_intent_modal(stem: str | None, busy_close) -> tuple[str, int]:
    """인쇄 직후 1단계 필터 모달. (choice, paper_copies) 반환.
    choice ∈ {"web_flow", "paper_only", "cancel"}.

    "web_flow" 는 QR 감지 + 매칭 다이얼로그로 진행해 거기서 최종 의도(웹반영&인쇄/웹반영만/
    종이만) 를 라디오로 다시 고른다. 여기서는 그냥 "종이만 인쇄로 끝낼지" 만 거른다 — QR
    디코드/주문목록 fetch/매칭 다이얼로그 비용을 피하려는 fast path.

    paper_copies: choice=='paper_only' 일 때만 의미 있음(>=1). 그 외엔 0.

    busy_close: 모달 표시 직전에 호출할 콜백(인쇄물 처리중 안내창 닫기용).
    저장된 .fs 면 파일명 표시, 미저장이면 그 사실을 안내.
    """
    holder: dict = {"choice": "cancel", "copies": 0, "done": threading.Event()}

    def _show():
        try:
            busy_close()
        except Exception:
            pass
        try:
            win = tk.Toplevel()
            win.title("인쇄 방식 선택")
            win.configure(bg="#ffffff")
            win.resizable(False, False)
            try:
                win.attributes("-topmost", True)
            except Exception:
                pass
            frm = tk.Frame(win, bg="#ffffff")
            frm.pack(padx=28, pady=22, fill="both")
            tk.Label(frm, text="인쇄 방식 선택",
                     bg="#ffffff", fg="#18181b", font=("맑은 고딕", 14, "bold"),
                     anchor="w").pack(fill="x")
            tk.Label(frm, text="FlexiSIGN 인쇄가 감지되었습니다. 어떻게 처리할까요?",
                     bg="#ffffff", fg="#71717a", font=("맑은 고딕", 10),
                     anchor="w").pack(fill="x", pady=(6, 4))
            if stem:
                tk.Label(frm, text=f"파일 : {stem}.fs",
                         bg="#ffffff", fg="#52525b", font=("맑은 고딕", 9),
                         anchor="w").pack(fill="x", pady=(0, 14))
            else:
                tk.Label(frm, text="※ 아직 저장되지 않은 새 도큐먼트입니다.",
                         bg="#ffffff", fg="#b91c1c", font=("맑은 고딕", 9),
                         anchor="w").pack(fill="x", pady=(0, 14))

            def _choose(c: str):
                holder["choice"] = c
                try:
                    win.destroy()
                except Exception:
                    pass

            def _make_choice(parent, label, sub, icon, color_bg, color_fg, on_click,
                             hover_bg):
                btn = tk.Frame(parent, bg=color_bg, cursor="hand2",
                               highlightbackground="#a1a1aa", highlightthickness=1)
                btn.pack(fill="x", pady=(0, 8))
                inner = tk.Frame(btn, bg=color_bg, cursor="hand2")
                inner.pack(fill="x", padx=14, pady=10)
                icon_lbl = tk.Label(inner, text=icon, bg=color_bg, fg=color_fg,
                                    font=("Segoe UI Emoji", 18), cursor="hand2")
                icon_lbl.pack(side="left", padx=(0, 12))
                text_fr = tk.Frame(inner, bg=color_bg, cursor="hand2")
                text_fr.pack(side="left", fill="x", expand=True)
                title_lbl = tk.Label(text_fr, text=label, bg=color_bg, fg=color_fg,
                                     font=("맑은 고딕", 12, "bold"), anchor="w",
                                     cursor="hand2")
                title_lbl.pack(fill="x")
                sub_lbl = tk.Label(text_fr, text=sub, bg=color_bg, fg=color_fg,
                                   font=("맑은 고딕", 9), anchor="w", cursor="hand2")
                sub_lbl.pack(fill="x")

                def _on_enter(_e=None):
                    for w in (btn, inner, icon_lbl, text_fr, title_lbl, sub_lbl):
                        try:
                            w.configure(bg=hover_bg)
                        except Exception:
                            pass

                def _on_leave(_e=None):
                    for w in (btn, inner, icon_lbl, text_fr, title_lbl, sub_lbl):
                        try:
                            w.configure(bg=color_bg)
                        except Exception:
                            pass

                for w in (btn, inner, icon_lbl, text_fr, title_lbl, sub_lbl):
                    w.bind("<Button-1>", lambda _e: on_click())
                    w.bind("<Enter>", _on_enter)
                    w.bind("<Leave>", _on_leave)

            _make_choice(frm,
                "웹 작업으로 진행",
                "QR 감지 → 매칭 다이얼로그에서 최종 결정 (웹반영&인쇄 / 웹반영만 / 종이만)",
                "\U0001F4BE", "#2563eb", "white",
                lambda: _choose("web_flow"), "#1d4ed8")
            _make_choice(frm,
                "종이만 인쇄",
                "현재 화면 그대로 종이만 인쇄 (저장/업로드 없음 — 빠른 경로)",
                "\U0001F5A8", "#f4f4f5", "#18181b",
                lambda: _choose("paper_only"), "#e4e4e7")

            win.protocol("WM_DELETE_WINDOW", lambda: _choose("cancel"))
            win.bind("<Escape>", lambda _e: _choose("cancel"))
            win.update_idletasks()
            ww, wh = win.winfo_reqwidth(), win.winfo_reqheight()
            sw, sh = win.winfo_screenwidth(), win.winfo_screenheight()
            win.geometry(f"{ww}x{wh}+{(sw - ww) // 2}+{max(40, (sh - wh) // 3)}")
            try:
                win.grab_set()
                win.focus_force()
            except Exception:
                pass
            win.wait_window()
        except Exception as e:
            ui_log(f"인쇄 의도 모달 오류: {e}")
        finally:
            holder["done"].set()

    _ui_queue.put(("run", _show))
    holder["done"].wait()

    if holder["choice"] == "paper_only":
        copies = _ask_paper_copies_modal()
        if copies <= 0:
            return ("cancel", 0)
        holder["copies"] = copies

    return (holder["choice"], holder["copies"])


def _ask_paper_copies_modal() -> int:
    """[종이 인쇄만] 선택 시 매수 입력 모달. 0 또는 취소 시 0 반환."""
    holder: dict = {"value": 0, "done": threading.Event()}

    def _show():
        try:
            win = tk.Toplevel()
            win.title("인쇄 매수")
            win.configure(bg="#ffffff")
            win.resizable(False, False)
            try:
                win.attributes("-topmost", True)
            except Exception:
                pass
            frm = tk.Frame(win, bg="#ffffff")
            frm.pack(padx=28, pady=22)
            tk.Label(frm, text="종이 인쇄 매수",
                     bg="#ffffff", fg="#18181b", font=("맑은 고딕", 13, "bold"),
                     anchor="w").pack(fill="x")
            tk.Label(frm, text="현재 화면 그대로 인쇄할 매수를 입력해주세요.",
                     bg="#ffffff", fg="#71717a", font=("맑은 고딕", 10),
                     anchor="w").pack(fill="x", pady=(6, 14))
            entry_var = tk.StringVar(value="1")
            entry = tk.Entry(frm, textvariable=entry_var, font=("맑은 고딕", 14),
                             width=10, justify="center")
            entry.pack(pady=(0, 16))

            def _confirm():
                try:
                    v = int(entry_var.get().strip())
                except Exception:
                    v = 0
                if v < 1:
                    v = 0
                holder["value"] = v
                try:
                    win.destroy()
                except Exception:
                    pass

            def _cancel():
                holder["value"] = 0
                try:
                    win.destroy()
                except Exception:
                    pass

            btns = tk.Frame(frm, bg="#ffffff")
            btns.pack(fill="x")
            tk.Button(btns, text="취소", command=_cancel,
                      font=("맑은 고딕", 10), bg="#e4e4e7", fg="#18181b",
                      activebackground="#d4d4d8", relief="flat", bd=0, padx=14, pady=8,
                      cursor="hand2").pack(side="right")
            tk.Button(btns, text="✓ 인쇄", command=_confirm,
                      font=("맑은 고딕", 10, "bold"), bg="#2563eb", fg="white",
                      activebackground="#1d4ed8", relief="flat", bd=0, padx=14, pady=8,
                      cursor="hand2").pack(side="right", padx=(0, 8))

            win.bind("<Return>", lambda _e: _confirm())
            win.bind("<Escape>", lambda _e: _cancel())
            win.protocol("WM_DELETE_WINDOW", _cancel)
            win.update_idletasks()
            ww, wh = win.winfo_reqwidth(), win.winfo_reqheight()
            sw, sh = win.winfo_screenwidth(), win.winfo_screenheight()
            win.geometry(f"{ww}x{wh}+{(sw - ww) // 2}+{max(40, (sh - wh) // 3)}")
            try:
                win.grab_set()
                entry.focus_set()
                entry.select_range(0, tk.END)
            except Exception:
                pass
            win.wait_window()
        except Exception as e:
            ui_log(f"인쇄 매수 모달 오류: {e}")
        finally:
            holder["done"].set()

    _ui_queue.put(("run", _show))
    holder["done"].wait()
    return holder["value"]


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

    # ── "처리 중" 창 ── 인쇄물 감지~매칭 다이얼로그 사이 + 매칭 확정 후 패치/업로드/인쇄
    # 진행 단계까지 빈 화면을 메우는 진행 안내. 단계마다 메시지가 다르므로 _show_busy 가
    # title/subtitle 을 받는다. 기존 창이 있으면 먼저 닫고 새로 띄움.
    _busy: dict = {"win": None, "pb": None}

    def _show_busy(title: str | None = None, subtitle: str | None = None):
        # 이미 열린 창이 있으면 닫고 새로 그린다 — 같은 처리 안에서 단계 전환할 때 사용.
        if _busy.get("win") is not None:
            _close_busy()
        title_text = title or "인쇄물을 확인하고 있습니다…"
        sub_text = subtitle or "QR 코드 인식 · 발주 목록 불러오는 중 — 잠시만 기다려 주세요."
        try:
            w = tk.Toplevel()
            w.title("인쇄물 처리 중")
            w.configure(bg="#ffffff")
            w.resizable(False, False)
            try:
                w.attributes("-topmost", True)
            except Exception:
                pass
            fr = tk.Frame(w, bg="#ffffff")
            fr.pack(padx=28, pady=22)
            tk.Label(fr, text=title_text, bg="#ffffff", fg="#18181b",
                     font=("맑은 고딕", 12, "bold"), anchor="w").pack(fill="x")
            tk.Label(fr, text=sub_text,
                     bg="#ffffff", fg="#71717a", font=("맑은 고딕", 9), anchor="w").pack(fill="x", pady=(6, 12))
            pb = ttk.Progressbar(fr, mode="indeterminate", length=300)
            pb.pack(fill="x")
            try:
                pb.start(12)
            except Exception:
                pass
            _busy["win"], _busy["pb"] = w, pb
            w.protocol("WM_DELETE_WINDOW", _close_busy)  # 보통 자동으로 닫히지만, 원하면 직접 닫아도 무방
            w.update_idletasks()
            ww, wh = w.winfo_reqwidth(), w.winfo_reqheight()
            sw, sh = w.winfo_screenwidth(), w.winfo_screenheight()
            w.geometry(f"{ww}x{wh}+{(sw - ww) // 2}+{max(40, (sh - wh) // 3)}")
        except Exception as e:
            ui_log(f"처리중 창 표시 오류: {e}")

    def _close_busy():
        w = _busy.get("win")
        if w is None:
            return
        _busy["win"] = None
        try:
            pb = _busy.get("pb")
            if pb is not None:
                pb.stop()
        except Exception:
            pass
        try:
            w.destroy()
        except Exception:
            pass

    _ui_queue.put(("run", _show_busy))

    # 파일이 완전히 쓰여질 때까지 잠깐 대기 (PDF24 가 청크 단위로 쓸 수 있음).
    # 짧게 — 더 길게 잡으면 그만큼 매칭 창이 늦게 뜬다. 혹시 부분 파일이면 QR 디코드만
    # 한 번 빗나가고(QR 미인식 → 폴백) 이후 종이/업로드는 더 늦게 일어나니 문제 없음.
    time.sleep(0.3)

    # ── 인쇄 직후 1단계 필터 모달 ──────────────────────────────────────────────
    # [💾 웹 작업으로 진행] / [🖨 종이만 인쇄] 두 옵션. 종이만이면 QR/매칭 전부 건너뛰는
    # fast path. 웹 작업이면 QR 감지 + 매칭 다이얼로그에서 [웹반영&인쇄 / 웹반영만 / 종이만]
    # 라디오로 최종 의도 결정.
    # (FlexiSIGN 창 상태는 자동저장 시 prior_status 보완용으로만 기억.)
    # 인쇄 직후 타이밍 실패(다이얼로그 최상단/제목 갱신중)를 줄이려 짧게 재시도(상한 ~0.24s).
    _intent_status, _intent_stem, _ = _flexisign_window_status_quick()

    filter_choice, paper_copies = _ask_print_intent_modal(_intent_stem, _close_busy)
    ui_log(f"인쇄 필터 — '{filter_choice}' (stem={_intent_stem or '(unsaved)'}, copies={paper_copies})")

    if filter_choice == "cancel":
        ui_log(f"인쇄 — 필터 모달 취소: 종이/업로드 모두 생략 ({pdf_path.name})")
        _ui_queue.put(("run", _close_busy))
        _schedule_printed_pdf_cleanup(pdf_path)
        return

    if filter_choice == "paper_only":
        ui_log(f"인쇄 — [종이 인쇄만] {paper_copies}장 ({pdf_path.name}) — 저장/매칭/업로드 모두 생략")
        _ui_queue.put(("run", _close_busy))
        if paper_copies > 0:
            try:
                print_pdf_to_paper(pdf_path, copies=paper_copies)
            except Exception as e:
                ui_log(f"종이 인쇄 실패: {e}")
        _schedule_printed_pdf_cleanup(pdf_path)
        return

    # filter_choice == "web_flow" — 매칭 다이얼로그가 최종 의도 결정. 일단 기본은 web_print 로
    # 시작하고, 매칭 다이얼로그의 라디오로 사용자가 web_only/paper_only 로 바꾸면 sel["intent"]
    # 가 그 값을 가져온다. 아래 로직은 sel["intent"] 를 받은 뒤 분기.
    intent = "web_print"

    # 의도 모달이 busy 안내창을 닫아버렸으므로, 이후 QR 디코드 + 발주 목록 fetch 동안
    # 사용자에게 다시 진행 상태 보여줌(매칭/QR-create 다이얼로그가 뜨면서 닫는다).
    _ui_queue.put(("run", _show_busy))

    # NOTE: FlexiSIGN 자동저장(Ctrl+S → .fs)은 매칭 다이얼로그가 *뜨기 전* 이 아니라,
    # 사용자가 매칭 다이얼로그에서 [✓ 적용하기] 를 누른 *후* 에 수행된다(patch_due_date 직전).
    # 이유: 다이얼로그 뜨자마자 자동저장하면, 사용자가 매칭 다이얼로그에서 [취소] 하더라도
    # .fs 는 이미 덮어써진 상태가 됨 — "취소했는데 파일은 저장됨" UX 가 의도와 다름.
    # [✓ 적용하기] 후로 옮기면, 취소 시엔 .fs 도 손대지 않고 그대로 보존된다.

    # 시스템 기본 프린터는 워처 실행 동안 PDF24 로 유지 — 종이 인쇄는
    # print_pdf_to_paper 가 시스템 기본과 무관하게 삼성으로 직접 보낸다.
    # 워처 종료 시 on_close 에서 원래 프린터로 일괄 복구.

    # 진행중 지시서 목록(/api/admin/orders) — QR 매칭 다이얼로그·[기존 변경] 탭·빈발주 폴백
    # 어디서든 필요한데 네트워크 왕복이라 수백 ms~수 초 걸린다. QR 디코드(수백 ms)와 *동시에*
    # 백그라운드로 받아 두 비용을 겹친다 — 직렬로 하면 매칭 창이 그만큼 늦게 뜸.
    _ew_holder: dict = {"v": []}

    def _fetch_existing_worksheets_bg():
        try:
            _ew_holder["v"] = fetch_existing_worksheets()
        except Exception as e:
            ui_log(f"기존 지시서 목록 조회 실패: {e}")

    _ew_thread = threading.Thread(target=_fetch_existing_worksheets_bg, daemon=True)
    _ew_thread.start()

    # PDF 안의 QR 인식 — 분기점. 있으면 매칭/업로드(기존), 없으면 QR 클립보드 복사 다이얼로그(신규).
    ui_log(f"인쇄물 감지: {pdf_path.name} — QR 확인 중…")
    qr_order_number = decode_pdf_qr(pdf_path)
    if qr_order_number:
        ui_log(f"QR 인식: {qr_order_number}")
    else:
        ui_log("QR 미인식 — 발주 매칭 창을 준비 중…")

    orders = list_recent_orders()
    if not orders and not qr_order_number:
        # 큐 비고 QR 도 못 찾아도 다이얼로그는 띄운다 — 사용자가 [기존 변경] 탭에서
        # 진행중 worksheet 그리드를 보고 수동으로 골라 매칭하거나, [매칭 안 함] 으로
        # 종이만 인쇄하기로 결정할 수 있게.
        ui_log(f"인쇄 PDF 감지 — 큐/QR 자동 매칭 실패, 수동 매칭 다이얼로그 띄움: {pdf_path.name}")

    # 위에서 동시 시작한 진행중 지시서 목록 fetch 합류 — 보통 QR 디코드 끝났을 즈음 이미 완료.
    _ew_thread.join(timeout=15)
    existing_worksheets = _ew_holder.get("v") or []

    if qr_order_number:
        has_existing = any(
            (w.get("orderNumber") or "") == qr_order_number
            for w in existing_worksheets
        )
        has_recent = any(
            (o.get("orderNumber") or "") == qr_order_number
            for o in orders
        )
        if not has_existing and not has_recent:
            qr_detail = fetch_public_worksheet_detail(qr_order_number)
            if qr_detail:
                if (qr_detail.get("worksheetPdfUrl") or "").strip():
                    existing_worksheets = [qr_detail] + list(existing_worksheets)
                    ui_log(f"QR 단건 조회 매칭: {qr_order_number} (기존 지시서)")
                else:
                    orders = [qr_detail] + list(orders)
                    ui_log(f"QR 단건 조회 매칭: {qr_order_number} (첫 지시서 등록)")
            else:
                ui_log(f"QR 주문 단건 조회 결과 없음: {qr_order_number}")

    # QR 디코드 실패 — 하지만 방금 [QR 코드 만들기] 로 빈 발주를 발급한 직후라면, 작업자가
    # 또 거래처를 골라 발급해 고아 카드를 만들기 전에 "이 인쇄물이 그 발주인가요?" 를 먼저 묻는다.
    _asked_recent_qr_only = False  # 이미 "이 빈 발주 맞습니까?" 를 물어봤으면 [QR 코드 만들기] 모달은 같은 경고 생략
    if qr_order_number is None:
        _cand = recent_incomplete_qr_only_orders(existing_worksheets)
        if _cand:
            _asked_recent_qr_only = True
            _m = _cand[0]
            _h0: dict = {"value": None, "done": threading.Event()}

            _age_str = _humanize_age_sec(_m.get("ageSec", 0))
            _company = str(_m.get("companyName") or "-")
            _ordno = str(_m.get("orderNumber") or "-")

            def _ask_recent_match():
                # 거래처명·발주번호·"몇 분 전"을 큼직하게 보여주는 커스텀 모달
                # (messagebox 는 글자 크기를 못 키운다). 빌드 실패해도 messagebox 로 폴백.
                _close_busy()  # "처리 중" 창 닫고 이 다이얼로그로 교체
                try:
                    win = tk.Toplevel()
                    win.title("발주 매칭 확인")
                    win.configure(bg="#ffffff")
                    win.resizable(False, False)
                    try:
                        win.attributes("-topmost", True)
                    except Exception:
                        pass
                    frm = tk.Frame(win, bg="#ffffff")
                    frm.pack(padx=24, pady=22, fill="both")
                    tk.Label(frm, text="이 인쇄물에서 QR 을 읽지 못했습니다 (지워졌거나 흐릴 수 있음).",
                             bg="#ffffff", fg="#18181b", font=("맑은 고딕", 12, "bold"),
                             anchor="w").pack(fill="x")
                    tk.Label(frm, text="최근에 발급한 빈 발주가 있습니다 — 이 지시서가 그 발주의 것인가요?",
                             bg="#ffffff", fg="#71717a", font=("맑은 고딕", 10),
                             anchor="w").pack(fill="x", pady=(8, 12))
                    card = tk.Frame(frm, bg="#f4f4f5", highlightbackground="#d4d4d8",
                                    highlightthickness=1)
                    card.pack(fill="x", pady=(0, 14))
                    tk.Label(card, text=_company, bg="#f4f4f5", fg="#18181b",
                             font=("맑은 고딕", 18, "bold"), anchor="w").pack(fill="x", padx=16, pady=(12, 0))
                    tk.Label(card, text=f"발주번호  {_ordno}", bg="#f4f4f5", fg="#3f3f46",
                             font=("맑은 고딕", 13, "bold"), anchor="w").pack(fill="x", padx=16, pady=(3, 0))
                    tk.Label(card, text=f"{_age_str} 발급", bg="#f4f4f5", fg="#71717a",
                             font=("맑은 고딕", 12), anchor="w").pack(fill="x", padx=16, pady=(3, 12))
                    tk.Label(frm,
                             text=f"[예] → {_ordno} 의 QR 을 클립보드에 다시 복사 → FlexSign 에 Ctrl+V 로 붙이고\n"
                                  f"        지시서를 다시 인쇄하세요 (이번 인쇄물은 QR 이 없어 배부하지 않습니다)\n"
                                  f"[아니오] → 거래처를 골라 새 발주 발급",
                             bg="#ffffff", fg="#71717a", font=("맑은 고딕", 9),
                             justify="left", anchor="w").pack(fill="x", pady=(0, 16))
                    btns = tk.Frame(frm, bg="#ffffff")
                    btns.pack(fill="x")

                    def _close(val: bool):
                        _h0["value"] = val
                        try:
                            win.destroy()
                        except Exception:
                            pass

                    tk.Button(btns, text="아니오 — 새 발주 발급", command=lambda: _close(False),
                              font=("맑은 고딕", 10), bg="#e4e4e7", fg="#18181b",
                              activebackground="#d4d4d8", relief="flat", bd=0, padx=16, pady=9,
                              cursor="hand2").pack(side="right")
                    tk.Button(btns, text="예 — QR 다시 복사", command=lambda: _close(True),
                              font=("맑은 고딕", 10, "bold"), bg="#10b981", fg="white",
                              activebackground="#0ea371", relief="flat", bd=0, padx=16, pady=9,
                              cursor="hand2").pack(side="right", padx=(0, 8))
                    win.protocol("WM_DELETE_WINDOW", lambda: _close(False))
                    win.bind("<Escape>", lambda _e: _close(False))
                    win.bind("<Return>", lambda _e: _close(True))
                    win.update_idletasks()
                    w, h = win.winfo_reqwidth(), win.winfo_reqheight()
                    sw, sh = win.winfo_screenwidth(), win.winfo_screenheight()
                    win.geometry(f"{w}x{h}+{(sw - w) // 2}+{max(40, (sh - h) // 3)}")
                    try:
                        win.grab_set()
                        win.focus_force()
                    except Exception:
                        pass
                    win.wait_window()
                except Exception as e:
                    ui_log(f"발주 매칭 확인 다이얼로그 오류 — 기본 창으로 폴백: {e}")
                    try:
                        _h0["value"] = messagebox.askyesno(
                            "발주 매칭 확인",
                            f"이 인쇄물의 QR 을 읽지 못했습니다.\n\n"
                            f"{_age_str} 발급한 빈 발주: {_ordno}  ·  {_company}\n\n"
                            f"이 인쇄물이 그 발주의 지시서가 맞습니까?")
                    except Exception as e2:
                        ui_log(f"발주 매칭 확인 폴백 다이얼로그도 실패: {e2}")
                finally:
                    _h0["done"].set()

            _ui_queue.put(("run", _ask_recent_match))
            _h0["done"].wait()
            if _h0["value"]:
                # [예] = "이 인쇄물이 그 빈 발주의 지시서다 — QR 만 빠졌다." → 그 발주의 QR 을
                # 클립보드에 다시 복사해 사용자가 FlexSign 에 붙이고 재인쇄하게 한다.
                # 이번 인쇄물(QR 없는 PDF)은 배부/업로드하지 않는다 — 두 번째(QR 박힌) 인쇄에서
                # 평소 흐름(QR 인식 → 납기/배송/분배함 → 업로드)으로 들어간다.
                ui_log(f"QR 미인식 → 빈 발주 {_ordno} 의 QR 재복사 (사용자가 FlexSign 에 붙여 재인쇄)")
                _reqr_ok = False
                try:
                    qr_to_clipboard(_ordno)
                    _reqr_ok = True
                except Exception as e:
                    ui_log(f"QR 클립보드 복사 실패 ({_ordno}): {e}")
                if _reqr_ok:
                    ui_log(f"{_ordno} QR 클립보드 복사 완료 — FlexSign 에 붙여넣고 다시 인쇄")
                    _reqr_msg = (
                        f"발주번호 {_ordno} 의 QR 이 클립보드에 복사되었습니다.\n\n"
                        f"1) FlexSign 캔버스로 돌아가 (지워졌거나 흐린) QR 자리에 Ctrl+V 로 붙여넣기\n"
                        f"2) 지시서 저장 후 다시 인쇄\n\n"
                        f"이번 인쇄물은 QR 이 없어 배부/업로드하지 않았습니다.\n"
                        f"두 번째 인쇄에서 납기 / 배송 / 분배함 입력 단계로 진행됩니다.\n\n"
                        f"※ 이 창을 닫으면 FlexSign 으로 자동 전환됩니다."
                    )
                    _show_qr_copy_done_and_focus_flex("QR 코드 복사 완료 — 다시 인쇄하세요", _reqr_msg)
                else:
                    _ui_queue.put((
                        "alert",
                        "QR 클립보드 복사 실패",
                        f"발주번호 {_ordno} 의 QR 클립보드 복사에 실패했습니다.\n"
                        f"어드민 페이지에서 QR 을 다시 발급해 사용해주세요.",
                    ))
                _close_busy()
                _schedule_printed_pdf_cleanup(pdf_path)
                return

    # [신규 작성] 탭에서 더 이상 거래처를 직접 고르지 않으므로 fetch 생략 — 거래처 발주 발급은
    # 메인 GUI [QR 코드 만들기] 모달에서만 일어나고, 거기서 자기 데이터를 따로 받는다.
    clients_for_new: list[dict] = []

    # PDF 에 QR 이 없을 때(보통 케이스) — [QR 코드 만들기] 모달을 1차 진입점으로 띄운다.
    # 거래처를 골라 새 발주를 발급받거나, [기존지시서 변경하기] 버튼으로 _ask_print_match_blocking
    # 의 [기존 변경] 탭으로 위임. QR 이 디코드된 경우엔 종전대로 곧장 _ask_print_match_blocking.
    sel: dict | None = None
    if qr_order_number is None:
        routing_ctx: dict = {
            "pdf_path": pdf_path,
            "orders": orders,
            "existing_worksheets": existing_worksheets,
            "clients_for_new": clients_for_new,
            # 위에서 "이 빈 발주 맞습니까?" 를 이미 물어보고 [아니오] 했으면 모달 안에서 같은 경고 생략.
            "skip_recent_qr_warning": _asked_recent_qr_only,
            # [기존지시서 변경하기] 진입 시 _ask_print_match_blocking 에 그대로 전달.
            "intent": intent,
            # 모달이 거래처 목록 다 받고 화면에 뜨기 직전 "처리 중" 창을 닫게 한다.
            "busy_close": _close_busy,
            "result": {"action": "cancel"},
            "done": threading.Event(),
        }
        open_qr_create_dialog_async(print_routing_context=routing_ctx)
        routing_ctx["done"].wait()
        _ui_queue.put(("run", _close_busy))  # 안전망 — 모달 초기화가 실패해 못 닫혔어도 확실히 닫음
        action = (routing_ctx.get("result") or {}).get("action") or "cancel"
        if action == "cancel":
            ui_log(f"인쇄 — [QR 코드 만들기] 취소: 종이/업로드 모두 생략 ({pdf_path.name})")
            return
        if action == "qr_created":
            order_num = (routing_ctx["result"].get("order_number") or "").strip()
            ui_log(f"인쇄 — QR 발급({order_num}) 후 재인쇄 대기: 이번 PDF 는 종이/업로드 생략 ({pdf_path.name})")
            _schedule_printed_pdf_cleanup(pdf_path)
            return
        # action == "modify_existing" — _ask_print_match_blocking 가 ctx 안에서 이미 실행됨.
        sel = (routing_ctx.get("result") or {}).get("sel")
    else:
        holder: dict = {"value": None, "done": threading.Event()}

        def _ask_on_ui():
            _close_busy()  # "처리 중" 창 닫고 매칭 다이얼로그로 교체
            try:
                holder["value"] = _ask_print_match_blocking(
                    orders, pdf_path, existing_worksheets,
                    qr_order_number=qr_order_number,
                    clients_for_new=clients_for_new,
                    intent=intent,
                )
            except Exception as e:
                # 다이얼로그 자체가 터지면 사용자가 취소한 것처럼 조용히 묻혀 PDF24 인쇄가 무위로 끝나므로,
                # UI 로그에 명시 — 'PDF24 보냈는데 왜 취소되지?' 류 디버깅을 위해 흔적 남김.
                ui_log(f"인쇄 매칭 다이얼로그 오류: {e}")
            finally:
                holder["done"].set()

        _ui_queue.put(("run", _ask_on_ui))
        holder["done"].wait()
        _ui_queue.put(("run", _close_busy))  # 안전망
        sel = holder["value"]

    if sel is None:
        ui_log(f"인쇄 — 사용자 취소: 종이 인쇄/업로드 모두 생략 ({pdf_path.name})")
        return

    # QR 클립보드 복사 모드 — qr_order_number 가 None 이었던 경우(=PDF 에 QR 없음).
    # [신규 작성] 탭에서 거래처를 선택해 빈 주문을 발급한 직후, 또는 [기존 변경] 탭에서
    # 옛 worksheet 에 QR 만 다시 박고 싶을 때 호출. 이 PDF 는 R2 업로드 안 하고 종이 인쇄도
    # 생략 — 사용자가 FlexSign 에 QR 붙여 저장 후 재인쇄해야 두 번째 인쇄가 R2 업로드된다.
    if sel.get("qr_only_copy"):
        order_num = (sel.get("order_number") or "").strip()
        if order_num:
            qr_copy_ok = False
            try:
                qr_to_clipboard(order_num)
                qr_copy_ok = True
            except Exception as e:
                ui_log(f"QR 클립보드 복사 실패 ({order_num}): {e}")
            if qr_copy_ok:
                ui_log(f"{order_num} QR 클립보드 복사 완료 — FlexSign 에 붙여넣고 다시 인쇄")
                info_msg = (
                    f"발주번호 {order_num} 의 QR 이 클립보드에 복사되었습니다.\n\n"
                    f"1) FlexSign 캔버스로 돌아가 Ctrl+V 로 붙여넣기\n"
                    f"2) 지시서 저장 후 다시 인쇄\n\n"
                    f"두 번째 인쇄에서 납기 / 배송 / 분배함 입력 단계로 진행됩니다.\n\n"
                    f"※ 이 창을 닫으면 FlexSign 으로 자동 전환됩니다."
                )
                _show_qr_copy_done_and_focus_flex("QR 코드 복사 완료", info_msg)
            else:
                _ui_queue.put((
                    "alert",
                    "QR 클립보드 복사 실패",
                    f"발주번호 {order_num} 는 등록되었지만 QR 클립보드 복사에 실패했습니다.\n"
                    f"어드민 페이지에서 QR 을 다시 발급해 사용해주세요.",
                ))
        _schedule_printed_pdf_cleanup(pdf_path)
        return

    # 매칭 다이얼로그에서 최종 의도 결정 — 라디오 값을 받아 intent 로 반영한다.
    intent = sel.get("intent") or intent
    ui_log(f"인쇄 의도 — 매칭 다이얼로그 최종 결정 '{_INTENT_LABEL.get(intent, intent)}' ({pdf_path.name})")

    # 라디오에서 [종이만 인쇄] 를 골랐다면 FlexiSIGN 저장/매칭/업로드 모두 건너뛰고 종이만.
    # (매칭 다이얼로그에서 사용자가 '아 그냥 종이만 뽑을래' 로 마음 바꾼 케이스.)
    if intent == "paper_only":
        copies = int(sel.get("copies") or 0)
        ui_log(f"인쇄 — 매칭 다이얼로그 [종이만 인쇄] {copies}장 ({pdf_path.name}) — 저장/업로드 생략")
        if copies > 0:
            _ui_queue.put(("run", lambda c=copies: _show_busy(
                "종이 인쇄 중…",
                f"{c}장 출력 중 — 잠시만 기다려 주세요.",
            )))
            try:
                print_pdf_to_paper(pdf_path, copies=copies)
            except Exception as e:
                ui_log(f"종이 인쇄 실패: {e}")
            _ui_queue.put(("run", _close_busy))
        _schedule_printed_pdf_cleanup(pdf_path)
        return

    # 사용자가 매칭 다이얼로그에서 [✓ 적용하기] 또는 [매칭 안 함] 등 *진행* 의사를 표시한
    # 직후 FlexiSIGN 자동저장. 항상 Ctrl+S 한 번 보내고:
    #   ・이미 저장된 .fs (또는 변경분만 있는 .fs): FlexiSIGN 이 즉시 자동저장 → 즉시 통과.
    #   ・진짜 새(이름 없는) 도큐먼트: FlexiSIGN 이 Save As 다이얼로그를 띄움 →
    #     워처가 그걸 감지하면 "지시서 제목 입력 대기" 모달, 사용자가 저장 완료 시 통과.
    #     [취소]/타임아웃이면 auto_ok=False → patch/업로드/종이 모두 생략하고 종료.
    #   ・no_window (다른 앱 인쇄): Ctrl+S 안 보내고 그대로 통과.
    auto_ok, alert_kind = _auto_save_flexisign_for_print(
        pdf_path,
        prior_status=_intent_status,
        prior_stem=_intent_stem,
    )
    if not auto_ok:
        ui_log(f"인쇄 — Save As 대기 중 사용자 취소/타임아웃: patch/업로드/종이 모두 생략 ({pdf_path.name})")
        return

    # NOTE: 자동저장 결과 + 처리 결과를 한 번의 모달에 합쳐서 끝에 띄운다. 사용자가
    # "확인" 한 번만 클릭하면 끝. alert_kind 는 아래 분기에서 메시지 prefix 로 사용.

    # 자동 저장 이후 patch/업로드/(필요 시) 인쇄가 네트워크 + I/O 라 수 초 걸린다 — 진행 안내.
    # 의도별로 다음 단계 표현을 다르게(상세 결과 모달과 일관성 유지).
    _PROGRESS_SUB = {
        "web_print": "저장 완료 · 웹 업로드 → 종이 인쇄 — 잠시만 기다려 주세요.",
        "web_only":  "저장 완료 · 웹 업로드 중 — 잠시만 기다려 주세요.",
    }
    _ui_queue.put(("run", lambda i=intent: _show_busy(
        "웹에 반영 중…",
        _PROGRESS_SUB.get(i, "처리 중 — 잠시만 기다려 주세요."),
    )))

    # [웹반영만] 라디오 — 매칭 다이얼로그가 정해주는 copies 와 무관하게 종이 인쇄는
    # 무조건 스킵. 아래 print_done 분기에서 sel.get("skip_print") 가 받는다.
    if intent == "web_only":
        sel["skip_print"] = True

    order_number = sel.get("order_number")
    # 다이얼로그 [✓ 적용하기] 로 확정된 매수. 0 이면 종이 인쇄 생략 — 0 or 1 함정 회피를
    # 위해 None 인 경우만 1 로 폴백하고, 명시적 0 은 그대로 0 으로 전달한다.
    copies_raw = sel.get("copies")
    copies = int(copies_raw) if copies_raw is not None else 1
    if order_number is None:
        _ui_queue.put(("run", _close_busy))
        if intent == "web_only":
            # 웹반영만 의도였는데 매칭이 안 됨 — 업로드도 인쇄도 안 일어남, 명시적으로 안내.
            ui_log(f"인쇄 — [웹반영만] + 매칭 안 함: 아무 작업도 수행 안 됨 ({pdf_path.name})")
            _ui_queue.put((
                "run",
                lambda: messagebox.showwarning(
                    "처리 안 됨",
                    "[웹반영만]을 선택했지만 발주 매칭이 안 되어\n"
                    "업로드와 종이 인쇄가 모두 진행되지 않았습니다.",
                ),
            ))
        elif copies < 1:
            ui_log(f"인쇄 — 매칭 안 함 선택 + 매수 0, 종이 인쇄 생략 ({pdf_path.name})")
        else:
            ui_log(f"인쇄 — 매칭 안 함 선택, 종이 인쇄만 진행 ({pdf_path.name}, {copies}장)")
            print_pdf_to_paper(pdf_path, copies=copies)
            _show_combined_done_modal(
                alert_kind,
                f"종이 인쇄 완료 ({copies}장).\n웹 반영은 진행하지 않았습니다.",
            )
        # 직원이 명시적으로 "웹에 안 올림" 선택 — PDF 가 더 갈 데 없으므로 정리.
        _schedule_printed_pdf_cleanup(pdf_path)
        return

    # 새 폼은 month + day 를 같이 받음 — 명시적 월 입력으로 자동 추론 의존을 없앤다.
    if "month" in sel:
        new_due = resolve_new_due_date_md(
            sel.get("current_due_iso", ""), sel["month"], sel["day"]
        )
    else:
        # 구버전 호환 — 혹시 month 없는 흐름이 남아 있으면 day 만으로 폴백.
        new_due = resolve_new_due_date(sel.get("current_due_iso", ""), sel["day"])
    # 배송방법은 다이얼로그에서 변경된 경우에만 함께 보낸다(원래 값과 같으면 생략).
    new_delivery = sel.get("delivery_method") or ""
    orig_delivery = sel.get("original_delivery_method") or ""
    delivery_to_send = new_delivery if (new_delivery and new_delivery != orig_delivery) else None
    # 부서 태그(모바일 필터용)와 슬롯 라벨(다이얼로그 ✓ 정확 복원용)을 항상 함께 송신.
    # 빈 리스트도 명시적 "비우기" 의도라 None 이 아니라 list() 로 강제.
    dept_tags = list(sel.get("department_tags") or [])
    dept_slots = list(sel.get("department_slots") or [])
    patch_due_date(order_number, new_due, delivery_to_send, dept_tags, dept_slots)

    # NOTE: '자동 저장' 안내는 이 함수 앞쪽(_auto_save_flexisign_for_print 직후)에서
    # 이미 띄웠다 — patch/업로드 전에 사용자에게 결과를 먼저 보여주기 위함.
    # 사용자가 메모를 새로 입력/수정했을 때만 contentChanged=true. prefill 된 이전 메모를
    # 그대로 두고 confirm 한 단순 재인쇄는 preserve_note=True 로 보내 DB 의 메모만 보존
    # (worksheetUpdatedAt 도 갱신 안 됨 → 모바일/관리자 변경 배지 트리거 X).
    # 인쇄한 도큐먼트 stem 을 단일 출처로 확정 — 인쇄 직전(다이얼로그 전) 캡처한 _intent_stem 을
    # 우선 쓴다(인쇄 후 사용자가 다른 FlexiSIGN 창으로 전환해도 '인쇄한 그 문서'를 가리킴).
    # _intent_stem 이 없으면(새 도큐먼트라 Save As 로 이제야 이름이 생긴 경우 등) 지금 창에서 한 번 읽는다.
    # 이 stem 을 PDF 리네임(썸네일 이름)과 .fs UID 스탬프 양쪽에 같이 넘겨, 썸네일과 못 박는
    # .fs 가 같은 도큐먼트를 가리키게 한다('썸네일 ≠ 열리는 파일' 어긋남 원천 차단).
    printed_stem = _intent_stem
    if not printed_stem:
        try:
            _ps_status, _ps_stem, _ = _flexisign_window_status_quick()
            printed_stem = _ps_stem
        except Exception:
            printed_stem = None

    # PDF24 가 시각값 파일명으로 떨궜어도, 인쇄한 도큐먼트 stem 으로 리네임 → 업로드되는
    # originalPdfFilename 이 깔끔해져 (UID 가 없는 옛/폴백 케이스에서) .fs 이름 매칭이 정확해진다.
    pdf_path = _rename_printed_pdf_to_original(pdf_path, order_number, doc_stem=printed_stem)
    # 거래처 폴더에서 이 지시서의 .fs 를 단일 확정하고 그 파일에 UID(ADS)를 박는다 — 현장
    # [FS에서 열기] 가 그 UID(없으면 경로)로 직행. 확정 못 하면 ("","") → 현장은 이름 매칭 폴백.
    fs_path, fs_uid = _resolve_and_stamp_printed_fs(order_number, doc_stem=printed_stem)
    # ── 겹치기: PDF 업로드(네트워크/백엔드)를 백그라운드로 시작하고, 그 대기시간 동안 치수 추출
    #    (FlexiSIGN GUI + 입력가드)을 동시에 돌린다. 자원이 달라(네트워크 vs GUI) 병렬 → 체감 추가시간
    #    ~0. 치수는 부차 기능이라 어떤 실패든 PDF 업로드/인쇄 본류엔 영향 없음.
    _upload_box: dict = {}

    def _upload_pdf_bg():
        try:
            _upload_box["ok"] = upload_worksheet_pdf(
                order_number, pdf_path,
                content_changed=bool(sel.get("content_changed", False)),
                change_note=sel.get("change_note") or "",
                preserve_note=bool(sel.get("preserve_note", False)),
                original_fs_path=fs_path,
                original_fs_uid=fs_uid)
        except Exception as e:
            ui_log(f"PDF 업로드 스레드 예외: {e}")
            _upload_box["ok"] = False

    _up_thread = threading.Thread(target=_upload_pdf_bg, daemon=True)
    _up_thread.start()
    try:
        _extract_and_upload_dimensions(order_number, fs_path, _busy, pdf_path=pdf_path)
    except Exception as e:
        ui_log(f"치수 추출 예외(무시): {e}")
    _up_thread.join(timeout=180)
    upload_ok = _upload_box.get("ok", False)
    # "웹에만 적용하고 인쇄 안 함" 선택 또는 확정 매수 0 인 경우 종이 인쇄 생략.
    print_done = False
    if sel.get("skip_print"):
        ui_log(f"인쇄 — '인쇄 안 함' 선택, 종이 인쇄 생략 ({pdf_path.name})")
    elif copies < 1:
        ui_log(f"인쇄 — 매수 0(적용 안 함), 종이 인쇄 생략 ({pdf_path.name})")
    else:
        print_pdf_to_paper(pdf_path, copies=copies)
        print_done = True

    # 처리 결과 알림 직전 — '웹에 반영 중' 창 닫고 결과 모달로 교체.
    _ui_queue.put(("run", _close_busy))

    # 처리 결과 알림 — 자동저장 결과까지 한 모달에 합쳐서 끝에 한 번만 띄움.
    if upload_ok:
        if print_done:
            ops_msg = f"웹 반영 + 종이 인쇄 완료 ({copies}장)."
        else:
            ops_msg = "웹 반영 완료 (종이 인쇄 없이 업로드만 진행)."
        _show_combined_done_modal(alert_kind, ops_msg)
    else:
        # 업로드 자체가 실패한 경우 — 자동저장 결과는 부차적이므로 prefix 만 짧게.
        save_prefix = ""
        if alert_kind == 'saved':
            save_prefix = "FlexiSIGN 자동 저장 완료.\n"
        elif alert_kind == 'failed':
            save_prefix = "FlexiSIGN 자동 저장 실패 — Ctrl+S 로 직접 저장해주세요.\n"
        _ui_queue.put((
            "run",
            lambda p=save_prefix: messagebox.showwarning(
                "웹 반영 실패",
                f"{p}\n"
                "웹 업로드에 실패했습니다.\n"
                "PDF 는 로컬에 보관되어 있으니 잠시 후 다시 시도하거나,\n"
                "어드민 페이지에서 직접 업로드해주세요.",
            ),
        ))

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
        # doc.geometricBounds 는 대지 안/밖을 가리지 않고 도큐먼트 내 모든 visible art 의 외곽을 돌려준다.
        # → 거래처가 대지 밖에 그려둔 컨텐츠도 자동으로 폼 사이즈 산출에 반영된다.
        "  if (hasArt) {"
        "    try {"
        "      var dbnd = doc.geometricBounds;"  # [left, top, right, bottom]
        "      artLeft = dbnd[0]; artTop = dbnd[1]; artRight = dbnd[2]; artBottom = dbnd[3];"
        "      artWidth = artRight - artLeft;"
        "      if (artWidth <= 0) artWidth = abWidth;"
        "    } catch (e) { hasArt = false; }"
        "  }"
        # 폼 사이즈·위치의 기준은 "실제 도면 bounds" — 거래처가 큰 대지(예: 2874mm) 안에
        # 작은 도면(예: 1119mm)만 올려도 폼이 도면 폭에 맞춰진다. hasArt=false(빈 도큐먼트)
        # 면 대지로 폴백. 마지막에 대지를 ref* + 폼 footprint 로 다시 잡아 살짝 큰 사각으로 맞춘다.
        "  var refLeft = hasArt ? artLeft : abLeft;"
        "  var refTop = hasArt ? artTop : abTop;"
        "  var refRight = hasArt ? artRight : abRight;"
        "  var refBottom = hasArt ? artBottom : abBottom;"
        "  var refWidth = hasArt ? artWidth : abWidth;"
        # 워크시트가 도면 상단 폭을 꽉 채우도록 도면 폭 기준 10%.
        # 도면 크기와 무관하게 비례시켜야 작은 간판이든 큰 간판이든 폼이 일관되게 상단을 차지.
        "  var qrSize = refWidth * 0.10;"
        "  if (qrSize < 130) qrSize = 130;"  # 인쇄→PDF24→재디코드용 — 작은 도면에서도 최소 ~46mm 확보 (60pt→130pt)
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
        # 헤더박스는 도면 정중앙 정렬 — 좌(거래처)와 우(QR) 중 큰 쪽이 박스 한쪽 한계를 결정.
        # 좌+박스/2+margin+gap > refWidth/2 이거나 우측이 그렇다면 글씨/박스/QR 모두 동일 비율 s 로 축소.
        # margin·lineGap 은 sc 에 따라 자동으로 같이 줄어든다.
        "  var minGap = bigFont * 0.5;"
        "  var sideMax = (leftWidth > qrSize) ? leftWidth : qrSize;"
        "  var totalNeed = boxW / 2 + sideMax + margin + minGap;"
        "  if (totalNeed > refWidth / 2) {"
        "    var s = (refWidth / 2) / totalNeed;"
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
        "  var qrOriginX = refRight - margin - qrSize;"
        "  var noteW = qrSize * 1.9;"
        "  var noteRight = qrOriginX + qrSize;"
        "  var noteLeft = noteRight - noteW;"
        "  if (noteLeft < refLeft + margin + boxW / 2) {"
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
        # 폼은 항상 도면 위쪽에 얹힌다 (도면 ref* 기준). hasArt=false 면 빈 도큐먼트 대지 상단부터.
        "  var topY = hasArt ? (refTop + overlayHeight + margin) : abTop;"
        # 새 대지 = 도면(또는 폴백 시 대지) + 폼 footprint + 살짝 여유. 폼 위·도면 좌우/하단을 모두 감싼다.
        "  var needAbTop = topY + margin;"
        "  var needAbBottom = hasArt ? (refBottom - margin) : abBottom;"
        # 노트가 너무 길어 도면 하단을 넘어가면 그만큼 새 대지 하단을 키운다.
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
        "  var leftTargetX = refLeft + margin;"
        "  var leftTargetTop = topY - margin;"
        "  leftTf.position = [leftTargetX - lb[0], leftTargetTop - lb[1]];"
        # ── 중앙 상단: 박스 + 발주/배송 텍스트 ──
        "  var centerX = (refLeft + refRight) / 2;"
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
        # 새 대지: 도면(ref*) + 폼 footprint 를 모두 감싸도록 사방에 margin 만큼 여유.
        # 거래처가 실제 도면보다 큰 대지에 작업했어도 출력 대지는 도면 + 살짝 여유로 줄어든다.
        # hasArt=false 인 빈 도큐먼트는 원래 대지 좌우를 그대로 사용.
        "  var newAbLeft = hasArt ? (refLeft - margin) : abLeft;"
        "  var newAbRight = hasArt ? (refRight + margin) : abRight;"
        "  try { doc.artboards[0].artboardRect = [newAbLeft, needAbTop, newAbRight, needAbBottom]; } catch (e) {}"
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
        "  if (qrSize < 130) qrSize = 130;"  # 인쇄→PDF24→재디코드용 — 작은 도면에서도 최소 ~46mm 확보 (60pt→130pt)
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


def _enumerate_illustrator_progids() -> list[str]:
    """HKEY_CLASSES_ROOT 에서 'Illustrator.Application' 또는 버전 접미사가 붙은
    ProgID 를 모두 찾아 반환. CC 2024+ 일부 설치본은 bare ProgID 를 등록하지 않고
    'Illustrator.Application.28' 같은 형태만 등록하는 경우가 있어 fallback 필요."""
    try:
        import winreg
    except Exception:
        return []
    found: list[str] = []
    try:
        with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, "") as root:
            i = 0
            while True:
                try:
                    name = winreg.EnumKey(root, i)
                except OSError:
                    break
                if name.startswith("Illustrator.Application"):
                    found.append(name)
                i += 1
    except Exception:
        return found
    # bare 를 최우선, 그 다음 버전 큰 순서로 정렬 (최신 버전 우선 시도).
    def _sort_key(n: str):
        if n == "Illustrator.Application":
            return (0, 0)
        suffix = n.rsplit(".", 1)[-1]
        try:
            return (1, -int(suffix))
        except ValueError:
            return (2, 0)
    found.sort(key=_sort_key)
    return found


def _get_active_illustrator():
    """실행 중인 Illustrator 의 COM Application 객체 반환.
    'Illustrator.Application' 이 등록 안 돼 있을 수 있어 버전 접미사도 같이 시도.
    모든 시도 실패 시 RuntimeError — 시도한 ProgID 들과 마지막 에러 포함."""
    import win32com.client as win32

    progids = _enumerate_illustrator_progids() or ["Illustrator.Application"]
    attempts: list[str] = []
    last_error: Exception | None = None
    for progid in progids:
        try:
            app = win32.GetActiveObject(progid)
            ui_log(f"Illustrator COM 연결: {progid}")
            return app
        except Exception as e:
            attempts.append(f"{progid}={e}")
            last_error = e
    raise RuntimeError(
        f"Illustrator COM 연결 실패. Illustrator 가 실행 중인지, 워처와 Illustrator 를 "
        f"같은 권한으로 실행했는지, Illustrator COM/스크립팅 구성요소가 등록되어 있는지 "
        f"확인하세요. 시도: {attempts or [str(last_error)]}"
    )


def check_illustrator_com_ready() -> tuple[bool, str]:
    """Illustrator 프로세스 실행만으로는 부족해서 COM 연결 가능 여부까지 확인."""
    try:
        import pythoncom

        pythoncom.CoInitialize()
        progids = _enumerate_illustrator_progids()
        if not progids:
            return (
                False,
                "Illustrator 는 실행 중이지만 Windows COM 등록을 찾지 못했습니다.\n\n"
                "이 PC에서 아래 순서로 조치해 주세요.\n"
                "1. Illustrator 를 완전히 종료한 뒤 다시 실행\n"
                "2. 워처와 Illustrator 를 같은 권한으로 실행(둘 다 일반 실행 또는 둘 다 관리자 실행)\n"
                "3. 그래도 같으면 Adobe Creative Cloud 에서 Illustrator 복구/재설치\n\n"
                "원인: Illustrator.Application ProgID 가 이 PC의 레지스트리에 등록되어 있지 않습니다.",
            )
        try:
            _get_active_illustrator()
            return True, ""
        except Exception as e:
            return (
                False,
                "Illustrator 는 실행 중이지만 워처가 자동 저장용 COM 연결을 만들지 못했습니다.\n\n"
                "이 PC에서 아래 순서로 확인해 주세요.\n"
                "1. 워처와 Illustrator 를 같은 권한으로 실행(둘 다 일반 실행 또는 둘 다 관리자 실행)\n"
                "2. Illustrator 를 한 번 직접 열고 빈 문서를 만든 뒤 다시 시도\n"
                "3. 계속 실패하면 Adobe Creative Cloud 에서 Illustrator 복구/재설치\n\n"
                f"상세 오류: {e}",
            )
    except Exception as e:
        return False, f"Illustrator COM 확인 중 오류가 발생했습니다.\n\n상세 오류: {e}"


def convert_header_only(order_number: str, qr_js_matrix: str,
                        header_text: str, left_text: str, note_text: str) -> Path | None:
    """주문 정보로부터 헤더만 그린 AI v8 를 생성. 성공 시 경로, 실패 시 None."""
    try:
        import pythoncom

        pythoncom.CoInitialize()
        ai_app = _get_active_illustrator()
        ai_app.UserInteractionLevel = -1

        out_dir = WATCH_DIR / "converted"
        out_dir.mkdir(exist_ok=True)
        # 사용자 요청: 파일명에 타임스탬프 안 붙임.
        out_path = out_dir / f"{safe_filename_stem(order_number)}_헤더.ai"

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

        pythoncom.CoInitialize()
        ai_app = _get_active_illustrator()
        ai_app.UserInteractionLevel = -1

        out_dir = WATCH_DIR / "converted"
        out_dir.mkdir(exist_ok=True)
        # 확장자 .ai (Illustrator v8): FlexSign 으로 임포트 시 화면 표시는 정상.
        # 직원이 회사 네트워크 폴더에 저장할 때 [다른 이름으로 저장 → FlexiSIGN(.fs)]
        # 한 번 클릭으로 .fs 로 저장한다.
        # 사용자 요청: 파일명에 타임스탬프 안 붙임 — 같은 주문 재변환 시 FlexSign 캐시로
        # 이전 버전이 뜰 수 있는 가능성은 감수. 거래처 원본 AI 파일명의 Windows 금지문자만 위생화.
        safe_stem = safe_filename_stem(ai_path.stem)
        out_path = out_dir / f"{safe_stem}.ai"
        pdf_path = out_dir / f"{safe_stem}.pdf"

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


# 업로드 PDF 백드롭(참고사진) 화질 ↔ 용량 트레이드오프. 벡터(텍스트/QR/치수선)는 이 값과
# 무관하게 항상 원본 그대로 선명하다 — 이 DPI 는 '참고사진이 얼마나 또렷한가'만 정한다.
# 300 ≈ 0.6MB / 0.5초. 렌더가 빨라 DPI 를 올려도 속도는 거의 동일(용량만 증가) — 참고사진을
# 또렷하게. 더 가볍게 원하면 ↓(160 ≈ 0.3MB). 벡터(텍스트/QR/치수선) 선명도와는 무관한 값.
_UPLOAD_BACKDROP_DPI = 300
_UPLOAD_BACKDROP_JPEG_QUALITY = 65
# 백드롭 가장 긴 변 픽셀 상한 — A4 보다 큰 페이지(대형 도안)에서 백드롭이 비대해지는 것 방어.
# A4 @300DPI = 3508px 라 4000 이면 A4 는 풀 300DPI, A3+ 는 적응 하향.
_UPLOAD_BACKDROP_MAX_PX = 4000


def compress_pdf_for_upload(src: Path) -> Path:
    """업로드 직전, 참고사진을 저해상 '백드롭' 한 장으로 평탄화하되 벡터(텍스트/QR/치수선)는
    원본 그대로 선명하게 유지한다.

    왜: FlexSign→PDF24 는 참고사진 1장을 PDF 로 내보낼 때 종종 가로 1px 스캔라인 수백~수천 조각
    (관측: 사진 7장에 4030개 image XObject)으로 분해한다. 이전 방식(조각마다 resize+replace_image)은
    replace_image 가 호출마다 문서를 재구성해 거의 O(n²) 로 터졌고(실측 880조각 415초), 용량도
    12% 밖에 안 줄었다. 게다가 이미지 수가 많으면 백엔드가 400DPI 전체 재렌더(평탄화)까지 돌려
    업로드가 3~5분씩 걸렸다.

    방식(페이지마다) — 2레이어 분리:
      1) 백드롭(아래): 페이지를 복사해 벡터·텍스트를 제거(이미지만 남김) 후 저해상 JPEG 1장으로
         렌더 → '사진만' 담기고 벡터 자리는 흰 여백. (벡터까지 같이 구우면 흐린 벡터 잔상이
         위 선명 벡터 주변으로 번져 더 지저분해지므로 반드시 분리.)
      2) 윗장(벡터): 원본 페이지에서 이미지(사진 조각)만 apply_redactions 로 제거, 벡터·텍스트 보존
         (수천 조각도 0.6초)
      3) 사진 백드롭을 overlay=False 로 벡터 '밑'에 삽입 → 선명한 벡터는 깨끗한 흰 배경 위, 사진만
         저해상으로 비친다.
    결과: 6.5MB/880조각 → ~0.4MB, 약 1초. 백엔드도 이미지 1개짜리만 받아 평탄화/이중처리가
    자동으로 안 걸린다. 사진 화질은 _UPLOAD_BACKDROP_DPI 한 줄로 조절(참고용이라 다소 깨져도 OK).

    이미지가 0개인 순수 벡터 지시서는 건드리지 않고 원본 반환(이미 작고 빠름). 어떤 실패든
    발생하면 원본 반환 — 압축은 절대 업로드를 막지 않는다."""
    if fitz is None:
        return src
    import io
    out = Path(tempfile.gettempdir()) / f"hdsign_{src.stem}.min.pdf"
    try:
        doc = fitz.open(str(src))
    except Exception as e:
        ui_log(f"이미지 압축 — PDF 열기 실패: {e} (원본 그대로 업로드)")
        return src
    try:
        total_imgs = sum(len(page.get_images()) for page in doc)
        if total_imgs == 0:
            doc.close()
            ui_log("이미지 압축 — 래스터 사진 없음, 순수 벡터 (원본 그대로 업로드)")
            return src
        for page in doc:
            if page.rect.width <= 0 or page.rect.height <= 0:
                continue
            # ★ /Rotate 가 걸린 페이지(FlexSign 가로 지시서는 보통 rot=90, mediabox 는 세로)는
            # 회전 0 공간에서 일관 처리한 뒤 원래 회전을 복원한다. 안 그러면 get_pixmap(회전 적용)
            # 과 insert_image(회전 미적용 좌표)가 어긋나 백드롭이 90도 돌아간 채 박혀 지시서가
            # 세로로 보인다. 회전 0 에서 렌더·삽입하면 벡터·백드롭이 같은 좌표라 복원 시 함께 회전.
            rot = page.rotation
            page.set_rotation(0)
            rect = page.rect  # 회전 0 → mediabox
            # 가장 긴 변 픽셀이 상한을 넘지 않도록 DPI 적응 하향(대형 페이지 방어).
            longest_in = max(rect.width, rect.height) / 72.0
            dpi = _UPLOAD_BACKDROP_DPI
            if longest_in > 0:
                dpi = min(dpi, _UPLOAD_BACKDROP_MAX_PX / longest_in)
            # ── 백드롭(아래 레이어): '사진만' 굽는다 ──
            # 이 페이지만 별도 문서로 복사해 벡터/텍스트를 제거(이미지는 유지)하고 저해상 렌더.
            # 벡터까지 같이 구우면 그 '흐린 벡터'가 위에 올린 선명한 벡터 주변으로 번져(잔상)
            # 오히려 더 지저분해진다. 그래서 백드롭엔 사진만 담고 벡터 자리는 흰 여백으로 비운다.
            tmp = fitz.open()
            tmp.insert_pdf(doc, from_page=page.number, to_page=page.number)
            tpage = tmp[0]
            tpage.set_rotation(0)
            tpage.add_redact_annot(tpage.rect, fill=False)
            tpage.apply_redactions(
                images=fitz.PDF_REDACT_IMAGE_NONE,                     # 이미지 유지
                graphics=fitz.PDF_REDACT_LINE_ART_REMOVE_IF_TOUCHED,  # 벡터(line art) 제거
                text=fitz.PDF_REDACT_TEXT_REMOVE,                     # 텍스트 제거
            )
            pix = tpage.get_pixmap(matrix=fitz.Matrix(dpi / 72.0, dpi / 72.0), alpha=False)
            im = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
            buf = io.BytesIO()
            im.save(buf, format="JPEG", quality=_UPLOAD_BACKDROP_JPEG_QUALITY)
            backdrop = buf.getvalue()
            tmp.close()
            # ── 윗 레이어: '벡터만' 남긴다 ── 이미지(사진 조각)만 제거, 벡터·텍스트는 보존.
            # fill=False 라 흰 박스를 안 칠해 밑에 깔 사진 백드롭이 비친다.
            page.add_redact_annot(rect, fill=False)
            page.apply_redactions(
                images=fitz.PDF_REDACT_IMAGE_REMOVE,
                graphics=fitz.PDF_REDACT_LINE_ART_NONE,
                text=fitz.PDF_REDACT_TEXT_NONE,
            )
            # 사진만 든 백드롭을 벡터 '밑'에 삽입 → 선명한 벡터는 깨끗한 흰 배경 위, 사진만 저해상.
            page.insert_image(rect, stream=backdrop, overlay=False)
            page.set_rotation(rot)  # ★ 원래 회전 복원 → 벡터+백드롭 함께 회전
        doc.save(str(out), garbage=4, deflate=True)
        doc.close()
    except Exception as e:
        try:
            doc.close()
        except Exception:
            pass
        try:
            if out.exists():
                out.unlink()
        except Exception:
            pass
        ui_log(f"이미지 압축 실패: {e} — 원본으로 업로드")
        return src
    try:
        if out.exists() and out.stat().st_size < src.stat().st_size:
            before_kb = src.stat().st_size // 1024
            after_kb = out.stat().st_size // 1024
            ui_log(f"이미지 압축: {before_kb}KB → {after_kb}KB "
                   f"({100 - after_kb * 100 // max(before_kb, 1)}% 절감, "
                   f"사진 {total_imgs}조각→백드롭, 벡터 보존)")
            return out
        if out.exists():
            out.unlink()
    except Exception:
        pass
    return src


def upload_worksheet_pdf(order_number: str, pdf_path: Path,
                         content_changed: bool = False,
                         change_note: str = "",
                         preserve_note: bool = False,
                         original_fs_path: str = "",
                         original_fs_uid: str = "") -> bool:
    """변환된 PDF를 백엔드에 업로드. 거래처 카드에 노출되는 단일 PDF로 덮어씀.
    업로드 직전 Ghostscript 로 다운샘플링해 용량을 줄인다 (텍스트는 벡터 유지).
    multipart/form-data 를 표준 라이브러리만으로 구성한다 (외부 의존성 추가 없음).

    content_changed=True 면 contentChanged=true 폼 필드를 함께 보내서 백엔드가
    "변경" 배지를 띄우게 한다. 사용자가 다이얼로그에서 새 메모를 입력했을 때만 True.
    change_note: 작업자가 입력한 변경 사항 텍스트. 모바일 뷰어에서 PDF 한번 탭 시 노출.
                 content_changed=True 이고 비어있지 않을 때만 폼에 포함한다(빈 문자열은 백엔드에서 클리어).
    preserve_note=True: 다이얼로그에 prefill 된 이전 메모를 그대로 두고 confirm 한 경우.
                 백엔드가 DB 의 worksheetChangeNote 를 건드리지 않아 다음 회차에 또 prefill 되도록 영속.
                 content_changed 와 동시 True 일 일은 없음(상호 배타) — 다이얼로그가 그렇게 분기.
    original_fs_path: 워처가 인쇄 시점에 확정한 지시서 .fs 의 전체 경로. 비어 있지 않으면
                 originalFsPath 폼 필드로 보내 백엔드에 저장 — 현장 [FS에서 열기] 가 그 경로로
                 직행한다. 빈 문자열이면 필드를 안 보내 백엔드가 기존 값을 보존.
    original_fs_uid: 워처가 이번 인쇄에 발급해 그 .fs 의 ADS(hdsign.fsuid)에도 박은 전역 고유 ID.
                 비어 있지 않으면 originalFsUid 폼 필드로 보내 저장 — 현장이 이 UID 로 .fs 를
                 찾아 파일명이 바뀌어도 정확 매칭. 빈 문자열이면 필드를 안 보내 기존 값을 보존."""
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

    # contentChanged 필드는 사용자가 새 메모를 입력했을 때만 포함. 안 보내면 백엔드는
    # 단순 재인쇄로 간주해 worksheetUpdatedAt 갱신 안 함. preserveChangeNote=true 와 상호 배타.
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
    elif preserve_note:
        # 사용자가 prefill 된 이전 메모를 그대로 두고 confirm — 백엔드가 DB 의 메모를 보존.
        extra_field += (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="preserveChangeNote"\r\n\r\n'
            f"true\r\n"
        ).encode("utf-8")

    # 워처가 확정한 .fs 전체 경로 — 현장 [FS에서 열기] 가 이름 추측 없이 이 경로로 직행한다.
    # 빈 문자열이면 필드를 안 보내 백엔드가 직전 인쇄에서 잡아둔 경로를 보존한다.
    if original_fs_path:
        extra_field += (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="originalFsPath"\r\n\r\n'
            f"{original_fs_path}\r\n"
        ).encode("utf-8")

    # 이번 인쇄에 발급한 .fs UID(.fs 의 ADS 에도 동일 기록) — 현장 [FS에서 열기] 가 이 UID 로
    # .fs 를 찾는다. 빈 문자열이면 필드를 안 보내 백엔드가 기존 UID 를 보존.
    if original_fs_uid:
        extra_field += (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="originalFsUid"\r\n\r\n'
            f"{original_fs_uid}\r\n"
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


def upload_worksheet_objects(order_number: str, geom: dict) -> bool:
    """지시서 오브젝트별 가로세로(mm) 지오메트리 JSON 을 백엔드에 업로드(PDF 와 별도 호출).
    부차 기능 — 실패해도 인쇄/PDF업로드 본류엔 영향 없음."""
    if not order_number or not geom:
        return False
    try:
        body = json.dumps(geom, ensure_ascii=False).encode("utf-8")
    except Exception as e:
        ui_log(f"[치수] JSON 직렬화 실패: {e}")
        return False
    url = f"{API_BASE}/api/public/orders/{quote(order_number, safe='')}/worksheet-objects"
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Content-Length", str(len(body)))
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            resp.read()
        ui_log(f"[치수] {order_number} 지오메트리 업로드 완료 ({len(geom.get('objects', []))}개)")
        return True
    except urllib.error.HTTPError as e:
        ui_log(f"[치수] 지오메트리 업로드 실패 ({e.code}): {order_number}")
    except Exception as e:
        ui_log(f"[치수] 지오메트리 업로드 호출 실패: {e}")
    return False


_dim_lock_banner: dict = {"win": None}


def _show_lock_banner() -> None:
    """치수 추출(입력가드) 동안 '마우스/키보드 잠김' 안내 카드. 반드시 메인 UI 스레드(_ui_queue)에서 호출.
    현장 에이전트와 같은 다크 카드 + 🔒. WS_EX_TRANSPARENT 로 '클릭 통과'라 좌표 클릭도 방해 안 함.
    한 번만 만들어 재사용(withdraw/deiconify) — 교차스레드 재생성 크래시 회피."""
    try:
        CARD, ACCENT, FG, SUB = "#111a2e", "#38bdf8", "#f8fafc", "#94a3b8"
        w = _dim_lock_banner.get("win")
        if w is None:
            ww, wh = 460, 188
            w = tk.Toplevel()
            w.withdraw()
            w.overrideredirect(True)
            try:
                w.attributes("-topmost", True)
                w.attributes("-alpha", 0.97)
            except Exception:
                pass
            sw = w.winfo_screenwidth()
            sh = w.winfo_screenheight()
            x = max(0, (sw - ww) // 2)
            y = max(0, int(sh * 0.28) - wh // 2)  # 상단 28% — 중앙 대화상자와 안 겹침
            w.geometry(f"{ww}x{wh}+{x}+{y}")
            w.configure(bg=ACCENT)  # 1px accent 테두리
            card = tk.Frame(w, bg=CARD)
            card.pack(fill="both", expand=True, padx=2, pady=2)
            tk.Frame(card, bg=ACCENT, height=4).pack(fill="x")
            body = tk.Frame(card, bg=CARD)
            body.pack(fill="both", expand=True, padx=26, pady=18)
            tk.Label(body, text="🔒", bg=CARD, fg=ACCENT, font=("Segoe UI Emoji", 34)).pack()
            tk.Label(body, text="치수 데이터 추출 중", bg=CARD, fg=FG,
                     font=("맑은 고딕", 15, "bold")).pack(pady=(8, 2))
            tk.Label(body, text="잠시만 기다려 주세요  ·  ESC 키로 취소", bg=CARD, fg=SUB,
                     font=("맑은 고딕", 10)).pack()
            w.update_idletasks()
            # WS_EX: 포커스 안 뺏김(NOACTIVATE) + 작업표시줄 숨김(TOOLWINDOW) + 클릭 통과(TRANSPARENT).
            try:
                GWL_EXSTYLE = -20
                WS_EX_TRANSPARENT, WS_EX_TOOLWINDOW, WS_EX_NOACTIVATE = 0x20, 0x80, 0x08000000
                hwnd = ctypes.windll.user32.GetParent(w.winfo_id()) or w.winfo_id()
                cur = ctypes.windll.user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
                ctypes.windll.user32.SetWindowLongW(
                    hwnd, GWL_EXSTYLE, cur | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TRANSPARENT)
                ctypes.windll.user32.SetWindowPos(hwnd, -1, 0, 0, 0, 0, 0x1 | 0x2 | 0x10 | 0x40)
            except Exception:
                pass
            _dim_lock_banner["win"] = w
        try:
            w.deiconify()
            w.lift()
            w.attributes("-topmost", True)
        except Exception:
            pass
    except Exception as e:
        ui_log(f"치수 잠금 배너 표시 오류: {e}")


def _hide_lock_banner() -> None:
    w = _dim_lock_banner.get("win")
    if w is not None:
        try:
            w.withdraw()  # destroy 아님(재사용) — 교차스레드 GC 크래시 회피
        except Exception:
            pass


def _busy_set_topmost(busy, val) -> None:
    """'웹 반영 중' 모달의 topmost 토글 — 치수 추출 중엔 비-topmost 로 내려 좌표 클릭이
    모달에 가로채이지 않게 한다. (반드시 _ui_queue 로 메인 UI 스레드에서 호출)"""
    try:
        w = busy.get("win") if isinstance(busy, dict) else None
        if w is not None:
            w.attributes("-topmost", bool(val))
    except Exception:
        pass


def _compute_page_box(pdf_path: str):
    """워크시트 PDF 1페이지의 '벡터 drawings' bbox 를 '화면 표시(회전 반영) 좌표'로 정규화(0..1)해 반환.
    프론트 오버레이가 DXF extent 를 '전체 잉크 영역'(텍스트/사진 포함)이 아니라 '실제 벡터(아트워크) 영역'에
    매핑하도록 하는 기준 박스. DXF 는 벡터만(텍스트 제외)이라 PDF 의 get_drawings(=벡터 경로) bbox 와 대응한다.
    페이지 /Rotate 가 걸려 있으면(가로 지시서는 보통 rot=90) rotation_matrix 로 표시 좌표로 변환해야
    프론트가 렌더하는 (회전 적용된) 이미지와 정합한다. 실패하면 None — 프론트는 기존 휴리스틱으로 폴백."""
    try:
        import fitz  # PyMuPDF
        doc = fitz.open(pdf_path)
        try:
            pg = doc[0]
            dr = pg.get_drawings()
            if not dr:
                return None
            x0 = min(d["rect"].x0 for d in dr)
            y0 = min(d["rect"].y0 for d in dr)
            x1 = max(d["rect"].x1 for d in dr)
            y1 = max(d["rect"].y1 for d in dr)
            r = fitz.Rect(x0, y0, x1, y1) * pg.rotation_matrix  # 미회전 -> 표시(회전) 좌표
            r.normalize()
            R = pg.rect  # 표시(회전 적용) 페이지 rect
            if R.width <= 0 or R.height <= 0:
                return None
            bx = (r.x0 - R.x0) / R.width
            by = (r.y0 - R.y0) / R.height
            bw = r.width / R.width
            bh = r.height / R.height
            bx = min(max(bx, 0.0), 1.0)
            by = min(max(by, 0.0), 1.0)
            return {"x": bx, "y": by, "w": min(bw, 1.0 - bx), "h": min(bh, 1.0 - by)}
        finally:
            doc.close()
    except Exception:
        return None


def _extract_and_upload_dimensions(order_number: str, fs_path: str, busy, pdf_path: str = "") -> None:
    """[겹치기] 현재 활성 FlexiSIGN 문서를 DXF('외부 파일로 저장')로 내보내 오브젝트별 mm 를 추출 후
    서버 업로드. 입력가드(현장 잠금)로 자동화 중 작업자 물리입력 차단. 부차 기능 — 어떤 실패든
    조용히 넘어가 인쇄/PDF업로드 본류를 절대 막지 않는다. 문서는 export 만 — Save/Save-As 안 함.
    pdf_path: 인쇄 PDF — 거기서 벡터영역(page_box)을 계산해 geom 에 실어 보내(프론트 정렬 기준)."""
    try:
        import dxf_export
    except Exception as e:
        ui_log(f"[치수] dxf_export 로드 실패(스킵): {e}")
        return
    hwnd = 0
    try:
        _st, _stem, hwnd = _flexisign_window_status()
    except Exception:
        hwnd = 0
    if not hwnd:
        ui_log("[치수] FlexiSIGN 창 없음 — 추출 스킵")
        return
    # DXF 가 저장될 후보 폴더(현재폴더=활성 .fs 폴더 우선) + temp + converted.
    dirs = []
    if fs_path:
        try:
            dirs.append(str(Path(fs_path).parent))
        except Exception:
            pass
    dirs.append(tempfile.gettempdir())
    try:
        dirs.append(str(WATCH_DIR / "converted"))
    except Exception:
        pass
    # 좌표 클릭이 '웹 반영 중' 모달(topmost)에 가로채이지 않게 잠깐 비-topmost + 상단에 잠금 배너.
    _ui_queue.put(("run", lambda: _busy_set_topmost(busy, False)))
    _ui_queue.put(("run", _show_lock_banner))
    time.sleep(0.2)
    geom = None
    try:
        geom = dxf_export.extract_dimensions(hwnd, dirs, log=ui_log)
    except Exception as e:
        ui_log(f"[치수] extract_dimensions 예외(무시): {e}")
    finally:
        _ui_queue.put(("run", _hide_lock_banner))
        _ui_queue.put(("run", lambda: _busy_set_topmost(busy, True)))
    if geom and geom.get("objects"):
        # 프론트 정렬 기준 = '실제 벡터영역'(page_box). 인쇄 PDF 에서 회전 반영해 계산해 geom 에 싣는다.
        # (전체 잉크 bbox 휴리스틱은 지시서마다 텍스트/사진 배치가 달라 어긋났음 — page_box 로 정확히.)
        try:
            pb = _compute_page_box(pdf_path) if pdf_path else None
            if pb:
                geom["page_box"] = pb
                ui_log(f"[치수] page_box={pb}")
        except Exception as e:
            ui_log(f"[치수] page_box 계산 예외(무시): {e}")
        # 지오메트리 JSON 업로드는 백그라운드로 — 매크로(입력가드)는 이미 끝났으니, 이 네트워크 전송이
        # 결과 모달/인쇄 임계경로에 얹혀 매크로 직후 잠깐 멈춰 보이던 것을 없앤다.
        threading.Thread(
            target=lambda g=geom: upload_worksheet_objects(order_number, g),
            daemon=True,
        ).start()
    else:
        ui_log("[치수] 추출 결과 없음 — 업로드 스킵")


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
    동작 순서:
      1순위) WM_COMMAND 로 메뉴 직접 호출 → 다이얼로그 → 클립보드+Ctrl+V → Enter
            (포커스/IME/보안SW 키후킹 모두 우회)
      2순위) Alt+F → O 로 File > Open 메뉴 키보드 호출
      3순위) Ctrl+O 키 시뮬레이션 (앞 경로 실패 시 폴백, 스캔코드 강화)
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
    KEYEVENTF_SCANCODE = 0x0008
    WM_COMMAND = 0x0111
    MF_BYPOSITION = 0x0400

    def _vk_scancode(vk: int) -> int:
        try:
            return user32.MapVirtualKeyW(vk, 0)  # MAPVK_VK_TO_VSC
        except Exception:
            return 0

    def _press(vk: int) -> None:
        # 스캔코드 0 으로 보내면 일부 보안 SW / 키보드 후킹이 가짜로 판정해 차단함.
        # MapVirtualKey 로 실제 스캔코드 부여 — 노트북에선 둘 다 통하지만 사무실 PC 에선 차이 남.
        sc = _vk_scancode(vk)
        win32api.keybd_event(vk, sc, 0, 0)
        win32api.keybd_event(vk, sc, KEYEVENTF_KEYUP, 0)

    def _chord(modifier: int, key: int) -> None:
        sc_mod = _vk_scancode(modifier)
        sc_key = _vk_scancode(key)
        win32api.keybd_event(modifier, sc_mod, 0, 0)
        time.sleep(0.05)
        win32api.keybd_event(key, sc_key, 0, 0)
        time.sleep(0.05)
        win32api.keybd_event(key, sc_key, KEYEVENTF_KEYUP, 0)
        time.sleep(0.05)
        win32api.keybd_event(modifier, sc_mod, KEYEVENTF_KEYUP, 0)

    def _find_open_menu_id() -> int:
        """FlexSign 의 메뉴 트리를 순회해 'Open' / '열기' 항목의 menu ID 를 찾는다.
        실패 시 0 반환. 영문/한글 라벨 모두 대응.

        Windows 메뉴 텍스트는 보통 '&Open...\tCtrl+O' 형태 — 액셀러레이터 prefix '&' 와
        탭 이후 단축키 표기를 모두 제거한 뒤 매칭. 노트북에선 탭 없이 '&Open' 만이라
        startswith('open') 으로 통과했지만 사무실 PC 에선 다른 빌드일 수 있으니 둘 다 처리.
        """
        try:
            menu = user32.GetMenu(hwnd)
            if not menu:
                ui_log("FlexSign 창에 표준 Windows 메뉴 없음 (커스텀 UI)")
                return 0
            top_count = user32.GetMenuItemCount(menu)
            collected: list[str] = []
            for top_idx in range(top_count):
                sub = user32.GetSubMenu(menu, top_idx)
                if not sub:
                    continue
                cnt = user32.GetMenuItemCount(sub)
                for i in range(cnt):
                    buf = ctypes.create_unicode_buffer(256)
                    n = user32.GetMenuStringW(sub, i, buf, 256, MF_BYPOSITION)
                    if n <= 0:
                        continue
                    raw = buf.value
                    # 탭 이후는 단축키 표기 ("Open...\tCtrl+O") — 본 라벨만 남김.
                    label = raw.split("\t", 1)[0]
                    # & 는 액셀러레이터 prefix — 매칭에서 제외.
                    label = label.replace("&", "")
                    text = label.lower().strip()
                    if not text:
                        continue
                    collected.append(text)
                    # "Recent Files" / "Open Recent" / "Open Again" 류는 제외 (서브픽커).
                    if "recent" in text or "최근" in text or "again" in text:
                        continue
                    # "Open...", "Open File", "열기...", "파일 열기" 등.
                    if (text.startswith("open") or text.startswith("열기")
                            or "파일 열기" in text or "open file" in text):
                        mid = user32.GetMenuItemID(sub, i)
                        if mid and mid != 0xFFFFFFFF:
                            return mid & 0xFFFF
            # 매칭 실패 시 발견된 아이템들을 로그로 덤프 — 다음 라운드 디버깅 자료.
            if collected:
                preview = ", ".join(collected[:20])
                ui_log(f"메뉴 아이템 발견({len(collected)}개): {preview}")
            return 0
        except Exception as e:
            ui_log(f"메뉴 검색 예외: {e}")
            return 0

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
        # WM_COMMAND 우선 경로에선 포커스가 굳이 필요 없지만, Ctrl+O 폴백 경로엔 필수라
        # 양쪽 경로 모두 같은 진입을 거치도록 둔다.
        if not _force_foreground():
            ui_log("FlexSign 창을 foreground 로 가져오지 못함 — 메뉴 자동화 중단")
            return False
        time.sleep(0.4)

        # 2) 파일 열기 다이얼로그 띄우기 — 두 가지 경로를 순서대로 시도.
        #
        # 2a) WM_COMMAND 로 메뉴 직접 호출 (1순위)
        #     포커스/IME/키보드 후킹과 무관하게 FlexSign 의 메뉴 핸들러를 직접 깨운다.
        #     사무실 PC 처럼 키 시뮬레이션이 막히는 환경에서도 통한다.
        dlg_hwnd = 0
        open_id = _find_open_menu_id()
        if open_id:
            try:
                user32.PostMessageW(hwnd, WM_COMMAND, open_id, 0)
                ui_log(f"메뉴 ID {open_id} 로 [Open] 직접 호출")
                dlg_hwnd = _wait_for_open_dialog(timeout=3.0)
            except Exception as e:
                ui_log(f"WM_COMMAND 호출 실패: {e}")
        else:
            ui_log("FlexSign 메뉴에서 [Open] 항목을 찾지 못함 — Alt+F,O 키 경로로 폴백")

        # 2b) Alt+F → O 키보드 메뉴 경로. 드롭이 아니라 FlexSign [열기] 메뉴를 누르는 방식이라
        #     열리면 .ai 를 .fs 문서로 전환하는 기존 저장 흐름을 유지한다.
        if not dlg_hwnd:
            _chord(VK_MENU, ord('F'))
            time.sleep(0.25)
            _press(ord('O'))
            dlg_hwnd = _wait_for_open_dialog(timeout=3.0)
            if dlg_hwnd:
                ui_log("Alt+F,O 로 FlexSign [Open] 호출")
            else:
                ui_log("Alt+F,O 후 다이얼로그 미감지 — Ctrl+O 키 시뮬레이션으로 폴백")

        # 2c) Ctrl+O 키 시뮬레이션 (마지막 폴백)
        #     스캔코드 부여로 키 후킹 SW 도 가능한 한 통과시킨다.
        if not dlg_hwnd:
            for attempt in range(2):
                _chord(VK_CONTROL, ord('O'))
                dlg_hwnd = _wait_for_open_dialog(timeout=3.0)
                if dlg_hwnd:
                    break
                ui_log(f"Ctrl+O 후 다이얼로그 미감지 — 재시도 {attempt + 1}/2")
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
        flexsign_exe = find_flexsign_exe()
        if not flexsign_exe:
            ui_log("FlexSign 실행파일을 찾을 수 없습니다. [FlexSign 위치 지정] 버튼으로 직접 지정해주세요.")
            _ui_queue.put(("flexsign_missing",))
            return
        try:
            subprocess.Popen([flexsign_exe])
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

    # 안전망 — 워처 시작 시 이미 PDF24 로 전환했지만, 사용자가 도중에 기본 프린터를
    # 바꿨을 수 있으므로 매번 다시 한 번 보장. 이미 PDF24 면 무동작.
    switch_default_to_pdf24()

    # 드롭 방식은 화면에는 뜨지만 FlexSign 내부에서 .ai 문서로 잡혀 저장 오류가 난다.
    # 반드시 FlexSign 의 [열기] 흐름으로 v8 AI 를 열어 .fs 도큐먼트로 전환해야 한다.
    ui_log(f"FlexSign 창(HWND={hwnd}) — [파일 → 열기] 시뮬레이션")
    ok = _open_file_via_menu(hwnd, file_path)
    if ok:
        ui_log(f"FlexSign에 전달 완료: {file_path.name}")
    else:
        ui_log(f"FlexSign 열기 실패 — 드롭은 저장 오류가 나므로 사용하지 않습니다. 수동으로 [열기]에서 파일을 열어주세요: {file_path}")


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
    ok, message = check_illustrator_com_ready()
    if not ok:
        ui_log(f"{zip_path.name} 처리 보류 — Illustrator COM 연결 실패")
        ui_alert("Illustrator 연결 확인 필요", message)
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
        self.geometry("420x620")
        self.resizable(False, False)
        self.configure(bg=self.BG)
        try:
            self.iconbitmap(str(resource_path("hdsign_worksheet.ico")))
        except Exception:
            pass
        self._observer = None
        self._has_logs = False
        self._log_count = 0
        self._alert_banner: tk.Frame | None = None
        self._alert_banner_after_id: str | None = None
        # 최근 도착한 발주/견적 5건 — newest first. 자동지시서 처리 로그와 분리해
        # 작업이 활발해도 가려지지 않게 별도 섹션에 표시한다.
        self._alert_history: list[dict] = []
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
        flex_btn = tk.Button(
            act, text="FlexSign 위치 지정",
            bg="#f4f4f5", fg="#3f3f46",
            activebackground="#e4e4e7",
            font=("맑은 고딕", 9),
            relief="flat", bd=0, highlightthickness=0,
            cursor="hand2", padx=12, pady=6,
            command=change_flexsign_path_async,
        )
        flex_btn.pack(side="left", padx=(8, 0))
        # 메인 액션 — 손작업 지시서를 위한 QR 코드를 인쇄 흐름과 무관하게 즉시 발급.
        # 액센트 컬러로 강조해 사장님/직원이 자주 쓰는 버튼임을 시각적으로 구분.
        qr_btn = tk.Button(
            act, text="QR 코드 만들기",
            bg="#10b981", fg="white",
            activebackground="#059669", activeforeground="white",
            font=("맑은 고딕", 9, "bold"),
            relief="flat", bd=0, highlightthickness=0,
            cursor="hand2", padx=12, pady=6,
            command=open_qr_create_dialog_async,
        )
        qr_btn.pack(side="left", padx=(8, 0))

        # 현재 추적 경로를 작게 표시 — 매년 1월 폴더 옮긴 후 사장님이 확인 용도.
        self._tracked_lbl = tk.Label(
            self._card, text="", bg=self.CARD, fg="#a1a1aa",
            font=("맑은 고딕", 8), anchor="w", justify="left",
            wraplength=360,
        )
        self._tracked_lbl.pack(fill="x", padx=24, pady=(6, 0))
        self._refresh_tracked_label()

        # 새 발주/견적 알림 토글 — config.json 에 영속. 폴러 스레드가 매 사이클 _get_notify_enabled 를 읽어
        # 즉시 반영된다. 테스트 버튼은 사운드/배너 동작을 한 번 확인할 때 쓴다.
        notify_cfg = _load_config()
        self._notify_orders_var = tk.BooleanVar(
            value=True if notify_cfg.get("notify_orders") is None
            else bool(notify_cfg.get("notify_orders")))
        self._notify_sound_var = tk.BooleanVar(
            value=True if notify_cfg.get("notify_sound") is None
            else bool(notify_cfg.get("notify_sound")))

        notify_row = tk.Frame(self._card, bg=self.CARD)
        notify_row.pack(fill="x", padx=24, pady=(10, 0))

        tk.Checkbutton(
            notify_row, text="🔔 새 주문 알림",
            variable=self._notify_orders_var,
            bg=self.CARD, fg="#3f3f46",
            activebackground=self.CARD,
            selectcolor=self.CARD,
            font=("맑은 고딕", 9),
            bd=0, highlightthickness=0,
            command=self._on_toggle_notify,
        ).pack(side="left")

        tk.Checkbutton(
            notify_row, text="알림음",
            variable=self._notify_sound_var,
            bg=self.CARD, fg="#3f3f46",
            activebackground=self.CARD,
            selectcolor=self.CARD,
            font=("맑은 고딕", 9),
            bd=0, highlightthickness=0,
            command=self._on_toggle_sound,
        ).pack(side="left", padx=(12, 0))

        tk.Button(
            notify_row, text="테스트",
            bg=self.CARD, fg="#71717a",
            activebackground="#f4f4f5",
            font=("맑은 고딕", 8),
            relief="flat", bd=0, highlightthickness=0,
            cursor="hand2", padx=8, pady=2,
            command=self._test_alert,
        ).pack(side="right")

        # Divider
        tk.Frame(self._card, bg="#e4e4e7", height=1).pack(fill="x", padx=24, pady=(20, 0))

        # 최근 도착 — 새 발주/견적이 자동지시서 처리 로그에 묻히지 않도록 별도 섹션.
        alert_hdr = tk.Frame(self._card, bg=self.CARD)
        alert_hdr.pack(fill="x", padx=24, pady=(14, 0))
        self._alert_section_lbl = tk.Label(
            alert_hdr, text="최근 도착",
            bg=self.CARD, fg="#a1a1aa",
            font=("맑은 고딕", 8, "bold"),
        )
        self._alert_section_lbl.pack(side="left")
        self._alert_clear_btn = tk.Button(
            alert_hdr, text="전체 지우기",
            bg=self.CARD, fg="#a1a1aa",
            activebackground="#f4f4f5",
            font=("맑은 고딕", 8),
            relief="flat", bd=0, highlightthickness=0,
            cursor="hand2", padx=4, pady=0,
            command=self._clear_alert_history,
        )

        self._alert_list = tk.Frame(self._card, bg=self.CARD)
        self._alert_list.pack(fill="x", padx=24, pady=(6, 0))
        self._refresh_alert_history()

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

    # ── 새 주문 알림 ──

    def _on_toggle_notify(self):
        _set_notify_enabled(self._notify_orders_var.get())

    def _on_toggle_sound(self):
        _set_notify_sound_enabled(self._notify_sound_var.get())

    def _test_alert(self):
        """[테스트] 버튼 — 실제 폴러를 거치지 않고 알림 표시만 즉시 확인."""
        self._handle_order_alert("새 발주 (테스트)",
                                  "테스트 거래처 · 알림 동작 확인 · #TEST-000")

    def _handle_order_alert(self, title_text: str, body: str):
        """새 주문 폴러가 큐로 보낸 알림을 처리. 사운드 + 창 raise + 배너 + 별도 도착 섹션."""
        if _get_notify_sound_enabled():
            play_alert_sound()
        self._raise_window()
        self._show_alert_banner(title_text, body)
        self._push_alert_to_history(title_text, body)

    def _push_alert_to_history(self, title_text: str, body: str):
        entry = {"time": time.strftime("%H:%M"),
                 "title": title_text, "body": body}
        self._alert_history.insert(0, entry)
        if len(self._alert_history) > 5:
            self._alert_history = self._alert_history[:5]
        self._refresh_alert_history()

    def _refresh_alert_history(self):
        for child in self._alert_list.winfo_children():
            child.destroy()

        n = len(self._alert_history)
        if n == 0:
            self._alert_section_lbl.config(text="최근 도착")
            self._alert_clear_btn.pack_forget()
            tk.Label(
                self._alert_list,
                text="새 발주/견적이 들어오면 여기에 표시됩니다.",
                bg=self.CARD, fg="#a1a1aa",
                font=("맑은 고딕", 9), anchor="w",
            ).pack(anchor="w")
            return

        self._alert_section_lbl.config(text=f"최근 도착 ({n})")
        self._alert_clear_btn.pack(side="right")
        for idx, entry in enumerate(self._alert_history):
            self._render_alert_row(idx, entry)

    def _render_alert_row(self, idx: int, entry: dict):
        row = tk.Frame(self._alert_list, bg=self.CARD)
        row.pack(fill="x", pady=(2, 0))

        tk.Label(
            row, text=entry["time"],
            bg=self.CARD, fg="#a1a1aa",
            font=("맑은 고딕", 8), width=5, anchor="w",
        ).pack(side="left")

        close_lbl = tk.Label(
            row, text="✕",
            bg=self.CARD, fg="#a1a1aa",
            activebackground="#f4f4f5", activeforeground="#dc2626",
            font=("맑은 고딕", 9), cursor="hand2", padx=4,
        )
        close_lbl.pack(side="right")
        close_lbl.bind("<Button-1>", lambda _e, i=idx: self._dismiss_alert(i))

        # body 가 길면 wrap. 폭은 카드 폭 - 좌측 시간 - 우측 X 대략 280px.
        tk.Label(
            row, text=entry["body"],
            bg=self.CARD, fg="#3f3f46",
            font=("맑은 고딕", 9),
            anchor="w", justify="left",
            wraplength=280,
        ).pack(side="left", padx=(4, 0), fill="x", expand=True)

    def _dismiss_alert(self, idx: int):
        if 0 <= idx < len(self._alert_history):
            self._alert_history.pop(idx)
        self._refresh_alert_history()

    def _clear_alert_history(self):
        self._alert_history.clear()
        self._refresh_alert_history()

    def _raise_window(self):
        """최소화 해제 + 맨 앞으로 + 잠시 topmost 후 해제. 작업 중 거슬리지 않도록 짧게."""
        try:
            if self.state() == "iconic":
                self.deiconify()
            self.lift()
            self.attributes("-topmost", True)
            self.focus_force()
            self.after(500, lambda: self.attributes("-topmost", False))
        except Exception:
            pass

    def _show_alert_banner(self, title_text: str, body: str):
        """헤더와 카드 사이에 빨간 배너를 8초간 띄움. 클릭(또는 X)으로 즉시 닫기.
        이미 떠 있는 배너가 있으면 교체 — 같은 시간대에 새 알림이 또 오면 최신 정보 우선."""
        if self._alert_banner is not None and self._alert_banner.winfo_exists():
            self._alert_banner.destroy()
        if self._alert_banner_after_id is not None:
            try:
                self.after_cancel(self._alert_banner_after_id)
            except Exception:
                pass
            self._alert_banner_after_id = None

        banner = tk.Frame(self, bg="#dc2626")
        # before=self._card — 카드가 expand=True 라 명시적으로 카드 위에 끼워야 함.
        banner.pack(fill="x", before=self._card)

        inner = tk.Frame(banner, bg="#dc2626")
        inner.pack(fill="x", padx=20, pady=(8, 8))

        tk.Label(
            inner, text=f"🔔  {title_text}",
            bg="#dc2626", fg="white",
            font=("맑은 고딕", 11, "bold"),
        ).pack(anchor="w")
        tk.Label(
            inner, text=body,
            bg="#dc2626", fg="#fee2e2",
            font=("맑은 고딕", 9),
            wraplength=360, justify="left",
        ).pack(anchor="w")

        close_btn = tk.Label(
            banner, text="✕",
            bg="#dc2626", fg="white",
            font=("맑은 고딕", 11, "bold"),
            cursor="hand2",
        )
        close_btn.place(relx=1.0, y=4, anchor="ne", x=-8)
        close_btn.bind("<Button-1>", lambda _e: banner.destroy())

        self._alert_banner = banner
        self._alert_banner_after_id = self.after(
            8000, lambda b=banner: b.destroy() if b.winfo_exists() else None)

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
                elif item[0] == "flexsign_missing":
                    # FlexSign 실행파일을 찾지 못한 경우 — 즉시 위치지정 다이얼로그 유도.
                    def _prompt():
                        if messagebox.askyesno(
                            "FlexSign 위치 확인 필요",
                            "FlexSign 실행파일(App.exe)을 찾지 못했습니다.\n\n"
                            "지금 [FlexSign 위치 지정] 다이얼로그를 열까요?"):
                            change_flexsign_path_async()
                    self.after(0, _prompt)
                elif item[0] == "notify_order":
                    self._handle_order_alert(item[1], item[2])
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

            # 새 발주/견적 도착 시 사운드+창 raise+배너 알림 (30초 폴링).
            # admin_username/password 가 config 에 없으면 폴러는 조용히 무동작 → 설정 추가 시 자동 활성.
            start_order_alert_loop()

            ui_status("watching", "지시서가 도착하면 자동으로 열어드립니다")

            # 시스템 기본 프린터를 PDF24 로 전환 — 워처 실행 동안 유지.
            # FlexSign 에서 기존 지시서 열어 인쇄해도 자동으로 PDF24 로 가서
            # 매칭 다이얼로그가 뜨도록 보장. on_close 에서 원래 프린터로 복구.
            switch_default_to_pdf24()

        threading.Thread(target=_run, daemon=True).start()

    def on_close(self):
        # 워처 시작 시 PDF24 로 전환했던 기본 프린터를 원래대로 복구.
        # 사용자가 워처 없이 다른 프로그램에서 인쇄할 때 PDF24 로 가지 않게.
        try:
            restore_default_printer()
        except Exception:
            pass
        if self._observer:
            self._observer.stop()
            self._observer.join()
        self.destroy()


def main():
    app = App()
    app.protocol("WM_DELETE_WINDOW", app.on_close)
    # 이지폼 자동기입 '채우기' UI 를 워처 GUI(같은 tk root)에 붙인다(별도 exe 없음).
    try:
        easyform.install(app)
    except Exception as e:  # noqa: BLE001 — easyform 실패해도 워처 본기능은 계속.
        ui_log(f"이지폼 자동기입 UI 설치 실패: {e}")
    app.after(300, app.start_watcher)
    app.mainloop()


if __name__ == "__main__":
    main()
