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
    """기준 창과 다른 최상위 창(=팝업)이 떠 있으면 True. 기준 미설정이면 False."""
    if BASE_FG_CLASS is None:
        return False
    return fg_class_name() != BASE_FG_CLASS


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


def copy_cell(x: int, y: int) -> str:
    # ⚠ 활성화 대기 0.10초는 검증된 안전값. 줄이면 셀 활성화가 마우스를 못 따라가
    # 직전 셀 텍스트가 다음 칸으로 밀리는 오염 발생 (0.045 테스트에서 248곳 오염 확인).
    set_clipboard(SENT); time.sleep(0.015)
    click(x, y); time.sleep(0.10)
    if modal_present():       # 클릭하자마자 팝업이 떴으면 더 손대지 않음
        return ""
    key(VK_C, [VK_CTRL]); time.sleep(0.05)
    v = get_clipboard()
    if v == SENT:
        return ""
    return v


def _extract_row(row_cells: list) -> tuple[dict, bool]:
    """한 행 추출 + 모달 감지(창 기반). 모달이면 즉시 중단 (부분결과, True).
    셀 클릭마다 팝업을 확인 — 팝업 떴는데 나머지 셀을 계속 클릭하면 안 되므로."""
    cells = {}
    for cell in row_cells:
        x, y, col_name = cell["x"], cell["y"], cell["col"]
        text = copy_cell(x, y)
        if modal_present():           # 클릭 직후 팝업 → 즉시 멈춤 (마우스 더 안 움직임)
            return cells, True
        cells[col_name] = text
    return cells, False


def extract_grid(layout: dict) -> tuple[list[dict], str]:
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
        cells, modal = _extract_row(row_cells)
        if modal:
            return out, "MODAL"
        result = process(cells)
        if result != "CONTINUE":
            return out, result

    # Phase 2: 스크롤 모드
    if empty_streak == 0:
        last_remark = last_row_template[-1]
        rx, ry = last_remark["x"], last_remark["y"]
        while len(out) < 200:
            if STOP_REQUESTED:
                return out, "STOPPED"
            wheel_down(rx, ry, 1)
            time.sleep(0.25)
            wait_if_busy()  # 스크롤 후 로딩 대기 (긴 명세서 busy 모달 방지)
            cells, modal = _extract_row(last_row_template)
            if modal:
                return out, "MODAL"
            result = process(cells)
            if result != "CONTINUE":
                return out, result
        return out, "MAX"

    return out, "OK"


def focus_easyform() -> bool:
    """이지폼 명세서 상세 창을 포그라운드로 — 터미널에서 실행돼도 기준 창이 이지폼이 되게.
    (직접 PowerShell 실행 땐 불필요하지만, 헤드리스/터미널 실행 호환용. 매크로 로직 영향 없음.)"""
    try:
        from pywinauto import Desktop
        desk = Desktop(backend="win32")
        # 이지폼은 Delphi MDI 앱 — 명세서 상세는 메인창(TfrmBookMain) 안의 자식. 메인창을 포커스.
        cands = [w for w in desk.windows()
                 if w.class_name() == "TfrmBookMain" or "이지폼" in (w.window_text() or "")]
        if not cands:
            return False
        cands[0].set_focus()
        time.sleep(0.4)
        return True
    except Exception as e:
        print(f"  포커스 시도 실패: {e}")
        return False


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

    if focus_easyform():
        print("이지폼 상세 창 포커스 OK")
    else:
        print("⚠ 이지폼 상세 창을 못 찾음 — 상세화면이 열려 있는지 확인하세요")

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

        # 첫 정상 명세서에서 기준 창 클래스 확정 (이후 이 창과 다르면 모달로 판단)
        global BASE_FG_CLASS
        if BASE_FG_CLASS is None and not modal_present():
            BASE_FG_CLASS = fg_class_name()
            print(f"기준 창 클래스: {BASE_FG_CLASS!r}")

        grid, grid_stop = extract_grid(layout)
        if grid_stop == "STOPPED":
            stop_reason = f"⚠ Ctrl+Esc 중단 (인덱스 {inv_idx})"
            break
        if grid_stop == "MODAL":
            # 전자발행/전자전송 명세서 — 셀 클릭 시 "변경할 수 없습니다" 팝업.
            # 사용자 확인 닫기 순서: 엔터 → esc → 엔터 → 엔터 → 엔터 → 목록 화면.
            # (esc 로 상세를 닫을 때 연쇄 확인 팝업이 떠서 엔터를 여러 번 눌러야 함)
            key(VK_ENTER); time.sleep(0.5); wait_if_busy()   # 1. 변경불가 팝업 확인
            key(VK_ESC);   time.sleep(0.5); wait_if_busy()   # 2. 상세 닫기 → 확인 팝업 유발
            for _ in range(5):                                # 3~. 연쇄 확인 팝업 닫기
                key(VK_ENTER); time.sleep(0.5); wait_if_busy()
                if not modal_present():
                    break
            if modal_present():
                stop_reason = f"⚠ 전자발행 팝업이 안 닫힘 — 중단 (인덱스 {inv_idx})"
                break
            all_results.append({
                "invoice_idx": inv_idx, "grid": [], "grid_row_count": 0,
                "grid_stop_reason": "MODAL_SKIP",
            })
            out_path.write_text(
                json.dumps({"invoices": all_results, "extracted_at": time.time()},
                           ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"  [{inv_idx:>4}] 전자발행 팝업 감지 → 닫고 스킵, 다음 명세서로")
            same_streak = 0
            # 이미 목록 화면 — 다음 명세서 열기
            key(VK_DOWN); time.sleep(0.2)
            key(VK_ENTER); time.sleep(1.0); wait_if_busy()
            continue

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

        # 마지막 명세서 감지 — 연속 30회 동일 시그니처 (= 31개 명세서 연속 동일) 시 종료
        # dc 등 자재 텍스트만 같은 연속 명세서 오탐 방지. 안전 마진 크게 잡음.
        # 진짜 마지막 도달 시 같은 명세서 30번 중복 저장 후 종료 — 후처리 dedup.
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
            "grid_stop_reason": grid_stop,
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

        # 다음 명세서로
        key(VK_ESC); time.sleep(0.3)
        wait_if_busy()                  # 상세 닫기 로딩 대기
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
