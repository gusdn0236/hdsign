"""이지폼 오버레이 클릭통과 진단 — 딤/패널을 띄운 채 매크로를 돌려, 클릭이 오버레이를 통과해
이지폼 셀에 떨어지는지 검증(워처 재빌드 없이 빠르게). 여기서 되면 같은 방식을 easyform.py 에 넣는다.

견고한 클릭통과: GetAncestor(GA_ROOT)로 진짜 top-level HWND + WS_EX_LAYERED|TRANSPARENT 명시 +
SetWindowPos(FRAMECHANGED)로 강제 반영.

사용:
  1. 워처 종료.
  2. 이지폼 → 매출 거래명세서 → 새로작성 → 거래처 선택, 그 창 맨 앞.
  3. py -3 C:\\Users\\USER\\Desktop\\hdsign\\hdsign-watcher\\easyform_selftest2.py
  4. 5초 뒤 화면이 어두워지고(딤+🔒패널) 매크로 실행 — **딤이 떠 있는데도 셀에 들어가면 성공**.
  5. 결과 알려주세요. (저장 안 함 / 잘못되면 Esc)
"""
import ctypes
import sys
import threading
import time
import tkinter as tk

sys.path.insert(0, r"C:\Users\USER\Desktop\hdsign\hdsign-watcher")
import easyform as e  # noqa: E402

ROWS = [
    {"item_code": "AQ-1", "item": "테스트", "spec": "1000x500", "qty": "2",
     "unit_price": "15000", "supply": "30000", "tax": "3000"},
    {"item_code": "AQ-2", "item": "아크릴", "spec": "600x300", "qty": "1",
     "unit_price": "8000", "supply": "8000", "tax": "800"},
]

_u = ctypes.windll.user32
GWL_EXSTYLE = -20
GA_ROOT = 2
WS_EX_LAYERED = 0x00080000
WS_EX_TRANSPARENT = 0x00000020
WS_EX_NOACTIVATE = 0x08000000
WS_EX_TOPMOST = 0x00000008
WS_EX_TOOLWINDOW = 0x00000080
SWP_NOMOVE = 0x0002
SWP_NOSIZE = 0x0001
SWP_NOZORDER = 0x0004
SWP_NOACTIVATE = 0x0010
SWP_FRAMECHANGED = 0x0020

try:
    _GetWindowLong = _u.GetWindowLongPtrW
    _SetWindowLong = _u.SetWindowLongPtrW
except AttributeError:
    _GetWindowLong = _u.GetWindowLongW
    _SetWindowLong = _u.SetWindowLongW


def make_clickthrough(win):
    win.update_idletasks()
    hwnd = _u.GetAncestor(win.winfo_id(), GA_ROOT)  # 진짜 top-level
    cur = _GetWindowLong(hwnd, GWL_EXSTYLE)
    new = cur | WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOPMOST | WS_EX_TOOLWINDOW
    _SetWindowLong(hwnd, GWL_EXSTYLE, new)
    _u.SetWindowPos(hwnd, 0, 0, 0, 0, 0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED)
    return hwnd


def main():
    if not e.EASYFORM_AVAILABLE:
        print("EASYFORM_AVAILABLE=False")
        return
    root = tk.Tk()
    root.withdraw()
    sw, sh = root.winfo_screenwidth(), root.winfo_screenheight()

    dim = tk.Toplevel(root)
    dim.overrideredirect(True)
    dim.geometry(f"{sw}x{sh}+0+0")
    dim.configure(bg="#000000")
    dim.attributes("-alpha", 0.45)
    dim.attributes("-topmost", True)

    panel = tk.Toplevel(root)
    panel.overrideredirect(True)
    pw, ph = 560, 220
    panel.geometry(f"{pw}x{ph}+{(sw - pw) // 2}+{(sh - ph) // 2}")
    panel.configure(bg="#1f2937")
    panel.attributes("-topmost", True)
    panel.attributes("-alpha", 0.97)
    tk.Label(panel, text="🔒 클릭통과 테스트", font=("맑은 고딕", 18, "bold"),
             fg="#fbbf24", bg="#1f2937").pack(expand=True)

    dim.withdraw()
    panel.withdraw()

    def worker():
        time.sleep(0.5)
        try:
            ok, msg = e.run_easyform_fill(ROWS)
        except Exception as ex:  # noqa: BLE001
            ok, msg = False, f"오류: {ex}"
        print(("성공: " if ok else "실패: ") + msg)
        root.after(1500, root.quit)

    def start_overlay():  # 메인 스레드(tk 안전)
        dim.deiconify(); panel.deiconify()
        h1 = make_clickthrough(dim)
        h2 = make_clickthrough(panel)
        dim.lift(); panel.lift()
        print(f"오버레이 표시(클릭통과 적용). dim hwnd={h1}, panel hwnd={h2}")
        e.ef_focus_easyform()
        threading.Thread(target=worker, daemon=True).start()

    print("5초 후 시작 — 이지폼 창 맨 앞에, 마우스 만지지 마세요.")
    root.after(5000, start_overlay)
    root.mainloop()
    print("종료 — 딤이 떠 있는데도 셀에 들어갔으면 클릭통과 성공.")


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore
    except Exception:
        pass
    main()
