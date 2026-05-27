"""한 명세서만 추출 — 매크로 검증 (dry-run).

사용:
    1. 이지폼 명세서 상세 화면 띄움 (자재 들어있는)
    2. py -3 C:\\Users\\USER\\Desktop\\hdsign\\scripts\\easyform_dryrun.py
    3. 5초 후 자동 시작 — 이지폼 창 클릭으로 활성 상태 유지
    4. 결과 → 화면 + C:\\Users\\USER\\Desktop\\easyform_dryrun.json

매크로가 하는 일:
    - 자재 그리드 9컬럼 × N행 클릭+Ctrl+C
    - 빈 행 도달 → STOP
    - 헤더 (win32 GetWindowText) 보너스 추출
"""
from __future__ import annotations
import ctypes
import json
import sys
import time
from ctypes import wintypes
from pathlib import Path

# clipboard + SendInput (easyform_extract.py 와 동일)
user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

# DPI awareness 시도 (Python 시작 후라 무효일 수도)
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    try:
        user32.SetProcessDPIAware()
    except Exception:
        pass

# 현재 DPI scale 자동 측정
def _detect_scale() -> float:
    """Windows 의 현재 DPI scale 반환 (100%=1.0, 200%=2.0)."""
    try:
        gdi32 = ctypes.windll.gdi32
        hdc = user32.GetDC(0)
        LOGPIXELSX = 88
        dpi = gdi32.GetDeviceCaps(hdc, LOGPIXELSX)
        user32.ReleaseDC(0, hdc)
        return dpi / 96.0
    except Exception:
        return 1.0


DPI_SCALE = _detect_scale()
print(f"[INFO] DPI scale 감지 = {DPI_SCALE:.2f}x  (100%={DPI_SCALE==1.0})")

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


INPUT_MOUSE = 0
INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_ABSOLUTE = 0x8000

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


class _POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


user32.GetCursorPos.argtypes = [ctypes.POINTER(_POINT)]
user32.GetCursorPos.restype = wintypes.BOOL
user32.SetCursorPos.argtypes = [ctypes.c_int, ctypes.c_int]
user32.SetCursorPos.restype = wintypes.BOOL


def click(x: int, y: int) -> tuple[int, int]:
    """측정 좌표 × DPI_SCALE 변환 후 SetCursorPos."""
    adj_x = int(x * DPI_SCALE)
    adj_y = int(y * DPI_SCALE)
    user32.SetCursorPos(adj_x, adj_y)
    time.sleep(0.05)
    p = _POINT()
    user32.GetCursorPos(ctypes.byref(p))
    actual = (p.x, p.y)
    mi_d = _MI(0, 0, 0, MOUSEEVENTF_LEFTDOWN, 0, None)
    mi_u = _MI(0, 0, 0, MOUSEEVENTF_LEFTUP, 0, None)
    _send([_IN(INPUT_MOUSE, _U(mi=mi)) for mi in (mi_d, mi_u)])
    return actual


def wheel_down(x: int, y: int, notches: int = 1) -> None:
    """마우스 위치로 이동 후 휠 down (한 칸 = 120). 한 칸씩 정확히 스크롤."""
    adj_x = int(x * DPI_SCALE)
    adj_y = int(y * DPI_SCALE)
    user32.SetCursorPos(adj_x, adj_y)
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


def copy_cell(x: int, y: int) -> tuple[str, tuple[int, int]]:
    """셀 클릭 + Ctrl+C → (텍스트, 실제 마우스 좌표).
    click 후 0.10s 활성화 시간 — 빠르면 빈 셀 클릭 시 이전 셀(spec) 텍스트 묻음."""
    SENT = "__SENT__"
    set_clipboard(SENT); time.sleep(0.015)
    actual = click(x, y); time.sleep(0.10)  # 활성화 시간 확보
    key(VK_C, [VK_CTRL]); time.sleep(0.05)
    v = get_clipboard()
    if v == SENT:
        return "", actual
    return v, actual


def _extract_row(row_cells: list) -> dict:
    cells = {}
    for cell in row_cells:
        x, y, col_name = cell["x"], cell["y"], cell["col"]
        text, _ = copy_cell(x, y)
        cells[col_name] = text
    return cells


def extract_grid(layout: dict) -> tuple[list[dict], str]:
    """그리드 추출. 10행 다 차면 스크롤 모드로 11+ 행 처리.
    종료 조건:
      - 연속 2 빈 행 → "OK"
      - 연속 3 같은 시그 → "DUPLICATE"
      - 모달 감지 → "MODAL"
      - Ctrl+Esc → "STOPPED"
      - 최대 100행 → "MAX"
    """
    rows = layout["cells"]
    last_row_template = rows[-1]  # 10번째 행 좌표 — 스크롤 후 재사용
    out = []
    empty_streak = 0
    dup_streak = 0
    prev_sig = None

    def process_cells(cells, scroll_phase=False):
        nonlocal empty_streak, dup_streak, prev_sig
        is_empty = all(not v.strip() for v in cells.values())
        if is_empty:
            empty_streak += 1
            tag = "스크롤" if scroll_phase else ""
            print(f"  행 {len(out)+empty_streak}{tag}: (빈, streak={empty_streak})")
            if empty_streak >= 2:
                return "OK"
            return "CONTINUE"
        empty_streak = 0
        sig = tuple(cells.values())
        if sig == prev_sig:
            dup_streak += 1
            tag = "스크롤" if scroll_phase else ""
            print(f"  행 {len(out)+1}{tag}: 직전과 동일 (dup_streak={dup_streak+1}회) → {cells}")
            if dup_streak >= 2:  # 처음 + 2 동일 = 3회 같은 데이터
                return "DUPLICATE"
        else:
            dup_streak = 0
        prev_sig = sig
        out.append(cells)
        tag = " [스크롤]" if scroll_phase else ""
        print(f"  행 {len(out)}{tag}: {cells}")
        return "CONTINUE"

    # Phase 1 — 보이는 10행 정상 순회
    for row_cells in rows:
        if STOP_REQUESTED:
            return out, "STOPPED"
        cells = _extract_row(row_cells)
        # 모달 키워드 감지
        if any("Information" in v or "저장되지" in v for v in cells.values()):
            return out, "MODAL"
        result = process_cells(cells, scroll_phase=False)
        if result != "CONTINUE":
            return out, result

    # Phase 2 — 10행 다 차고 빈 streak 0 → 스크롤 모드
    if empty_streak == 0:
        print(f"  → 10행 모두 채움. 스크롤 모드 진입")
        # 비고 셀 위치 (10번째 행의 비고)
        last_remark = last_row_template[-1]  # 마지막 컬럼 = 비고
        remark_x, remark_y = last_remark["x"], last_remark["y"]

        while len(out) < 100:
            if STOP_REQUESTED:
                return out, "STOPPED"
            # 비고 셀 위치에서 휠 다운 1 노치
            wheel_down(remark_x, remark_y, notches=1)
            time.sleep(0.25)  # 스크롤 적용 대기

            cells = _extract_row(last_row_template)
            if any("Information" in v or "저장되지" in v for v in cells.values()):
                return out, "MODAL"
            result = process_cells(cells, scroll_phase=True)
            if result != "CONTINUE":
                return out, result

        return out, "MAX"

    return out, "OK"


def extract_header() -> dict:
    """창 안 모든 TEdit/TAdvEdit/TMaskEdit 텍스트 dump — 거래처/일자/주소/전화/총액 등."""
    out = {}
    try:
        from pywinauto import Desktop
    except ImportError:
        return {"error": "pywinauto 없음"}
    try:
        desk = Desktop(backend="win32")
        for w in desk.windows():
            try:
                title = w.window_text() or ""
            except:
                continue
            if "매출 거래명세서" in title and "목록" not in title:
                # 모든 자식 컨트롤 텍스트
                for ch in w.descendants():
                    try:
                        cls = ch.class_name()
                        txt = (ch.window_text() or "").strip()
                    except:
                        continue
                    if not txt:
                        continue
                    if cls in ("TEdit", "TAdvEdit", "TMaskEdit", "TMemo"):
                        out[f"{cls}_{len(out)}"] = txt
                break
    except Exception as e:
        out["error"] = str(e)
    return out


def find_invoice_window():
    """명세서 상세 창 찾기 — MDI 자식 검색 포함."""
    try:
        from pywinauto import Desktop
    except ImportError:
        return None
    desk = Desktop(backend="win32")
    # 1. top-level 에서 직접
    for w in desk.windows():
        try:
            title = w.window_text() or ""
        except:
            continue
        if "매출 거래명세서" in title and "목록" not in title:
            return w
    # 2. 이지폼 메인 창 안의 MDI 자식 검색
    for w in desk.windows():
        try:
            title = w.window_text() or ""
        except:
            continue
        if "이지폼" in title or "EasyForm" in title:
            try:
                for child in w.descendants():
                    try:
                        cls = child.class_name() if hasattr(child, "class_name") else ""
                        ctitle = child.window_text() or ""
                    except:
                        continue
                    if cls == "TfrmExchange" or (
                        "매출 거래명세서" in ctitle and "목록" not in ctitle
                    ):
                        return child
            except Exception:
                pass
    return None


def main() -> int:
    layout_path = Path(r"C:\Users\USER\Desktop\hdsign\scripts\easyform_layout.json")
    if not layout_path.is_file():
        print(f"layout 없음: {layout_path}", file=sys.stderr)
        return 1
    layout = json.loads(layout_path.read_text(encoding="utf-8"))

    print("=" * 60)
    print("Dry-run — 한 명세서만 추출")
    print("=" * 60)
    print()
    # 명세서 창 찾기 + 활성화
    win = find_invoice_window()
    if win:
        try:
            rect = win.rectangle()
            print(f"명세서 창 위치: ({rect.left}, {rect.top}) ~ ({rect.right}, {rect.bottom})")
            print(f"  폭 {rect.right - rect.left}, 높이 {rect.bottom - rect.top}")
        except:
            pass
    else:
        print("⚠ 명세서 창 자동 검색 실패 — 좌표만으로 계속 진행")
    print()
    print("준비: 이지폼 명세서 상세 화면이 calibration 때와 동일한 위치/크기여야 함")
    print("5초 후 시작...")
    for i in range(5, 0, -1):
        print(f"  {i}...", end="\r", flush=True); time.sleep(1)
    print("\n시작\n")

    N_INVOICES = 3
    all_results = []

    for inv_idx in range(N_INVOICES):
        print(f"\n--- 명세서 {inv_idx + 1}/{N_INVOICES} ---")
        print("[1/2] 헤더 추출 (win32 GetWindowText)")
        header = extract_header()
        for k, v in header.items():
            print(f"  {k}: {v!r}")

        print("[2/2] 자재 그리드 추출 (클릭+Ctrl+C)")
        grid, stop_reason = extract_grid(layout)
        print(f"  → 종료 사유: {stop_reason}")

        all_results.append({
            "invoice_idx": inv_idx,
            "header": header,
            "grid": grid,
            "grid_row_count": len(grid),
            "stop_reason": stop_reason,
        })

        if STOP_REQUESTED:
            print("⚠ 사용자 중단")
            break

        if stop_reason == "MODAL":
            print("⚠ 모달 감지 — 중단")
            break

        if inv_idx < N_INVOICES - 1:
            print("  → ESC → ↓ → Enter (다음 명세서, 1초 대기)")
            key(VK_ESC); time.sleep(0.3)
            key(VK_DOWN); time.sleep(0.15)
            key(VK_ENTER); time.sleep(1.0)

    out_path = Path(r"C:\Users\USER\Desktop\hdsign\easyform-data\easyform_dryrun.json")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps({"invoices": all_results, "extracted_at": time.time()},
                   ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print()
    print("=" * 60)
    print(f"저장됨: {out_path}")
    for r in all_results:
        print(f"  명세서 {r['invoice_idx']+1}: 헤더 {len(r['header'])}개, 자재 {r['grid_row_count']}행")
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore
    sys.exit(main())
