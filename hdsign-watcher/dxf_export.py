"""FlexiSIGN '외부 파일로 저장 → DXF' 자동화 + dxf_dims 파싱 → 오브젝트별 mm 지오메트리 추출.

검증된 레시피(2026-06-17, _dxf_export_probe.py 에서 20여 회 시도 끝에 확정). 워처 인쇄 흐름에서
`extract_dimensions()` 를 호출해, 현재 활성 FlexiSIGN 문서의 오브젝트별 가로세로(mm)를 뽑는다.

핵심 레시피(절대 함부로 바꾸지 말 것 — 메모리 worksheet-dimension-overlay 참고):
  - 메뉴 '외부 파일로 저장' = 명령ID 51744 (WM_COMMAND). 대화상자 #32770.
  - 컨트롤: 형식콤보 1136, 파일명 edit 1152, 저장 IDOK=1. '옵션무시' 1011/'선택만' 1009 는 중첩
    자식이라 EnumChildWindows 로 찾는다.
  - ★ '옵션무시' 체크 반드시 해제(물리 클릭). 켜져 있으면 사이즈가 틀리게 저장됨.
  - ★ 형식=DXF: 콤보 실제 클릭(드롭다운)→ ComboLBox 행 클릭(DXF=인덱스2). 메시지(CB_SETCURSEL)는
    실제 export 형식에 반영 안 됨(EPS/PSD 로 샘).
  - 파일명: WM_SETTEXT 로 통째 교체(경로 없이 이름만 → 현재폴더=활성 .fs 폴더에 저장). Ctrl+A 안 먹음.
  - 저장: 입력칸 클릭(포커스) + 물리 Enter. 메시지로는 comdlg 저장 완료 안 됨(0바이트).
  - 옵션무시 해제 시 저장 후 'DXF 선택 사항' 옵션창(#32770) 뜸 → Enter 로 확정. 그러면 좌표가
    표시단위(mm)로 저장됨($INSUNITS 없음) → dxf_dims 기본단위 mm.
  - 형식 지속성: 저장한 형식으로 기억됨 → 끝나고 더미 AI 저장+삭제로 AI 복원.

모든 함수는 실패해도 예외를 던지지 않고 None/False 반환(부차 기능 — 인쇄/업로드 본류 보호).
입력가드(저수준 훅)로 자동화 중 작업자 물리입력 차단(주입 입력은 통과). 함수 import 시 win32 필요.
"""

from __future__ import annotations

import ctypes
import threading
import time
from ctypes import wintypes
from pathlib import Path

try:
    import dxf_dims
except Exception:  # pragma: no cover
    dxf_dims = None

u = ctypes.windll.user32
k = ctypes.windll.kernel32

# ── win32 상수 ──
WM_COMMAND = 0x0111
WM_CLOSE = 0x0010
WM_SETTEXT = 0x000C
WM_GETTEXT = 0x000D
WM_GETTEXTLENGTH = 0x000E
CB_GETCURSEL = 0x0147
CB_GETITEMHEIGHT = 0x0154
BM_GETCHECK = 0x00F0
VK_RETURN = 0x0D

EXPORT_MENU_ID = 51744          # '외부 파일로 저장'
DLG_COMBO_FORMAT = 1136
DLG_EDIT_FILENAME = 1152
DLG_BTN_SAVE = 1                # IDOK
CHK_SUPPRESS_OPTS = 1011        # '옵션 무시'
CHK_SELECTION_ONLY = 1009       # '선택만'
DXF_ROW = 2                     # 형식 콤보: 0=AI, 1=PSD, 2=DXF
AI_ROW = 0                      # ADOBE Illustrator

u.GetWindowTextLengthW.restype = ctypes.c_int
u.GetWindowTextLengthW.argtypes = [ctypes.c_void_p]
u.GetWindowTextW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_int]
u.IsWindowVisible.argtypes = [ctypes.c_void_p]
u.GetClassNameW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_int]
u.GetForegroundWindow.restype = ctypes.c_void_p
u.SendMessageW.restype = ctypes.c_long
u.SendMessageW.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p]
u.PostMessageW.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p]
u.GetDlgItem.restype = ctypes.c_void_p
u.GetDlgItem.argtypes = [ctypes.c_void_p, ctypes.c_int]
u.GetDlgCtrlID.argtypes = [ctypes.c_void_p]


# ════════════════════════ 입력 잠금 가드 (field_agent 와 동일 방식) ════════════════════════
# 저수준 훅(WH_*_LL)으로 '주입(injected)되지 않은' 물리 입력만 삼키고, 우리 keybd_event/mouse_event
# (INJECTED 플래그)는 통과. 물리 ESC = 중단 신호. 자동화 끝나면 반드시 stop.
_guard_abort = threading.Event()
_guard_tid = 0
_guard_refs: list = []
_GUARD_AVAILABLE = False
try:
    _WH_MOUSE_LL = 14
    _WH_KEYBOARD_LL = 13
    _WM_QUIT = 0x0012
    _LLMHF_INJECTED = 0x00000001
    _LLKHF_INJECTED = 0x00000010
    _VK_ESCAPE = 0x1B
    _LRESULT = ctypes.c_ssize_t
    _HOOKPROC = ctypes.WINFUNCTYPE(_LRESULT, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM)

    class _KBDLL(ctypes.Structure):
        _fields_ = [("vkCode", wintypes.DWORD), ("scanCode", wintypes.DWORD),
                    ("flags", wintypes.DWORD), ("time", wintypes.DWORD),
                    ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]

    class _MSLL(ctypes.Structure):
        _fields_ = [("pt", wintypes.POINT), ("mouseData", wintypes.DWORD),
                    ("flags", wintypes.DWORD), ("time", wintypes.DWORD),
                    ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]

    _gu = u
    _gk = k
    _gu.SetWindowsHookExW.argtypes = [ctypes.c_int, _HOOKPROC, wintypes.HINSTANCE, wintypes.DWORD]
    _gu.SetWindowsHookExW.restype = wintypes.HHOOK
    _gu.CallNextHookEx.argtypes = [wintypes.HHOOK, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM]
    _gu.CallNextHookEx.restype = _LRESULT
    _gu.UnhookWindowsHookEx.argtypes = [wintypes.HHOOK]
    _gu.GetMessageW.argtypes = [ctypes.c_void_p, wintypes.HWND, wintypes.UINT, wintypes.UINT]
    _gu.GetMessageW.restype = ctypes.c_int
    _gu.PostThreadMessageW.argtypes = [wintypes.DWORD, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    _gk.GetCurrentThreadId.restype = wintypes.DWORD
    _gk.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
    _gk.GetModuleHandleW.restype = wintypes.HMODULE

    def _mouse_proc(nCode, wParam, lParam):
        if nCode >= 0:
            ms = ctypes.cast(lParam, ctypes.POINTER(_MSLL)).contents
            if not (ms.flags & _LLMHF_INJECTED):
                return 1
        return _gu.CallNextHookEx(None, nCode, wParam, lParam)

    def _kbd_proc(nCode, wParam, lParam):
        if nCode >= 0:
            kb = ctypes.cast(lParam, ctypes.POINTER(_KBDLL)).contents
            if not (kb.flags & _LLKHF_INJECTED):
                if kb.vkCode == _VK_ESCAPE:
                    _guard_abort.set()
                return 1
        return _gu.CallNextHookEx(None, nCode, wParam, lParam)

    def _guard_thread():
        global _guard_tid
        _guard_tid = _gk.GetCurrentThreadId()
        hInst = _gk.GetModuleHandleW(None)
        mp = _HOOKPROC(_mouse_proc)
        kp = _HOOKPROC(_kbd_proc)
        _guard_refs[:] = [mp, kp]
        hM = _gu.SetWindowsHookExW(_WH_MOUSE_LL, mp, hInst, 0)
        hK = _gu.SetWindowsHookExW(_WH_KEYBOARD_LL, kp, hInst, 0)
        msg = wintypes.MSG()
        while _gu.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            pass
        if hM:
            _gu.UnhookWindowsHookEx(hM)
        if hK:
            _gu.UnhookWindowsHookEx(hK)

    _GUARD_AVAILABLE = True
except Exception:
    _GUARD_AVAILABLE = False


def input_guard_start() -> bool:
    if not _GUARD_AVAILABLE:
        return False
    _guard_abort.clear()
    threading.Thread(target=_guard_thread, daemon=True).start()
    time.sleep(0.06)
    return True


def input_guard_stop() -> None:
    global _guard_tid
    if _GUARD_AVAILABLE and _guard_tid:
        _gu.PostThreadMessageW(_guard_tid, _WM_QUIT, 0, 0)
        _guard_tid = 0


def input_guard_aborted() -> bool:
    return _guard_abort.is_set()


# ════════════════════════ win32 헬퍼 ════════════════════════
class _RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


def _class_name(h) -> str:
    b = ctypes.create_unicode_buffer(256)
    u.GetClassNameW(h, b, 256)
    return b.value or ""


def _win_text(h) -> str:
    n = u.GetWindowTextLengthW(h)
    if n <= 0:
        return ""
    b = ctypes.create_unicode_buffer(n + 1)
    u.GetWindowTextW(h, b, n + 1)
    return b.value or ""


def _ctrl_text(ctrl) -> str:
    n = u.SendMessageW(ctypes.c_void_p(ctrl), WM_GETTEXTLENGTH, None, None)
    b = ctypes.create_unicode_buffer(int(n) + 1)
    u.SendMessageW(ctypes.c_void_p(ctrl), WM_GETTEXT, ctypes.c_void_p(int(n) + 1), ctypes.cast(b, ctypes.c_void_p))
    return b.value or ""


def _combo_cursel(combo) -> int:
    return u.SendMessageW(ctypes.c_void_p(combo), CB_GETCURSEL, None, None)


def _rect(h) -> _RECT:
    r = _RECT()
    u.GetWindowRect(ctypes.c_void_p(h), ctypes.byref(r))
    return r


def _click(x, y) -> None:
    u.SetCursorPos(int(x), int(y)); time.sleep(0.04)
    u.mouse_event(0x0002, 0, 0, 0, 0); time.sleep(0.02)
    u.mouse_event(0x0004, 0, 0, 0, 0); time.sleep(0.05)


def _press(vk) -> None:
    s = u.MapVirtualKeyW(vk, 0)
    u.keybd_event(vk, s, 0, 0)
    u.keybd_event(vk, s, 2, 0)


def _force_fg(hwnd) -> bool:
    VK_MENU = 0x12
    for _ in range(3):
        u.keybd_event(VK_MENU, 0, 0, 0)
        u.keybd_event(VK_MENU, 0, 2, 0)
        try:
            u.BringWindowToTop(ctypes.c_void_p(hwnd))
            u.SetForegroundWindow(ctypes.c_void_p(hwnd))
        except Exception:
            pass
        time.sleep(0.2)
        if u.GetForegroundWindow() == hwnd:
            return True
    return False


def _wait_export_dialog(main_hwnd, timeout=5.0) -> int:
    end = time.time() + timeout
    while time.time() < end:
        fg = u.GetForegroundWindow()
        if fg and int(fg) != main_hwnd and _class_name(fg) == "#32770":
            if "외부 파일로 저장" in _win_text(fg) or "저장" in _win_text(fg):
                return int(fg)
            return int(fg)
        time.sleep(0.1)
    return 0


def _find_child_by_id(parent, ctrlid) -> int:
    found = [0]
    ENUM = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)

    def cb(h, _l):
        try:
            if u.GetDlgCtrlID(ctypes.c_void_p(h)) == ctrlid:
                found[0] = int(h)
                return False
        except Exception:
            pass
        return True

    u.EnumChildWindows(ctypes.c_void_p(parent), ENUM(cb), 0)
    return found[0]


def find_flexisign_window(exe_hint="app.exe") -> int:
    """최상단 FlexiSIGN 메인 창(표준 메뉴 보유) hwnd. 못 찾으면 0."""
    found = []
    ENUM = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    k.OpenProcess.restype = ctypes.c_void_p
    k.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    k.QueryFullProcessImageNameW.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_ulong)]
    k.CloseHandle.argtypes = [ctypes.c_void_p]
    u.GetWindowThreadProcessId.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
    u.GetMenu.restype = ctypes.c_void_p
    u.GetMenu.argtypes = [ctypes.c_void_p]

    def _proc(pid):
        h = k.OpenProcess(0x1000, False, pid)
        if not h:
            return ""
        try:
            buf = ctypes.create_unicode_buffer(32768)
            sz = ctypes.c_ulong(32768)
            if k.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(sz)):
                return (buf.value or "").lower()
        finally:
            k.CloseHandle(h)
        return ""

    def cb(h, _l):
        try:
            if not u.IsWindowVisible(h) or not _win_text(h):
                return True
            pid = ctypes.c_ulong(0)
            u.GetWindowThreadProcessId(h, ctypes.byref(pid))
            exe = _proc(pid.value)
            if "flexi" not in exe and not exe.endswith("\\" + exe_hint):
                return True
            hi = int(h)
            found.append((hi, bool(u.GetMenu(ctypes.c_void_p(hi)))))
        except Exception:
            pass
        return True

    u.EnumWindows(ENUM(cb), 0)
    for hi, has_menu in found:
        if has_menu:
            return hi
    return found[0][0] if found else 0


# ════════════════════════ 핵심 내보내기 레시피 ════════════════════════
def _do_export(main_hwnd, fmt_row, fname, target_dirs, log, timeout=14.0):
    """대화상자 열기→옵션무시 해제→형식(fmt_row 행)→파일명(fname)→저장→옵션창/덮어쓰기 Enter.
    target_dirs 에서 fname 파일 생성 확인 후 그 Path 반환(없으면 None)."""
    _force_fg(main_hwnd)
    u.PostMessageW(ctypes.c_void_p(main_hwnd), WM_COMMAND, ctypes.c_void_p(EXPORT_MENU_ID), None)
    dlg = _wait_export_dialog(main_hwnd, timeout=5.0)
    if not dlg:
        log("[치수] 외부파일로저장 대화상자가 안 떴음")
        return None
    time.sleep(0.15)
    combo = u.GetDlgItem(ctypes.c_void_p(dlg), DLG_COMBO_FORMAT)
    edit = u.GetDlgItem(ctypes.c_void_p(dlg), DLG_EDIT_FILENAME)
    if not combo or not edit:
        log("[치수] 대화상자 컨트롤(콤보/입력칸) 못 찾음")
        return None

    # 저장 위치 = 대화상자의 현재 폴더(CDM_GETFOLDERPATH). 파일명만 넣으면 여기에 저장되므로,
    # 이 폴더를 탐색 후보 맨 앞에 둔다 → 집(로컬 .fs)/회사(네트워크) 어디서든 생성 파일을 찾는다.
    CDM_GETFOLDERPATH = 0x0402  # WM_USER+2
    dirs = list(target_dirs)
    try:
        fbuf = ctypes.create_unicode_buffer(600)
        if u.SendMessageW(ctypes.c_void_p(dlg), CDM_GETFOLDERPATH, ctypes.c_void_p(600),
                          ctypes.cast(fbuf, ctypes.c_void_p)) > 0 and fbuf.value:
            dirs.insert(0, fbuf.value)
            log(f"[치수] 저장 위치: {fbuf.value}")
    except Exception:
        pass
    target_dirs = dirs

    _force_fg(dlg)
    time.sleep(0.1)

    # 0) '옵션 무시'/'선택만' 체크 해제(켜져 있으면 물리 클릭으로 토글). 옵션무시 켜지면 사이즈 틀림.
    for cid in (CHK_SUPPRESS_OPTS, CHK_SELECTION_ONLY):
        ch = _find_child_by_id(dlg, cid)
        if ch and u.SendMessageW(ctypes.c_void_p(ch), BM_GETCHECK, None, None) == 1:
            r = _rect(ch)
            _click((r.left + r.right) // 2, (r.top + r.bottom) // 2)
            time.sleep(0.08)

    # 1) 형식 = 드롭다운 실제 클릭 → ComboLBox 의 fmt_row 행 클릭
    rc = _rect(combo)
    _click((rc.left + rc.right) // 2, (rc.top + rc.bottom) // 2)
    time.sleep(0.2)
    lb = [0]
    ENUM = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)

    def _findlb(h, _l):
        try:
            if _class_name(h) == "ComboLBox" and u.IsWindowVisible(h):
                lb[0] = int(h)
        except Exception:
            pass
        return True

    u.EnumWindows(ENUM(_findlb), 0)
    ih = u.SendMessageW(ctypes.c_void_p(combo), CB_GETITEMHEIGHT, None, None) or 16
    if lb[0]:
        lr = _rect(lb[0])
        _click((lr.left + lr.right) // 2, lr.top + ih * fmt_row + ih // 2)
    time.sleep(0.15)
    log(f"[치수] 형식 콤보 cur={_combo_cursel(combo)} (기대={fmt_row})")

    # 2) 파일명 = 이름만 통째교체(WM_SETTEXT)
    nbuf = ctypes.create_unicode_buffer(fname)
    u.SendMessageW(ctypes.c_void_p(edit), WM_SETTEXT, None, ctypes.cast(nbuf, ctypes.c_void_p))
    time.sleep(0.1)
    er = _rect(edit)
    _click((er.left + er.right) // 2, (er.top + er.bottom) // 2)
    time.sleep(0.06)
    if _ctrl_text(edit) != fname:
        u.SendMessageW(ctypes.c_void_p(edit), WM_SETTEXT, None, ctypes.cast(nbuf, ctypes.c_void_p))
        time.sleep(0.08)

    # 3) 저장 = 물리 Enter
    _press(VK_RETURN)
    time.sleep(0.3)

    # 4) 옵션창('DXF 선택 사항')/덮어쓰기 등 전면 모달 Enter + 파일 생성 대기.
    import os
    end = time.time() + timeout
    last_enter = 0.0
    while time.time() < end:
        for d in target_dirs:
            try:
                for f in os.listdir(d):
                    if f.lower() == fname.lower():
                        p = Path(d) / f
                        if p.stat().st_size > 0:
                            time.sleep(0.3)
                            return p
            except Exception:
                pass
        fg = u.GetForegroundWindow()
        if fg and int(fg) != main_hwnd and int(fg) != dlg:
            cls = _class_name(fg)
            ttl = _win_text(fg)
            low = ttl.lower()
            is_panel = any(p0 in low for p0 in ("designcentral", "fill/stroke", "stroke editor"))
            is_err = ("에러" in ttl) or ("오류" in ttl) or ("error" in low) or ("cannot" in low)
            dialogish = (cls == "#32770") or cls.startswith("Afx")
            if dialogish and is_err:
                log(f"[치수] 에러 대화상자 감지: {ttl!r} — 중단")
                return None
            if (dialogish and not is_panel and "외부 파일로 저장" not in ttl
                    and (time.time() - last_enter) > 0.8):
                _press(VK_RETURN)
                last_enter = time.time()
        time.sleep(0.2)
    log("[치수] 시간 내 파일이 안 생김")
    return None


def restore_format_ai(main_hwnd, search_dirs, log) -> None:
    """더미 AI 저장 후 삭제 → 다음 수동 내보내기 기본 형식을 AI 로 되돌림(세션 내 복원)."""
    import os
    dummy = "_hd_fmtreset.ai"
    for d in search_dirs:
        try:
            (Path(d) / dummy).unlink()
        except Exception:
            pass
    try:
        p = _do_export(main_hwnd, AI_ROW, dummy, search_dirs, log, timeout=12.0)
    except Exception as e:
        log(f"[치수] AI 복원 실패: {e}")
        p = None
    for d in search_dirs:
        try:
            fp = Path(d) / dummy
            if fp.exists():
                fp.unlink()
        except Exception:
            pass


def extract_dimensions(main_hwnd, search_dirs, log=print, restore_ai=True) -> dict | None:
    """현재 활성 FlexiSIGN 문서를 DXF 로 내보내 오브젝트별 mm 지오메트리 dict 반환(실패 None).

    search_dirs: DXF 가 저장될 후보 폴더들(활성 .fs 폴더 우선). 거기서 생성 파일을 찾아 파싱.
    입력가드로 자동화 중 작업자 물리입력 차단. 부차 기능 — 어떤 실패든 None 반환, 예외 안 던짐.
    """
    if dxf_dims is None:
        log("[치수] dxf_dims 모듈 없음 — 스킵")
        return None
    if not main_hwnd:
        log("[치수] FlexiSIGN 창 없음 — 스킵")
        return None
    import os
    fname = f"_hdsigndim_{os.getpid()}.dxf"
    geom = None
    guarded = input_guard_start()
    try:
        saved = _do_export(main_hwnd, DXF_ROW, fname, search_dirs, log, timeout=14.0)
        if saved:
            geom = dxf_dims.parse_dxf_objects(saved)
            try:
                saved.unlink()
            except Exception:
                pass
            n = len(geom.get("objects", [])) if geom else 0
            log(f"[치수] 추출 완료 — 오브젝트 {n}개, unit_mm={geom.get('unit_mm') if geom else '?'}")
        if restore_ai:
            restore_format_ai(main_hwnd, search_dirs, log)
    except Exception as e:
        log(f"[치수] 추출 중 예외(무시): {e}")
        geom = None
    finally:
        if guarded:
            input_guard_stop()
    if geom and not geom.get("objects"):
        return None
    return geom
