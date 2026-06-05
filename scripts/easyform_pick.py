"""EasyForm 좌표 찍기 — F7 으로 마우스 위치 캡처.

slice-14 이지폼 매크로용. easyform_layout.json 과 **같은 좌표계(논리 픽셀)** 로 찍는다.
  - easyform_batch.py 는 좌표를 논리 픽셀로 저장하고 클릭 시 DPI_SCALE 을 곱한다.
  - 그래서 여기서는 GetCursorPos(물리) ÷ DPI_SCALE = 논리 로 환산해 보여준다.
  - 즉 여기서 찍힌 logical 좌표를 batch.py 의 click(x, y) 에 그대로 넣으면 같은 지점을 누른다.

사용:
    py -3 C:\\Users\\USER\\Desktop\\hdsign\\scripts\\easyform_pick.py

    1. 이지폼 매출 거래명세서 [새로작성] 화면을 띄운다 (좌표는 창 위치에 의존하니
       batch.py 돌릴 때와 같은 창 위치/크기로 둘 것).
    2. 찍고 싶은 지점(예: "현재 □ 줄 선택됨" 흰 박스, "삽입" 버튼)에 마우스를 올린다.
    3. F7 을 누른다 → 그 자리 좌표가 콘솔에 찍히고 easyform_picked.json 에 누적 저장.
    4. 라벨을 물어보면(콘솔 입력 불가 환경이면 생략) 엔터.
    5. 다 찍었으면 Esc 로 종료. 콘솔 출력 + JSON 둘 다 남는다.

⚠ 안전: 클릭/키 입력 전혀 안 함. 마우스 위치만 읽는다(GetCursorPos). 데이터 변경 0.
"""
from __future__ import annotations
import ctypes
import json
import time
from ctypes import wintypes
from pathlib import Path

user32 = ctypes.WinDLL("user32", use_last_error=True)

# DPI awareness — batch.py 와 동일(per-monitor v2 → 실패 시 system aware).
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
        dpi = gdi32.GetDeviceCaps(hdc, 88)  # LOGPIXELSX
        user32.ReleaseDC(0, hdc)
        return dpi / 96.0
    except Exception:
        return 1.0


DPI_SCALE = _detect_scale()

user32.GetCursorPos.argtypes = [ctypes.POINTER(wintypes.POINT)]
user32.GetCursorPos.restype = wintypes.BOOL
user32.GetAsyncKeyState.argtypes = [ctypes.c_int]
user32.GetAsyncKeyState.restype = ctypes.c_short

# 어떤 창 위에서 찍었는지도 같이 기록(좌표는 창 위치 의존이라 디버깅에 유용).
user32.GetForegroundWindow.restype = wintypes.HWND
user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetWindowTextW.restype = ctypes.c_int

VK_F7 = 0x76
VK_ESC = 0x1B


def cursor_physical() -> tuple[int, int]:
    pt = wintypes.POINT()
    user32.GetCursorPos(ctypes.byref(pt))
    return pt.x, pt.y


def fg_title() -> str:
    h = user32.GetForegroundWindow()
    buf = ctypes.create_unicode_buffer(256)
    user32.GetWindowTextW(h, buf, 256)
    return buf.value


def main() -> int:
    out_path = Path(r"C:\Users\USER\Desktop\hdsign\scripts\easyform_picked.json")
    picks: list[dict] = []
    if out_path.is_file():
        try:
            picks = json.loads(out_path.read_text(encoding="utf-8")).get("picks", [])
        except Exception:
            picks = []

    print("=" * 64)
    print(f"EasyForm 좌표 찍기 — DPI scale {DPI_SCALE:.2f}x")
    print("=" * 64)
    print("이지폼 [새로작성] 화면을 띄우고, 찍을 지점에 마우스를 올린 뒤 F7.")
    print("F7 = 캡처 / Esc = 종료")
    print(f"저장: {out_path}")
    if picks:
        print(f"(기존 {len(picks)}개 이어서 누적)")
    print("-" * 64)

    f7_was_down = False
    n = len(picks)
    while True:
        # Esc → 종료
        if user32.GetAsyncKeyState(VK_ESC) & 0x8000:
            break

        f7_down = bool(user32.GetAsyncKeyState(VK_F7) & 0x8000)
        if f7_down and not f7_was_down:  # 누르는 순간 1회만(엣지)
            px, py = cursor_physical()
            lx = round(px / DPI_SCALE)
            ly = round(py / DPI_SCALE)
            n += 1
            rec = {
                "n": n,
                "logical": {"x": lx, "y": ly},   # ← batch.py click(x,y) 에 그대로 사용
                "physical": {"x": px, "y": py},
                "dpi_scale": round(DPI_SCALE, 4),
                "fg_title": fg_title(),
            }
            picks.append(rec)
            out_path.write_text(
                json.dumps({"picks": picks}, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            print(f"  [{n:>2}] logical=({lx:>4},{ly:>4})  physical=({px:>4},{py:>4})  "
                  f"창='{rec['fg_title'][:30]}'")
        f7_was_down = f7_down
        time.sleep(0.02)

    print("-" * 64)
    print(f"종료 — 총 {n}개 좌표 저장됨: {out_path}")
    return 0


if __name__ == "__main__":
    try:
        import sys
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore
    except Exception:
        pass
    raise SystemExit(main())
