"""이지폼 자동기입 — 사무 워처(hdsign_watcher) 내장 모듈.

자동견적 명세서(grid)를 이지폼 '매출 거래명세서' 새로작성 화면에 셀 단위로 자동 기입한다.
원래 현장 에이전트(field_agent)에 있던 기능을, 사무실이 이미 상시 띄우는 워처(tkinter+HTTP)
안으로 옮긴 것 — 사무실은 워처 1개만 켜면 된다(별도 exe 없음).

워처에서의 연결:
  - HTTP: _PingHandler 가 GET /easyform/probe → handle_probe(), POST /easyform/fill → handle_fill(body).
  - GUI : main() 에서 install(app) 호출(app = 워처 tk root). 별도 mainloop 없음(워처 것 사용).

IRON LAW: Enter/저장(F5)/전자전송(F11) 등 **확정 키는 절대 보내지 않는다**. 매크로 입력은
① 셀 클릭(SendInput 주입) ② 흰 박스에 '2' 한 글자 ③ Ctrl+V(붙여넣기) 뿐. 최종 저장/전자발행은
사람이 직접 확인 후 누른다.

좌표계: easyform_pick.py / easyform_layout.json 과 동일한 **논리 픽셀**. 클릭 직전 DPI_SCALE 을
곱해 물리 좌표로 변환. 좌표는 이지폼 창 위치에 의존하므로 캡처할 때와 같은 위치/크기로 둘 것.
"""
from __future__ import annotations

import logging
import queue
import sys
import threading
import time

EASYFORM_AVAILABLE = False
try:
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes

        _user32 = ctypes.WinDLL("user32", use_last_error=True)
        _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

        # ⚠ 워처(호스트) 프로세스의 DPI awareness 를 바꾸지 않는다 — 바꾸면 워처 GUI 가 작아진다.
        # ef_click 은 절대좌표(0..65535 정규화) SendInput 이라, EF_DPI_SCALE·EF_SCREEN_W 를 현재
        # awareness 그대로 읽기만 하면 awareness 와 무관하게 같은 물리 픽셀을 클릭한다(정규값 동일).

        def _ef_scale() -> float:
            try:
                gdi32 = ctypes.windll.gdi32
                hdc = _user32.GetDC(0)
                dpi = gdi32.GetDeviceCaps(hdc, 88)  # LOGPIXELSX
                _user32.ReleaseDC(0, hdc)
                return dpi / 96.0
            except Exception:
                return 1.0

        EF_DPI_SCALE = _ef_scale()

        _user32.OpenClipboard.argtypes = [wintypes.HWND]; _user32.OpenClipboard.restype = wintypes.BOOL
        _user32.EmptyClipboard.restype = wintypes.BOOL
        _user32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]; _user32.SetClipboardData.restype = wintypes.HANDLE
        _kernel32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]; _kernel32.GlobalAlloc.restype = wintypes.HGLOBAL
        _kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]; _kernel32.GlobalLock.restype = wintypes.LPVOID
        _kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]; _kernel32.GlobalUnlock.restype = wintypes.BOOL
        _user32.SetCursorPos.argtypes = [ctypes.c_int, ctypes.c_int]; _user32.SetCursorPos.restype = wintypes.BOOL
        _user32.GetForegroundWindow.restype = wintypes.HWND
        _user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]; _user32.GetWindowTextW.restype = ctypes.c_int
        _user32.GetAsyncKeyState.argtypes = [ctypes.c_int]; _user32.GetAsyncKeyState.restype = ctypes.c_short
        _user32.MessageBoxW.argtypes = [wintypes.HWND, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.UINT]
        _user32.MessageBoxW.restype = ctypes.c_int

        _CF_UNICODETEXT = 13
        _GMEM_MOVEABLE = 0x0002
        _INPUT_MOUSE = 0
        _INPUT_KEYBOARD = 1
        _KEYEVENTF_KEYUP = 0x0002
        _MOUSEEVENTF_LEFTDOWN = 0x0002
        _MOUSEEVENTF_LEFTUP = 0x0004
        _MOUSEEVENTF_MOVE = 0x0001
        _MOUSEEVENTF_ABSOLUTE = 0x8000

        _user32.GetSystemMetrics.argtypes = [ctypes.c_int]
        _user32.GetSystemMetrics.restype = ctypes.c_int
        EF_SCREEN_W = _user32.GetSystemMetrics(0) or 1920  # SM_CXSCREEN(물리 px, PMv2 aware)
        EF_SCREEN_H = _user32.GetSystemMetrics(1) or 1080  # SM_CYSCREEN

        class _EF_MI(ctypes.Structure):
            _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG),
                        ("mouseData", wintypes.DWORD), ("dwFlags", wintypes.DWORD),
                        ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]

        class _EF_KI(ctypes.Structure):
            _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD),
                        ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD),
                        ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]

        class _EF_U(ctypes.Union):
            _fields_ = [("mi", _EF_MI), ("ki", _EF_KI), ("pad", ctypes.c_byte * 32)]

        class _EF_IN(ctypes.Structure):
            _fields_ = [("type", wintypes.DWORD), ("u", _EF_U)]

        def _ef_send(inputs):
            arr = (_EF_IN * len(inputs))(*inputs)
            _user32.SendInput(len(inputs), ctypes.byref(arr), ctypes.sizeof(_EF_IN))

        def _ef_open_clipboard(retries: int = 15) -> bool:
            for _ in range(retries):
                if _user32.OpenClipboard(None):
                    return True
                time.sleep(0.02)
            return False

        def ef_set_clipboard(text: str) -> None:
            if not _ef_open_clipboard():
                return
            try:
                _user32.EmptyClipboard()
                data = (text + "\0").encode("utf-16-le")
                h = _kernel32.GlobalAlloc(_GMEM_MOVEABLE, len(data))
                ptr = _kernel32.GlobalLock(h)
                ctypes.memmove(ptr, data, len(data))
                _kernel32.GlobalUnlock(h)
                _user32.SetClipboardData(_CF_UNICODETEXT, h)
            finally:
                _user32.CloseClipboard()

        def ef_click(x: int, y: int) -> None:
            # 논리좌표 → 물리 px → 절대좌표(0..65535). 모든 마우스 입력을 SendInput 으로 '주입'한다
            # (SetCursorPos 아님) → 입력가드(LL 훅)가 우리 클릭은 통과시키고 사용자 물리 입력만 차단 가능.
            px = int(x * EF_DPI_SCALE)
            py = int(y * EF_DPI_SCALE)
            nx = int(px * 65535 / max(1, EF_SCREEN_W - 1))
            ny = int(py * 65535 / max(1, EF_SCREEN_H - 1))
            mv = _EF_MI(nx, ny, 0, _MOUSEEVENTF_MOVE | _MOUSEEVENTF_ABSOLUTE, 0, None)
            _ef_send([_EF_IN(_INPUT_MOUSE, _EF_U(mi=mv))])
            time.sleep(0.03)
            d = _EF_MI(nx, ny, 0, _MOUSEEVENTF_LEFTDOWN | _MOUSEEVENTF_ABSOLUTE, 0, None)
            u = _EF_MI(nx, ny, 0, _MOUSEEVENTF_LEFTUP | _MOUSEEVENTF_ABSOLUTE, 0, None)
            _ef_send([_EF_IN(_INPUT_MOUSE, _EF_U(mi=d)), _EF_IN(_INPUT_MOUSE, _EF_U(mi=u))])

        def ef_double_click(x: int, y: int) -> None:
            ef_click(x, y)
            time.sleep(0.05)
            ef_click(x, y)

        def ef_key(vk: int, mods=None) -> None:
            mods = mods or []
            seq = []
            for m in mods:
                seq.append(_EF_IN(_INPUT_KEYBOARD, _EF_U(ki=_EF_KI(m, 0, 0, 0, None))))
            seq.append(_EF_IN(_INPUT_KEYBOARD, _EF_U(ki=_EF_KI(vk, 0, 0, 0, None))))
            seq.append(_EF_IN(_INPUT_KEYBOARD, _EF_U(ki=_EF_KI(vk, 0, _KEYEVENTF_KEYUP, 0, None))))
            for m in reversed(mods):
                seq.append(_EF_IN(_INPUT_KEYBOARD, _EF_U(ki=_EF_KI(m, 0, _KEYEVENTF_KEYUP, 0, None))))
            _ef_send(seq)

        def ef_paste() -> None:
            ef_key(0x56, [0x11])  # Ctrl(0x11) + V(0x56) — IRON LAW 허용 키시퀀스

        def ef_foreground_title() -> str:
            h = _user32.GetForegroundWindow()
            buf = ctypes.create_unicode_buffer(256)
            _user32.GetWindowTextW(h, buf, 256)
            return buf.value

        def ef_messagebox(text: str, title: str = "HD사인 이지폼") -> None:
            # MB_OK(0) | MB_TOPMOST(0x40000) | MB_SETFOREGROUND(0x10000)
            try:
                _user32.MessageBoxW(None, text, title, 0x50000)
            except Exception:
                pass

        def ef_confirm(text: str, title: str = "이지폼 자동기입") -> bool:
            # MB_YESNO(0x4)|MB_ICONQUESTION(0x20)|MB_SETFOREGROUND(0x10000)|MB_TOPMOST(0x40000) → IDYES(6)
            try:
                return _user32.MessageBoxW(None, text, title, 0x50024) == 6
            except Exception:
                return False

        # ── 이지폼 창 찾아 앞으로 ── '채우기' 클릭 시 이지폼을 최상위로 끌어와 클릭이 정확히 떨어지게.
        _EF_WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        _user32.EnumWindows.argtypes = [_EF_WNDENUMPROC, wintypes.LPARAM]
        _user32.EnumWindows.restype = wintypes.BOOL
        _user32.IsWindowVisible.argtypes = [wintypes.HWND]
        _user32.IsWindowVisible.restype = wintypes.BOOL
        _user32.SetForegroundWindow.argtypes = [wintypes.HWND]
        _user32.SetForegroundWindow.restype = wintypes.BOOL
        _user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
        _user32.ShowWindow.restype = wintypes.BOOL
        _user32.IsIconic.argtypes = [wintypes.HWND]
        _user32.IsIconic.restype = wintypes.BOOL

        def _ef_find_easyform_hwnd():
            matches: list = []

            def _cb(hwnd, lparam):
                if not _user32.IsWindowVisible(hwnd):
                    return True
                b = ctypes.create_unicode_buffer(256)
                _user32.GetWindowTextW(hwnd, b, 256)
                t = b.value or ""
                if ("거래명세서" in t) or ("이지폼" in t):
                    matches.append((hwnd, t))
                return True

            _user32.EnumWindows(_EF_WNDENUMPROC(_cb), 0)
            if not matches:
                return None
            for hwnd, t in matches:   # '매출 거래명세서' 폼 우선
                if "거래명세서" in t:
                    return hwnd
            return matches[0][0]      # 없으면 메인 앱 창

        def ef_focus_easyform() -> bool:
            hwnd = _ef_find_easyform_hwnd()
            if not hwnd:
                return False
            try:
                if _user32.IsIconic(hwnd):
                    _user32.ShowWindow(hwnd, 9)  # SW_RESTORE
                _user32.SetForegroundWindow(hwnd)
            except Exception:
                pass
            return True

        # ── 입력 가드: 매크로 중 사용자 물리 마우스/키보드 차단 + ESC 즉시 중단 ──
        # 저수준 훅(WH_MOUSE_LL/WH_KEYBOARD_LL)으로 '주입(SendInput)되지 않은' 물리 입력을 삼킨다.
        # 우리 매크로의 클릭/키는 INJECTED 플래그가 있어 통과. 직원이 실수로 마우스를 움직여도
        # 엉뚱한 클릭이 안 되고, ESC 는 잡아서(이지폼에 안 흘려보냄 → 폼이 안 닫힘) 중단 신호로만 쓴다.
        # Ctrl+Alt+Del 은 시스템 예약이라 항상 동작 → 영구 잠김 위험 없음. 매크로 종료 시 항상 해제.
        _WH_MOUSE_LL = 14
        _WH_KEYBOARD_LL = 13
        _WM_QUIT = 0x0012
        _LLMHF_INJECTED = 0x00000001
        _LLKHF_INJECTED = 0x00000010
        _VK_ESCAPE = 0x1B
        _LRESULT = ctypes.c_ssize_t
        _HOOKPROC = ctypes.WINFUNCTYPE(_LRESULT, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM)

        class _EF_KBDLL(ctypes.Structure):
            _fields_ = [("vkCode", wintypes.DWORD), ("scanCode", wintypes.DWORD),
                        ("flags", wintypes.DWORD), ("time", wintypes.DWORD),
                        ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]

        class _EF_MSLL(ctypes.Structure):
            _fields_ = [("pt", wintypes.POINT), ("mouseData", wintypes.DWORD),
                        ("flags", wintypes.DWORD), ("time", wintypes.DWORD),
                        ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]

        _user32.SetWindowsHookExW.argtypes = [ctypes.c_int, _HOOKPROC, wintypes.HINSTANCE, wintypes.DWORD]
        _user32.SetWindowsHookExW.restype = wintypes.HHOOK
        _user32.CallNextHookEx.argtypes = [wintypes.HHOOK, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM]
        _user32.CallNextHookEx.restype = _LRESULT
        _user32.UnhookWindowsHookEx.argtypes = [wintypes.HHOOK]
        _user32.UnhookWindowsHookEx.restype = wintypes.BOOL
        _user32.GetMessageW.argtypes = [ctypes.c_void_p, wintypes.HWND, wintypes.UINT, wintypes.UINT]
        _user32.GetMessageW.restype = ctypes.c_int
        _user32.PostThreadMessageW.argtypes = [wintypes.DWORD, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
        _user32.PostThreadMessageW.restype = wintypes.BOOL
        _kernel32.GetCurrentThreadId.restype = wintypes.DWORD
        _kernel32.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
        _kernel32.GetModuleHandleW.restype = wintypes.HMODULE

        _EF_ABORT = threading.Event()
        _EF_GUARD_TID = 0
        _ef_hook_refs: list = []  # 콜백 GC 방지(살아 있어야 훅이 유효)

        def _ef_mouse_proc(nCode, wParam, lParam):
            if nCode >= 0:
                ms = ctypes.cast(lParam, ctypes.POINTER(_EF_MSLL)).contents
                if not (ms.flags & _LLMHF_INJECTED):
                    return 1  # 사용자 물리 마우스 차단(주입된 우리 입력만 통과)
            return _user32.CallNextHookEx(None, nCode, wParam, lParam)

        def _ef_kbd_proc(nCode, wParam, lParam):
            if nCode >= 0:
                kb = ctypes.cast(lParam, ctypes.POINTER(_EF_KBDLL)).contents
                if not (kb.flags & _LLKHF_INJECTED):
                    if kb.vkCode == _VK_ESCAPE:
                        _EF_ABORT.set()  # ESC → 중단 신호
                    return 1  # 사용자 물리 키 차단(ESC 도 삼켜 이지폼 폼이 닫히지 않게)
            return _user32.CallNextHookEx(None, nCode, wParam, lParam)

        def _ef_guard_thread():
            global _EF_GUARD_TID
            _EF_GUARD_TID = _kernel32.GetCurrentThreadId()
            hInst = _kernel32.GetModuleHandleW(None)
            mp = _HOOKPROC(_ef_mouse_proc)
            kp = _HOOKPROC(_ef_kbd_proc)
            _ef_hook_refs[:] = [mp, kp]
            hM = _user32.SetWindowsHookExW(_WH_MOUSE_LL, mp, hInst, 0)
            hK = _user32.SetWindowsHookExW(_WH_KEYBOARD_LL, kp, hInst, 0)
            msg = wintypes.MSG()
            while _user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
                pass  # WM_QUIT(0) 오면 루프 종료
            if hM:
                _user32.UnhookWindowsHookEx(hM)
            if hK:
                _user32.UnhookWindowsHookEx(hK)

        def ef_guard_start() -> None:
            _EF_ABORT.clear()
            threading.Thread(target=_ef_guard_thread, daemon=True).start()
            time.sleep(0.06)  # 훅 설치 + 메시지 큐 생성 잠깐 대기

        def ef_guard_stop() -> None:
            global _EF_GUARD_TID
            if _EF_GUARD_TID:
                _user32.PostThreadMessageW(_EF_GUARD_TID, _WM_QUIT, 0, 0)
                _EF_GUARD_TID = 0

        def ef_aborted() -> bool:
            return _EF_ABORT.is_set()

        EASYFORM_AVAILABLE = True
except Exception as _ef_e:  # noqa: BLE001 — Win32 초기화 실패 시 기능만 비활성
    logging.warning("이지폼 자동기입 비활성(Win32 초기화 실패): %s", _ef_e)
    EASYFORM_AVAILABLE = False


# ── 셀 좌표 (논리 픽셀) — easyform_layout.json 의 90셀 + pick 으로 찍은 컨트롤 2개 ──
# 열 순서: month_day, item_code, item, spec, qty, unit_price, supply, tax, remark
EF_COLS = ["month_day", "item_code", "item", "spec", "qty", "unit_price", "supply", "tax", "remark"]
EF_CELLS = [
    [(27, 297), (82, 300), (200, 301), (319, 300), (374, 302), (429, 302), (500, 302), (572, 303), (643, 301)],
    [(29, 319), (83, 321), (202, 322), (319, 321), (371, 321), (428, 322), (495, 321), (566, 321), (637, 324)],
    [(27, 341), (85, 342), (208, 342), (324, 342), (375, 342), (430, 341), (493, 341), (565, 342), (644, 345)],
    [(29, 360), (84, 364), (207, 364), (321, 365), (373, 361), (427, 361), (500, 363), (577, 363), (646, 363)],
    [(27, 381), (82, 381), (197, 383), (323, 383), (372, 383), (426, 382), (494, 382), (568, 384), (643, 384)],
    [(28, 404), (88, 405), (202, 407), (326, 405), (372, 405), (430, 401), (493, 402), (567, 404), (643, 404)],
    [(26, 421), (82, 424), (211, 422), (321, 422), (375, 424), (430, 426), (494, 425), (568, 424), (638, 424)],
    [(30, 445), (87, 445), (212, 444), (326, 445), (373, 445), (428, 444), (493, 446), (566, 446), (648, 446)],
    [(28, 467), (88, 467), (207, 466), (319, 466), (378, 466), (427, 466), (501, 468), (571, 467), (644, 469)],
    [(29, 486), (86, 486), (203, 487), (323, 488), (372, 490), (431, 491), (490, 487), (567, 487), (643, 487)],
]
EF_WHITEBOX = (756, 417)   # "현재 □ 줄 선택됨" 흰 박스 — 더블클릭 후 '2' 입력
EF_INSERT_BTN = (745, 456)  # "삽입" 버튼 — 행 수만큼 클릭

# 채울 7칸: (grid 키, EF_COLS 인덱스, 숫자 여부). 월일·비고는 건드리지 않는다(월일=자동).
EF_FILL_SEQ = [
    ("item_code", 1, False), ("item", 2, False), ("spec", 3, False),
    ("qty", 4, True), ("unit_price", 5, True), ("supply", 6, True), ("tax", 7, True),
]


def _ef_num(s: str) -> str:
    """숫자 셀 값 — 콤마/공백 제거(이지폼 숫자칸이 '15,000' 붙여넣기를 거부할 수 있어 '15000' 으로)."""
    return (s or "").replace(",", "").replace(" ", "").strip()


def run_easyform_fill(rows: "list[dict]") -> "tuple[bool, str]":
    """이지폼 새로작성 그리드에 rows 를 셀 단위로 기입. (성공여부, 메시지)."""
    if not EASYFORM_AVAILABLE:
        return False, "이 PC 에서는 이지폼 자동기입을 쓸 수 없습니다(Win32 미초기화)."
    n = len(rows)
    if n == 0:
        return False, "기입할 행이 없습니다."
    cap = len(EF_CELLS)  # 10
    if n > cap:
        return False, (f"행이 {n}개로 자동기입 한도({cap}행)를 넘습니다. "
                       f"먼저 {cap}행 이하로 나눠 작성해 주세요. (현재 버전 미지원)")

    abort_msg = "ESC 로 중단했습니다. (일부만 입력됐을 수 있어요 — 이지폼에서 확인 후 저장 마세요)"
    # 입력 가드 ON — 사용자 물리 마우스/키보드 차단, ESC 누르면 ef_aborted()=True. 끝나면 항상 해제.
    ef_guard_start()
    try:
        # 0) 첫 행 품목칸 클릭 — 그리드 활성화 + 첫 행 월일 자동기입 트리거
        ef_click(*EF_CELLS[0][EF_COLS.index("item")])
        time.sleep(0.15)
        if ef_aborted():
            return False, abort_msg

        # 1) 흰 박스 더블클릭 → '2' 입력(삽입 위치=둘째 줄: 월일행이 맨 위 유지)
        ef_double_click(*EF_WHITEBOX)
        time.sleep(0.1)
        ef_key(0x32)  # '2'
        time.sleep(0.1)
        if ef_aborted():
            return False, abort_msg

        # 2) 삽입 N번 — 기존 1행 + N = N+1행(마지막 1행은 여유분)
        for _ in range(n):
            if ef_aborted():
                return False, abort_msg
            ef_click(*EF_INSERT_BTN)
            time.sleep(0.12)

        time.sleep(0.2)

        # 3) 행마다 7칸 클릭+붙여넣기 (월일은 행 진입 시 자동, 비고는 건드리지 않음)
        for r in range(n):
            for key_name, col_idx, is_num in EF_FILL_SEQ:
                if ef_aborted():
                    return False, abort_msg
                val = str(rows[r].get(key_name, "") or "")
                if is_num:
                    val = _ef_num(val)
                if val == "":
                    continue  # 빈 값은 칸을 건드리지 않음
                x, y = EF_CELLS[r][col_idx]
                ef_click(x, y)
                time.sleep(0.08)            # 셀 활성화 대기(batch.py 검증 타이밍)
                ef_set_clipboard(val)
                time.sleep(0.02)
                ef_paste()
                time.sleep(0.05)

        # 4) 마지막 셀 확정 — 여유분(다음) 행 품목칸 클릭(저장/Enter 안 함). 한도면 마지막 행 재클릭.
        commit_r = min(n, cap - 1)
        ef_click(*EF_CELLS[commit_r][EF_COLS.index("item")])
    finally:
        ef_guard_stop()  # 입력 가드 OFF — 사용자 입력 복구(항상 실행)
    return True, f"{n}개 행을 기입했습니다. 내용 확인 후 직접 저장(F5)하세요."


# ── 스테이징 + 핫키 트리거 ──────────────────────────────────────────────────
# 웹 '이지폼 입력' 버튼이 grid 를 POST 하면 여기 담아두고(arm), 사용자가 이지폼 창에서 '채우기'
# 버튼(또는 F6)을 누르면 그때 실행한다. 클릭이 정확한 창에 떨어지려면 실행 순간 이지폼이 최상위여야
# 하는데 웹 버튼 직후엔 브라우저가 최상위이기 때문.
_EF_LOCK = threading.Lock()
_EF_JOB = None                       # {"rows": [...], "armed_at": ts}
EF_JOB_TTL = 1800                    # 30분 지나면 자동 만료(새로작성·거래처 선택 여유)
EF_HOTKEY_VK = 0x75                  # F6 (이지폼 단축키 F2/F5/F8/F9/F11/F12/Esc 와 충돌 없음) — 보조 트리거
EF_HOTKEY_LABEL = "F6"
_EF_UI_QUEUE: "queue.Queue" = queue.Queue()  # HTTP 스레드 → tk UI 스레드 신호
_EF_ROW_KEYS = ("item_code", "item", "spec", "qty", "unit_price", "supply", "tax")


def ef_stage_job(rows: "list[dict]") -> None:
    global _EF_JOB
    with _EF_LOCK:
        _EF_JOB = {"rows": rows, "armed_at": time.time()}


def _ef_take_job():
    global _EF_JOB
    with _EF_LOCK:
        job = _EF_JOB
        if job is None:
            return None
        if time.time() - job["armed_at"] > EF_JOB_TTL:
            _EF_JOB = None
            return None
        _EF_JOB = None
        return job


def _ef_hotkey_watcher() -> None:
    """핫키(F6, 보조) 폴링 — 눌리는 순간(엣지) + 스테이징된 작업이 있으면 UI 트리거만 보낸다.
    실제 확인창·딤 오버레이·실행은 '채우기' 버튼과 동일하게 install 의 on_fill 이 처리(중복 제거)."""
    was_down = False
    while True:
        time.sleep(0.03)
        down = bool(_user32.GetAsyncKeyState(EF_HOTKEY_VK) & 0x8000)
        edge = down and not was_down
        was_down = down
        if not edge:
            continue
        with _EF_LOCK:
            has_job = _EF_JOB is not None
        if not has_job:
            continue  # 무장 안 된 상태의 핫키는 무시(오발사 방지)
        try:
            _EF_UI_QUEUE.put(("trigger",))
        except Exception:
            pass


# ── HTTP (워처 _PingHandler 가 호출) ─────────────────────────────────────────
def handle_probe() -> dict:
    """GET /easyform/probe — 이 PC 가 자동기입 가능한지 + 핫키 라벨."""
    return {"ok": True, "easyform": EASYFORM_AVAILABLE, "hotkey": EF_HOTKEY_LABEL}


def handle_fill(body: dict) -> "tuple[int, dict]":
    """POST /easyform/fill — grid(rows) 를 받아 스테이징(arm)하고 '채우기' 버튼창을 띄운다.
    실제 기입은 사용자가 그 버튼(또는 F6)을 눌렀을 때. (status_code, payload) 반환."""
    if not EASYFORM_AVAILABLE:
        return 200, {"staged": False, "message": "이 PC 에서는 이지폼 자동기입을 쓸 수 없습니다."}
    rows_in = body.get("rows") if isinstance(body, dict) else None
    if not isinstance(rows_in, list) or not rows_in:
        return 400, {"staged": False, "message": "rows 가 비어 있습니다."}
    rows = []
    for r in rows_in:
        if isinstance(r, dict):
            rows.append({k: ("" if r.get(k) is None else str(r.get(k))) for k in _EF_ROW_KEYS})
    if not rows:
        return 400, {"staged": False, "message": "유효한 행이 없습니다."}
    cap = len(EF_CELLS)
    if len(rows) > cap:
        return 200, {"staged": False, "message": f"행이 {len(rows)}개로 한도({cap}행)를 넘어 보낼 수 없습니다."}
    ef_stage_job(rows)
    try:
        _EF_UI_QUEUE.put(("show", len(rows)))
    except Exception:
        pass
    logging.info("이지폼 자동기입 스테이징 — %d행, '채우기' 버튼/%s 대기", len(rows), EF_HOTKEY_LABEL)
    return 200, {
        "staged": True, "count": len(rows), "hotkey": EF_HOTKEY_LABEL,
        "message": f"이지폼 새로작성 → 거래처 선택 후 '이지폼 자동기입 시작하기' 버튼(또는 {EF_HOTKEY_LABEL})을 누르면 {len(rows)}행이 자동 입력됩니다.",
    }


# ── GUI 설치 (워처 tk root 에 붙임) ──────────────────────────────────────────
def install(root) -> None:
    """워처의 tkinter root 에 이지폼 '채우기' UI 를 붙인다(별도 mainloop 없음). F6 워처도 시작.
      ① 코너 '채우기' 버튼창(win, Toplevel) — 웹이 grid 를 보내면 표시.
      ② 풀스크린 딤 + 중앙 패널 — 매크로 중 화면을 살짝 어둡게 + 🔒 잠금/ESC 안내, 완료 시 [확인]."""
    if not EASYFORM_AVAILABLE:
        logging.info("이지폼 자동기입: 비활성(이 PC 는 Win32 미초기화 — 기능 숨김)")
        return
    import tkinter as tk

    s = EF_DPI_SCALE
    sw, sh = root.winfo_screenwidth(), root.winfo_screenheight()

    win = tk.Toplevel(root)
    win.title("HD사인 이지폼 자동기입")
    win.attributes("-topmost", True)
    win.resizable(False, False)
    w, h = int(370 * s), int(195 * s)
    win.geometry(f"{w}x{h}+{max(0, sw - w - int(28 * s))}+{max(0, sh - h - int(72 * s))}")

    frame = tk.Frame(win, bg="#ffffff", padx=int(14 * s), pady=int(12 * s))
    frame.pack(fill="both", expand=True)
    tk.Label(frame, text="이지폼 자동기입", font=("맑은 고딕", int(12 * s), "bold"),
             fg="#0a3d4a", bg="#ffffff").pack(anchor="w")
    info_lbl = tk.Label(frame, text="", font=("맑은 고딕", int(10 * s)), fg="#333333",
                        bg="#ffffff", justify="left", wraplength=w - int(42 * s))
    info_lbl.pack(anchor="w", pady=(int(6 * s), int(10 * s)))
    btn = tk.Button(frame, text="이지폼 자동기입 시작하기 ▶", font=("맑은 고딕", int(13 * s), "bold"),
                    bg="#0a9396", fg="white", activebackground="#097a7d", activeforeground="white",
                    relief="flat", padx=int(14 * s), pady=int(8 * s), cursor="hand2")
    btn.pack(fill="x")

    # ── 풀스크린 딤(반투명 검정) ──
    dim = tk.Toplevel(root)
    dim.overrideredirect(True)
    dim.geometry(f"{sw}x{sh}+0+0")
    dim.configure(bg="#000000")
    dim.attributes("-alpha", 0.45)
    dim.attributes("-topmost", True)
    dim.withdraw()

    # ── 중앙 패널(불투명 카드) — 실행 안내 / 완료 두 화면 ──
    panel = tk.Toplevel(root)
    panel.overrideredirect(True)
    panel.configure(bg="#1f2937")
    pw, ph = int(560 * s), int(220 * s)
    panel.geometry(f"{pw}x{ph}+{(sw - pw) // 2}+{(sh - ph) // 2}")
    panel.attributes("-topmost", True)
    panel.attributes("-alpha", 0.97)  # 살짝만 투명 → WS_EX_LAYERED 적용(클릭통과 전제), 보기엔 불투명

    run_frame = tk.Frame(panel, bg="#1f2937")
    tk.Label(run_frame, text="🔒", font=("Segoe UI Emoji", int(34 * s)),
             fg="#fbbf24", bg="#1f2937").pack(pady=(int(20 * s), int(4 * s)))
    tk.Label(run_frame, text="자동입력 중에는 마우스가 잠깁니다.", font=("맑은 고딕", int(14 * s), "bold"),
             fg="#ffffff", bg="#1f2937").pack()
    tk.Label(run_frame, text="중단하시려면 ESC 를 눌러주세요.", font=("맑은 고딕", int(12 * s)),
             fg="#fca5a5", bg="#1f2937").pack(pady=(int(6 * s), 0))

    done_frame = tk.Frame(panel, bg="#1f2937")
    done_lbl = tk.Label(done_frame, text="", font=("맑은 고딕", int(15 * s), "bold"),
                        fg="#ffffff", bg="#1f2937", justify="center", wraplength=pw - int(60 * s))
    done_lbl.pack(pady=(int(26 * s), int(14 * s)))
    done_btn = tk.Button(done_frame, text="확인", font=("맑은 고딕", int(13 * s), "bold"),
                         bg="#0a9396", fg="white", activebackground="#097a7d", activeforeground="white",
                         relief="flat", padx=int(26 * s), pady=int(7 * s), cursor="hand2")
    done_btn.pack()
    panel.withdraw()

    def _set_exstyle(w_, add=0, remove=0):
        try:
            w_.update_idletasks()
            hwnd = w_.winfo_id()
            u = ctypes.windll.user32
            GWL_EXSTYLE = -20
            cur = u.GetWindowLongW(hwnd, GWL_EXSTYLE)
            u.SetWindowLongW(hwnd, GWL_EXSTYLE, (cur | add) & ~remove)
        except Exception:
            pass

    _WS_EX_NOACTIVATE = 0x08000000
    _WS_EX_TOPMOST = 0x00000008
    _WS_EX_TOOLWINDOW = 0x00000080
    _WS_EX_TRANSPARENT = 0x00000020  # 마우스 클릭 통과(밑의 이지폼으로 전달) — LAYERED 와 함께.
    busy = {"v": False}

    def show_overlay():
        run_frame.pack(fill="both", expand=True)
        done_frame.pack_forget()
        dim.deiconify()
        panel.deiconify()
        # NOACTIVATE(포커스 안 뺏음) + TRANSPARENT(클릭 통과 → 매크로 클릭이 이지폼 셀에 떨어지게).
        over = _WS_EX_NOACTIVATE | _WS_EX_TOPMOST | _WS_EX_TOOLWINDOW | _WS_EX_TRANSPARENT
        _set_exstyle(dim, add=over)
        _set_exstyle(panel, add=over)
        dim.lift()
        panel.lift()

    def show_done(ok, msg):
        run_frame.pack_forget()
        done_lbl.config(text=("✅ 자동작성이 완료되었습니다." if ok else "⏹ 중단되었습니다.") +
                        ("" if ok else f"\n{msg}"),
                        fg="#ffffff" if ok else "#fca5a5")
        done_frame.pack(fill="both", expand=True)
        # 완료 화면은 [확인] 클릭을 받아야 하니 클릭통과·비활성 해제.
        _set_exstyle(panel, remove=_WS_EX_NOACTIVATE | _WS_EX_TRANSPARENT)
        panel.lift()
        panel.attributes("-topmost", True)

    def hide_overlay():
        panel.withdraw()
        dim.withdraw()
        busy["v"] = False

    def set_staged(count):
        busy["v"] = False
        info_lbl.config(
            text="이지폼 [새로작성 → 거래처 선택] 후\n아래 버튼을 누르면 해당 명세서가 자동입력됩니다.",
            fg="#333333")
        btn.config(text="이지폼 자동기입 시작하기 ▶", state="normal", bg="#0a9396")
        win.deiconify()
        win.lift()
        win.attributes("-topmost", True)

    def on_fill():
        if busy["v"]:
            return
        if not ef_confirm("자동작성을 시작하시겠습니까?\n\n시작하면 입력이 끝날 때까지 마우스가 잠깁니다.\n(중단하려면 ESC)"):
            return
        if not ef_focus_easyform():
            ef_messagebox("이지폼 '매출 거래명세서' 창을 먼저 띄우세요(새로작성 → 거래처 선택).",
                          "이지폼 자동기입")
            return
        job = _ef_take_job()
        if job is None:
            ef_messagebox("대기 중인 작업이 없습니다(만료). 홈페이지에서 다시 [이지폼 입력] 을 누르세요.",
                          "이지폼 자동기입")
            win.withdraw()
            return
        busy["v"] = True
        win.withdraw()        # 코너 버튼창 숨김
        show_overlay()        # 딤 + 잠금 안내
        ef_focus_easyform()   # 이지폼 다시 최상위(키 주입이 이지폼으로 가게)

        def worker():
            time.sleep(0.4)
            try:
                ok, msg = run_easyform_fill(job["rows"])
            except Exception as e:  # noqa: BLE001
                ok, msg = False, f"오류: {e}"
                logging.exception("이지폼 자동기입 오류(UI)")
            _EF_UI_QUEUE.put(("result", ok, msg))

        threading.Thread(target=worker, daemon=True).start()

    btn.config(command=on_fill)
    done_btn.config(command=hide_overlay)
    win.protocol("WM_DELETE_WINDOW", win.withdraw)  # X = 숨김(종료 아님)
    win.withdraw()

    def poll():
        try:
            while True:
                cmd = _EF_UI_QUEUE.get_nowait()
                if cmd[0] == "show":
                    set_staged(cmd[1])
                elif cmd[0] == "trigger":   # F6 보조 트리거 → 버튼과 동일 흐름
                    on_fill()
                elif cmd[0] == "result":
                    ok, msg = cmd[1], cmd[2]
                    show_done(ok, msg)
                    logging.info("이지폼 자동기입(UI) %s — %s", "성공" if ok else "실패/중단", msg)
        except queue.Empty:
            pass
        root.after(120, poll)

    root.after(120, poll)
    threading.Thread(target=_ef_hotkey_watcher, daemon=True).start()
    logging.info("이지폼 '채우기' UI 준비됨(평소 숨김, 스테이징 시 표시). DPI %.2fx", EF_DPI_SCALE)
