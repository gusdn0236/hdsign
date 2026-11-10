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
        # 작성 직전 폼을 기준 위치로 옮긴 뒤 격자 기준 잔차를 담는 평행이동값(가상좌표).
        # ef_click/ef_right_click 이 모든 클릭에 가산 → 창을 옮겨도 같은 칸을 누른다. fill 끝나면 0 으로.
        _EF_OFFSET = [0, 0]

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
        _MOUSEEVENTF_RIGHTDOWN = 0x0008
        _MOUSEEVENTF_RIGHTUP = 0x0010
        _MOUSEEVENTF_MOVE = 0x0001
        _MOUSEEVENTF_ABSOLUTE = 0x8000
        _MOUSEEVENTF_WHEEL = 0x0800

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
            px = int((x + _EF_OFFSET[0]) * EF_DPI_SCALE)
            py = int((y + _EF_OFFSET[1]) * EF_DPI_SCALE)
            nx = int(px * 65535 / max(1, EF_SCREEN_W - 1))
            ny = int(py * 65535 / max(1, EF_SCREEN_H - 1))
            mv = _EF_MI(nx, ny, 0, _MOUSEEVENTF_MOVE | _MOUSEEVENTF_ABSOLUTE, 0, None)
            _ef_send([_EF_IN(_INPUT_MOUSE, _EF_U(mi=mv))])
            time.sleep(0.012)
            d = _EF_MI(nx, ny, 0, _MOUSEEVENTF_LEFTDOWN | _MOUSEEVENTF_ABSOLUTE, 0, None)
            u = _EF_MI(nx, ny, 0, _MOUSEEVENTF_LEFTUP | _MOUSEEVENTF_ABSOLUTE, 0, None)
            _ef_send([_EF_IN(_INPUT_MOUSE, _EF_U(mi=d)), _EF_IN(_INPUT_MOUSE, _EF_U(mi=u))])

        def ef_double_click(x: int, y: int) -> None:
            ef_click(x, y)
            time.sleep(0.03)
            ef_click(x, y)

        def ef_right_click(x: int, y: int) -> None:
            # 절대좌표 주입 우클릭(컨텍스트 메뉴 열기). 이지폼이 Ctrl+V 를 막아 '붙여넣기' 메뉴로 대체.
            px = int((x + _EF_OFFSET[0]) * EF_DPI_SCALE)
            py = int((y + _EF_OFFSET[1]) * EF_DPI_SCALE)
            nx = int(px * 65535 / max(1, EF_SCREEN_W - 1))
            ny = int(py * 65535 / max(1, EF_SCREEN_H - 1))
            mv = _EF_MI(nx, ny, 0, _MOUSEEVENTF_MOVE | _MOUSEEVENTF_ABSOLUTE, 0, None)
            _ef_send([_EF_IN(_INPUT_MOUSE, _EF_U(mi=mv))])
            time.sleep(0.012)
            d = _EF_MI(nx, ny, 0, _MOUSEEVENTF_RIGHTDOWN | _MOUSEEVENTF_ABSOLUTE, 0, None)
            u = _EF_MI(nx, ny, 0, _MOUSEEVENTF_RIGHTUP | _MOUSEEVENTF_ABSOLUTE, 0, None)
            _ef_send([_EF_IN(_INPUT_MOUSE, _EF_U(mi=d)), _EF_IN(_INPUT_MOUSE, _EF_U(mi=u))])

        # (행 초과 스크롤은 휠 대신 '비고 칸 클릭 → Enter = 1행 이동'(easyform 그리드 동작)을 쓴다.
        #  휠 1노치는 기본 3줄이라 여러 행을 내려 버렸음 — 사용자 제공 방법이 정확.)

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
        _user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        _user32.GetClassNameW.restype = ctypes.c_int
        _user32.EnumChildWindows.argtypes = [wintypes.HWND, _EF_WNDENUMPROC, wintypes.LPARAM]
        _user32.EnumChildWindows.restype = wintypes.BOOL
        _user32.GetParent.argtypes = [wintypes.HWND]
        _user32.GetParent.restype = wintypes.HWND
        _user32.ScreenToClient.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.POINT)]
        _user32.ScreenToClient.restype = wintypes.BOOL
        _user32.MoveWindow.argtypes = [wintypes.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.BOOL]
        _user32.MoveWindow.restype = wintypes.BOOL
        _user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
        _user32.GetWindowRect.restype = wintypes.BOOL
        _user32.BringWindowToTop.argtypes = [wintypes.HWND]
        _user32.BringWindowToTop.restype = wintypes.BOOL

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

        # ── 클래스 기반 정확 추적 ── 입력폼 = 'TfrmExchange' (목록창 'TfrmListExchange'·보고서와 안 헷갈림).
        #   입력폼은 메인 앱(TfrmBookMain) 안의 MDI 자식이라 EnumWindows(최상위)로는 못 찾음 → 자식까지 탐색.
        EF_FORM_HOME = (2, 45)   # 작성 직전 폼을 끌어다 놓을 화면 위치(가상좌표). 항상 화면 안 + EF_CELLS 유효.
        EF_GRID_REF = (8, 267)   # 보정 시점 격자(TAdvStringGrid) 좌상단(가상좌표). 이동 후 잔차 보정 기준.

        def _ef_classname(hwnd) -> str:
            b = ctypes.create_unicode_buffer(256)
            _user32.GetClassNameW(hwnd, b, 256)
            return b.value or ""

        def _ef_find_toplevel_class(klass):
            out: list = []

            def _cb(hwnd, _):
                if _ef_classname(hwnd) == klass:
                    out.append(hwnd)
                return True

            _user32.EnumWindows(_EF_WNDENUMPROC(_cb), 0)
            return out[0] if out else None

        def _ef_find_child_class(parent, klass):
            out: list = []

            def _cb(hwnd, _):
                if _ef_classname(hwnd) == klass:
                    out.append(hwnd)
                return True

            _user32.EnumChildWindows(parent, _EF_WNDENUMPROC(_cb), 0)
            return out[0] if out else None

        def _ef_find_main_form():
            # 이지폼이 여러 개(사업자별) 떠 있을 수 있다 → 거래명세서 폼(TfrmExchange)이 열린 쪽을 고른다.
            # 둘 다 열려 있으면 가장 최근에 앞에 있던(Z순서 위) 창 — EnumWindows 는 위→아래 순.
            mains: list = []

            def _cb(hwnd, _):
                if _ef_classname(hwnd) == "TfrmBookMain" and _user32.IsWindowVisible(hwnd):
                    mains.append(hwnd)
                return True

            _user32.EnumWindows(_EF_WNDENUMPROC(_cb), 0)
            if not mains:
                return None, None
            for m in mains:
                form = _ef_find_child_class(m, "TfrmExchange")
                if form and _user32.IsWindowVisible(form):
                    return m, form
            return mains[0], None

        def _ef_topleft(hwnd):
            r = wintypes.RECT()
            _user32.GetWindowRect(hwnd, ctypes.byref(r))
            return r.left, r.top

        def _ef_move_to_screen(hwnd, sx: int, sy: int) -> None:
            # 자식창(MDI) 은 부모 클라이언트 좌표로 이동해야 한다 → 화면좌표를 ScreenToClient 로 변환.
            r = wintypes.RECT()
            _user32.GetWindowRect(hwnd, ctypes.byref(r))
            w, h = r.right - r.left, r.bottom - r.top
            parent = _user32.GetParent(hwnd)
            pt = wintypes.POINT(sx, sy)
            if parent:
                _user32.ScreenToClient(parent, ctypes.byref(pt))
            _user32.MoveWindow(hwnd, pt.x, pt.y, w, h, True)

        def ef_focus_easyform() -> bool:
            """입력폼(TfrmExchange)을 찾아 최상위로. 폼이 없으면 False(호출부가 '폼 띄우세요' 안내)."""
            main, form = _ef_find_main_form()
            if not form:
                return False
            try:
                if _user32.IsIconic(main):
                    _user32.ShowWindow(main, 9)  # SW_RESTORE
                _user32.SetForegroundWindow(main)
                _user32.BringWindowToTop(form)
                _user32.SetForegroundWindow(main)
            except Exception:
                pass
            return True

        def ef_dock_and_offset() -> bool:
            """작성 직전: 입력폼을 앞으로 + 항상 기준 위치로 이동 + 격자 기준 잔차를 _EF_OFFSET 에 설정.
            창을 어디로 옮기든/가장자리로 밀든 같은 칸에 입력되게 하고 off-screen 을 원천 차단한다."""
            main, form = _ef_find_main_form()
            if not form:
                return False
            try:
                if _user32.IsIconic(main):
                    _user32.ShowWindow(main, 9)
                _user32.SetForegroundWindow(main)
                _user32.BringWindowToTop(form)
                _user32.SetForegroundWindow(main)
                _ef_move_to_screen(form, EF_FORM_HOME[0], EF_FORM_HOME[1])
                time.sleep(0.28)  # 창 이동·포커스 안정화 대기(첫 클릭/키 씹힘 방지)
                _user32.SetForegroundWindow(main)  # 이동 후 포커스 재확정
                grid = _ef_find_child_class(form, "TAdvStringGrid")
                if grid:
                    gl, gt = _ef_topleft(grid)
                    _EF_OFFSET[0] = gl - EF_GRID_REF[0]
                    _EF_OFFSET[1] = gt - EF_GRID_REF[1]
                else:
                    _EF_OFFSET[0] = 0
                    _EF_OFFSET[1] = 0
            except Exception:
                logging.exception("이지폼 폼 이동/보정 실패")
                _EF_OFFSET[0] = 0
                _EF_OFFSET[1] = 0
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

# 이지폼이 Ctrl+V 를 막아, 셀 채우기는 [좌클릭 → 우클릭 → '붙여넣기' 메뉴 클릭] 으로 한다.
# 우클릭 지점(=셀 좌표)에서 컨텍스트 메뉴 '붙여넣기' 항목까지의 논리좌표 오프셋(dx, dy).
# F7 측정값: 우클릭점(207,301) → 붙여넣기(263,391) ⇒ (56, 90). (0,0)이면 Ctrl+V 폴백.
EF_PASTE_OFFSET = (56, 90)

# 채울 칸: (grid 키, EF_COLS 인덱스, 숫자 여부). 월일=자동. 비고=홈페이지 주문번호(첫 줄만, 웹이 보냄)
# — 나중에 이지폼→홈페이지 동기화 때 이 번호로 주문을 찾는다. 빈 값이면 칸을 안 건드린다.
EF_FILL_SEQ = [
    ("item_code", 1, False), ("item", 2, False), ("spec", 3, False),
    ("qty", 4, True), ("unit_price", 5, True), ("supply", 6, True), ("tax", 7, True),
    ("remark", 8, False),
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
    cap = len(EF_CELLS)  # 보이는 행 수(좌표 매핑 10행). 넘으면 한 행씩 스크롤하며 채운다.

    abort_msg = "ESC 로 중단했습니다. (일부만 입력됐을 수 있어요 — 이지폼에서 확인 후 저장 마세요)"
    # 입력 가드 ON — 사용자 물리 마우스/키보드 차단, ESC 누르면 ef_aborted()=True. 끝나면 항상 해제.
    ef_guard_start()
    try:
        # ★ 작성 직전: 입력폼(TfrmExchange)을 클래스로 찾아 항상 기준 위치로 이동 + 격자기준 잔차 보정.
        #   사용자가 창을 옮기거나 가장자리로 밀어도 정확히 같은 칸에 입력되고, off-screen 을 차단한다.
        if not ef_dock_and_offset():
            return False, "이지폼 '매출 거래명세서' 새로작성 창을 못 찾았습니다(먼저 띄우세요)."
        time.sleep(0.15)  # 입력 시작 전 추가 안정화

        # 0) 첫 행 품목칸 클릭 — 그리드 활성화 + 첫 행 월일 자동기입 트리거
        ef_click(*EF_CELLS[0][EF_COLS.index("item")])
        time.sleep(0.06)
        if ef_aborted():
            return False, abort_msg

        # 1) 흰 박스 더블클릭 → '2' 입력(삽입 위치=둘째 줄: 월일행이 맨 위 유지)
        ef_double_click(*EF_WHITEBOX)
        time.sleep(0.05)
        ef_key(0x32)  # '2'
        time.sleep(0.05)
        if ef_aborted():
            return False, abort_msg

        # 2) 삽입 N번 — 기존 1행 + N = N+1행(마지막 1행은 여유분)
        for _ in range(n):
            if ef_aborted():
                return False, abort_msg
            ef_click(*EF_INSERT_BTN)
            time.sleep(0.06)

        time.sleep(0.1)

        # 3) 행마다 7칸 클릭+붙여넣기 (월일은 행 진입 시 자동, 비고는 건드리지 않음).
        #    보이는 cap 행은 그 좌표에, cap 을 넘는 행은 '마지막 보이는 행의 비고 칸 클릭 → Enter'
        #    로 한 행 내린 뒤(easyform 그리드 동작) 그 마지막 위치(EF_CELLS[cap-1])에 채운다.
        remark_xy = EF_CELLS[cap - 1][EF_COLS.index("remark")]
        last_row_cells = EF_CELLS[cap - 1]
        for r in range(n):
            if ef_aborted():
                return False, abort_msg
            if r < cap:
                cells = EF_CELLS[r]
            else:
                # 한 행 스크롤: 비고 칸 클릭 → Enter(행 이동, 저장 아님) → 다음 행이 마지막 위치에.
                ef_click(*remark_xy)
                time.sleep(0.05)
                ef_key(0x0D)  # VK_RETURN
                time.sleep(0.14)
                cells = last_row_cells
            for key_name, col_idx, is_num in EF_FILL_SEQ:
                if ef_aborted():
                    return False, abort_msg
                val = str(rows[r].get(key_name, "") or "")
                if is_num:
                    val = _ef_num(val)
                if val == "":
                    continue  # 빈 값은 칸을 건드리지 않음
                x, y = cells[col_idx]
                ef_set_clipboard(val)
                time.sleep(0.01)
                if EF_PASTE_OFFSET == (0, 0):
                    # 오프셋 미설정 — Ctrl+V 폴백(이지폼이 막았으면 셀이 빈 채로 남음).
                    ef_click(x, y)
                    time.sleep(0.04)
                    ef_paste()
                    time.sleep(0.03)
                else:
                    # 이지폼이 Ctrl+V 차단 → 좌클릭(셀 선택) → 우클릭(메뉴) → '붙여넣기' 클릭.
                    ef_click(x, y)
                    time.sleep(0.035)
                    ef_right_click(x, y)
                    time.sleep(0.1)  # 컨텍스트 메뉴 뜨는 대기
                    ef_click(x + EF_PASTE_OFFSET[0], y + EF_PASTE_OFFSET[1])  # '붙여넣기' 항목
                    time.sleep(0.04)

        # 4) 마지막 셀 확정 — 저장/Enter 안 함. cap 이하면 여유분(다음) 행, 넘으면 마지막 보이는 행 재클릭.
        commit_cells = EF_CELLS[min(n, cap - 1)] if n <= cap else last_row_cells
        ef_click(*commit_cells[EF_COLS.index("item")])
    finally:
        _EF_OFFSET[0] = 0   # 평행이동 보정값 원복(다른 클릭에 영향 없게)
        _EF_OFFSET[1] = 0
        ef_guard_stop()  # 입력 가드 OFF — 사용자 입력 복구(항상 실행)
    return True, f"{n}개 행을 기입했습니다. 내용 확인 후 직접 저장(F5)하세요."


# ── 이지폼 → 홈페이지 (가져오기) ────────────────────────────────────────────
# 이지폼에 열어둔 상세명세서 1건의 표를 읽어 웹 명세서로 보낸다. 방식은 검증된 easyform_fast.py 와
# 동일: 셀 좌클릭 → 우클릭 → 컨텍스트 메뉴 '복사' 클릭 → 클립보드 읽기. **Ctrl+C 절대 금지** —
# 전자명세서는 Ctrl 을 누르면 '수정불가' 팝업이 떠 셀을 오염시킨다. 읽기 전용(입력·저장 안 함).
# 읽는 칸 = 품목코드·품목·규격·수량·단가 5개 + 비고(홈페이지 주문번호 찾기용). 월일·공급가액·세액은 안 읽음.
EF_PULL_COLS = ("item_code", "item", "spec", "qty", "unit_price", "remark")
EF_COPY_OFFSET = (41, 68)   # 우클릭점 → 메뉴 '복사' 항목(논리좌표). easyform_fast COPY_DX/DY.
EF_MENU_SAFE = (325, 214)   # 빈 칸(복사 비활성)일 때 메뉴를 닫으려고 누르는 폼 위 빈 자리.
_EF_SENT = "__HDSIGN_SENT__"


def _ef_menu_open() -> bool:
    return bool(_user32.FindWindowW("#32768", None))


def _ef_get_clipboard() -> str:
    if not _ef_open_clipboard():
        return ""
    try:
        _user32.GetClipboardData.argtypes = [wintypes.UINT]
        _user32.GetClipboardData.restype = wintypes.HANDLE
        h = _user32.GetClipboardData(_CF_UNICODETEXT)
        if not h:
            return ""
        p = _kernel32.GlobalLock(h)
        if not p:
            return ""
        try:
            return ctypes.wstring_at(p)
        finally:
            _kernel32.GlobalUnlock(h)
    finally:
        _user32.CloseClipboard()


def _ef_menu_copy_enabled():
    """떠 있는 우클릭 메뉴의 '복사' 항목이 켜져 있나 → True/False, 못 읽으면 None.
    빈 칸이면 '복사'가 회색(MF_GRAYED) — 시간으로 짐작하지 않고 메뉴 상태를 직접 본다
    (예전엔 0.05초 안에 클립보드가 안 바뀌면 빈칸으로 봐서, 이지폼이 느리면 '1'을 ''로 읽었음)."""
    mw = _user32.FindWindowW("#32768", None)
    if not mw:
        return None
    try:
        hm = ctypes.c_void_p(_user32.SendMessageW(mw, 0x01E1, 0, 0))  # MN_GETHMENU
        if not hm.value:
            return None
        n = _user32.GetMenuItemCount(hm)
        for i in range(max(0, n)):
            b = ctypes.create_unicode_buffer(128)
            _user32.GetMenuStringW(hm, i, b, 128, 0x400)  # MF_BYPOSITION
            if b.value.startswith("복사"):
                return not (_user32.GetMenuState(hm, i, 0x400) & 0x3)  # MF_GRAYED|MF_DISABLED
    except Exception:
        return None
    return None


def _ef_inplace_text(x: int, y: int, timeout: float = 0.3):
    """셀을 좌클릭하면 이지폼이 그 칸 위에 편집칸(TAdvInplaceEdit)을 띄운다 → 그 글자를 바로 읽는다
    (WM_GETTEXT, 클립보드·우클릭 메뉴 없음 → 빠르고 정확, '붙여넣기'·'삭제' 메뉴를 누를 일도 없음).
    편집칸이 **클릭한 칸 위에** 떠야만 인정(이전 칸 편집칸 글자를 잘못 읽지 않게). 못 찾으면 None."""
    form = _ef_find_main_form()[1]
    grid = _ef_find_child_class(form, "TAdvStringGrid") if form else None
    if not grid:
        return None
    px, py = x + _EF_OFFSET[0], y + _EF_OFFSET[1]
    ef_click(x, y)
    t = time.time()
    while time.time() - t < timeout:
        for h in _ef_children(grid, "TAdvInplaceEdit"):
            l, tp, r, b = _ef_rect(h)
            if l - 2 <= px <= r + 2 and tp - 2 <= py <= b + 2:
                return " ".join(_ef_wtext(h).replace("\t", " ").split())
        time.sleep(0.01)
    return None


_EF_INPLACE_OK = [False]  # 지금 읽는 명세서에서 편집칸 읽기가 한 번이라도 됐나(읽기 시작마다 초기화)


def _ef_copy_cell(x: int, y: int):
    """한 칸 읽기 → 글자 / ''(빈칸) / None(표 끝 또는 창 없음).
    1순위 편집칸 글자 직접 읽기, 안 되면(표 밖 등) 예전 우클릭 '복사' 방식.
    이 명세서에서 편집칸이 이미 잘 뜨고 있었다면, 안 뜨는 칸 = 표 끝(마지막 줄 아래)으로 보고 짧게 한 번만
    다시 확인한 뒤 끝낸다 — 예전엔 여기서 우클릭 메뉴까지 기다려(≈0.9초) 다 읽고도 ESC 가 늦었다."""
    v = _ef_inplace_text(x, y, timeout=0.15 if _EF_INPLACE_OK[0] else 0.3)
    if v is not None:
        _EF_INPLACE_OK[0] = True
        return v
    if _EF_INPLACE_OK[0]:
        v = _ef_inplace_text(x, y, timeout=0.12)  # 한 번 더(느린 순간 대비)
        return v  # 그래도 없으면 None = 표 끝
    return _ef_copy_cell_menu(x, y)


def _ef_copy_cell_menu(x: int, y: int):
    """(예전 방식) 우클릭 메뉴 '복사' 로 한 칸 읽기 → 글자 / '' / None(메뉴 안 뜸 = 표 끝)."""
    ef_set_clipboard(_EF_SENT)
    ef_click(x, y)
    ef_right_click(x, y)
    t = time.time()
    while not _ef_menu_open():
        if time.time() - t > 0.6:
            return None
        time.sleep(0.004)
    time.sleep(0.01)
    enabled = _ef_menu_copy_enabled()
    if enabled is False:
        ef_click(*EF_MENU_SAFE)  # 빈 칸 — '복사' 회색. 메뉴만 닫는다.
        return ""
    ef_click(x + EF_COPY_OFFSET[0], y + EF_COPY_OFFSET[1])
    t = time.time()
    v = _EF_SENT
    # '복사'가 켜져 있으면 글자가 반드시 오므로 넉넉히 기다린다(상태를 못 읽었으면 예전처럼 짧게).
    limit = 0.8 if enabled else 0.35
    while time.time() - t < limit:
        cur = _ef_get_clipboard()
        if cur != _EF_SENT:
            v = cur
            break
        if enabled is None and time.time() - t > 0.05 and _ef_menu_open():
            break  # (상태 못 읽은 경우만) '복사'가 비활성 — 메뉴가 안 닫힘
        time.sleep(0.004)
    if _ef_menu_open():
        ef_click(*EF_MENU_SAFE)
    return "" if v == _EF_SENT else " ".join(v.replace("\t", " ").split())


def _ef_read_row(cells):
    """한 줄 5칸 → (dict, ok). 첫 칸에서 메뉴가 안 뜨면 ok=False(표 끝)."""
    out = {}
    for i, key_name in enumerate(EF_PULL_COLS):
        x, y = cells[EF_COLS.index(key_name)]
        v = _ef_copy_cell(x, y)
        if v is None:
            if i == 0:
                return out, False
            v = ""
        out[key_name] = v
    return out, True


_EF_LAST_HEADER = ["", ""]  # 직접가져오기로 읽은 명세서의 (발행일, 합계)


def run_easyform_extract() -> "tuple[bool, str, list]":
    """이지폼에 열린 상세명세서 표를 읽는다. (성공여부, 메시지, rows)."""
    if not EASYFORM_AVAILABLE:
        return False, "이 PC 에서는 이지폼 가져오기를 쓸 수 없습니다.", []
    abort_msg = "ESC 로 중단했습니다. 홈페이지엔 아무것도 넣지 않았어요."
    ef_guard_start()
    try:
        if not ef_dock_and_offset():
            return False, "이지폼에서 옮길 상세명세서 창을 못 찾았습니다(먼저 열어두세요).", []
        time.sleep(0.15)
        # 발행일·합계(클릭 없이 글자 읽기) — 같은 이지폼 명세서가 다른 주문에 이미 있나 확인용.
        try:
            _form = _ef_find_main_form()[1]
            _EF_LAST_HEADER[0], _EF_LAST_HEADER[1] = _ef_form_header(_form) if _form else ("", "")
        except Exception:
            _EF_LAST_HEADER[0] = _EF_LAST_HEADER[1] = ""
        rows = _ef_read_open_form()
    finally:
        _EF_OFFSET[0] = 0
        _EF_OFFSET[1] = 0
        ef_guard_stop()
        try:
            ef_set_clipboard("")
        except Exception:
            pass
    if rows is None:
        return False, abort_msg, []
    if not rows:
        return False, "읽은 줄이 없습니다. 상세명세서가 열려 있는지 확인하세요.", []
    return True, f"{len(rows)}줄을 가져왔습니다.", rows


_WM_VSCROLL, _SB_LINEDOWN, _SB_TOP = 0x0115, 1, 6
_EF_STUCK = 4  # 같은 줄이 이만큼 더 반복되면(스크롤이 안 내려감) 표 끝 — 안전장치

if EASYFORM_AVAILABLE:
    _user32.SendMessageW.restype = ctypes.c_ssize_t
    _user32.GetMenuItemCount.argtypes = [ctypes.c_void_p]
    _user32.GetMenuStringW.argtypes = [ctypes.c_void_p, wintypes.UINT, wintypes.LPWSTR, ctypes.c_int, wintypes.UINT]
    _user32.GetMenuState.argtypes = [ctypes.c_void_p, wintypes.UINT, wintypes.UINT]

    class _EF_SCROLLINFO(ctypes.Structure):
        _fields_ = [("cbSize", wintypes.UINT), ("fMask", wintypes.UINT), ("nMin", ctypes.c_int),
                    ("nMax", ctypes.c_int), ("nPage", wintypes.UINT), ("nPos", ctypes.c_int),
                    ("nTrackPos", ctypes.c_int)]


def _ef_vpos(grid):
    """표 세로 스크롤 위치 (pos, max) — 이지폼 표는 0~127 비율값. 맨 아래면 pos==max. 못 읽으면 None."""
    try:
        si = _EF_SCROLLINFO()
        si.cbSize = ctypes.sizeof(_EF_SCROLLINFO)
        si.fMask = 0x17  # SIF_ALL
        if not _user32.GetScrollInfo(grid, 1, ctypes.byref(si)):  # SB_VERT
            return None
        return si.nPos, si.nMax
    except Exception:
        return None


def _ef_scroll_one(grid) -> bool:
    """보기만 한 줄 내림 → 실제로 내려갔으면 True, 이미 맨 아래(더 안 움직임)면 False.
    마지막 줄을 여러 번 읽던 문제의 해결 — 스크롤 위치로 끝을 정확히 안다."""
    before = _ef_vpos(grid)
    _ef_grid_scroll(grid, _SB_LINEDOWN)
    after = _ef_vpos(grid)
    if before is None or after is None:
        return True  # 못 읽으면 예전 방식(빈 줄·반복)으로 끝 판단
    return not (after == before and after[0] >= after[1])


def _ef_form_grid():
    """열린 상세명세서의 표(TAdvStringGrid) 창."""
    form = _ef_find_main_form()[1]
    return _ef_find_child_class(form, "TAdvStringGrid") if form else None


def _ef_grid_scroll(grid, how) -> None:
    """표 **보기만** 움직인다(WM_VSCROLL — 스크롤바 화살표 누르는 것과 같음). 키 입력이 아니라
    셀·줄을 절대 바꾸지 않는다. ※ 예전엔 비고칸 클릭+Enter 로 내렸는데, 마지막 줄에서 Enter 를 누르면
    이지폼이 **새 빈 줄을 만든다**(저장은 안 되지만 명세서를 건드림) → 읽기에선 Enter 금지."""
    if grid:
        _user32.SendMessageW(grid, _WM_VSCROLL, how, 0)
        time.sleep(0.05)


def _ef_read_open_form():
    """열려 있는(기준 위치로 옮겨 둔) 상세명세서 표를 읽는다 → rows / None(ESC 중단).
    입력 가드는 호출부가 켜 둔 상태여야 한다. 읽기 전용(셀 클릭·우클릭 '복사'·표 보기 스크롤만, Enter 없음)."""
    rows: list = []
    grid = _ef_form_grid()
    _ef_grid_scroll(grid, _SB_TOP)  # 열 때 아래로 내려가 있어도 첫 줄부터
    _EF_INPLACE_OK[0] = False  # 명세서마다 편집칸 읽기 여부 새로
    if True:
        empty = dup = 0
        prev = None

        def take(r):
            """줄 하나 반영 → 'go' 계속 / 'end' 표 끝."""
            nonlocal empty, dup, prev
            if not any(v.strip() for v in r.values()):
                empty += 1  # 이지폼 표 맨 끝엔 항상 빈 줄 1개 — 스크롤 끝이면 그 빈 줄이 계속 읽힘
                return "end" if empty >= 2 else "go"
            empty = 0
            sig = tuple(r.values())
            if sig == prev:
                dup += 1
                if dup >= _EF_STUCK:
                    return "end"  # 같은 줄이 계속 = 스크롤이 더 안 내려감(같은 내용 2~3줄은 실제 데이터일 수 있음)
            else:
                dup = 0
            prev = sig
            rows.append(r)
            return "go"

        ended = False
        for cells in EF_CELLS:
            if ef_aborted():
                return None
            r, ok = _ef_read_row(cells)
            if not ok or take(r) == "end":
                ended = True
                break
        if not ended:
            # 보이는 10줄이 다 찼으면 — 표 보기만 한 줄씩 내리고(새 줄 안 생김) 마지막 줄을 읽는다.
            while len(rows) < 200:
                if ef_aborted():
                    return None
                if not _ef_scroll_one(grid):
                    break  # 맨 아래 — 더 읽을 줄 없음
                r, ok = _ef_read_row(EF_CELLS[-1])
                if not ok or take(r) == "end":
                    break
        # 안전장치로 끝났으면(같은 줄 반복) 반복해 넣은 것들 정리.
        if dup >= _EF_STUCK:
            for _ in range(dup):
                if len(rows) >= 2 and rows[-1] == rows[-2]:
                    rows.pop()
    return rows


# ── 이지폼 목록에서 찾기(scan) ───────────────────────────────────────────────
# 사람이 이지폼 [매출 거래명세서 목록 → 매출처별 조회 → 그 해 1/1~12/31 → 역순보기] 를 띄워 두면,
# 목록 맨 위(최신)부터 한 건씩 [Enter 로 열기 → 표·비고 읽기 → ESC 로 닫기 → ↓] 를 반복한다.
# **읽기 전용**: 쓰는 입력은 좌클릭·우클릭 '복사'·Enter·ESC·↓ 뿐. 닫을 때 저장 질문 창이 뜨거나
# 창이 안 닫히면 **아무 버튼도 누르지 않고 그 자리에서 멈춘다**(사람이 직접 '아니오').
import re as _re

_EF_ORDER_NO_RE = _re.compile(r"(?<!\d)(\d{6}-\d{1,4})(?!\d)")
_VK_DOWN = 0x28
_VK_RETURN = 0x0D
_VK_ESC = 0x1B


def _ef_wtext(hwnd) -> str:
    """컨트롤 글자(WM_GETTEXT) — 클릭 없이 읽기."""
    buf = ctypes.create_unicode_buffer(1024)
    _user32.SendMessageW(hwnd, 0x000D, 1024, buf)
    return buf.value or ""


def _ef_children(parent, klass=None, visible=True) -> list:
    out: list = []

    def _cb(h, _):
        if (klass is None or _ef_classname(h) == klass) and (not visible or _user32.IsWindowVisible(h)):
            out.append(h)
        return True

    _user32.EnumChildWindows(parent, _EF_WNDENUMPROC(_cb), 0)
    return out


def _ef_rect(hwnd):
    r = wintypes.RECT()
    _user32.GetWindowRect(hwnd, ctypes.byref(r))
    return r.left, r.top, r.right, r.bottom


def _ef_find_list():
    """(main, 목록창, 목록 표, 전체 건수) — 보이는 TfrmListExchange 의 가장 넓은 표."""
    mains: list = []

    def _cb(h, _):
        if _ef_classname(h) == "TfrmBookMain" and _user32.IsWindowVisible(h):
            mains.append(h)
        return True

    _user32.EnumWindows(_EF_WNDENUMPROC(_cb), 0)
    for m in mains:
        for lst in _ef_children(m, "TfrmListExchange"):
            grids = sorted(_ef_children(lst, "TAdvStringGrid"),
                           key=lambda g: _ef_rect(g)[2] - _ef_rect(g)[0], reverse=True)
            if not grids:
                continue
            g = grids[0]
            gl, gt, gr, gb = _ef_rect(g)
            count = None
            for p in _ef_children(lst, "TPanel"):
                m2 = _re.search(r"(\d+)\s*(?:건|개)의 자료", _ef_wtext(p))  # 목록 아래 '23건의 자료가 있습니다.'
                pl, pt, _pr, _pb = _ef_rect(p)
                if m2 and abs(pt - gb) < 40 and pl >= gl - 10:
                    count = int(m2.group(1))
            return m, lst, g, count
    return None, None, None, None


def _ef_easyform_dialog(main) -> bool:
    """이지폼 프로세스의 질문/알림 창(#32770·TMessageForm)이 떠 있나."""
    pid = wintypes.DWORD()
    _user32.GetWindowThreadProcessId(main, ctypes.byref(pid))
    found = []

    def _cb(h, _):
        if _user32.IsWindowVisible(h) and _ef_classname(h) in ("#32770", "TMessageForm"):
            p2 = wintypes.DWORD()
            _user32.GetWindowThreadProcessId(h, ctypes.byref(p2))
            if p2.value == pid.value:
                found.append(h)
        return True

    _user32.EnumWindows(_EF_WNDENUMPROC(_cb), 0)
    return bool(found)


def ef_force_foreground(hwnd) -> bool:
    """다른 창(이지폼)이 앞에 있어도 hwnd(홈페이지 브라우저)를 맨 앞으로. 현장 에이전트 ForceForeground 와 같은
    방식: 포그라운드 잠금 타임아웃 0 → 현재 전면 스레드에 AttachThreadInput → SetForegroundWindow.
    (Alt 키 트릭은 안 씀 — 이지폼 메뉴가 켜질 수 있음.)"""
    if not hwnd or not _user32.IsWindow(hwnd):
        return False
    try:
        if _user32.IsIconic(hwnd):
            _user32.ShowWindow(hwnd, 9)  # SW_RESTORE
        _user32.SystemParametersInfoW(0x2001, 0, None, 2)  # SPI_SETFOREGROUNDLOCKTIMEOUT=0
        fg = _user32.GetForegroundWindow()
        fg_tid = _user32.GetWindowThreadProcessId(fg, None) if fg else 0
        my_tid = _kernel32.GetCurrentThreadId()
        attached = bool(fg_tid and fg_tid != my_tid and _user32.AttachThreadInput(my_tid, fg_tid, True))
        _user32.SetForegroundWindow(hwnd)
        _user32.BringWindowToTop(hwnd)
        _user32.ShowWindow(hwnd, 5)  # SW_SHOW
        if attached:
            _user32.AttachThreadInput(my_tid, fg_tid, False)
        return _user32.GetForegroundWindow() == hwnd
    except Exception:
        logging.exception("홈페이지 창 앞으로 가져오기 실패")
        return False


def _ef_open_form(main):
    forms = [f for f in _ef_children(main, "TfrmExchange")]
    return forms[0] if forms else None


def _ef_form_header(form) -> "tuple[str, str]":
    """상세 창 발행일(TMaskEdit)·합계금액(표 위 TAdvEdit) — 화면 글자 그대로."""
    date = ""
    for e in _ef_children(form, "TMaskEdit"):
        date = _ef_wtext(e).strip()
        break
    total = ""
    grid = _ef_find_child_class(form, "TAdvStringGrid")
    gtop = _ef_rect(grid)[1] if grid else 10 ** 6
    for e in _ef_children(form, "TAdvEdit"):
        if _ef_rect(e)[3] <= gtop:
            total = _ef_wtext(e).strip()
            break
    return date, total


def ef_progress_text(n: int, date: str) -> str:
    """찾기 진행 글자 — '11월 05일까지 총 12개의 명세서를 읽고 있습니다.' (date='YYYY.MM.DD')"""
    m = _re.match(r"\d{4}\.(\d{1,2})\.(\d{1,2})", date or "")
    upto = f"{m.group(1)}월 {m.group(2)}일까지 " if m else ""
    return f"{upto}총 {n}개의 명세서를 읽고 있습니다."


def _ef_read_remarks(clues: bool = False):
    """열린 상세명세서를 훑는다 → [(품목, 규격, 비고)] / None(ESC).
    clues=False(주문번호 찾기): **비고 칸만** 읽는다 — 표 끝은 비고 칸 메뉴가 안 뜨는 것으로 판단.
      (10줄 넘어 스크롤할 때만 품목 칸도 읽음 — 같은 줄 반복=표 끝 판단에 비고만으론 부족)
    clues=True(키워드로 찾기): 품목코드·품목·규격·수량·단가·비고(홈페이지 명세서 칸 그대로).
    줄이 10개를 넘으면 **표 보기만** 한 줄씩 내린다(WM_VSCROLL — Enter 는 마지막 줄에서 새 줄을 만들어 금지)."""
    ci, cs, cr = EF_COLS.index("item"), EF_COLS.index("spec"), EF_COLS.index("remark")
    cc, cq, cp = EF_COLS.index("item_code"), EF_COLS.index("qty"), EF_COLS.index("unit_price")
    out: list = []
    prev = None
    dup = 0
    grid = _ef_form_grid()
    _ef_grid_scroll(grid, _SB_TOP)  # 열 때 아래로 내려가 있어도 첫 줄부터
    _EF_INPLACE_OK[0] = False  # 명세서마다 편집칸 읽기 여부 새로

    def one(cells, need_item=False):
        if clues or need_item:
            it = _ef_copy_cell(*cells[ci])
            if it is None:
                return None  # 메뉴 안 뜸 = 표 끝
        else:
            it = ""
        sp = (_ef_copy_cell(*cells[cs]) or "") if clues else ""
        rm = _ef_copy_cell(*cells[cr])
        if rm is None:
            if clues or need_item:
                rm = ""
            else:
                return None  # 비고만 읽을 때: 메뉴 안 뜸 = 표 끝
        if clues:
            # 키워드 찾기: 홈페이지 명세서 칸 그대로(품목코드·품목·규격·수량·단가·비고). 공급가·세액은 계산값이라 뺌.
            code = _ef_copy_cell(*cells[cc]) or ""
            qty = _ef_copy_cell(*cells[cq]) or ""
            price = _ef_copy_cell(*cells[cp]) or ""
            return it, sp, rm, code, qty, price
        return it, sp, rm

    for cells in EF_CELLS:
        if ef_aborted():
            return None
        r = one(cells)
        if r is None:
            return out
        out.append(r)
    empty = 0
    while len(out) < 200:
        if ef_aborted():
            return None
        if not _ef_scroll_one(grid):  # 보기만 한 줄 아래로(새 줄 안 생김) — 맨 아래면 끝
            break
        r = one(EF_CELLS[-1], need_item=True)
        if r is None:
            break
        if not any(v.strip() for v in r):
            empty += 1  # 표 맨 끝 빈 줄 — 스크롤이 멈추면 계속 그 빈 줄
            if empty >= 2:
                break
            continue
        empty = 0
        if r == prev:
            dup += 1
            if dup >= _EF_STUCK:
                break  # 안전장치: 같은 줄 계속 = 더 안 내려감
        else:
            dup = 0
        prev = r
        out.append(r)
    return out


def _ef_dock_fast() -> bool:
    """찾기용 빠른 위치 맞추기 — 상세 창이 이미 기준 위치면 옮기지 않고(대기 0) 격자 잔차만 계산.
    ef_dock_and_offset 은 매번 전면화+이동+0.28초 대기라 건마다 쌓이면 느리다."""
    _main, form = _ef_find_main_form()
    if not form:
        return False
    try:
        if _ef_topleft(form) != EF_FORM_HOME:
            _ef_move_to_screen(form, EF_FORM_HOME[0], EF_FORM_HOME[1])
            time.sleep(0.12)
        grid = _ef_find_child_class(form, "TAdvStringGrid")
        if grid:
            gl, gt = _ef_topleft(grid)
            _EF_OFFSET[0] = gl - EF_GRID_REF[0]
            _EF_OFFSET[1] = gt - EF_GRID_REF[1]
        else:
            _EF_OFFSET[0] = _EF_OFFSET[1] = 0
    except Exception:
        logging.exception("이지폼 폼 빠른 보정 실패")
        return ef_dock_and_offset()
    return True


def _kw_norm(t: str) -> str:
    """키워드 비교용 — 공백 제거·소문자(웹 clueMatch.normClue 와 같음)."""
    return _re.sub(r"\s+", "", t or "").lower()


def ef_keyword_hits(light: dict, keywords: list) -> "tuple[list, list]":
    """훑은 명세서 1건에 맞은 키워드 → (맞은 키워드[원래 글자], 맞은 칸 글자[원래]).
    웹 clueMatch.hasClue 와 같은 규칙: 칸 ⊃ 키워드, 또는 3글자 넘는 칸 ⊂ 키워드."""
    raw = [str(x) for k in ("codes", "items", "specs", "qtys", "prices", "remarks")
           for x in (light.get(k) or []) if x]
    cells = [(c, _kw_norm(c)) for c in raw]
    cells = [(c, n) for c, n in cells if n]
    matched, texts = [], []
    for kw in keywords:
        k = _kw_norm(kw)
        if not k:
            continue
        hit = [c for c, n in cells if k in n or (len(n) >= 3 and n in k)]
        if hit:
            matched.append(kw)
            for c in hit:
                if c not in texts:
                    texts.append(c)
    return matched, texts


def run_easyform_scan(opts: dict, progress=None, on_hit=None) -> "tuple[bool, str, list]":
    """목록 맨 위부터 명세서를 하나씩 열어 **비고만** 훑어 주문번호(findOrderNo)를 찾는다.
    찾으면 그 명세서만 전체를 읽어 [그 1건] 을 돌려주고 멈춘다. (성공여부, 메시지, 명세서 목록).
    opts: findOrderNo='261103-19', stopBefore='YYYY.MM.DD'(이보다 오래된 발행일이 나오면 멈춤), max."""
    if not EASYFORM_AVAILABLE:
        return False, "이 PC 에서는 이지폼 찾기를 쓸 수 없습니다.", []
    want = str(opts.get("findOrderNo") or "").strip()
    clue_mode = bool(opts.get("clues"))  # 단서 찾기 2차: 품목·규격·비고를 훑기만(주문번호 안 찾음)
    keywords = [str(k) for k in (opts.get("keywords") or []) if str(k).strip()][:20] if clue_mode else []
    if clue_mode:
        want = ""
    stop_before = str(opts.get("stopBefore") or "").strip()
    try:
        max_n = max(1, min(500, int(opts.get("max") or 300)))
    except (TypeError, ValueError):
        max_n = 300
    found: list = []

    def result(ok, msg):
        return ok, msg, found

    ef_guard_start()
    try:
        main, lst, grid, count = _ef_find_list()
        if not grid:
            return result(False, "이지폼 [매출 거래명세서 목록] 창을 못 찾았습니다(매출처별 조회를 띄워 두세요).")
        if _ef_open_form(main):
            return result(False, "이지폼에 열려 있는 상세명세서 창을 먼저 닫아주세요(목록만 띄워 두기).")
        total_n = min(max_n, count) if count else max_n
        if _user32.IsIconic(main):
            _user32.ShowWindow(main, 9)
        _user32.SetForegroundWindow(main)
        _user32.BringWindowToTop(lst)
        _user32.SetForegroundWindow(main)
        time.sleep(0.3)
        gl, gt, _gr, _gb = _ef_rect(grid)
        # 목록이 중간까지 내려가 있어도 **맨 위(최신)** 부터 — ① 표를 맨 위로 스크롤(WM_VSCROLL SB_TOP,
        # 입력 아님) ② 보이는 첫 줄 발행일자 칸 클릭(줄 선택만. '선택' 체크칸·[세금변환]은 오른쪽 끝이라
        # 안 건드림) ③ PageUp 여러 번 = 선택을 확실히 1번째 줄로(목록 표에서 PageUp 은 이동만).
        _user32.SendMessageW(grid, 0x0115, 6, 0)  # WM_VSCROLL, SB_TOP
        time.sleep(0.25)
        ef_click(gl + 45, gt + 33)
        time.sleep(0.2)
        for _ in range(((count or 40) // 8) + 3):
            ef_key(0x21)  # VK_PRIOR(PageUp)
            time.sleep(0.04)
        time.sleep(0.2)

        def close_form():
            """ESC 한 번. 안 닫히거나 질문 창이 뜨면 아무것도 누르지 않고 False."""
            ef_key(_VK_ESC)
            t1 = time.time()
            while time.time() - t1 < 3.0 and _ef_open_form(main):
                time.sleep(0.04)
            return not (_ef_open_form(main) or _ef_easyform_dialog(main))

        # ── 고른 1건만 열기(openIdx) — 단서로 고른 명세서: 맨 위에서 ↓ N번 → Enter → 발행일·합계가
        #    고를 때와 같은지 확인(목록이 바뀌었으면 멈춤) → 전체 읽기. 다른 명세서는 안 연다.
        if opts.get("openIdx") is not None:
            try:
                n_down = max(0, int(opts.get("openIdx")))
            except (TypeError, ValueError):
                return result(False, "열 명세서 번호가 잘못됐어요.")
            for _ in range(n_down):
                if ef_aborted():
                    return result(False, "ESC 로 중단했습니다.")
                ef_key(_VK_DOWN)
                time.sleep(0.08)
            time.sleep(0.2)
            ef_key(_VK_RETURN)
            form = None
            t0 = time.time()
            while time.time() - t0 < 4.0:
                form = _ef_open_form(main)
                if form and "_" not in _ef_form_header(form)[0] and _ef_form_header(form)[0]:
                    break
                time.sleep(0.1)
            if not form:
                return result(False, "명세서가 안 열렸어요. 목록을 확인해주세요.")
            time.sleep(0.25)
            date, total = _ef_form_header(form)
            exp_d, exp_t = str(opts.get("expectDate") or ""), str(opts.get("expectTotal") or "")
            if (exp_d and date != exp_d) or (exp_t and total != exp_t):
                ok_close = close_form()
                return result(False, f"목록이 바뀌었어요({date} {total}원이 열림, 찾던 건 {exp_d} {exp_t}원)."
                                     + ("" if ok_close else " 열린 창은 직접 닫아주세요.")
                                     + " 다시 [이지폼에서 찾기] 해주세요.")
            if not ef_dock_and_offset():
                return result(False, "상세명세서 창 위치를 맞추지 못했어요.")
            time.sleep(0.12)
            rows = _ef_read_open_form()
            _EF_OFFSET[0] = 0
            _EF_OFFSET[1] = 0
            if rows is None:
                return result(False, "ESC 로 중단했습니다.")
            if not close_form():
                return result(False, f"{date} 명세서를 닫을 때 이지폼 창이 떠서 멈췄어요. 직접 닫아주세요.")
            remark_all = " ".join(r.get("remark", "") for r in rows)
            found.append({"idx": n_down, "date": date, "total": total, "rows": rows, "match": True,
                          "orderNos": list(dict.fromkeys(_EF_ORDER_NO_RE.findall(remark_all)))})
            return result(True, f"{date} 명세서를 읽었어요.")

        prev_sig = None
        checked = 0
        for i in range(total_n):
            if ef_aborted():
                return result(False, "ESC 로 중단했습니다.")
            if i > 0:
                ef_key(_VK_DOWN)  # 목록 다음 줄
                time.sleep(0.08)
            ef_key(_VK_RETURN)  # 열기
            form = None
            t0 = time.time()
            while time.time() - t0 < 4.0:
                form = _ef_open_form(main)
                if form and "_" not in _ef_form_header(form)[0] and _ef_form_header(form)[0]:
                    break
                time.sleep(0.04)
            if not form:
                if _ef_easyform_dialog(main):
                    return result(False, f"{i + 1}번째에서 이지폼 알림 창이 떠서 멈췄어요. 직접 확인해주세요.")
                return result(len(found) > 0, f"{i + 1}번째 명세서가 안 열려서 멈췄어요({len(found)}건 확인).")
            time.sleep(0.06)  # 표 그려질 틈(발행일 글자가 뜬 뒤라 짧게)
            date, total = _ef_form_header(form)
            stuck = (f"{date} 명세서를 닫을 때 이지폼 창이 떠서 멈췄어요. "
                     "저장하지 말고 직접 '아니오'/닫기 해주세요.")
            if stop_before and date and date < stop_before:
                if not close_form():
                    return result(False, stuck)
                if clue_mode:
                    return result(True, f"키워드 찾기용으로 {checked}건을 훑었어요({stop_before} 이후).")
                return result(True, f"{checked}건을 훑었지만 {stop_before} 이후 명세서 비고에서 {want} 를 못 찾았어요.")
            if not _ef_dock_fast():
                return result(False, "상세명세서 창 위치를 맞추지 못했어요.")
            remarks = _ef_read_remarks(clues=clue_mode)
            _EF_OFFSET[0] = 0
            _EF_OFFSET[1] = 0
            if remarks is None:
                return result(False, "ESC 로 중단했습니다.")
            nos = list(dict.fromkeys(_EF_ORDER_NO_RE.findall(" ".join(r[2] for r in remarks))))
            sig = (date, total, tuple(remarks))
            if not close_form():
                return result(False, stuck)
            if sig == prev_sig:
                break  # ↓ 가 더 안 내려감 = 목록 끝
            prev_sig = sig
            checked += 1
            # 못 찾았을 때 단서로 고를 수 있게 가볍게 남긴다(품목·규격·비고 + 목록 위치 idx).
            light = {"idx": i, "date": date, "total": total, "light": True, "orderNos": nos,
                     "items": [r[0] for r in remarks], "specs": [r[1] for r in remarks],
                     "remarks": [r[2] for r in remarks]}
            if clue_mode:
                light["codes"] = [r[3] if len(r) > 3 else "" for r in remarks]
                light["qtys"] = [r[4] if len(r) > 4 else "" for r in remarks]
                light["prices"] = [r[5] if len(r) > 5 else "" for r in remarks]
            found.append(light)
            if clue_mode and on_hit and keywords:
                try:
                    kws, texts = ef_keyword_hits(light, keywords)
                    if kws:
                        on_hit(date, total, kws, texts)
                except Exception:
                    pass
            if progress:
                try:
                    progress(checked, total_n, date)
                except Exception:
                    pass
            if want and want in nos:
                # 찾음 → 같은 줄을 다시 열어(표가 맨 위부터 보이게) 전체 5칸+비고를 읽는다.
                time.sleep(0.08)
                ef_key(_VK_RETURN)
                t0 = time.time()
                form = None
                while time.time() - t0 < 4.0:
                    form = _ef_open_form(main)
                    if form and _ef_form_header(form)[0] == date:
                        break
                    time.sleep(0.04)
                time.sleep(0.06)
                if not form or not _ef_dock_fast():
                    return result(False, f"{date} 명세서에서 찾았는데 다시 열지 못했어요. 그 명세서를 열고 [가져오기] 해주세요.")
                rows = _ef_read_open_form()
                _EF_OFFSET[0] = 0
                _EF_OFFSET[1] = 0
                if rows is None:
                    return result(False, "ESC 로 중단했습니다.")
                if not close_form():
                    return result(False, stuck)
                found.append({"idx": i, "date": date, "total": total, "rows": rows, "orderNos": nos, "match": True})
                return result(True, f"{date} 명세서 비고에서 {want} 를 찾았어요({checked}건째).")
            time.sleep(0.03)
    finally:
        _EF_OFFSET[0] = 0
        _EF_OFFSET[1] = 0
        ef_guard_stop()
        try:
            ef_set_clipboard("")
        except Exception:
            pass
    if clue_mode:
        return result(True, f"키워드 찾기용으로 {checked}건을 훑었어요.")
    return result(True, f"{checked}건을 훑었지만 비고에서 {want} 를 못 찾았어요.")


# 가져오기 상태(웹이 폴링): idle → waiting(버튼 대기) → running → done/error.
# mode: 'one' = 열어 둔 상세명세서 1건 / 'scan' = 목록에서 한 건씩 열어 찾기(statements 로 돌려줌).
_EF_PULL = {"id": 0, "state": "idle", "rows": [], "statements": [], "message": "", "at": 0.0,
            "mode": "one", "opts": {}, "progress": ""}
EF_PULL_TTL = 1800


def handle_pull_start(body: "dict | None" = None) -> "tuple[int, dict]":
    """POST /easyform/pull — 가져오기 대기(arm) + 코너 버튼창 표시. body.mode='scan' 이면 목록 찾기."""
    if not EASYFORM_AVAILABLE:
        return 200, {"armed": False, "message": "이 PC 에서는 이지폼 가져오기를 쓸 수 없습니다."}
    body = body if isinstance(body, dict) else {}
    mode = "scan" if body.get("mode") == "scan" else "one"
    opts = {"stopBefore": str(body.get("stopBefore") or ""), "max": body.get("max") or 300,
            "findOrderNo": str(body.get("findOrderNo") or ""),
            "clientName": str(body.get("clientName") or "")[:40],  # 코너 창 안내 문구용
            "clues": bool(body.get("clues")),  # 단서 찾기 2차(품목·규격·비고 훑기)
            # 키워드로 찾기 — 훑는 동안 맞는 명세서가 나오면 오른쪽 위 판에 하나씩 띄움(보고 ESC 로 멈추게)
            "keywords": [str(k)[:40] for k in body.get("keywords") if str(k).strip()][:20]
            if isinstance(body.get("keywords"), list) else []}
    if mode == "scan" and body.get("openIdx") is not None:
        opts.update(openIdx=body.get("openIdx"), expectDate=str(body.get("expectDate") or ""),
                    expectTotal=str(body.get("expectTotal") or ""))
    auto = bool(body.get("auto")) and "openIdx" in opts  # 웹에서 이미 확인 → 코너 버튼 없이 바로
    # 웹 버튼을 누른 순간 앞에 있는 창 = 홈페이지 브라우저 → 끝나면 이 창으로 되돌아간다.
    try:
        ret = _user32.GetForegroundWindow()
    except Exception:
        ret = None
    with _EF_LOCK:
        _EF_PULL["id"] += 1
        _EF_PULL.update(state="waiting", rows=[], statements=[], message="", at=time.time(),
                        mode=mode, opts=opts, progress="", return_hwnd=ret)
        pid = _EF_PULL["id"]
    try:
        _EF_UI_QUEUE.put(("pull_auto",) if auto else ("pull_show", mode))
    except Exception:
        pass
    logging.info("이지폼 가져오기 대기 #%d — '가져오기' 버튼 대기", pid)
    return 200, {"armed": True, "id": pid}


def handle_pull_status(pid: int) -> dict:
    """GET /easyform/pull?id=N — 상태/결과. 결과(done)는 한 번 넘겨주면 idle 로."""
    with _EF_LOCK:
        if pid != _EF_PULL["id"]:
            return {"state": "gone"}
        if _EF_PULL["state"] == "waiting" and time.time() - _EF_PULL["at"] > EF_PULL_TTL:
            _EF_PULL["state"] = "idle"
            return {"state": "gone"}
        st = _EF_PULL["state"]
        out = {"state": st, "message": _EF_PULL["message"], "mode": _EF_PULL["mode"],
               "progress": _EF_PULL["progress"]}
        if st == "done":
            out["rows"] = list(_EF_PULL["rows"])
            out["statements"] = list(_EF_PULL["statements"])
            hd = _EF_PULL.get("header") or ["", ""]
            out["date"], out["total"] = hd[0], hd[1]  # 직접가져오기: 명세서 발행일·합계
            _EF_PULL.update(state="idle", rows=[], statements=[])
        elif st == "error":
            _EF_PULL["state"] = "idle"
        return out


def handle_pull_cancel(pid: int) -> dict:
    with _EF_LOCK:
        if pid == _EF_PULL["id"] and _EF_PULL["state"] == "waiting":
            _EF_PULL["state"] = "idle"
    try:
        _EF_UI_QUEUE.put(("pull_cancel",))
    except Exception:
        pass
    return {"ok": True}


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
_EF_ROW_KEYS = ("item_code", "item", "spec", "qty", "unit_price", "supply", "tax", "remark")


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
def install(root, accent="#0a9396", accent_dark="#097a7d") -> None:
    """워처의 tkinter root 에 이지폼 '채우기' UI 를 붙인다(별도 mainloop 없음). F6 워처도 시작.
      ① 코너 '채우기' 버튼창(win, Toplevel) — 웹이 grid 를 보내면 표시.
      ② 풀스크린 딤 + 중앙 패널 — 매크로 중 화면을 살짝 어둡게 + 🔒 잠금/ESC 안내, 완료 시 [확인].
    accent/accent_dark = 버튼 색(워처=기본 청록, 명세서자동작성 에이전트=주황으로 호출)."""
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
    w = int(390 * s)

    # 깔끔한 흰 카드: 제목 / 안내(번호 단계는 색 동그라미) / 큰 버튼. 높이는 내용에 맞춰 자동.
    frame = tk.Frame(win, bg="#ffffff", padx=int(20 * s), pady=int(16 * s))
    frame.pack(fill="both", expand=True)
    title_lbl = tk.Label(frame, text="이지폼 자동기입", font=("맑은 고딕", int(14 * s), "bold"),
                         fg="#111827", bg="#ffffff")
    title_lbl.pack(anchor="w")
    info_box = tk.Frame(frame, bg="#ffffff")
    info_box.pack(anchor="w", fill="x", pady=(int(10 * s), int(14 * s)))
    btn = tk.Button(frame, text="이지폼 자동기입 시작하기 ▶", font=("맑은 고딕", int(13 * s), "bold"),
                    bg=accent, fg="white", activebackground=accent_dark, activeforeground="white",
                    relief="flat", bd=0, padx=int(14 * s), pady=int(10 * s), cursor="hand2")
    btn.pack(fill="x")

    def set_info(title, text, ww=None):
        """코너 창 내용 바꾸기 — '1. …' 줄은 번호 동그라미 + 글자, 나머지는 그냥 글자. 창 크기는 내용에 맞춤."""
        ww = ww or w
        title_lbl.config(text=title)
        for ch in info_box.winfo_children():
            ch.destroy()
        for line in (text or "").split("\n"):
            m = _re.match(r"\s*(\d+)\.\s*(.*)", line)
            row = tk.Frame(info_box, bg="#ffffff")
            row.pack(anchor="w", fill="x", pady=(0, int(5 * s)))
            if m:
                tk.Label(row, text=m.group(1), font=("맑은 고딕", int(9 * s), "bold"), fg="white", bg=accent,
                         width=2).pack(side="left", padx=(0, int(8 * s)))
                line = m.group(2)
            tk.Label(row, text=line, font=("맑은 고딕", int(11 * s)), fg="#374151", bg="#ffffff",
                     justify="left", anchor="w", wraplength=ww - int(80 * s)).pack(side="left", anchor="w")
        win.update_idletasks()
        hh = win.winfo_reqheight()
        win.geometry(f"{ww}x{hh}+{max(0, sw - ww - int(28 * s))}+{max(0, sh - hh - int(72 * s))}")

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
    panel.configure(bg="#ffffff")
    pw, ph = int(520 * s), int(200 * s)
    panel.geometry(f"{pw}x{ph}+{(sw - pw) // 2}+{(sh - ph) // 2}")
    panel.attributes("-topmost", True)
    panel.attributes("-alpha", 0.995)  # 살짝만 투명 → WS_EX_LAYERED 적용(클릭통과 전제), 보기엔 불투명

    run_frame = tk.Frame(panel, bg="#ffffff")
    tk.Label(run_frame, text="🔒", font=("Segoe UI Emoji", int(26 * s)),
             fg="#111827", bg="#ffffff").pack(pady=(int(22 * s), int(6 * s)))
    run_lbl = tk.Label(run_frame, text="자동입력 중에는 마우스가 잠깁니다.", font=("맑은 고딕", int(14 * s), "bold"),
                       fg="#111827", bg="#ffffff")
    run_lbl.pack()
    # 찾기(순회) 중 진행 — 'MM월 DD일까지 총 n개의 명세서를 읽고 있습니다.' 보고 안 나올 것 같으면 ESC 로 멈추게.
    prog_lbl = tk.Label(run_frame, text="", font=("맑은 고딕", int(13 * s), "bold"),
                        fg="#c2410c", bg="#ffffff")
    prog_lbl.pack(pady=(int(8 * s), 0))
    tk.Label(run_frame, text="멈추려면 ESC", font=("맑은 고딕", int(11 * s)),
             fg="#6b7280", bg="#ffffff").pack(pady=(int(8 * s), 0))

    # ── 키워드 판(오른쪽 위) — 키워드로 찾기 때만: 찾는 키워드 + 맞은 명세서가 나올 때마다 한 줄씩.
    #    원하는 게 보이면 ESC → 지금까지 읽은 것 중에서 홈페이지에서 고른다.
    #    어두운 딤 위라 **흰 카드 + 큰 글자**로 단순하게: 키워드 / 찾은 명세서(날짜·금액 + 맞은 키워드) / ESC 안내.
    KW_BG, KW_INK, KW_SUB = "#ffffff", "#111827", "#6b7280"
    KW_FONT = "맑은 고딕"
    kwp = tk.Toplevel(root)
    kwp.overrideredirect(True)
    kwp.configure(bg=KW_BG)
    kpw = int(400 * s)
    kwp.attributes("-topmost", True)
    kwp.attributes("-alpha", 0.995)
    kw_box = tk.Frame(kwp, bg=KW_BG, padx=int(20 * s), pady=int(16 * s))
    kw_box.pack(fill="both", expand=True)
    tk.Label(kw_box, text="찾는 키워드", font=(KW_FONT, int(11 * s)), fg=KW_SUB, bg=KW_BG).pack(anchor="w")
    kw_lbl = tk.Label(kw_box, text="", font=(KW_FONT, int(15 * s), "bold"), fg=KW_INK, bg=KW_BG,
                      justify="left", anchor="w", wraplength=kpw - int(40 * s))
    kw_lbl.pack(anchor="w", fill="x", pady=(int(2 * s), int(12 * s)))
    tk.Frame(kw_box, bg="#e5e7eb", height=max(1, int(1 * s))).pack(fill="x")
    kw_head = tk.Label(kw_box, text="", font=(KW_FONT, int(12 * s), "bold"), fg=KW_INK, bg=KW_BG)
    kw_head.pack(anchor="w", pady=(int(12 * s), int(6 * s)))
    kw_list = tk.Frame(kw_box, bg=KW_BG)
    kw_list.pack(anchor="w", fill="x")
    tk.Label(kw_box, text="찾았으면 ESC", font=(KW_FONT, int(12 * s), "bold"),
             fg="#dc2626", bg=KW_BG).pack(anchor="w", pady=(int(10 * s), 0))
    kwp.withdraw()
    kw_state = {"n": 0, "kws": []}
    KW_SHOW = 6  # 판에는 최근 6건만(전체 개수는 머리글에)

    def _kw_fit():
        kwp.update_idletasks()
        kh = kwp.winfo_reqheight()
        kwp.geometry(f"{kpw}x{kh}+{max(0, sw - kpw - int(20 * s))}+{int(20 * s)}")

    def kw_show(keywords):
        for ch in kw_list.winfo_children():
            ch.destroy()
        kw_state.update(n=0, kws=list(keywords))
        kw_lbl.config(text="  ·  ".join(keywords))
        kw_head.config(text="찾은 명세서 0건", fg=KW_SUB)
        _kw_fit()
        kwp.deiconify()
        _set_exstyle(kwp, add=_WS_EX_LAYERED | _WS_EX_TRANSPARENT | _WS_EX_NOACTIVATE
                     | _WS_EX_TOPMOST | _WS_EX_TOOLWINDOW)
        kwp.lift()

    def kw_add(date, total, kws, texts):
        kw_state["n"] += 1
        full = len(kws) >= (len(kw_state["kws"]) or 1)  # 키워드 전부 맞음 = 초록
        bg = "#dcfce7" if full else "#f3f4f6"
        row = tk.Frame(kw_list, bg=bg, padx=int(12 * s), pady=int(7 * s))
        md = _re.match(r"\d{4}\.(\d{1,2})\.(\d{1,2})", date or "")
        d = f"{int(md.group(1))}월 {int(md.group(2))}일" if md else (date or "")
        tk.Label(row, text=d + (f"   {total}원" if total else ""), font=(KW_FONT, int(14 * s), "bold"),
                 fg=KW_INK, bg=bg, anchor="w").pack(anchor="w")
        tk.Label(row, text=("✔ " if full else "") + ", ".join(kws), font=(KW_FONT, int(12 * s)),
                 fg="#15803d" if full else "#374151", bg=bg, anchor="w", justify="left",
                 wraplength=kpw - int(64 * s)).pack(anchor="w")
        kids = kw_list.pack_slaves()  # 화면 순서(맨 위=최신). row 는 아직 pack 전이라 안 들어 있음
        if kids:
            row.pack(anchor="w", fill="x", pady=(0, int(6 * s)), before=kids[0])  # 최신이 맨 위
        else:
            row.pack(anchor="w", fill="x", pady=(0, int(6 * s)))
        for old in kw_list.pack_slaves()[KW_SHOW:]:
            old.destroy()
        kw_head.config(text=f"찾은 명세서 {kw_state['n']}건", fg=KW_INK)
        _kw_fit()
        kwp.lift()

    def kw_hide():
        kwp.withdraw()

    done_frame = tk.Frame(panel, bg="#ffffff")
    done_lbl = tk.Label(done_frame, text="", font=("맑은 고딕", int(14 * s), "bold"),
                        fg="#111827", bg="#ffffff", justify="center", wraplength=pw - int(60 * s))
    done_lbl.pack(pady=(int(26 * s), int(14 * s)))
    done_btn = tk.Button(done_frame, text="확인", font=("맑은 고딕", int(13 * s), "bold"),
                         bg=accent, fg="white", activebackground=accent_dark, activeforeground="white",
                         relief="flat", bd=0, padx=int(30 * s), pady=int(8 * s), cursor="hand2")
    done_btn.pack()
    panel.withdraw()

    # 견고한 exstyle 설정(selftest2 로 검증): GetAncestor 로 진짜 top-level HWND + WS_EX_LAYERED 명시 +
    # SetWindowPos(FRAMECHANGED) 로 강제 반영. winfo_id() 만으론 클릭통과가 안 먹던 문제 해결.
    _GWL_EXSTYLE = -20
    _GA_ROOT = 2
    _SWP_APPLY = 0x0001 | 0x0002 | 0x0004 | 0x0010 | 0x0020  # NOSIZE|NOMOVE|NOZORDER|NOACTIVATE|FRAMECHANGED
    try:
        _GetWL = ctypes.windll.user32.GetWindowLongPtrW
        _SetWL = ctypes.windll.user32.SetWindowLongPtrW
    except AttributeError:
        _GetWL = ctypes.windll.user32.GetWindowLongW
        _SetWL = ctypes.windll.user32.SetWindowLongW

    def _set_exstyle(w_, add=0, remove=0):
        try:
            w_.update_idletasks()
            u = ctypes.windll.user32
            hwnd = u.GetAncestor(w_.winfo_id(), _GA_ROOT)  # 진짜 top-level
            cur = _GetWL(hwnd, _GWL_EXSTYLE)
            _SetWL(hwnd, _GWL_EXSTYLE, (cur | add) & ~remove)
            u.SetWindowPos(hwnd, 0, 0, 0, 0, 0, _SWP_APPLY)  # 변경 강제 반영
        except Exception:
            pass

    _WS_EX_NOACTIVATE = 0x08000000
    _WS_EX_TOPMOST = 0x00000008
    _WS_EX_TOOLWINDOW = 0x00000080
    _WS_EX_TRANSPARENT = 0x00000020  # 마우스 클릭 통과(밑의 이지폼으로 전달)
    _WS_EX_LAYERED = 0x00080000      # 클릭통과 전제(명시) — 알파와 별개로 확실히 켠다.
    busy = {"v": False}
    mode = {"v": "fill"}  # 코너 버튼창 용도: fill(웹→이지폼 입력) / pull(이지폼→웹 가져오기)

    def show_overlay(text="자동입력 중에는 마우스가 잠깁니다."):
        run_lbl.config(text=text)
        prog_lbl.config(text="")
        run_frame.pack(fill="both", expand=True)
        done_frame.pack_forget()
        dim.deiconify()
        panel.deiconify()
        # LAYERED+TRANSPARENT(클릭 통과 → 매크로 클릭이 이지폼 셀에) + NOACTIVATE(포커스 안 뺏음).
        over = _WS_EX_LAYERED | _WS_EX_TRANSPARENT | _WS_EX_NOACTIVATE | _WS_EX_TOPMOST | _WS_EX_TOOLWINDOW
        _set_exstyle(dim, add=over)
        _set_exstyle(panel, add=over)
        dim.lift()
        panel.lift()

    def show_done(ok, msg, ok_text="✅ 자동작성이 완료되었습니다."):
        run_frame.pack_forget()
        done_lbl.config(text=(ok_text if ok else "⏹ 중단되었습니다.") +
                        ("" if ok else f"\n{msg}"),
                        fg="#111827" if ok else "#dc2626")
        done_frame.pack(fill="both", expand=True)
        # 완료 화면은 [확인] 클릭을 받아야 하니 클릭통과·비활성 해제.
        _set_exstyle(panel, remove=_WS_EX_NOACTIVATE | _WS_EX_TRANSPARENT)
        panel.lift()
        panel.attributes("-topmost", True)

    def hide_overlay():
        kw_hide()
        panel.withdraw()
        dim.withdraw()
        busy["v"] = False

    def set_staged(count):
        busy["v"] = False
        mode["v"] = "fill"
        set_info("이지폼 자동기입",
                 "1. 이지폼에서 [새로작성 → 거래처 선택]\n2. 아래 버튼을 누르면 명세서가 자동입력돼요")
        btn.config(text="이지폼 자동기입 시작하기 ▶", state="normal", bg=accent)
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

    def set_pull(pmode="one"):
        busy["v"] = False
        mode["v"] = "pull"
        if pmode == "scan":
            # 웹 안내창과 같은 3단계 문구(거래처 이름은 웹이 보내 줌). 3줄이라 창을 조금 키운다.
            with _EF_LOCK:
                client = str(_EF_PULL.get("opts", {}).get("clientName") or "").strip() or "이 거래처"
            with _EF_LOCK:
                kwd = bool(_EF_PULL.get("opts", {}).get("clues"))
            set_info("이지폼에서 키워드로 찾기" if kwd else "이지폼에서 찾기",
                     (f"1. 매출처별 조회에서 '{client}' 검색\n"
                      "2. 날짜를 1/1~12/31 로 (최신순)\n"
                      "3. 아래 버튼 누르기"), ww=int(420 * s))
            btn.config(text="이지폼 목록에서 찾기 ▶", state="normal", bg=accent)
        else:
            set_info("이지폼에서 가져오기",
                     "1. 이지폼에서 옮길 상세명세서 열기\n2. 아래 버튼을 누르면 홈페이지 명세서로 가져와요")
            btn.config(text="이지폼에서 가져오기 ▶", state="normal", bg=accent)
        win.deiconify()
        win.lift()
        win.attributes("-topmost", True)

    def on_pull(auto=False):
        if busy["v"]:
            return
        with _EF_LOCK:
            waiting = _EF_PULL["state"] == "waiting"
            pid = _EF_PULL["id"]
            pmode = _EF_PULL["mode"]
            popts = dict(_EF_PULL["opts"])
        if not waiting:
            ef_messagebox("대기 중인 가져오기가 없습니다(만료). 홈페이지에서 다시 눌러주세요.",
                          "이지폼 가져오기")
            win.withdraw()
            return
        def precheck_fail(msg):
            # 자동(웹에서 고른 1건 열기)은 코너 버튼이 없으니 웹에 오류로 알린다(안 그러면 웹이 계속 대기).
            if auto:
                with _EF_LOCK:
                    if _EF_PULL["id"] == pid:
                        _EF_PULL.update(state="error", message=msg)
            else:
                ef_messagebox(msg, "이지폼 찾기")

        if pmode == "scan":
            if not _ef_find_list()[2]:
                precheck_fail("이지폼 [매출 거래명세서 목록 → 매출처별 조회] 를 먼저 띄워 두세요.")
                return
            if _ef_open_form(_ef_find_list()[0]):
                precheck_fail("열려 있는 상세명세서 창을 먼저 닫고(ESC), 목록만 띄워 두세요.")
                return
        elif not ef_focus_easyform():
            ef_messagebox("이지폼에서 옮길 상세명세서를 먼저 열어두세요.", "이지폼 가져오기")
            return
        # 한 번 더 확인([이지폼 입력] 과 같은 방식). 아니오 = 대기 상태 그대로(다시 누를 수 있음).
        if pmode == "scan" and popts.get("clues"):
            q = ("이지폼 목록 맨 위부터 명세서를 하나씩 열어\n품목·규격을 훑을까요? (키워드로 찾기)\n\n"
                 + (f"({popts.get('stopBefore')} 까지 보고 멈춥니다)\n" if popts.get("stopBefore") else "")
                 + "훑는 동안 마우스가 잠깁니다. (중단하려면 ESC)")
            title = "이지폼에서 키워드로 찾기"
        elif pmode == "scan":
            want = popts.get("findOrderNo") or ""
            q = (f"이지폼 목록 맨 위부터 명세서를 하나씩 열어\n비고에서 주문번호 {want} 를 찾을까요?\n\n"
                 + (f"({popts.get('stopBefore')} 까지 보고 멈춥니다)\n" if popts.get("stopBefore") else "")
                 + "찾는 동안 마우스가 잠깁니다. (중단하려면 ESC)")
            title = "이지폼에서 찾기"
        else:
            q = ("열려 있는 상세명세서를 홈페이지 명세서로 가져올까요?\n\n"
                 "가져오는 동안 마우스가 잠깁니다. (중단하려면 ESC)")
            title = "이지폼에서 가져오기"
        if not auto and not ef_confirm(q, title):
            return
        with _EF_LOCK:
            if _EF_PULL["id"] != pid or _EF_PULL["state"] != "waiting":
                return  # 확인창 떠 있는 사이 웹에서 취소/만료
            _EF_PULL["state"] = "running"
        busy["v"] = True
        win.withdraw()
        if pmode == "scan":
            show_overlay("명세서를 하나씩 열어 확인하는 동안 마우스가 잠깁니다.")
            if popts.get("clues") and popts.get("keywords"):
                kw_show(popts["keywords"])
        else:
            show_overlay("가져오는 동안에는 마우스가 잠깁니다.")
            ef_focus_easyform()

        def on_progress(n, total_n, date):
            with _EF_LOCK:
                if _EF_PULL["id"] == pid:
                    _EF_PULL["progress"] = ef_progress_text(n, date)
            _EF_UI_QUEUE.put(("pull_progress", pid, ef_progress_text(n, date)))

        def on_hit(date, total, kws, texts):
            _EF_UI_QUEUE.put(("pull_hit", pid, date, total, kws, texts))

        def worker():
            time.sleep(0.4)
            stmts: list = []
            try:
                if pmode == "scan":
                    ok, msg, stmts = run_easyform_scan(popts, on_progress, on_hit)
                    rows = []
                    ok = ok or bool(stmts)  # 중간에 멈춰도 읽은 건 넘긴다(메시지에 이유)
                else:
                    ok, msg, rows = run_easyform_extract()
            except Exception as e:  # noqa: BLE001
                ok, msg, rows = False, f"오류: {e}", []
                logging.exception("이지폼 가져오기 오류(UI)")
            with _EF_LOCK:
                if _EF_PULL["id"] == pid:
                    _EF_PULL.update(state="done" if ok else "error", rows=rows, statements=stmts, message=msg,
                                    header=list(_EF_LAST_HEADER) if pmode != "scan" else ["", ""])
            _EF_UI_QUEUE.put(("pull_result", ok, msg, len(stmts) if pmode == "scan" else len(rows), pmode))

        threading.Thread(target=worker, daemon=True).start()

    def on_btn():
        if mode["v"] == "pull":
            on_pull()
        else:
            on_fill()

    def on_close():
        win.withdraw()  # X = 숨김(종료 아님). 가져오기 대기 중이었으면 취소로 본다.
        if mode["v"] == "pull":
            with _EF_LOCK:
                if _EF_PULL["state"] == "waiting":
                    _EF_PULL["state"] = "idle"

    btn.config(command=on_btn)
    done_btn.config(command=hide_overlay)
    win.protocol("WM_DELETE_WINDOW", on_close)
    win.withdraw()

    def poll():
        try:
            while True:
                cmd = _EF_UI_QUEUE.get_nowait()
                if cmd[0] == "show":
                    set_staged(cmd[1])
                elif cmd[0] == "trigger":   # F6 보조 트리거 → 버튼과 동일 흐름
                    on_fill()
                elif cmd[0] == "pull_show":
                    set_pull(cmd[1] if len(cmd) > 1 else "one")
                elif cmd[0] == "pull_auto":  # 단서로 고른 1건 열기 — 웹에서 이미 확인, 바로 실행
                    mode["v"] = "pull"
                    busy["v"] = False
                    on_pull(auto=True)
                elif cmd[0] == "pull_progress":
                    with _EF_LOCK:
                        live = _EF_PULL["id"] == cmd[1] and _EF_PULL["state"] == "running"
                    if live:
                        prog_lbl.config(text=cmd[2])
                elif cmd[0] == "pull_hit":
                    with _EF_LOCK:
                        live = _EF_PULL["id"] == cmd[1] and _EF_PULL["state"] == "running"
                    if live:
                        kw_add(*cmd[2:])
                elif cmd[0] == "pull_cancel":
                    if mode["v"] == "pull" and not busy["v"]:
                        win.withdraw()
                elif cmd[0] == "pull_result":
                    ok, msg, n = cmd[1], cmd[2], cmd[3]
                    kw_hide()
                    with _EF_LOCK:
                        ret = _EF_PULL.get("return_hwnd")
                    if ok and ret:
                        # 성공 → 워처 완료판 없이 바로 홈페이지 명세서 화면으로(결과·확인창은 웹이 띄움).
                        hide_overlay()
                        if not ef_force_foreground(ret):
                            root.after(300, lambda h=ret: ef_force_foreground(h))
                        logging.info("이지폼 가져오기 성공 — 홈페이지 창으로 복귀: %s", msg)
                        continue
                    if len(cmd) > 4 and cmd[4] == "scan":
                        show_done(ok, msg, ok_text=("✅ " if n else "🔍 ") + f"{msg}\n홈페이지 화면에서 확인하세요.")
                    else:
                        show_done(ok, msg, ok_text=f"✅ {n}줄을 가져왔어요.\n홈페이지 명세서 화면에서 확인하세요.")
                    logging.info("이지폼 가져오기 %s — %s", "성공" if ok else "실패/중단", msg)
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
