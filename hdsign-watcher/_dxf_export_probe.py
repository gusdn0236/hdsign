r"""[1단계 진단 v2] FlexiSIGN DXF 자동 내보내기 - 메뉴/대화상자 구조 탐침.

FlexiSIGN 메뉴는 오너드로(owner-drawn)라 GetMenuString 으로 라벨을 못 읽는다.
그래서 라벨 대신 '위치(position) + 명령ID' 를 전부 덤프한다(ID 는 라벨 없이도 읽힌다).
사용자가 실제 메뉴에서 '외부 파일로 저장' 이 [파일] 메뉴의 몇 번째인지 알려주면 ID 를 확정한다.

사용법:
  1) 메뉴/레지스트리 덤프(안전, 호출 안 함):
       py _dxf_export_probe.py
  2) 특정 ID 가 내보내기 대화상자를 여는지 확인 + 대화상자 컨트롤 덤프(취소로 닫음):
       py _dxf_export_probe.py --invoke 1234

안전: 저장 안 함(대화상자는 Cancel/닫기), 레지스트리는 읽기만.
"""

from __future__ import annotations

import ctypes
import sys
import time
from ctypes import wintypes

# UTF-8 로 출력 — bash(!) 캡처가 UTF-8 로 읽으므로 한글이 안 깨지게.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

u = ctypes.windll.user32
k = ctypes.windll.kernel32

WM_COMMAND = 0x0111
WM_CLOSE = 0x0010
CB_GETCOUNT = 0x0146
CB_GETCURSEL = 0x0147
CB_GETLBTEXT = 0x0148
CB_GETLBTEXTLEN = 0x0149

u.GetWindowTextLengthW.restype = ctypes.c_int
u.GetWindowTextLengthW.argtypes = [ctypes.c_void_p]
u.GetWindowTextW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_int]
u.IsWindowVisible.argtypes = [ctypes.c_void_p]
u.GetWindowThreadProcessId.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
u.GetClassNameW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_int]
u.GetMenu.restype = ctypes.c_void_p
u.GetMenu.argtypes = [ctypes.c_void_p]
u.GetSubMenu.restype = ctypes.c_void_p
u.GetSubMenu.argtypes = [ctypes.c_void_p, ctypes.c_int]
u.GetMenuItemCount.argtypes = [ctypes.c_void_p]
u.GetMenuItemID.restype = ctypes.c_uint
u.GetMenuItemID.argtypes = [ctypes.c_void_p, ctypes.c_int]
u.GetMenuStringW.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_wchar_p, ctypes.c_int, ctypes.c_uint]
u.GetForegroundWindow.restype = ctypes.c_void_p
u.SendMessageW.restype = ctypes.c_long
u.SendMessageW.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p]
u.PostMessageW.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p]
u.GetDlgCtrlID.argtypes = [ctypes.c_void_p]
u.GetDlgItem.restype = ctypes.c_void_p
u.GetDlgItem.argtypes = [ctypes.c_void_p, ctypes.c_int]
k.OpenProcess.restype = ctypes.c_void_p
k.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
k.QueryFullProcessImageNameW.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_ulong)]
k.CloseHandle.argtypes = [ctypes.c_void_p]

MF_BYPOSITION = 0x0400
SEP = 0          # GetMenuItemID -> 0 : 구분선
POPUP = 0xFFFFFFFF  # GetMenuItemID -> -1 : 하위메뉴(팝업)


def _proc_path(pid: int) -> str:
    h = k.OpenProcess(0x1000, False, pid)
    if not h:
        return ""
    try:
        buf = ctypes.create_unicode_buffer(32768)
        size = ctypes.c_ulong(32768)
        if k.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return buf.value or ""
    finally:
        k.CloseHandle(h)
    return ""


def _win_text(hwnd) -> str:
    n = u.GetWindowTextLengthW(hwnd)
    if n <= 0:
        return ""
    buf = ctypes.create_unicode_buffer(n + 1)
    u.GetWindowTextW(hwnd, buf, n + 1)
    return buf.value or ""


def _class_name(hwnd) -> str:
    buf = ctypes.create_unicode_buffer(256)
    u.GetClassNameW(hwnd, buf, 256)
    return buf.value or ""


def _menu_label(menu, i) -> str:
    buf = ctypes.create_unicode_buffer(256)
    u.GetMenuStringW(ctypes.c_void_p(menu), i, buf, 256, MF_BYPOSITION)
    return (buf.value or "").split("\t")[0].replace("&", "").strip()


def find_flexisign_window():
    WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    found = []

    def cb(hwnd, _l):
        try:
            if not u.IsWindowVisible(hwnd):
                return True
            title = _win_text(hwnd)
            if not title:
                return True
            pid = ctypes.c_ulong(0)
            u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            exe = _proc_path(pid.value).lower()
            if "flexi" not in exe and not exe.endswith("\\app.exe"):
                return True
            h_int = int(hwnd) if hwnd else 0
            has_menu = bool(u.GetMenu(ctypes.c_void_p(h_int)))
            found.append((h_int, title, has_menu))
        except Exception:
            pass
        return True

    u.EnumWindows(WNDENUMPROC(cb), 0)
    if not found:
        return 0, None
    for h, t, m in found:
        if m:
            return h, t
    return found[0][0], found[0][1]


def dump_menu(hwnd):
    print("\n===== 메뉴 트리 (위치 + 명령ID, 라벨은 오너드로라 비어있을 수 있음) =====")
    menu = u.GetMenu(ctypes.c_void_p(hwnd))
    if not menu:
        print("  표준 Windows 메뉴 없음.")
        return
    top = u.GetMenuItemCount(ctypes.c_void_p(menu))
    for ti in range(top):
        sub = u.GetSubMenu(ctypes.c_void_p(menu), ti)
        top_label = _menu_label(menu, ti)
        if not sub:
            print(f"\n[top#{ti}] '{top_label}'  (명령? ID={u.GetMenuItemID(ctypes.c_void_p(menu), ti) & 0xFFFF})")
            continue
        cnt = u.GetMenuItemCount(ctypes.c_void_p(sub))
        print(f"\n[top#{ti}] '{top_label}'  (항목 {cnt}개)")
        for i in range(cnt):
            mid = u.GetMenuItemID(ctypes.c_void_p(sub), i)
            label = _menu_label(sub, i)
            sub2 = u.GetSubMenu(ctypes.c_void_p(sub), i)
            if mid == SEP and not sub2:
                kind = "--- 구분선 ---"
            elif sub2:
                kind = "(하위메뉴)"
            else:
                kind = f"ID={mid & 0xFFFF}"
            print(f"   pos{i:>2}: {kind:<16} label={label!r}")


def dump_registry():
    print("\n===== 레지스트리 형식 설정 (HKCU\\Software\\Amiable\\Design\\Preferences) =====")
    try:
        import winreg
        kpath = r"Software\Amiable\Design\Preferences"
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, kpath) as reg:
            for name in ("AExportTool", "ADXFExportFilter", "AHTOBitmapExportFilter"):
                try:
                    val, typ = winreg.QueryValueEx(reg, name)
                    b = bytes(val) if isinstance(val, (bytes, bytearray)) else b""
                    print(f"  {name}: type={typ} len={len(b)} head={b[:40].hex()}")
                except FileNotFoundError:
                    print(f"  {name}: (없음)")
    except Exception as e:
        print("  레지스트리 읽기 실패:", e)


def force_fg(hwnd):
    VK_MENU = 0x12
    for _ in range(3):
        u.keybd_event(VK_MENU, 0, 0, 0)
        u.keybd_event(VK_MENU, 0, 2, 0)
        try:
            u.BringWindowToTop(ctypes.c_void_p(hwnd))
            u.SetForegroundWindow(ctypes.c_void_p(hwnd))
        except Exception:
            pass
        time.sleep(0.25)
        if u.GetForegroundWindow() == hwnd:
            return True
    return False


def wait_dialog(main_hwnd, timeout=4.0):
    end = time.time() + timeout
    while time.time() < end:
        fg = u.GetForegroundWindow()
        if fg and int(fg) != main_hwnd and _class_name(fg) == "#32770":
            return int(fg)
        time.sleep(0.1)
    return 0


def dump_dialog_controls(dlg):
    print("\n===== 대화상자 (#32770) 컨트롤 =====")
    print(f"  대화상자 제목: {_win_text(dlg)!r}")
    ENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)

    def cb(h, _l):
        try:
            cls = _class_name(h)
            cid = u.GetDlgCtrlID(ctypes.c_void_p(h))
            txt = _win_text(h)
            line = f"  ctrlID={cid:<6} class={cls:<18} text={txt!r}"
            if cls.lower().startswith("combobox"):
                cnt = u.SendMessageW(ctypes.c_void_p(h), CB_GETCOUNT, None, None)
                cur = u.SendMessageW(ctypes.c_void_p(h), CB_GETCURSEL, None, None)
                items = []
                for i in range(min(cnt, 40)):
                    ln = u.SendMessageW(ctypes.c_void_p(h), CB_GETLBTEXTLEN, ctypes.c_void_p(i), None)
                    b = ctypes.create_unicode_buffer(max(ln, 1) + 1)
                    u.SendMessageW(ctypes.c_void_p(h), CB_GETLBTEXT, ctypes.c_void_p(i), b)
                    items.append(b.value)
                line += f"\n      COMBO count={cnt} cur={cur} items={items}"
            print(line)
        except Exception as e:
            print("   (컨트롤 읽기 오류)", e)
        return True

    u.EnumChildWindows(ctypes.c_void_p(dlg), ENUMPROC(cb), 0)


# --- stage 2: 실제 DXF 자동 내보내기 (창 메시지로 대화상자 조작) ---
WM_SETTEXT = 0x000C
CB_SETCURSEL = 0x014E
CBN_SELCHANGE = 1
BM_SETCHECK = 0x00F1
EXPORT_MENU_ID = 51744          # '외부 파일로 저장' (확정)
DLG_EDIT_FILENAME = 1152
DLG_COMBO_FORMAT = 1136
DLG_CHK_SELECTION_ONLY = 1009   # '선택만'
DLG_CHK_SUPPRESS_OPTS = 1011    # '옵션 무시'
DLG_BTN_SAVE = 1                # IDOK
DXF_FILTER_INDEX = 2            # 콤보 항목: 0=AI, 1=PSD, 2=DXF


def _combo_cursel(combo):
    return u.SendMessageW(ctypes.c_void_p(combo), CB_GETCURSEL, None, None)


WM_GETTEXT = 0x000D
WM_GETTEXTLENGTH = 0x000E
BM_CLICK = 0x00F5


def _ctrl_text(ctrl) -> str:
    ln = u.SendMessageW(ctypes.c_void_p(ctrl), WM_GETTEXTLENGTH, None, None)
    b = ctypes.create_unicode_buffer(int(ln) + 1)
    u.SendMessageW(ctypes.c_void_p(ctrl), WM_GETTEXT, ctypes.c_void_p(int(ln) + 1), ctypes.cast(b, ctypes.c_void_p))
    return b.value or ""


def _find_child_by_id(parent, ctrlid):
    """parent 의 모든 자손 중 GetDlgCtrlID==ctrlid 인 컨트롤 hwnd. 못 찾으면 0.
    (중첩 #32770 안의 컨트롤도 EnumChildWindows 는 재귀로 다 훑는다 — GetDlgItem 은 직속만.)"""
    found = [0]
    ENUM = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)

    def cb(h, _l):
        try:
            if u.GetDlgCtrlID(ctypes.c_void_p(h)) == ctrlid:
                found[0] = int(h)
                return False  # 중단
        except Exception:
            pass
        return True

    u.EnumChildWindows(ctypes.c_void_p(parent), ENUM(cb), 0)
    return found[0]


def _list_dialogs(exclude=0):
    """현재 보이는 #32770 창들 (hwnd, title) 목록."""
    out = []
    ENUM = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)

    def cb(h, _l):
        try:
            if not u.IsWindowVisible(h):
                return True
            if _class_name(h) != "#32770":
                return True
            hi = int(h)
            if hi == exclude:
                return True
            out.append((hi, _win_text(h)))
        except Exception:
            pass
        return True

    u.EnumWindows(ENUM(cb), 0)
    return out


def _select_format_and_save(dlg, combo, edit, save_btn, fmt_row, fname):
    """대화상자에서 형식(드롭다운 fmt_row 행 클릭) + 파일명(WM_SETTEXT) + Enter 저장. 검증된 레시피."""
    CB_GETITEMHEIGHT = 0x0154
    VK_RETURN = 0x0D

    class _RECT(ctypes.Structure):
        _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                    ("right", ctypes.c_long), ("bottom", ctypes.c_long)]

    def _rect(h):
        r = _RECT(); u.GetWindowRect(ctypes.c_void_p(h), ctypes.byref(r)); return r

    def _click(x, y):
        u.SetCursorPos(int(x), int(y)); time.sleep(0.04)
        u.mouse_event(0x0002, 0, 0, 0, 0); time.sleep(0.02)
        u.mouse_event(0x0004, 0, 0, 0, 0); time.sleep(0.05)

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
    nbuf = ctypes.create_unicode_buffer(fname)
    u.SendMessageW(ctypes.c_void_p(edit), WM_SETTEXT, None, ctypes.cast(nbuf, ctypes.c_void_p))
    time.sleep(0.1)
    er = _rect(edit)
    _click((er.left + er.right) // 2, (er.top + er.bottom) // 2)
    time.sleep(0.06)
    if _ctrl_text(edit) != fname:
        u.SendMessageW(ctypes.c_void_p(edit), WM_SETTEXT, None, ctypes.cast(nbuf, ctypes.c_void_p))
        time.sleep(0.08)
    cur = _combo_cursel(combo)
    s = u.MapVirtualKeyW(VK_RETURN, 0)
    u.keybd_event(VK_RETURN, s, 0, 0)
    u.keybd_event(VK_RETURN, s, 2, 0)
    time.sleep(0.3)
    return cur


def restore_format_ai(main_hwnd, net_dir):
    """형식 복원: AI(드롭다운 0행)로 더미 저장 후 그 파일 삭제 → 다음 수동 내보내기 기본=AI."""
    import os
    from pathlib import Path
    force_fg(main_hwnd)
    u.PostMessageW(ctypes.c_void_p(main_hwnd), WM_COMMAND, ctypes.c_void_p(EXPORT_MENU_ID), None)
    dlg = wait_dialog(main_hwnd, timeout=5.0)
    if not dlg:
        print("   [복원] 대화상자 안 뜸 — 복원 스킵")
        return
    time.sleep(0.15)
    combo = u.GetDlgItem(ctypes.c_void_p(dlg), DLG_COMBO_FORMAT)
    edit = u.GetDlgItem(ctypes.c_void_p(dlg), DLG_EDIT_FILENAME)
    save_btn = u.GetDlgItem(ctypes.c_void_p(dlg), DLG_BTN_SAVE)
    import tempfile
    dummy = "hd_fmtreset.ai"
    cand = [Path(net_dir), Path(tempfile.gettempdir()), Path.cwd()]
    for d in cand:  # 이전 더미 잔여 정리
        try:
            (Path(d) / dummy).unlink()
        except Exception:
            pass
    _select_format_and_save(dlg, combo, edit, save_btn, 0, dummy)  # 0행 = ADOBE Illustrator
    # 저장 후 'AI/EPS 선택 사항' 옵션창이 뜰 수 있음 + 파일 생성까지 대기하며 모달 Enter.
    import os
    deadline = time.time() + 12
    saved = None
    while time.time() < deadline:
        for d in cand:
            try:
                for f in os.listdir(d):
                    if f.lower() == dummy.lower() and (Path(d) / f).stat().st_size > 0:
                        saved = Path(d) / f
            except Exception:
                pass
        if saved:
            break
        fg = u.GetForegroundWindow()
        if fg and int(fg) != main_hwnd and _class_name(fg) == "#32770":
            ttl = _win_text(fg)
            if "외부 파일로 저장" not in ttl:
                u.keybd_event(0x0D, u.MapVirtualKeyW(0x0D, 0), 0, 0)
                u.keybd_event(0x0D, u.MapVirtualKeyW(0x0D, 0), 2, 0)
        time.sleep(0.2)
    # 더미 파일 삭제
    for d in cand:
        try:
            p = Path(d) / dummy
            if p.exists():
                p.unlink()
                print(f"   [복원] 더미 AI 삭제: {p}")
        except Exception:
            pass


def export_dxf(main_hwnd, out_path) -> bool:
    """현재 활성 FlexiSIGN 문서를 out_path 로 DXF 내보내기 (대화상자를 창 메시지로 조작). 진단 강화판."""
    from pathlib import Path
    out_path = Path(out_path)
    try:
        if out_path.exists():
            out_path.unlink()
    except Exception:
        pass

    force_fg(main_hwnd)
    u.PostMessageW(ctypes.c_void_p(main_hwnd), WM_COMMAND, ctypes.c_void_p(EXPORT_MENU_ID), None)
    dlg = wait_dialog(main_hwnd, timeout=5.0)
    if not dlg:
        print("[!] 내보내기 대화상자가 안 떴음.")
        return False
    time.sleep(0.15)

    combo = u.GetDlgItem(ctypes.c_void_p(dlg), DLG_COMBO_FORMAT)
    edit = u.GetDlgItem(ctypes.c_void_p(dlg), DLG_EDIT_FILENAME)
    chk_sel = u.GetDlgItem(ctypes.c_void_p(dlg), DLG_CHK_SELECTION_ONLY)
    chk_opt = u.GetDlgItem(ctypes.c_void_p(dlg), DLG_CHK_SUPPRESS_OPTS)
    save_btn = u.GetDlgItem(ctypes.c_void_p(dlg), DLG_BTN_SAVE)
    print(f"   컨트롤 hwnd: combo={combo} edit={edit} save_btn={save_btn} "
          f"chk_sel={chk_sel} chk_opt={chk_opt}")

    # ── 사용자가 알려준 '실제 수동 순서' 그대로: 콤보 클릭→드롭다운→DXF 행 클릭→
    #    파일명칸 클릭→전체선택→이름 붙여넣기→Enter. (전부 실제 마우스/키 입력.)
    import win32clipboard
    VK_CONTROL = 0x11
    VK_RETURN = 0x0D
    CB_GETITEMHEIGHT = 0x0154

    class _RECT(ctypes.Structure):
        _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                    ("right", ctypes.c_long), ("bottom", ctypes.c_long)]

    def _press(vk):
        s = u.MapVirtualKeyW(vk, 0)
        u.keybd_event(vk, s, 0, 0)
        u.keybd_event(vk, s, 2, 0)

    def _chord(mod, key):
        sm, sk = u.MapVirtualKeyW(mod, 0), u.MapVirtualKeyW(key, 0)
        u.keybd_event(mod, sm, 0, 0); time.sleep(0.04)
        u.keybd_event(key, sk, 0, 0); time.sleep(0.04)
        u.keybd_event(key, sk, 2, 0); time.sleep(0.04)
        u.keybd_event(mod, sm, 2, 0)

    def _rect(h):
        r = _RECT(); u.GetWindowRect(ctypes.c_void_p(h), ctypes.byref(r)); return r

    def _click(x, y):
        u.SetCursorPos(int(x), int(y)); time.sleep(0.04)
        u.mouse_event(0x0002, 0, 0, 0, 0); time.sleep(0.02)
        u.mouse_event(0x0004, 0, 0, 0, 0); time.sleep(0.05)

    force_fg(dlg)
    time.sleep(0.1)

    # 0) '옵션 무시' 체크 해제 — 체크돼 있으면 DXF 사이즈가 틀리게 저장됨(사용자 확인).
    #    1011=옵션무시, 1009=선택만. 중첩 자식이라 EnumChildWindows 로 찾고, 물리 클릭으로 토글.
    BM_GETCHECK = 0x00F0
    for cid, label in ((1011, "옵션무시"), (1009, "선택만")):
        ch = _find_child_by_id(dlg, cid)
        if not ch:
            print(f"   [{label}] 체크박스 못 찾음(id={cid})")
            continue
        st = u.SendMessageW(ctypes.c_void_p(ch), BM_GETCHECK, None, None)
        print(f"   [{label}] 현재 체크={st} (해제 원함=0)")
        if st == 1:
            r = _rect(ch)
            _click((r.left + r.right) // 2, (r.top + r.bottom) // 2)
            time.sleep(0.08)
            print(f"   [{label}] 해제 클릭 후={u.SendMessageW(ctypes.c_void_p(ch), BM_GETCHECK, None, None)}")

    # 1) 형식 드롭다운 클릭해서 열기
    rc = _rect(combo)
    _click((rc.left + rc.right) // 2, (rc.top + rc.bottom) // 2)
    time.sleep(0.2)
    # 펼쳐진 드롭다운 리스트(ComboLBox) 찾아 DXF(인덱스2=위에서 3번째 행) 클릭
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
        _click((lr.left + lr.right) // 2, lr.top + ih * 2 + ih // 2)  # 3번째 행 = DXF
        print(f"   드롭다운 DXF 행 클릭 (ih={ih})")
    else:
        print("   [!] 드롭다운(ComboLBox) 못 찾음")
    time.sleep(0.15)
    print(f"   형식 콤보 cur={_combo_cursel(combo)} (2=DXF 기대)")

    # 2) 파일명 = 이름만(ASCII) — WM_SETTEXT 로 '통째 교체'(=전체선택+입력과 동일, 확실).
    #    키보드 Ctrl+A 는 이 옛 입력칸에서 안 먹어 기본명 뒤에 덧붙던 문제를 회피.
    name_ascii = out_path.name  # hdsign_dim_<pid>.dxf
    nbuf = ctypes.create_unicode_buffer(name_ascii)
    u.SendMessageW(ctypes.c_void_p(edit), WM_SETTEXT, None, ctypes.cast(nbuf, ctypes.c_void_p))
    time.sleep(0.1)
    print(f"   파일명 edit(교체후): {_ctrl_text(edit)!r}")

    # 3) 저장 — 입력칸 클릭으로 포커스 준 뒤 Enter (사용자 수동 순서와 동일).
    er = _rect(edit)
    _click((er.left + er.right) // 2, (er.top + er.bottom) // 2)
    time.sleep(0.06)
    # 클릭이 기본명을 되살리지 않았는지 확인 후, 다르면 한 번 더 교체.
    if _ctrl_text(edit) != name_ascii:
        u.SendMessageW(ctypes.c_void_p(edit), WM_SETTEXT, None, ctypes.cast(nbuf, ctypes.c_void_p))
        time.sleep(0.08)
    print(f"   파일명 edit(저장직전)={_ctrl_text(edit)!r}")
    _press(VK_RETURN)
    time.sleep(0.3)
    print("   저장(Enter).")

    # 후보 저장 위치들 — 전체경로가 안 먹고 현재폴더+파일명으로 저장될 수 있어 여러 곳 탐색.
    import tempfile
    import os
    cand_dirs = [out_path.parent, Path(tempfile.gettempdir()), Path.cwd()]
    net = Path(r"\\Main\현대공유\00000 2026년 자료\000 2026년 거래처\테스트회사1 (자동생성)\6-17dxf내보내기테스트")
    cand_dirs.append(net)
    name = out_path.name
    print(f"   파일 탐색 폴더: {[str(d) for d in cand_dirs]}")

    def _found():
        # UNC 에서 Path.exists() 가 불안정 → listdir 로 이름 매칭.
        for d in cand_dirs:
            try:
                for f in os.listdir(d):
                    if f.lower() == name.lower():
                        p = Path(d) / f
                        if p.stat().st_size > 0:
                            return p
            except Exception:
                pass
        return None

    # 5) 대기: '전면(foreground)에 뜬 진짜 모달'만 잡아 Enter. 도구 패널(DesignCentral 등)은
    #    절대 안 건드린다(전면화도 안 함). "시스템에러/에러" 류면 멈추고 보고.
    VK_RETURN = 0x0D
    PANELS = ("designcentral", "fill/stroke", "fill / stroke", "stroke editor", "design central")
    ERR_KEYS = ("시스템에러", "시스템 에러", "에러", "error", "오류")
    deadline = time.time() + 14
    tick = 0
    last_enter = 0.0
    while time.time() < deadline:
        p = _found()
        if p:
            time.sleep(0.4)
            print(f"   ✅ DXF 생성됨: {p} ({p.stat().st_size} bytes)")
            return p
        fg = u.GetForegroundWindow()
        fg_i = int(fg) if fg else 0
        cls = _class_name(fg) if fg_i else "-"
        ttl = _win_text(fg) if fg_i else ""
        low = ttl.lower()
        # 모달 = 메인/내보내기창이 아닌 '대화상자류' 전면창(#32770 또는 Afx). 작업표시줄/바탕화면 등 제외.
        is_dialogish = (cls == "#32770") or cls.startswith("Afx")
        # '외부 파일로 저장' 제목은 우리 저장 대화상자 자체 → Enter 보내면 새 창이 양산됨. 제외.
        is_save_dlg = "외부 파일로 저장" in ttl
        is_modal = (bool(fg_i) and fg_i != dlg and fg_i != main_hwnd
                    and is_dialogish and not is_save_dlg)
        is_panel = any(p0 in low for p0 in PANELS)
        is_err = any(e in ttl for e in ERR_KEYS) or ("error" in low) or ("cannot" in low)
        if tick % 2 == 0:
            print(f"   ...전면창 hwnd={fg_i} class={cls!r} title={ttl!r} modal={is_modal} panel={is_panel}")
        if is_modal and is_err:
            print(f"   [!] 에러 대화상자 감지: {ttl!r} — 자동화 중단(원인 파악 필요).")
            return None
        if is_modal and (not is_panel) and (time.time() - last_enter) > 1.0:
            u.keybd_event(VK_RETURN, 0, 0, 0)
            u.keybd_event(VK_RETURN, 0, 2, 0)
            print(f"      -> 모달(hwnd={fg_i}, '{ttl}') 에 Enter")
            last_enter = time.time()
        tick += 1
        time.sleep(0.2)
    print("[!] 시간 내 DXF 파일이 안 생김.")
    return None


def main():
    invoke_id = None
    if "--invoke" in sys.argv:
        try:
            invoke_id = int(sys.argv[sys.argv.index("--invoke") + 1])
        except Exception:
            print("--invoke 뒤에 숫자 ID 를 주세요.")
            return

    print("FlexiSIGN DXF 내보내기 구조 진단 v2 (저장X / 레지쓰기X)")
    hwnd, title = find_flexisign_window()
    if not hwnd:
        print("\n[!] FlexiSIGN 창을 못 찾음. FlexiSIGN 에 문서를 하나 연 뒤 다시 실행.")
        return
    print(f"FlexiSIGN 창: hwnd={hwnd} title={title!r}")

    if "--export" in sys.argv:
        import tempfile
        import os
        from pathlib import Path
        # 네트워크 테스트 폴더에 고유 이름으로 저장 (수동 export 가 정상 동작하는 폴더 = 정상 DXF).
        # %TEMP% 는 0바이트만 나왔음. 따옴표 감싼 전체경로를 Ctrl+V 로 넣는다.
        net = Path(r"\\Main\현대공유\00000 2026년 자료\000 2026년 거래처\테스트회사1 (자동생성)\6-17dxf내보내기테스트")
        out = net / f"hdsign_dim_{os.getpid()}.dxf"
        print(f"\n-> DXF 자동 내보내기 테스트(빠른모드): {out.name}")
        print("   (1초 후 시작. 이상하면 Ctrl+C)")
        time.sleep(1)
        import time as _tt
        _t0 = _tt.perf_counter()
        found = export_dxf(hwnd, out)
        _elapsed = _tt.perf_counter() - _t0
        print(f"\n   ⏱ 내보내기 소요: {_elapsed:.1f}초")
        if found:
            try:
                import dxf_dims
                res = dxf_dims.parse_dxf_objects(found)
                objs = sorted(res["objects"], key=lambda o: -o["w"])
                print(f"\n   파싱 결과: {len(objs)}개 객체, unit_mm={res['unit_mm']}")
                for o in objs[:6]:
                    print(f"     {o['w']:.1f} x {o['h']:.1f} mm  {o['type']}")
            except Exception as e:
                print("   파싱 오류:", e)
        # AI 형식 복원 (더미 AI 저장 후 삭제)
        _tr0 = _tt.perf_counter()
        print("\n-> AI 형식 복원 중...")
        restore_format_ai(hwnd, net)
        print(f"   ⏱ 복원 소요: {_tt.perf_counter() - _tr0:.1f}초")
        # 복원 확인
        time.sleep(0.3)
        force_fg(hwnd)
        u.PostMessageW(ctypes.c_void_p(hwnd), WM_COMMAND, ctypes.c_void_p(EXPORT_MENU_ID), None)
        dlg2 = wait_dialog(hwnd, 4.0)
        if dlg2:
            cur2 = _combo_cursel(u.GetDlgItem(ctypes.c_void_p(dlg2), DLG_COMBO_FORMAT))
            print(f"   [복원 확인] 형식 cur={cur2} (0=AI 성공)")
            u.PostMessageW(ctypes.c_void_p(dlg2), WM_CLOSE, None, None)
        print(f"\n   ⏱ 전체 소요: {_tt.perf_counter() - _t0:.1f}초")
        print("완료. 출력 전체를 복사해 전달하세요.")
        return

    if invoke_id is None:
        dump_registry()
        dump_menu(hwnd)
        print("\n----------------------------------------------------------")
        print("다음 단계: 실제 [파일] 메뉴에서 '외부 파일로 저장' 이 위에서 몇 번째(pos)인지 알려주세요.")
        print("그 pos 의 ID 로 다음을 실행하면 대화상자 구조를 덤프합니다:")
        print("   py _dxf_export_probe.py --invoke <그_ID>")
        return

    print(f"\n-> 메뉴 ID {invoke_id} 호출 (3초 후, 대화상자는 자동 취소). 중단=Ctrl+C")
    time.sleep(3)
    force_fg(hwnd)
    u.PostMessageW(ctypes.c_void_p(hwnd), WM_COMMAND, ctypes.c_void_p(invoke_id), None)
    dlg = wait_dialog(hwnd, timeout=5.0)
    if not dlg:
        print(f"\n[!] ID {invoke_id} 로는 #32770 대화상자가 안 떴음. 다른 pos/ID 를 시도하거나, "
              f"메뉴 호출이 흡수됐을 수 있음.")
        return
    time.sleep(0.3)
    dump_dialog_controls(dlg)
    print("\n-> 대화상자 취소(닫기) - 저장 안 함.")
    u.PostMessageW(ctypes.c_void_p(dlg), WM_CLOSE, None, None)
    print("\n완료. 출력 전체를 복사해 전달하세요.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n중단됨(Ctrl+C).")
        sys.exit(1)
