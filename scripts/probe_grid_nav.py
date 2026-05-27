"""EasyForm 자재 그리드 navigation 자동 탐색.

사용법:
    1. 이지폼 명세서 상세 화면 열기
    2. 자재 그리드의 첫 셀(왼쪽 위) 클릭으로 활성화 (텍스트 있는 셀 선호)
    3. PowerShell:
        py -3 C:\\Users\\USER\\Desktop\\hdsign\\scripts\\probe_grid_nav.py
    4. "준비됐으면 Enter ↩" → 이지폼이 활성 상태인지 확인 후 Enter
    5. 스크립트가 자동으로 12개 키 + 4개 마우스 좌표 시도
    6. 각 시도의 결과 출력 — 클립보드 변화하면 ✓ 이동 성공

⚠ 주의:
    - 스크립트 실행 중 마우스/키보드 만지지 마세요
    - EasyForm 창이 활성(focus) 상태여야 함
    - 위험 키 (Delete/Save/Enter at root) 안 보냄
"""
from __future__ import annotations
import ctypes
import sys
import time
from ctypes import wintypes
from typing import Callable

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

# Clipboard signatures
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
    if not user32.OpenClipboard(None):
        return
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
    if not user32.OpenClipboard(None):
        return ""
    try:
        h = user32.GetClipboardData(CF_UNICODETEXT)
        if not h:
            return ""
        size = kernel32.GlobalSize(h)
        ptr = kernel32.GlobalLock(h)
        if not ptr:
            return ""
        try:
            data = ctypes.string_at(ptr, size)
            return data.decode("utf-16-le").rstrip("\0")
        finally:
            kernel32.GlobalUnlock(h)
    finally:
        user32.CloseClipboard()


# SendInput
INPUT_MOUSE = 0
INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_ABSOLUTE = 0x8000


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG),
                ("mouseData", wintypes.DWORD), ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD),
                ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD),
                ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]


class _INPUT_UNION(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("padding", ctypes.c_byte * 32)]


class INPUT(ctypes.Structure):
    _fields_ = [("type", wintypes.DWORD), ("u", _INPUT_UNION)]


def send_key(vk: int, modifiers: list[int] = None) -> None:
    """vk = virtual key code. modifiers = list of vk for held keys (Ctrl, Shift, ...)"""
    modifiers = modifiers or []
    inputs = []
    for m in modifiers:
        ki = KEYBDINPUT(wVk=m, wScan=0, dwFlags=0, time=0, dwExtraInfo=None)
        inputs.append(INPUT(type=INPUT_KEYBOARD, u=_INPUT_UNION(ki=ki)))
    ki_down = KEYBDINPUT(wVk=vk, wScan=0, dwFlags=0, time=0, dwExtraInfo=None)
    inputs.append(INPUT(type=INPUT_KEYBOARD, u=_INPUT_UNION(ki=ki_down)))
    ki_up = KEYBDINPUT(wVk=vk, wScan=0, dwFlags=KEYEVENTF_KEYUP, time=0, dwExtraInfo=None)
    inputs.append(INPUT(type=INPUT_KEYBOARD, u=_INPUT_UNION(ki=ki_up)))
    for m in reversed(modifiers):
        ki = KEYBDINPUT(wVk=m, wScan=0, dwFlags=KEYEVENTF_KEYUP, time=0, dwExtraInfo=None)
        inputs.append(INPUT(type=INPUT_KEYBOARD, u=_INPUT_UNION(ki=ki)))
    arr = (INPUT * len(inputs))(*inputs)
    user32.SendInput(len(inputs), ctypes.byref(arr), ctypes.sizeof(INPUT))


def mouse_click(x: int, y: int) -> None:
    """Absolute screen coordinates."""
    sw = user32.GetSystemMetrics(0)
    sh = user32.GetSystemMetrics(1)
    dx = int(x * 65535 / sw)
    dy = int(y * 65535 / sh)
    mi_move = MOUSEINPUT(dx=dx, dy=dy, mouseData=0,
                         dwFlags=MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE,
                         time=0, dwExtraInfo=None)
    mi_down = MOUSEINPUT(dx=dx, dy=dy, mouseData=0,
                         dwFlags=MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_ABSOLUTE,
                         time=0, dwExtraInfo=None)
    mi_up = MOUSEINPUT(dx=dx, dy=dy, mouseData=0,
                       dwFlags=MOUSEEVENTF_LEFTUP | MOUSEEVENTF_ABSOLUTE,
                       time=0, dwExtraInfo=None)
    inputs = [INPUT(type=INPUT_MOUSE, u=_INPUT_UNION(mi=mi)) for mi in [mi_move, mi_down, mi_up]]
    arr = (INPUT * len(inputs))(*inputs)
    user32.SendInput(len(inputs), ctypes.byref(arr), ctypes.sizeof(INPUT))


# Virtual key codes
VK = {
    "TAB": 0x09, "ENTER": 0x0D, "SHIFT": 0x10, "CTRL": 0x11, "ALT": 0x12,
    "ESC": 0x1B, "SPACE": 0x20,
    "PGUP": 0x21, "PGDN": 0x22, "END": 0x23, "HOME": 0x24,
    "LEFT": 0x25, "UP": 0x26, "RIGHT": 0x27, "DOWN": 0x28,
    "F2": 0x71,
    "C": 0x43, "A": 0x41,
}


def copy_current_cell() -> str:
    """현재 셀 Ctrl+C → 클립보드 read."""
    send_key(VK["C"], modifiers=[VK["CTRL"]])
    time.sleep(0.25)
    return get_clipboard()


def try_action(label: str, action: Callable[[], None], delay: float = 0.4) -> tuple[str, bool, str, str]:
    """
    Returns (label, moved?, before_text, after_text)
    """
    # 시작 셀 텍스트
    set_clipboard("__SENT__")
    time.sleep(0.1)
    before = copy_current_cell()
    # 액션
    set_clipboard("__SENT2__")
    time.sleep(0.05)
    action()
    time.sleep(delay)
    after = copy_current_cell()
    moved = (before != after) and (after != "__SENT2__")
    return label, moved, before, after


def main() -> int:
    print("=== EasyForm 그리드 navigation 자동 탐색 ===\n")
    print("준비:")
    print("  1. 이지폼 명세서 상세 화면 열어두기")
    print("  2. 자재 그리드의 첫 셀(왼쪽 위, 텍스트 있는 셀) 클릭으로 활성화")
    print("  3. EasyForm 창이 활성(가장 앞) 상태")
    print()
    print("⚠ Enter 누른 후 5초 대기 → 그 사이 EasyForm 창을 클릭으로 활성화하세요.")
    print("⚠ 그 후 마우스/키보드 만지지 마세요.")
    print()
    print("준비됐으면 Enter ↩")
    try:
        input()
    except (EOFError, KeyboardInterrupt):
        return 1

    print("5초 후 시작 — EasyForm 창 클릭으로 활성화...")
    for i in range(5, 0, -1):
        print(f"  {i}...", end="\r", flush=True)
        time.sleep(1)
    print()
    print("시작\n")

    tests: list[tuple[str, Callable[[], None]]] = [
        ("Tab",             lambda: send_key(VK["TAB"])),
        ("Shift+Tab",       lambda: send_key(VK["TAB"], [VK["SHIFT"]])),
        ("Enter",           lambda: send_key(VK["ENTER"])),
        ("Esc",             lambda: send_key(VK["ESC"])),
        ("Space",           lambda: send_key(VK["SPACE"])),
        ("F2",              lambda: send_key(VK["F2"])),
        ("F2 + Esc",        lambda: (send_key(VK["F2"]), time.sleep(0.2), send_key(VK["ESC"]))),
        ("Right",           lambda: send_key(VK["RIGHT"])),
        ("Down",            lambda: send_key(VK["DOWN"])),
        ("End",             lambda: send_key(VK["END"])),
        ("Home",            lambda: send_key(VK["HOME"])),
        ("Ctrl+End",        lambda: send_key(VK["END"], [VK["CTRL"]])),
        ("Ctrl+Home",       lambda: send_key(VK["HOME"], [VK["CTRL"]])),
        ("PgDn",            lambda: send_key(VK["PGDN"])),
        ("Ctrl+Right",      lambda: send_key(VK["RIGHT"], [VK["CTRL"]])),
        ("Ctrl+Down",       lambda: send_key(VK["DOWN"], [VK["CTRL"]])),
        # 마우스: 그리드 영역 안 추정 좌표 (L12, T401, R1055, B760)
        # 화면 좌상 (0,0) 기준. 명세서 상세 창이 보통 화면 가운데에 있다고 가정.
        # 사용자가 첫 셀 클릭하고 시작했으니 거기서 오른쪽으로 100px 이동 시도.
        # (절대 좌표라 추정에 실패할 수 있음)
        # 마우스 시도는 사용자가 첫 셀 좌표를 알고 있을 때만 유효 — 생략하고 키 시도 후 결과로 결정
    ]

    results = []
    for label, action in tests:
        r = try_action(label, action)
        results.append(r)
        symbol = "✓" if r[1] else "·"
        print(f"  {symbol}  {label:15s}  before={r[2]!r:30s}  after={r[3]!r:30s}")

    print()
    print("=" * 70)
    print("이동 성공:")
    succ = [r for r in results if r[1]]
    if succ:
        for r in succ:
            print(f"  ✓ {r[0]:15s}  '{r[2]}' → '{r[3]}'")
    else:
        print("  (없음 — 키 입력 모두 무시됨. 마우스 클릭만 가능)")
    print()
    print("결과 저장: C:\\Users\\USER\\Desktop\\grid_probe.txt")
    out_path = "C:\\Users\\USER\\Desktop\\grid_probe.txt"
    with open(out_path, "w", encoding="utf-8") as f:
        for r in results:
            f.write(f"{'✓' if r[1] else '·'}  {r[0]:15s}  before={r[2]!r}  after={r[3]!r}\n")
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore
    sys.exit(main())
