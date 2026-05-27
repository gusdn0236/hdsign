"""이지폼 목록에서 ↓ 키 N번 자동으로 누름 — 풀배치 재개 보조.

사용:
    1. 이지폼 매출 거래명세서 [목록] 화면 열기
    2. 역순으로 보기 끈 정순 (1월 2일 위, 12월 31일 아래)
    3. 첫 행 (1월 2일) 클릭으로 활성화 — Enter 누르지 말 것
    4. PowerShell:
        py -3 C:\\Users\\USER\\Desktop\\hdsign\\scripts\\easyform_seek.py <N>
       <N> = 풀배치에서 이미 완료한 명세서 수
    5. 5초 후 ↓ 키 N번 자동 → N+1번째 행 활성화
    6. 끝나면 사용자가 Enter 직접 누름 + batch.py --start N 실행

Ctrl+Esc 누르면 중단.
"""
from __future__ import annotations
import argparse
import ctypes
import sys
import time
import threading
from ctypes import wintypes

user32 = ctypes.WinDLL("user32", use_last_error=True)

try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    try:
        user32.SetProcessDPIAware()
    except Exception:
        pass

VK_DOWN = 0x28
VK_CTRL = 0x11
VK_ESC = 0x1B
INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002


class _KI(ctypes.Structure):
    _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD),
                ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD),
                ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]


class _U(ctypes.Union):
    _fields_ = [("ki", _KI), ("pad", ctypes.c_byte * 32)]


class _IN(ctypes.Structure):
    _fields_ = [("type", wintypes.DWORD), ("u", _U)]


def _send(inputs):
    arr = (_IN * len(inputs))(*inputs)
    user32.SendInput(len(inputs), ctypes.byref(arr), ctypes.sizeof(_IN))


def press_down():
    seq = [
        _IN(INPUT_KEYBOARD, _U(ki=_KI(VK_DOWN, 0, 0, 0, None))),
        _IN(INPUT_KEYBOARD, _U(ki=_KI(VK_DOWN, 0, KEYEVENTF_KEYUP, 0, None))),
    ]
    _send(seq)


STOP_REQUESTED = False


def _hotkey():
    global STOP_REQUESTED
    while not STOP_REQUESTED:
        if (user32.GetAsyncKeyState(VK_CTRL) & 0x8000) and \
           (user32.GetAsyncKeyState(VK_ESC) & 0x8000):
            STOP_REQUESTED = True
            print("\n⚠ Ctrl+Esc 중단")
            break
        time.sleep(0.05)


threading.Thread(target=_hotkey, daemon=True).start()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("count", type=int, help="↓ 누를 횟수 (= 완료한 명세서 수)")
    ap.add_argument("--delay", type=float, default=0.01,
                    help="↓ 누름 사이 sleep 초 (기본 0.01 = 1000번 약 10초)")
    args = ap.parse_args()

    print(f"=== EasyForm 목록 ↓ {args.count}회 ===")
    print()
    print("준비:")
    print("  1. 이지폼 매출 거래명세서 [목록] 화면 열기")
    print("  2. 역순으로 보기 끈 정순")
    print("  3. 첫 행 (1월 2일) 클릭으로 활성화 — Enter 누르지 말 것")
    print(f"  4. 5초 후 시작. 이지폼 창 활성 상태 유지. Ctrl+Esc 중단.")
    print()
    for i in range(5, 0, -1):
        print(f"  {i}...", end="\r", flush=True)
        time.sleep(1)
    print()

    t0 = time.time()
    for i in range(args.count):
        if STOP_REQUESTED:
            print(f"\n⚠ 중단 — {i}회 완료 (목표 {args.count})")
            return 1
        press_down()
        time.sleep(args.delay)
        if (i + 1) % 200 == 0:
            elapsed = time.time() - t0
            avg = elapsed / (i + 1)
            remain = avg * (args.count - i - 1)
            print(f"  {i+1}/{args.count} 완료  ({elapsed:.0f}s, 남은 {remain:.0f}s)")

    elapsed = time.time() - t0
    print(f"\n끝. ↓ {args.count}회 누름. 소요 {elapsed:.1f}s")
    print(f"이제 {args.count + 1}번째 행 활성 상태.")
    print(f"Enter 눌러 상세 열기 → batch.py --start {args.count} 실행")
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore
    sys.exit(main())
