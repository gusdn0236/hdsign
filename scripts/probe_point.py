"""안전한 빈 곳(우클릭 메뉴 닫기용) 좌표 측정 — F7 한 번.

사용:
    1. 이지폼 명세서 상세 화면
    2. py -3 probe_point.py
    3. 우클릭 메뉴를 닫을 '안전한 빈 곳'에 마우스 올리고 F7
       - 명세서 상세 창 안이되, 클릭해도 아무 셀도 활성화/편집 안 되는 곳
         (예: 그리드 아래 여백, 빈 라벨 영역)
    4. 출력된 좌표를 알려주세요
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


def main():
    print(f"DPI scale: {DPI:.2f}x")
    print()
    print(">> 우클릭 메뉴를 닫을 '안전한 빈 곳'에 마우스 올리고 F7")
    print("   (명세서 상세 창 안 / 클릭해도 셀 활성화·편집 안 되는 여백)")
    pt = wintypes.POINT()
    while True:
        if user32.GetAsyncKeyState(VK_F7) & 0x8000:
            user32.GetCursorPos(ctypes.byref(pt))
            print()
            print(f"=== 안전곳 논리좌표: x={pt.x / DPI:.0f}, y={pt.y / DPI:.0f} ===")
            print("이 x, y 값을 알려주세요.")
            break
        if user32.GetAsyncKeyState(VK_ESC) & 0x8000:
            print("취소됨"); break
        time.sleep(0.05)


if __name__ == "__main__":
    import sys
    sys.stdout.reconfigure(encoding="utf-8")
    main()
