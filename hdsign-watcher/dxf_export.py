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
CB_GETCOUNT = 0x0146
CB_GETLBTEXT = 0x0148
BM_GETCHECK = 0x00F0
VK_RETURN = 0x0D

EXPORT_MENU_ID = 51744          # '외부 파일로 저장'
DLG_COMBO_FORMAT = 1136
DLG_EDIT_FILENAME = 1152
DLG_BTN_SAVE = 1                # IDOK
CHK_SUPPRESS_OPTS = 1011        # '옵션 무시'
CHK_SELECTION_ONLY = 1009       # '선택만'
# ⚠️ 형식은 '행 번호'가 아니라 '항목 텍스트(라벨)'로 고른다 — 외부파일저장 형식 목록의 순서는
#    PC/FlexiSIGN 버전·설치 플러그인마다 다를 수 있어(예: 이 PC=[AI,PSD,DXF] 인데 다른 PC=[PSD,AI,DXF])
#    행 번호를 박으면 다른 PC서 엉뚱한 형식을 고른다(특히 AI 복원이 PSD 등으로 새서 작동 안 함).
#    아래 _ROW 는 라벨 매칭이 실패할 때만 쓰는 '폴백 인덱스'(이 PC 기준)일 뿐이다.
DXF_ROW = 2                     # (폴백) 이 PC 형식 콤보: 0=AI, 1=PSD, 2=DXF
AI_ROW = 0                      # (폴백) ADOBE Illustrator
# 라벨 매칭 키워드(소문자 부분일치). 형식명은 보통 'Adobe Illustrator (*.ai)' / 'AutoCAD (*.dxf)'.
DXF_LABELS = ("dxf",)
AI_LABELS = ("illustrator", ".ai")
ID_FILE_NEW = 57600             # 표준 MFC ID_FILE_NEW (파일>새로 만들기) — WM_COMMAND 로 결정적 호출
BM_CLICK = 0x00F5

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
u.GetParent.restype = ctypes.c_void_p
u.GetParent.argtypes = [ctypes.c_void_p]


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


def _combo_items(combo) -> list:
    """콤보(형식 드롭다운)의 모든 항목 텍스트를 순서대로 반환."""
    out = []
    try:
        n = int(u.SendMessageW(ctypes.c_void_p(combo), CB_GETCOUNT, None, None) or 0)
    except Exception:
        n = 0
    for i in range(max(0, n)):
        try:
            buf = ctypes.create_unicode_buffer(260)
            u.SendMessageW(ctypes.c_void_p(combo), CB_GETLBTEXT, ctypes.c_void_p(i), ctypes.cast(buf, ctypes.c_void_p))
            out.append(buf.value or "")
        except Exception:
            out.append("")
    return out


def _combo_find_row(combo, keywords) -> int:
    """keywords 중 하나라도 (소문자 부분일치로) 포함하는 첫 항목의 행 인덱스. 없으면 -1.
    형식 목록 순서가 PC마다 달라도 라벨로 정확히 고르기 위함(행 번호 하드코딩 회피)."""
    for i, t in enumerate(_combo_items(combo)):
        tl = (t or "").lower()
        if any(k in tl for k in keywords):
            return i
    return -1


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


def _find_mdiclient(main_hwnd) -> int:
    """FlexiSIGN 메인 프레임의 MDIClient 창 hwnd(문서창들의 부모). 못 찾으면 0."""
    res = [0]
    ENUM = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)

    def cb(h, _l):
        try:
            if _class_name(h) == "MDIClient":
                res[0] = int(h)
        except Exception:
            pass
        return True

    u.EnumChildWindows(ctypes.c_void_p(main_hwnd), ENUM(cb), 0)
    return res[0]


def _mdi_children(mdiclient) -> list:
    """MDIClient 직계 자식(열린 문서창) hwnd 목록."""
    out = []
    if not mdiclient:
        return out
    ENUM = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)

    def cb(h, _l):
        try:
            if u.GetParent(ctypes.c_void_p(h)) == mdiclient:
                out.append(int(h))
        except Exception:
            pass
        return True

    u.EnumChildWindows(ctypes.c_void_p(mdiclient), ENUM(cb), 0)
    return out


def _discard_save_prompt() -> bool:
    """떠 있는 '변경 내용 저장?' 프롬프트(#32770, 도구패널 제외)의 '저장 안 함' 버튼 클릭. 처리 시 True.
    (Enter 는 기본=저장이라 위험 → '저장 안 함'(저장+안) 버튼을 직접 클릭해 버리고 닫는다.)"""
    done = [False]
    ENUM = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)

    def find_prompt(h, _l):
        try:
            if u.IsWindowVisible(h) and _class_name(h) == "#32770":
                low = _win_text(h).lower()
                if not any(p in low for p in ("designcentral", "fill/stroke", "stroke editor")):
                    BENUM = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)

                    def bcb(bh, _bl):
                        try:
                            if _class_name(bh) == "Button":
                                t = _win_text(bh)
                                if ("저장" in t) and ("안" in t):
                                    u.SendMessageW(ctypes.c_void_p(bh), BM_CLICK, None, None)
                                    done[0] = True
                                    return False
                        except Exception:
                            pass
                        return True

                    u.EnumChildWindows(ctypes.c_void_p(h), BENUM(bcb), 0)
        except Exception:
            pass
        return True

    u.EnumWindows(ENUM(find_prompt), 0)
    return done[0]


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
def _do_export(main_hwnd, fmt_row, fname, target_dirs, log, timeout=14.0, wait_for_file=True, fmt_labels=None):
    """대화상자 열기→옵션무시 해제→형식 선택→파일명(fname)→저장→옵션창/덮어쓰기 Enter.
    형식 선택: fmt_labels(라벨 키워드)가 있으면 콤보 항목 텍스트로 그 형식의 행을 찾아 고른다
       (형식 목록 순서가 PC마다 달라도 정확). 라벨 매칭 실패 시에만 fmt_row(폴백 인덱스) 사용.
    wait_for_file=True: target_dirs 에서 fname 파일 생성 확인 후 그 Path 반환(없으면 None).
    wait_for_file=False: 파일 생성을 기다리지 않고, 짧게 모달만 닫아준 뒤 None 반환(형식 복원용 —
       AI 내보내기가 느려도 형식은 저장 클릭 시점에 이미 바뀌므로 파일 완성 대기 불필요)."""
    _force_fg(main_hwnd)
    u.PostMessageW(ctypes.c_void_p(main_hwnd), WM_COMMAND, ctypes.c_void_p(EXPORT_MENU_ID), None)
    dlg = _wait_export_dialog(main_hwnd, timeout=5.0)
    if not dlg:
        log("[치수] 외부파일로저장 대화상자가 안 떴음")
        return None
    time.sleep(0.08)
    combo = u.GetDlgItem(ctypes.c_void_p(dlg), DLG_COMBO_FORMAT)
    edit = u.GetDlgItem(ctypes.c_void_p(dlg), DLG_EDIT_FILENAME)
    if not combo or not edit:
        log("[치수] 대화상자 컨트롤(콤보/입력칸) 못 찾음")
        return None

    # 형식 행 결정 — 라벨(항목 텍스트)로 찾는 게 1순위. 형식 목록 순서가 PC/버전마다 달라도 정확.
    # 못 찾으면 fmt_row(이 PC 기준 폴백 인덱스) 사용. 목록 전체를 로그로 남겨 PC별 순서를 확인한다.
    target_row = fmt_row
    if fmt_labels:
        items = _combo_items(combo)
        found = _combo_find_row(combo, fmt_labels)
        if found >= 0:
            target_row = found
            log(f"[치수] 형식 라벨매칭 → {found}행 ('{items[found]}') / 목록={items}")
        else:
            log(f"[치수] 형식 라벨매칭 실패({fmt_labels}) — 폴백 {fmt_row}행 / 목록={items}")

    # fname 이 전체경로면 그 폴더에 저장되므로(WM_SETTEXT 가 경로 포함을 처리), 그 폴더를 탐색 1순위로.
    # 추가로 대화상자 현재 폴더(CDM_GETFOLDERPATH)도 가능하면 보탠다(옛 대화상자에선 0 반환할 수 있음).
    CDM_GETFOLDERPATH = 0x0402  # WM_USER+2
    base = Path(fname).name
    # 방어: wait_for_file(=DXF) 인데 정확히 같은 경로의 잔여 파일이 있으면 '덮어쓰기 확인창'이 뜨고,
    # 대기루프가 저장 완료 전에 그 옛 파일을 새 파일로 오인·반환해 모달이 남는다. 미리 지워 둔다.
    if wait_for_file:
        try:
            Path(fname).unlink()
        except Exception:
            pass
    dirs = list(target_dirs)
    pdir = str(Path(fname).parent)
    if pdir and pdir not in ('.', ''):
        dirs.insert(0, pdir)
    try:
        fbuf = ctypes.create_unicode_buffer(600)
        if u.SendMessageW(ctypes.c_void_p(dlg), CDM_GETFOLDERPATH, ctypes.c_void_p(600),
                          ctypes.cast(fbuf, ctypes.c_void_p)) > 0 and fbuf.value:
            dirs.insert(0, fbuf.value)
            log(f"[치수] 저장 위치(대화상자): {fbuf.value}")
    except Exception:
        pass
    target_dirs = dirs

    _force_fg(dlg)
    time.sleep(0.06)

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
    time.sleep(0.15)
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
        _click((lr.left + lr.right) // 2, lr.top + ih * target_row + ih // 2)
    time.sleep(0.1)
    log(f"[치수] 형식 콤보 cur={_combo_cursel(combo)} (기대={target_row})")

    # 2) 파일명 = 이름만 통째교체(WM_SETTEXT)
    nbuf = ctypes.create_unicode_buffer(fname)
    u.SendMessageW(ctypes.c_void_p(edit), WM_SETTEXT, None, ctypes.cast(nbuf, ctypes.c_void_p))
    time.sleep(0.06)
    er = _rect(edit)
    _click((er.left + er.right) // 2, (er.top + er.bottom) // 2)
    time.sleep(0.06)
    if _ctrl_text(edit) != fname:
        u.SendMessageW(ctypes.c_void_p(edit), WM_SETTEXT, None, ctypes.cast(nbuf, ctypes.c_void_p))
        time.sleep(0.08)

    # 3) 저장 = 물리 Enter
    _press(VK_RETURN)
    time.sleep(0.12)

    # 4) 옵션창('DXF/AI 선택 사항')/덮어쓰기 등 전면 모달 Enter + (옵션) 파일 생성 대기.
    import os
    end = time.time() + timeout
    last_enter = 0.0
    clear_streak = 0  # 전면 모달이 없는 연속 횟수 — 형식복원(wait_for_file=False)은 모달이 닫히면 즉시 복귀.
    while time.time() < end:
        if wait_for_file:
            for d in target_dirs:
                try:
                    for f in os.listdir(d):
                        if f.lower() == base.lower():
                            p = Path(d) / f
                            if p.stat().st_size > 0:
                                time.sleep(0.2)
                                return p
                except Exception:
                    pass
        fg = u.GetForegroundWindow()
        if fg and int(fg) != main_hwnd and int(fg) != dlg:
            clear_streak = 0
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
        else:
            # 전면 모달 없음(옵션창까지 닫힘). 형식복원은 저장 Enter 시점에 이미 AI 로 바뀌었으니
            # 더는 기다릴 필요 없이 즉시 복귀 → 매크로 직후 '몇 초 헛대기' 제거.
            clear_streak += 1
            if not wait_for_file and clear_streak >= 2:
                return None
        time.sleep(0.1)
    if wait_for_file:
        log("[치수] 시간 내 파일이 안 생김")
    return None


def restore_format_ai(main_hwnd, search_dirs, log) -> None:
    """형식 복원: '새 빈 문서'를 만들어 그걸 AI 로 export → '외부 파일로 저장'의 기본 형식=AI +
    마지막 폴더=지시서폴더 로 되돌린다(세션 내 메모리 상태). 빈 문서라 export 파일이 ~0.7KB 로,
    현재 작업 문서를 그대로 AI export 할 때의 50MB+(사진 임베드)가 네트워크에 써졌다 지워지는 걸 회피한다.
    작업자 문서는 안 건드린다(우리가 만든 새 문서창만 hwnd 로 WM_CLOSE).

    ※ 레지스트리(HKCU\\...\\AExportTool)로는 불가 — FlexiSIGN 은 세션 중 레지스트리를 다시 읽지 않고
      메모리 상태만 쓰며(콤보가 메모리값 표시), 레지스트리는 종료 시에만 기록한다(2026-06-18 실측 확인).
      그래서 '실제 export'만이 형식/폴더를 바꾼다.
    ※ New=WM_COMMAND(ID_FILE_NEW) / Close=WM_CLOSE(자식 hwnd) — 둘 다 메시지라 포커스 무관(키 입력은
      export 직후 포커스 미정착으로 불안정). 호출 시점엔 이미 입력가드가 걸려 있다(extract_dimensions)."""
    import os
    import glob
    import tempfile
    import threading
    import time as _t
    tmp = tempfile.gettempdir()
    save_dir = None
    for d in (search_dirs or []):
        try:
            if d and os.path.isdir(d):
                save_dir = d
                break
        except Exception:
            pass
    if not save_dir:
        save_dir = tmp

    mc = _find_mdiclient(main_hwnd)
    if not mc:
        log("[치수] MDIClient 못 찾음 — AI 복원 스킵")
        return
    before = set(_mdi_children(mc))

    # 1) 새 빈 문서(메시지, 포커스 무관) + 새 자식창 hwnd 폴링 포착(고정 sleep 없이 등장 즉시).
    new_hwnd = 0
    for _attempt in range(3):
        _force_fg(main_hwnd)
        u.PostMessageW(ctypes.c_void_p(main_hwnd), WM_COMMAND, ctypes.c_void_p(ID_FILE_NEW), None)
        end = time.time() + 1.2
        while time.time() < end:
            fresh = [h for h in _mdi_children(mc) if h not in before]
            if fresh:
                new_hwnd = fresh[0]
                break
            time.sleep(0.05)
        if new_hwnd:
            break
    if not new_hwnd:
        log("[치수] 새 문서 생성 실패 — AI 복원 스킵")
        return

    # 2) 빈 문서를 AI 로 export → save_dir(지시서폴더). 고유이름이라 덮어쓰기창 없음. 파일 대기 X.
    dummy = os.path.join(save_dir, f"_hd_fmtreset_{os.getpid()}_{int(_t.time())}.ai")
    try:
        _do_export(main_hwnd, AI_ROW, dummy, search_dirs, log, timeout=8.0, wait_for_file=False, fmt_labels=AI_LABELS)
    except Exception as e:
        log(f"[치수] AI 복원 export 실패: {e}")

    # 3) 우리가 만든 새 문서창만 닫기(WM_CLOSE, 포커스 무관). 빈 문서라 보통 프롬프트 없음 — 떠도 '저장 안 함'.
    #    자식이 사라질 때까지 폴링(고정 sleep 없이).
    u.PostMessageW(ctypes.c_void_p(new_hwnd), WM_CLOSE, None, None)
    cend = time.time() + 1.5
    while time.time() < cend:
        if new_hwnd not in _mdi_children(mc):
            break
        _discard_save_prompt()
        time.sleep(0.06)

    # 4) 더미 .ai 백그라운드 정리(재시도) — 풀릴 때까지. '내 pid' 것만(타 PC 동시작업 보호).
    def _cleanup_dummies():
        for _ in range(15):
            _t.sleep(1.0)
            remaining = False
            for d in {save_dir, tmp}:
                for old in glob.glob(os.path.join(d, f"_hd_fmtreset_{os.getpid()}_*.ai")):
                    try:
                        os.remove(old)
                    except Exception:
                        remaining = True
            if not remaining:
                return

    threading.Thread(target=_cleanup_dummies, daemon=True).start()


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
    import glob
    import tempfile
    # ★ 저장 위치 = 활성 .fs 가 있는 폴더(search_dirs[0]). Temp 에 저장하면 FlexiSIGN '외부 파일로 저장'의
    #   '마지막 폴더'가 Temp 로 바뀌어, 작업자가 나중에 수동으로 외부파일저장 할 때 Temp 가 열려 불편하다.
    #   지시서 폴더에 저장하면 마지막 폴더가 그대로 그 폴더로 유지된다(작업자 자연 위치). 25KB 소형 DXF 라
    #   네트워크여도 빠르고 파싱 직후 삭제한다. .fs 폴더를 못 받으면 temp 폴백.
    # ★ 파일명은 매번 '고유'(pid+시각). 같은 이름이면 '덮어쓰기 확인창'이 떠 대기루프가 (덮어쓰기 확정 전에)
    #   옛 파일을 먼저 반환→그 모달이 남아 이어지는 AI복원이 외부파일저장 메뉴를 못 열던 멈춤이 났다
    #   (restore_format_ai 더미 .ai 를 고유로 둔 것과 같은 이유).
    tmp = tempfile.gettempdir()
    save_dir = None
    for d in (search_dirs or []):
        try:
            if d and os.path.isdir(d):
                save_dir = d
                break
        except Exception:
            pass
    if not save_dir:
        save_dir = tmp
    # 이전 잔여 추출 DXF 청소(unlink 가 FlexiSIGN 파일잠금으로 조용히 실패해 남았을 수 있음). 내 pid 것만
    #   지운다(다른 사무실 PC 가 같은 네트워크 폴더에 동시 추출 중일 수 있어 전체삭제는 위험).
    for d in {save_dir, tmp}:
        for old in glob.glob(os.path.join(d, f"_hdsigndim_{os.getpid()}_*.dxf")):
            try:
                os.remove(old)
            except Exception:
                pass
    fname = str(Path(save_dir) / f"_hdsigndim_{os.getpid()}_{int(time.time())}.dxf")
    geom = None
    guarded = input_guard_start()
    try:
        saved = _do_export(main_hwnd, DXF_ROW, fname, search_dirs, log, timeout=14.0, fmt_labels=DXF_LABELS)
        if saved:
            geom = dxf_dims.parse_dxf_objects(saved)
            # 파싱 직후 즉시 삭제(지시서 폴더에 임시 DXF 잔재 안 남게). 네트워크 파일이 잠깐 잠겨
            # 실패하면 백그라운드로 재시도 — 작업자 폴더를 깨끗하게 유지.
            try:
                saved.unlink()
            except Exception:
                def _retry_rm(p=saved):
                    for _ in range(10):
                        time.sleep(1.0)
                        try:
                            p.unlink()
                            return
                        except Exception:
                            pass
                threading.Thread(target=_retry_rm, daemon=True).start()
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
    # 잔재 정리(백그라운드 재시도) — FlexiSIGN 이 '전체경로' 파일명을 받으면 실제 DXF 는 현재폴더에 쓰고
    # 지정폴더엔 0바이트를 만들 수 있다(대화상자 현재폴더 ≠ 지정폴더일 때). saved.unlink 는 '찾은' 파일만
    # 지우므로 그 0바이트 디코이가 거래처 폴더에 남을 수 있어, 내 pid DXF 를 모두 청소한다(타 PC 보호 위해 pid 한정).
    def _final_dxf_cleanup():
        import os as _o
        import glob as _g
        for _ in range(8):
            time.sleep(1.0)
            remaining = False
            for d in {save_dir, tmp}:
                for old in _g.glob(_o.path.join(d, f"_hdsigndim_{_o.getpid()}_*.dxf")):
                    try:
                        _o.remove(old)
                    except Exception:
                        remaining = True
            if not remaining:
                return

    threading.Thread(target=_final_dxf_cleanup, daemon=True).start()
    if geom and not geom.get("objects"):
        return None
    return geom
