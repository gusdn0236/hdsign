"""EasyForm 풀배치 — 2,191건 자재 자동 추출.

사용:
    1. 이지폼 매출 거래명세서 목록 → 역순으로 보기 끄기 (정순)
    2. 첫 명세서(1월 2일) 더블클릭으로 상세 열기
    3. PowerShell:
        py -3 C:\\Users\\USER\\Desktop\\hdsign\\scripts\\easyform_batch.py
    4. 5초 후 자동 시작 — 마우스/키보드 만지지 마세요
    5. ~4.5시간 후 완료 → C:\\Users\\USER\\Desktop\\easyform_batch.json

옵션:
    --max N       처리 명세서 수 (기본 2200)
    --start N     N번째 명세서부터 시작 (기본 0, 중단 복구용)
    --out PATH    출력 JSON 경로

⚠ 안전:
    - 클릭+Ctrl+C 만, 데이터 변경 0
    - Esc(상세 닫기) 외 키 안 누름
    - 명세서 사이 1초 대기
    - 매 명세서 추출 직후 디스크 저장 (중단 안전)
"""
from __future__ import annotations
import argparse
import ctypes
import json
import sys
import time
from ctypes import wintypes
from pathlib import Path

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

# DPI awareness
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    try:
        user32.SetProcessDPIAware()
    except Exception:
        pass


def _detect_scale() -> float:
    try:
        gdi32 = ctypes.windll.gdi32
        hdc = user32.GetDC(0)
        dpi = gdi32.GetDeviceCaps(hdc, 88)
        user32.ReleaseDC(0, hdc)
        return dpi / 96.0
    except Exception:
        return 1.0


DPI_SCALE = _detect_scale()

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


def _open_clipboard(retries: int = 15) -> bool:
    """이지폼이 클립보드 점유 중일 때 충돌(Cannot open clipboard) 방지 — 재시도."""
    for _ in range(retries):
        if user32.OpenClipboard(None):
            return True
        time.sleep(0.02)
    return False


def set_clipboard(text: str) -> None:
    if not _open_clipboard(): return
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
    if not _open_clipboard(): return ""
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


INPUT_MOUSE = 0
INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004

VK_C = 0x43
VK_CTRL = 0x11
VK_ESC = 0x1B
VK_DOWN = 0x28
VK_ENTER = 0x0D
MOUSEEVENTF_WHEEL = 0x0800

# 전역 중단 플래그 (Ctrl+Esc)
import threading
STOP_REQUESTED = False

def _hotkey_watcher():
    global STOP_REQUESTED
    while not STOP_REQUESTED:
        if (user32.GetAsyncKeyState(VK_CTRL) & 0x8000) and \
           (user32.GetAsyncKeyState(VK_ESC) & 0x8000):
            STOP_REQUESTED = True
            print("\n⚠ Ctrl+Esc 감지 — 중단 요청됨")
            break
        time.sleep(0.05)

threading.Thread(target=_hotkey_watcher, daemon=True).start()


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


def _send(inputs):
    arr = (_IN * len(inputs))(*inputs)
    user32.SendInput(len(inputs), ctypes.byref(arr), ctypes.sizeof(_IN))


user32.SetCursorPos.argtypes = [ctypes.c_int, ctypes.c_int]
user32.SetCursorPos.restype = wintypes.BOOL


# --- 모달 창 감지 (셀 텍스트 무관 — 최상위 창의 클래스로 판단) ---
# 셀 내용으로 모달을 판단하면 간판 자재명에 'Information'/'확인' 등이 우연히 들어갈 때
# 오탐. 그래서 '명세서 상세를 추출하는 정상 상태의 최상위 창 클래스'를 기준으로 잡고,
# 그와 다른 창이 최상위로 올라오면(전자발행 변경불가/클립보드 오류 등 팝업) 모달로 본다.
user32.GetForegroundWindow.restype = wintypes.HWND
user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetClassNameW.restype = ctypes.c_int

BASE_FG_CLASS = None  # 첫 정상 추출 시점의 최상위 창 클래스 (기준)


def fg_class_name() -> str:
    h = user32.GetForegroundWindow()
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(h, buf, 256)
    return buf.value


def modal_present() -> bool:
    """기준 창과 다른 최상위 창(=팝업)이 떠 있으면 True. 기준 미설정이면 False.
    단, 우클릭 컨텍스트 메뉴(#32768)는 정상 동작이므로 모달로 보지 않는다."""
    if BASE_FG_CLASS is None:
        return False
    cls = fg_class_name()
    if cls in ("#32768", BASE_FG_CLASS):
        return False
    return True


# --- 우클릭 복사 좌표 (숫자 칸은 Ctrl+C 막혀서 우클릭 메뉴 '복사'로만 됨) ---
# 메뉴는 커서 기준 상대 위치로 뜨므로 (셀 + 오프셋) 좌클릭이면 복사.
# 셀이 빈칸이면 '복사' 버튼이 비활성이라 클릭해도 메뉴가 안 닫힘 → 안전곳 클릭으로 닫는다.
# (우클릭 메뉴는 셀에 항상 뜨므로 메뉴 유무로 끝 판단 불가 — 끝은 복사 결과로 판단)
COPY_DX, COPY_DY = 41, 68    # 셀 중앙 → '복사' 버튼 오프셋 (probe_rmenu.py)
SAFE_X, SAFE_Y = 325, 214    # 우클릭 메뉴 닫기용 안전한 빈 곳 (probe_point.py)

user32.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
user32.FindWindowW.restype = wintypes.HWND


def menu_open() -> bool:
    """우클릭 컨텍스트 메뉴(#32768)가 떠 있으면 True.
    셀이 있으면 항상 뜨고(복사 버튼 활성/비활성만 차이), 그리드 밖이면 안 뜸=명세서 끝."""
    return bool(user32.FindWindowW("#32768", None))


# --- busy 커서 감지 (이지폼 로딩 중이면 대기) ---
class _CURSORINFO(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD), ("flags", wintypes.DWORD),
                ("hCursor", wintypes.HANDLE), ("ptScreenPos", wintypes.POINT)]

user32.LoadCursorW.argtypes = [wintypes.HINSTANCE, wintypes.LPVOID]
user32.LoadCursorW.restype = wintypes.HANDLE
user32.GetCursorInfo.argtypes = [ctypes.POINTER(_CURSORINFO)]
user32.GetCursorInfo.restype = wintypes.BOOL

IDC_WAIT = 32514
IDC_APPSTARTING = 32650
_WAIT_CURSOR = user32.LoadCursorW(None, IDC_WAIT)
_APPSTARTING_CURSOR = user32.LoadCursorW(None, IDC_APPSTARTING)
_BUSY_CURSORS = {_WAIT_CURSOR, _APPSTARTING_CURSOR}


def wait_if_busy(timeout: float = 12.0) -> bool:
    """이지폼이 로딩 커서(대기/도넛) 상태면 끝날 때까지 대기. True=정상, False=타임아웃."""
    start = time.time()
    busy_seen = False
    while time.time() - start < timeout:
        info = _CURSORINFO()
        info.cbSize = ctypes.sizeof(_CURSORINFO)
        if user32.GetCursorInfo(ctypes.byref(info)):
            if info.hCursor not in _BUSY_CURSORS:
                if busy_seen:
                    time.sleep(0.15)  # busy 해제 직후 약간 더 안정화
                return True
            busy_seen = True
        time.sleep(0.05)
    return False


def click(x: int, y: int) -> None:
    user32.SetCursorPos(int(x * DPI_SCALE), int(y * DPI_SCALE))
    time.sleep(0.03)
    mi_d = _MI(0, 0, 0, MOUSEEVENTF_LEFTDOWN, 0, None)
    mi_u = _MI(0, 0, 0, MOUSEEVENTF_LEFTUP, 0, None)
    _send([_IN(INPUT_MOUSE, _U(mi=mi)) for mi in (mi_d, mi_u)])


MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010


def right_click(x: int, y: int) -> None:
    user32.SetCursorPos(int(x * DPI_SCALE), int(y * DPI_SCALE))
    time.sleep(0.03)
    mi_d = _MI(0, 0, 0, MOUSEEVENTF_RIGHTDOWN, 0, None)
    mi_u = _MI(0, 0, 0, MOUSEEVENTF_RIGHTUP, 0, None)
    _send([_IN(INPUT_MOUSE, _U(mi=mi)) for mi in (mi_d, mi_u)])


def wheel_down(x: int, y: int, notches: int = 1) -> None:
    """비고 셀로 이동 후 휠 down 1 노치 — 한 칸씩 스크롤."""
    user32.SetCursorPos(int(x * DPI_SCALE), int(y * DPI_SCALE))
    time.sleep(0.05)
    mi = _MI(0, 0, -120 * notches, MOUSEEVENTF_WHEEL, 0, None)
    _send([_IN(INPUT_MOUSE, _U(mi=mi))])


def key(vk: int, mods=None):
    mods = mods or []
    seq = []
    for m in mods:
        seq.append(_IN(INPUT_KEYBOARD, _U(ki=_KI(m, 0, 0, 0, None))))
    seq.append(_IN(INPUT_KEYBOARD, _U(ki=_KI(vk, 0, 0, 0, None))))
    seq.append(_IN(INPUT_KEYBOARD, _U(ki=_KI(vk, 0, KEYEVENTF_KEYUP, 0, None))))
    for m in reversed(mods):
        seq.append(_IN(INPUT_KEYBOARD, _U(ki=_KI(m, 0, KEYEVENTF_KEYUP, 0, None))))
    _send(seq)


SENT = "__SENT__"

# 모든 명세서 5개 셀 우클릭 복사 — price 단독으로 완전 (기존 데이터 병합 불필요).
# 월일=목록 엑셀 매칭, 공급가액=수량×단가, 세액=10% 계산, 비고=생략.
TARGET_COLS = ("item_code", "item", "spec", "qty", "unit_price")


NOMENU = "__NOMENU__"   # 우클릭했는데 메뉴 안 뜸 = 그리드 밖(셀 없음) = 명세서 끝


def copy_cell_rmenu(x: int, y: int):
    """숫자 칸 복사 — 좌클릭 활성화 → 우클릭 → 메뉴 떴으면 (셀+오프셋) 복사 클릭 → 안전곳 닫기.
    전자발행 명세서도 우클릭 복사는 됨(Ctrl+C 만 막힘)이라 별도 스킵 불필요.
    반환: 텍스트 / "" (빈칸·복사버튼 비활성) / NOMENU (메뉴 안 뜸=그리드 밖=끝)."""
    set_clipboard(SENT); time.sleep(0.01)
    click(x, y); time.sleep(0.10)            # 좌클릭 활성화 (Ctrl+C 방식과 동일 — 밀림 방지)
    right_click(x, y); time.sleep(0.08)      # 우클릭 → 메뉴 (뜨는 최소 시간만 대기)
    if not menu_open():                      # 메뉴 안 뜸 = 그리드 밖 = 명세서 끝
        return NOMENU
    click(x + COPY_DX, y + COPY_DY)          # '복사' 클릭 (활성=복사, 비활성=무효)
    time.sleep(0.04)
    click(SAFE_X, SAFE_Y)                    # 안전곳 클릭 → 메뉴 확실히 닫기
    time.sleep(0.02)
    v = get_clipboard()
    if v == SENT:
        return ""
    return v


def _extract_row(row_cells: list, cols: tuple) -> tuple[dict, str]:
    """한 행에서 cols 에 속한 셀만 우클릭 방식으로 복사.
    반환 status: OK / NOMENU(첫 셀부터 메뉴 안 뜸=그리드 밖=끝)."""
    cells = {}
    first = True
    for cell in row_cells:
        if cell["col"] not in cols:
            continue
        v = copy_cell_rmenu(cell["x"], cell["y"])
        if v == NOMENU:
            if first:
                return cells, "NOMENU"  # 첫 셀부터 메뉴 안 뜸 = 그리드 밖 = 끝
            v = ""                      # 중간 셀만 안 뜸 = 빈칸 처리
        cells[cell["col"]] = v
        first = False
    return cells, "OK"


def extract_grid(layout: dict, cols: tuple = TARGET_COLS) -> tuple[list[dict], str]:
    """그리드 추출. (rows, stop_reason) 반환.
    종료 사유: OK / DUPLICATE / MODAL / STOPPED / MAX
    Phase 1: 보이는 10행 순회.
    Phase 2: 10행 다 차면 스크롤 모드 (비고 셀 휠 down, 10번째 행 좌표 재사용).
    """
    rows = layout["cells"]
    last_row_template = rows[-1]
    out = []
    empty_streak = 0
    dup_streak = 0
    prev_sig = None

    def process(cells: dict) -> str:
        nonlocal empty_streak, dup_streak, prev_sig
        is_empty = all(not v.strip() for v in cells.values())
        if is_empty:
            empty_streak += 1
            return "OK" if empty_streak >= 2 else "CONTINUE"
        empty_streak = 0
        sig = tuple(cells.values())
        if sig == prev_sig:
            dup_streak += 1
            if dup_streak >= 2:
                return "DUPLICATE"
        else:
            dup_streak = 0
        prev_sig = sig
        out.append(cells)
        return "CONTINUE"

    # Phase 1: 정상 순회
    for row_cells in rows:
        if STOP_REQUESTED:
            return out, "STOPPED"
        cells, status = _extract_row(row_cells, cols)
        if status == "NOMENU":          # 그리드 밖(우클릭 메뉴 안 뜸) = 명세서 끝
            return out, "OK"
        result = process(cells)         # 끝 판단: 연속 2 빈 행 or 같은 행 반복
        if result != "CONTINUE":
            return out, result

    # Phase 2: 스크롤 모드 — 한 화면(10행) 다 차면 한 칸 내리고 마지막 행 자리 재순회
    if empty_streak == 0:
        last_remark = last_row_template[-1]
        rx, ry = last_remark["x"], last_remark["y"]
        while len(out) < 200:
            if STOP_REQUESTED:
                return out, "STOPPED"
            wheel_down(rx, ry, 1)
            time.sleep(0.25)
            wait_if_busy()  # 스크롤 후 로딩 대기
            cells, status = _extract_row(last_row_template, cols)
            if status == "NOMENU":
                return out, "OK"
            result = process(cells)
            if result != "CONTINUE":
                return out, result
        return out, "MAX"

    return out, "OK"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--max", type=int, default=2200)
    ap.add_argument("--start", type=int, default=0)
    ap.add_argument("--out", default=r"C:\Users\USER\Desktop\hdsign\easyform-data\easyform_batch.json")
    args = ap.parse_args()

    layout_path = Path(r"C:\Users\USER\Desktop\hdsign\scripts\easyform_layout.json")
    if not layout_path.is_file():
        print(f"layout 없음: {layout_path}", file=sys.stderr)
        return 1
    layout = json.loads(layout_path.read_text(encoding="utf-8"))

    print("=" * 60)
    print(f"EasyForm 풀배치 — DPI scale {DPI_SCALE:.2f}x")
    print("=" * 60)
    print(f"처리 범위: {args.start} → {args.start + args.max}")
    print(f"출력: {args.out}")
    print()
    print("준비: 이지폼 명세서 상세 화면 (첫 명세서) 띄우기")
    print("5초 후 시작. 마우스/키보드 만지지 마세요.")
    for i in range(5, 0, -1):
        print(f"  {i}...", end="\r", flush=True); time.sleep(1)
    print()

    out_path = Path(args.out)
    # 기존 결과 (재시작 시)
    if args.start > 0 and out_path.is_file():
        existing = json.loads(out_path.read_text(encoding="utf-8"))
        all_results = existing.get("invoices", [])
        print(f"기존 {len(all_results)}건 로드 (재시작)")
    else:
        all_results = []

    prev_first_row_sig = None
    same_streak = 0  # 연속 동일 시그니처 명세서 카운트
    stop_reason = "끝까지"
    started_at = time.time()

    for inv_idx in range(args.start, args.start + args.max):
        if STOP_REQUESTED:
            stop_reason = f"⚠ Ctrl+Esc 중단 (인덱스 {inv_idx})"
            break

        t0 = time.time()
        wait_if_busy()  # 상세 화면 로딩(도넛 커서) 끝날 때까지 대기 후 추출

        # 첫 명세서에서 기준 창 클래스 확정 (명세서 닫을 때 확인 팝업 감지용)
        global BASE_FG_CLASS
        if BASE_FG_CLASS is None:
            BASE_FG_CLASS = fg_class_name()
            print(f"기준 창 클래스: {BASE_FG_CLASS!r}")

        grid, grid_stop = extract_grid(layout)
        if grid_stop == "STOPPED":
            stop_reason = f"⚠ Ctrl+Esc 중단 (인덱스 {inv_idx})"
            break

        # 빈 그리드 자동 재시도 — 이지폼 DB fetch 지연 (네트워크 느림 등) 대비.
        # 상세를 닫았다 다시 열고 넉넉히 대기 후 한 번 더. 그래도 비면 진짜 빈 명세서.
        retry = 0
        while len(grid) == 0 and grid_stop in ("OK", "DUPLICATE") and retry < 2 and not STOP_REQUESTED:
            retry += 1
            key(VK_ESC); time.sleep(0.4)      # 상세 닫기
            wait_if_busy()
            key(VK_ENTER); time.sleep(2.5)    # 같은 행 상세 재오픈 + 넉넉한 fetch 대기
            wait_if_busy()
            grid, grid_stop = extract_grid(layout)
        if retry and len(grid) > 0:
            print(f"  [{inv_idx:>4}] 빈 그리드 재시도 {retry}회 → {len(grid)}행 복구")

        # === ESC로 닫기 + 전자명세서 판별 (5개는 이미 다 추출됨) ===
        # ESC 후 "수정불가" 팝업이 뜨면 전자명세서 → 엔터로 닫기. 일반은 바로 닫힘.
        ebill = False
        key(VK_ESC); time.sleep(0.3); wait_if_busy()
        if modal_present():            # 팝업 = 전자명세서
            ebill = True
            for _ in range(4):         # 수정불가 팝업 닫기 (엔터 3번 정도)
                if not modal_present():
                    break
                key(VK_ENTER); time.sleep(0.3); wait_if_busy()
            print(f"  [{inv_idx:>4}] 전자명세서 (EBILL)")

        # 마지막 명세서 감지 — 연속 30회 동일 시그니처 시 종료 (병합된 grid 기준)
        full_sig = tuple(tuple(c.values()) for c in grid) if grid else None
        if prev_first_row_sig is not None and full_sig == prev_first_row_sig:
            same_streak += 1
            if same_streak >= 30:
                stop_reason = f"마지막 명세서 도달 (인덱스 {inv_idx}) — 연속 30회 동일"
                break
        else:
            same_streak = 0
        prev_first_row_sig = full_sig

        all_results.append({
            "invoice_idx": inv_idx,
            "grid": grid,
            "grid_row_count": len(grid),
            "grid_stop_reason": "EBILL" if ebill else grid_stop,
        })

        # 매 추출 후 즉시 디스크 저장 (중단 안전)
        out_path.write_text(
            json.dumps({"invoices": all_results, "extracted_at": time.time()},
                       ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        # 진행 로그
        dur = time.time() - t0
        if inv_idx % 50 == 0 or len(grid) > 10:
            elapsed = time.time() - started_at
            done = inv_idx - args.start + 1
            avg = elapsed / done if done else 0
            est_remain = avg * (args.max - done)
            print(f"  [{inv_idx:>4}] {len(grid)}행, {dur:.1f}s  "
                  f"avg {avg:.1f}s, 남은시간 {est_remain/60:.0f}분")

        # 다음 명세서로 (ESC는 위에서 이미 했으니 ↓ → Enter 만)
        key(VK_DOWN); time.sleep(0.15)
        key(VK_ENTER); time.sleep(1.0)
        wait_if_busy()                  # 새 상세 열기 + DB fetch 로딩 대기

    elapsed = time.time() - started_at
    done_count = len(all_results)
    print()
    print("=" * 60)
    print(f"종료: {stop_reason}")
    print(f"총 {done_count}건 추출, 소요 {elapsed/60:.1f}분")
    print(f"저장: {out_path}")
    if "중단" in stop_reason or STOP_REQUESTED:
        # 다음 인덱스 = 저장된 마지막 invoice_idx + 1
        # (all_results 는 기존 로드분 + 이번 추가분이라 args.start + len 은 틀림)
        next_idx = (max(i["invoice_idx"] for i in all_results) + 1) if all_results else args.start
        print()
        print("=" * 60)
        print(f" 재개 안내 — 총 {done_count}건 완료, 다음 인덱스 = {next_idx}")
        print("=" * 60)
        print(f"  1. 이지폼 매출 거래명세서 [목록] 열기 (역순 끈 정순)")
        print(f"  2. 첫 행 (1월 2일) 클릭으로 활성화 (Enter 누르지 말 것)")
        print(f"  3. PowerShell:")
        print(f"     py -3 C:\\Users\\USER\\Desktop\\hdsign\\scripts\\easyform_seek.py {next_idx}")
        print(f"     → ↓ 키 {next_idx}번 자동 → {next_idx + 1}번째 행 활성화")
        print(f"  4. Enter (상세 열기)")
        print(f"  5. PowerShell:")
        print(f"     py -3 C:\\Users\\USER\\Desktop\\hdsign\\scripts\\easyform_batch.py "
              f"--start {next_idx} --out {args.out}")
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore
    sys.exit(main())
