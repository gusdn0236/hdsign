"""우클릭 '복사' 버튼 오프셋 측정 — F7 두 번.

사용:
    1. 이지폼 명세서 상세 화면 (자재 값이 있는 행)
    2. py -3 probe_rmenu.py
    3. [1번째 F7] 아무 셀(값 있는 칸) 중앙에 마우스 올리고 F7
    4. 그 셀을 직접 우클릭 → 컨텍스트 메뉴가 뜸
    5. [2번째 F7] 메뉴의 '복사' 항목에 마우스 올리고 F7
    6. 출력된 오프셋(dx, dy)을 알려주세요

→ 매크로는 어느 셀이든 '우클릭 → (셀 + dx, 셀 + dy) 좌클릭' 으로 복사.
   (메뉴가 마우스 커서 기준 상대 위치로 뜨므로 오프셋은 셀과 무관하게 일정)
"""
import ctypes
import time
from ctypes import wintypes

user32 = ctypes.WinDLL("user32", use_last_error=True)

try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    try:
        user32.SetProcessDPIAware()
    except Exception:
        pass

gdi32 = ctypes.windll.gdi32
hdc = user32.GetDC(0)
DPI = gdi32.GetDeviceCaps(hdc, 88) / 96.0
user32.ReleaseDC(0, hdc)

VK_F7 = 0x76
VK_ESC = 0x1B
user32.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
user32.FindWindowW.restype = wintypes.HWND


def wait_f7():
    """F7 눌릴 때까지 대기 → 커서 논리좌표 반환. Esc 면 None. (떼임까지 디바운스)"""
    while not (user32.GetAsyncKeyState(VK_F7) & 0x8000):
        if user32.GetAsyncKeyState(VK_ESC) & 0x8000:
            return None
        time.sleep(0.03)
    pt = wintypes.POINT()
    user32.GetCursorPos(ctypes.byref(pt))
    while user32.GetAsyncKeyState(VK_F7) & 0x8000:  # 떼임 대기
        time.sleep(0.03)
    return (pt.x / DPI, pt.y / DPI)


def main():
    print(f"DPI scale: {DPI:.2f}x")
    print()
    print(">> [1번째 F7] 셀(값 있는 칸) 중앙에 마우스 올리고 F7")
    p1 = wait_f7()
    if p1 is None:
        print("취소됨"); return
    print(f"   셀 중앙: ({p1[0]:.0f}, {p1[1]:.0f})")
    print()
    print(">> 이제 그 셀을 직접 우클릭하세요. 메뉴가 뜨면")
    print(">> [2번째 F7] 메뉴의 '복사' 항목에 마우스 올리고 F7")
    p2 = wait_f7()
    if p2 is None:
        print("취소됨"); return
    menu = bool(user32.FindWindowW("#32768", None))
    print(f"   복사 버튼: ({p2[0]:.0f}, {p2[1]:.0f})")
    print(f"   (F7 시점 컨텍스트 메뉴 #32768 감지: {'예' if menu else '아니오'})")
    print()
    dx, dy = p2[0] - p1[0], p2[1] - p1[1]
    print(f"=== 오프셋: dx={dx:.0f}, dy={dy:.0f} ===")
    print("이 dx, dy 값과 위 '#32768 감지' 결과를 알려주세요.")


if __name__ == "__main__":
    import sys
    sys.stdout.reconfigure(encoding="utf-8")
    main()
