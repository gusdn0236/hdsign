"""
EasyForm 명세서 자동 추출 — 마우스 클릭 + Ctrl+C 기반.

흐름:
    1. 매출 거래명세서 목록 화면에서 시작
    2. 행 하나씩 더블클릭 → 상세 화면
    3. 헤더 (거래처/일자/주소/전화/총액) win32 GetWindowText 로 직접 추출
    4. 자재 그리드 9컬럼 × N행 마우스 클릭 + Ctrl+C 순회
    5. 빈 행 도달(품목+공급가액 둘 다 빈) → 닫기
    6. 다음 명세서

⚠ 안전:
    - 클릭 + Ctrl+C 만. 데이터 변경 0
    - Enter 절대 안 누름 (새 행 생성 방지)
    - [저장] 절대 클릭 안 함
    - 모달 뜨면 Esc 로 닫고 재시도
    - 최대 행 수 50 (무한 루프 방지)

사용:
    1. calibration_<grid>.json 준비 (좌표 표 — 사용자 캡처에서 추출)
    2. EasyForm 매출 거래명세서 목록 화면 띄우기
    3. py -3 scripts/easyform_extract.py [--max N] [--start 0]
    4. 결과 → C:\\Users\\USER\\Desktop\\easyform_extracted\\<seq>.json
"""
from __future__ import annotations
import argparse
import ctypes
import json
import sys
import time
from ctypes import wintypes
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Optional

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

# Clipboard
user32.OpenClipboard.argtypes = [wintypes.HWND]; user32.OpenClipboard.restype = wintypes.BOOL
user32.CloseClipboard.restype = wintypes.BOOL
user32.EmptyClipboard.restype = wintypes.BOOL
user32.GetClipboardData.argtypes = [wintypes.UINT]; user32.GetClipboardData.restype = wintypes.HANDLE
user32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]; user32.SetClipboardData.restype = wintypes.HANDLE
kernel32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]; kernel32.GlobalAlloc.restype = wintypes.HGLOBAL
kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]; kernel32.GlobalLock.restype = wintypes.LPVOID
kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]; kernel32.GlobalUnlock.restype = wintypes.BOOL
kernel32.GlobalSize.argtypes = [wintypes.HGLOBAL]; kernel32.GlobalSize.restype = ctypes.c_size_t

CF_UNICODETEXT = 13
GMEM_MOVEABLE = 0x0002


def set_clipboard(text: str) -> None:
    if not user32.OpenClipboard(None): return
    try:
        user32.EmptyClipboard()
        data = (text + "\0").encode("utf-16-le")
        h = kernel32.GlobalAlloc(GMEM_MOVEABLE, len(data))
        ptr = kernel32.GlobalLock(h)
        ctypes.memmove(ptr, data, len(data))
        kernel32.GlobalUnlock(h)
        user32.SetClipboardData(CF_UNICODETEXT, h)
    finally:
        user32.CloseClipboard()


def get_clipboard() -> str:
    if not user32.OpenClipboard(None): return ""
    try:
        h = user32.GetClipboardData(CF_UNICODETEXT)
        if not h: return ""
        size = kernel32.GlobalSize(h)
        ptr = kernel32.GlobalLock(h)
        if not ptr: return ""
        try:
            return ctypes.string_at(ptr, size).decode("utf-16-le").rstrip("\0")
        finally:
            kernel32.GlobalUnlock(h)
    finally:
        user32.CloseClipboard()


# SendInput
INPUT_MOUSE = 0
INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_ABSOLUTE = 0x8000
MOUSEEVENTF_WHEEL = 0x0800

VK_C = 0x43
VK_CTRL = 0x11
VK_ESC = 0x1B


class _MI(ctypes.Structure):
    _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG),
                ("mouseData", wintypes.DWORD), ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]


class _KI(ctypes.Structure):
    _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD),
                ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD),
                ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]


class _U(ctypes.Union):
    _fields_ = [("mi", _MI), ("ki", _KI), ("pad", ctypes.c_byte * 32)]


class _IN(ctypes.Structure):
    _fields_ = [("type", wintypes.DWORD), ("u", _U)]


def _send(inputs: list[_IN]) -> None:
    arr = (_IN * len(inputs))(*inputs)
    user32.SendInput(len(inputs), ctypes.byref(arr), ctypes.sizeof(_IN))


def click(x: int, y: int) -> None:
    sw = user32.GetSystemMetrics(0)
    sh = user32.GetSystemMetrics(1)
    dx = int(x * 65535 / sw)
    dy = int(y * 65535 / sh)
    mi_move = _MI(dx, dy, 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, 0, None)
    mi_dn = _MI(dx, dy, 0, MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_ABSOLUTE, 0, None)
    mi_up = _MI(dx, dy, 0, MOUSEEVENTF_LEFTUP | MOUSEEVENTF_ABSOLUTE, 0, None)
    _send([_IN(INPUT_MOUSE, _U(mi=mi)) for mi in (mi_move, mi_dn, mi_up)])


def double_click(x: int, y: int) -> None:
    click(x, y); time.sleep(0.05); click(x, y)


def wheel(x: int, y: int, amount: int) -> None:
    sw = user32.GetSystemMetrics(0); sh = user32.GetSystemMetrics(1)
    dx = int(x * 65535 / sw); dy = int(y * 65535 / sh)
    mi_move = _MI(dx, dy, 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, 0, None)
    mi_wh = _MI(0, 0, amount * 120, MOUSEEVENTF_WHEEL, 0, None)  # 120 = 한 noche
    _send([_IN(INPUT_MOUSE, _U(mi=mi)) for mi in (mi_move, mi_wh)])


def key(vk: int, mods: list[int] = None) -> None:
    mods = mods or []
    seq = []
    for m in mods:
        seq.append(_IN(INPUT_KEYBOARD, _U(ki=_KI(m, 0, 0, 0, None))))
    seq.append(_IN(INPUT_KEYBOARD, _U(ki=_KI(vk, 0, 0, 0, None))))
    seq.append(_IN(INPUT_KEYBOARD, _U(ki=_KI(vk, 0, KEYEVENTF_KEYUP, 0, None))))
    for m in reversed(mods):
        seq.append(_IN(INPUT_KEYBOARD, _U(ki=_KI(m, 0, KEYEVENTF_KEYUP, 0, None))))
    _send(seq)


def copy_cell(x: int, y: int, delay: float = 0.08) -> str:
    """셀 클릭 + Ctrl+C → 클립보드 read."""
    SENTINEL = "__SENT__"
    set_clipboard(SENTINEL); time.sleep(0.02)
    click(x, y); time.sleep(delay)
    key(VK_C, [VK_CTRL]); time.sleep(delay)
    val = get_clipboard()
    if val == SENTINEL:
        # Ctrl+C 가 클립보드를 안 채움 = 빈 셀 또는 모달
        # 한 번 Esc 후 빈 결과로
        key(VK_ESC); time.sleep(0.1)
        return ""
    return val


# ─────────────────────────────────────────────────────────────────────
# Calibration (사용자 캡처에서 추출 — 매크로 시작 전 채워야)
# ─────────────────────────────────────────────────────────────────────

@dataclass
class GridLayout:
    """명세서 상세 화면의 자재 그리드 좌표 (화면 절대 좌표 px)."""
    # 9개 컬럼의 중앙 X 좌표
    col_x: dict[str, int] = field(default_factory=lambda: {
        "month_day": 0, "item_code": 0, "item": 0, "spec": 0,
        "qty": 0, "unit_price": 0, "supply": 0, "tax": 0, "remark": 0,
    })
    # 첫 행 Y, 두 번째 행 Y (둘로부터 row_height 계산)
    row_y_first: int = 0
    row_y_second: int = 0
    # 그리드 영역 (스크롤 처리용)
    grid_left: int = 0
    grid_top: int = 0
    grid_right: int = 0
    grid_bottom: int = 0

    @property
    def row_height(self) -> int:
        return self.row_y_second - self.row_y_first

    def cell_xy(self, col: str, row_idx: int) -> tuple[int, int]:
        return (self.col_x[col], self.row_y_first + self.row_y_second * 0 + row_idx * self.row_height) \
            if False else (self.col_x[col], self.row_y_first + row_idx * self.row_height)

    @classmethod
    def load(cls, path: Path) -> "GridLayout":
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return cls(**data)


CALIBRATION_PATH = Path(r"C:\Users\USER\Desktop\hdsign\scripts\easyform_layout.json")


# ─────────────────────────────────────────────────────────────────────
# 한 명세서 추출
# ─────────────────────────────────────────────────────────────────────

MAX_ROWS = 50              # 한 명세서 안 최대 행 수
MAX_INVOICES = 3000        # 전체 명세서 최대 (안전 상한)
SLEEP_AFTER_OPEN = 1.0     # 상세 열림 후 (DB fetch 로딩)
SLEEP_AFTER_CLOSE = 0.3    # ESC 후
SLEEP_AFTER_NAV = 0.1      # ↓ 후
SLEEP_AFTER_CLICK = 0.10   # 셀 클릭 후
SLEEP_AFTER_COPY = 0.10    # Ctrl+C 후
SCROLL_TRY = 5             # 그리드 스크롤 시도


def extract_one_invoice(layout: GridLayout) -> dict:
    """현재 열린 명세서 상세 화면에서 자재 그리드 추출.
    헤더는 별도 (win32 GetWindowText — 다른 함수)."""
    rows: list[dict] = []
    last_row_signature = None
    scroll_used = 0

    for row_idx in range(MAX_ROWS):
        y = layout.row_y_first + row_idx * layout.row_height

        # 행이 그리드 영역 밖 → 스크롤 필요
        if y > layout.grid_bottom - layout.row_height // 2:
            if scroll_used >= SCROLL_TRY:
                break
            # 그리드 중앙에서 휠 다운
            cx = (layout.grid_left + layout.grid_right) // 2
            cy = (layout.grid_top + layout.grid_bottom) // 2
            wheel(cx, cy, -3)  # 3 노치 아래
            time.sleep(0.2)
            scroll_used += 1
            # 같은 row_idx 다시 (스크롤 후 그리드 안 위치)
            row_idx -= scroll_used  # 보이는 행 다시
            y = layout.row_y_first + (row_idx - scroll_used) * layout.row_height

        cells: dict[str, str] = {}
        for col_name, x in layout.col_x.items():
            cells[col_name] = copy_cell(x, y)
            time.sleep(0.02)

        # 행 끝 판단: 9개 셀 모두 빈 칸 → 그 행부터 없음
        # (비고만 적힌 행, 헤더 행, 도장비 행 등 모두 통과 — 어떤 셀이라도 채워지면 데이터 있음)
        if all(not v.strip() for v in cells.values()):
            break

        # 무한 루프 방지: 직전 행과 시그니처 동일
        sig = tuple(cells.values())
        if sig == last_row_signature:
            break
        last_row_signature = sig

        rows.append(cells)

    return {"items": rows, "row_count": len(rows)}


# ─────────────────────────────────────────────────────────────────────
# 헤더 추출 (win32 GetWindowText) — 별도, pywinauto 활용
# ─────────────────────────────────────────────────────────────────────

def extract_header() -> dict:
    """명세서 상세 화면의 헤더 영역 (거래처/일자/주소/전화/총액) 직접 텍스트 추출."""
    try:
        from pywinauto import Desktop
    except ImportError:
        return {"error": "pywinauto 필요"}

    desk = Desktop(backend="win32")
    matches = [w for w in desk.windows()
               if "매출 거래명세서" in (w.window_text() or "")
               and "목록" not in (w.window_text() or "")]
    if not matches:
        return {"error": "명세서 상세 창 못 찾음"}
    win = matches[0]

    out: dict[str, str] = {}
    for child in win.descendants():
        try:
            cls = child.class_name()
            txt = child.window_text() or ""
        except Exception:
            continue
        if not txt:
            continue
        # 휴리스틱: 클래스명 + 텍스트 패턴으로 식별
        if cls in ("TMaskEdit",) and "." in txt:
            out.setdefault("issued_date_or_period", txt)
        elif cls in ("TAdvEdit", "TEdit"):
            if "," in txt and txt.replace(",", "").replace("-", "").isdigit():
                out.setdefault("amount_" + str(len(out)), txt)
            elif "010-" in txt or "02-" in txt or "031-" in txt:
                out.setdefault("phone", txt)
            elif "도" in txt or "시" in txt:
                out.setdefault("address", txt)
            elif "농협" in txt or "국민" in txt or "기업" in txt or "신한" in txt:
                out.setdefault("bank_info", txt)
    return out


# ─────────────────────────────────────────────────────────────────────
# 매크로 — 목록에서 행 더블클릭 순회
# ─────────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--max", type=int, default=10, help="처리할 명세서 수 (기본 10)")
    ap.add_argument("--start", type=int, default=0, help="목록의 시작 인덱스")
    ap.add_argument("--out", default=r"C:\Users\USER\Desktop\easyform_extracted")
    args = ap.parse_args()

    if not CALIBRATION_PATH.is_file():
        print(f"calibration 파일 없음: {CALIBRATION_PATH}", file=sys.stderr)
        print("먼저 사용자 캡처에서 좌표 추출 후 이 파일 생성 필요.", file=sys.stderr)
        return 2

    layout = GridLayout.load(CALIBRATION_PATH)
    out_dir = Path(args.out); out_dir.mkdir(parents=True, exist_ok=True)

    print("=== EasyForm 자동 추출 ===")
    print(f"calibration: {CALIBRATION_PATH}")
    print(f"출력: {out_dir}")
    print(f"처리: {args.start} → {args.start + args.max}")
    print()
    print("준비: 매출 거래명세서 목록 화면을 띄워두기. 5초 후 시작...")
    for i in range(5, 0, -1):
        print(f"  {i}...", end="\r", flush=True); time.sleep(1)
    print()

    # ⚠ 여기서부터 목록 순회 — calibration 에 list_row_y_first 등 추가 필요.
    # 첫 1건만 처리하는 protоtype 으로:
    print("[protot] 현재 열린 명세서 상세에서 그리드만 추출 시도")
    header = extract_header()
    rows = extract_one_invoice(layout)
    result = {"header": header, "grid": rows, "extracted_at": time.time()}
    out_path = out_dir / f"{int(time.time())}.json"
    out_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"저장됨: {out_path}")
    print(f"  헤더 키: {list(header.keys())}")
    print(f"  그리드 행 수: {rows.get('row_count')}")
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore
    sys.exit(main())
