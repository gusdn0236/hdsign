"""이지폼 저장 → 홈페이지 자동반영 (2026-11-20).

사무실 직원이 이지폼 **'매출 거래명세서'** 창에서 직접 [저장]을 누르면:
  1) 워처가 그 클릭(또는 저장 버튼에 포커스 두고 Enter/Space)을 알아챈다 — 저수준 마우스·키 훅, **관찰만**(입력은 안 막음).
     · 창 제목이 정확히 '매출 거래명세서' 인 명세서 창(TfrmExchange)의 [저장](TBitBtn)만. 매입·발주서 등은 무시.
     · 우리 자동화(비고 적기 저장 등)는 PostMessage 로 누르므로 물리 입력이 아니라 여기 안 걸린다(무한반복 없음).
  2) 이미 있던 명세서면 이지폼이 '동일한 고유번호… 저장?' Yes/No 를 묻는다 → 직원이 [Yes] 면 계속, [No] 면 끝.
     새 명세서는 묻는 창 없이 바로 저장된다(사용자 확인 2026-11-20).
  3) "홈페이지에도 반영할까요?" 예/아니오 — **예일 때만** 아래가 돈다(사용자 지시).
  4) 2~3초 입력 잠금 + 안내판 → 발행일·합계(창 글자), 거래처명(화면에 그려진 글자라 OCR), 품목 표(칸 읽기) 읽기.
  5) 읽은 명세서를 '이벤트'로 쌓아 두면 홈페이지(관리자 화면, EasyformAutoSync)가 폴링해서
     · 비고에 주문번호가 있으면 그 주문 명세서를 바로 덮어쓰고,
     · 없으면 거래처·날짜로 지시서 카드를 띄워 "이 지시서가 맞나요?" → [맞아요] → /stamp 로 이지폼 비고에
       주문번호 적고 저장(easyform_bulk 의 승인된 저장 경로) → 홈페이지 명세서 덮어쓰기.
홈페이지가 안 열려 있으면 관리자 페이지를 브라우저로 연다.
"""
from __future__ import annotations

import logging
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
import webbrowser

import easyform as ef

ADMIN_URL = "https://hdsigncraft.com/admin/orders?tab=statement"
# 관리자 화면(로그인된 탭)의 제목 — 홈페이지 EasyformAutoSync 가 붙인다. Chrome 탭 목록에서 이걸로 관리자 탭을 찾는다.
ADMIN_TAB_MARK = "HD Sign 관리자"
FORM_TITLE = "매출 거래명세서"
_EVENT_TTL = 30 * 60  # 30분 지난 이벤트는 버림

_LOCK = threading.Lock()
_STATE = {"seq": 0, "events": [], "last_poll": 0.0, "busy": False, "started": False, "reading": False}
_Q: "queue.Queue[tuple]" = queue.Queue()
_ANSWER = {"text": "", "at": 0.0}  # 이지폼 질문창(TMessageForm)에서 마지막으로 누른 버튼

if ef.EASYFORM_AVAILABLE:
    import ctypes
    from ctypes import wintypes

    import easyform_bulk as bulk

    _u = ctypes.WinDLL("user32", use_last_error=True)
    _k = ctypes.WinDLL("kernel32", use_last_error=True)
    _g = ctypes.WinDLL("gdi32", use_last_error=True)
    _LRESULT = ctypes.c_ssize_t
    _HOOKPROC = ctypes.WINFUNCTYPE(_LRESULT, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM)
    _u.SetWindowsHookExW.argtypes = [ctypes.c_int, _HOOKPROC, wintypes.HINSTANCE, wintypes.DWORD]
    _u.SetWindowsHookExW.restype = wintypes.HHOOK
    _u.CallNextHookEx.argtypes = [wintypes.HHOOK, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM]
    _u.CallNextHookEx.restype = _LRESULT
    _u.GetMessageW.argtypes = [ctypes.c_void_p, wintypes.HWND, wintypes.UINT, wintypes.UINT]
    _u.WindowFromPoint.argtypes = [wintypes.POINT]
    _u.WindowFromPoint.restype = wintypes.HWND
    _u.GetParent.argtypes = [wintypes.HWND]
    _u.GetParent.restype = wintypes.HWND
    _u.ClientToScreen.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.POINT)]
    _u.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    _u.InternalGetWindowText.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    _u.GetForegroundWindow.restype = wintypes.HWND
    _u.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    _u.GetWindowThreadProcessId.restype = wintypes.DWORD
    _u.GetWindowDC.argtypes = [wintypes.HWND]
    _u.GetWindowDC.restype = wintypes.HDC
    _u.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
    _u.PrintWindow.argtypes = [wintypes.HWND, wintypes.HDC, wintypes.UINT]
    _g.CreateCompatibleDC.argtypes = [wintypes.HDC]
    _g.CreateCompatibleDC.restype = wintypes.HDC
    _g.CreateCompatibleBitmap.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int]
    _g.CreateCompatibleBitmap.restype = wintypes.HBITMAP
    _g.SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
    _g.SelectObject.restype = wintypes.HGDIOBJ
    _g.GetDIBits.argtypes = [wintypes.HDC, wintypes.HBITMAP, wintypes.UINT, wintypes.UINT, ctypes.c_void_p,
                             ctypes.c_void_p, wintypes.UINT]
    _g.DeleteObject.argtypes = [wintypes.HGDIOBJ]
    _g.DeleteDC.argtypes = [wintypes.HDC]

    class _MSLL(ctypes.Structure):
        _fields_ = [("pt", wintypes.POINT), ("mouseData", wintypes.DWORD), ("flags", wintypes.DWORD),
                    ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]

    class _KBLL(ctypes.Structure):
        _fields_ = [("vkCode", wintypes.DWORD), ("scanCode", wintypes.DWORD), ("flags", wintypes.DWORD),
                    ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]

    class _GUITHREADINFO(ctypes.Structure):
        _fields_ = [("cbSize", wintypes.DWORD), ("flags", wintypes.DWORD), ("hwndActive", wintypes.HWND),
                    ("hwndFocus", wintypes.HWND), ("hwndCapture", wintypes.HWND), ("hwndMenuOwner", wintypes.HWND),
                    ("hwndMoveSize", wintypes.HWND), ("hwndCaret", wintypes.HWND), ("rcCaret", wintypes.RECT)]

    _u.GetGUIThreadInfo.argtypes = [wintypes.DWORD, ctypes.POINTER(_GUITHREADINFO)]
    _u.IsWindowVisible.argtypes = [wintypes.HWND]
    _u.EnumWindows.argtypes = [bulk._ENUM, wintypes.LPARAM]
    _k.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
    _k.GetModuleHandleW.restype = wintypes.HMODULE


# ── 창 도구(훅 안에서도 쓰는 것 = 메시지를 보내지 않는 함수만) ─────────────────────────
def _cls(h) -> str:
    b = ctypes.create_unicode_buffer(128)
    _u.GetClassNameW(h, b, 128)
    return b.value or ""


def _itext(h) -> str:
    """창 글자(InternalGetWindowText) — 다른 프로세스에 메시지를 보내지 않아 훅 안에서도 안전."""
    b = ctypes.create_unicode_buffer(256)
    _u.InternalGetWindowText(h, b, 256)
    return (b.value or "").replace("&", "").strip()


def _ancestor(h, klass: str, depth: int = 12):
    while h and depth > 0:
        if _cls(h) == klass:
            return h
        h = _u.GetParent(h)
        depth -= 1
    return None


def _classify(h) -> "tuple | None":
    """누른 컨트롤 → ('save', 명세서창) / ('answer', 'Yes'|'No'|…) / None."""
    if not h:
        return None
    c = _cls(h)
    if c == "TBitBtn" and _itext(h) == "저장":
        form = _ancestor(_u.GetParent(h), "TfrmExchange")
        if form and _itext(form) == FORM_TITLE:
            return ("save", form)
        return None
    if c == "TButton":
        p = _u.GetParent(h)
        if p and _cls(p) == "TMessageForm":
            return ("answer", _itext(h))
    return None


def _focus_of_foreground():
    fg = _u.GetForegroundWindow()
    if not fg:
        return None
    tid = _u.GetWindowThreadProcessId(fg, None)
    gi = _GUITHREADINFO()
    gi.cbSize = ctypes.sizeof(_GUITHREADINFO)
    if not _u.GetGUIThreadInfo(tid, ctypes.byref(gi)):
        return None
    return gi.hwndFocus


# ── 훅(관찰만 — 항상 다음 훅으로 넘김, 아무것도 안 막음) ──────────────────────────────
_refs: list = []


def _mouse_proc(n, wp, lp):
    try:
        if n >= 0 and wp == 0x0202:  # WM_LBUTTONUP
            ms = ctypes.cast(lp, ctypes.POINTER(_MSLL)).contents
            if not (ms.flags & 0x1):  # 사람 손(주입 아님)
                r = _classify(_u.WindowFromPoint(ms.pt))
                if r:
                    _Q.put(r + (time.time(),))
    except Exception:
        pass
    return _u.CallNextHookEx(None, n, wp, lp)


def _kbd_proc(n, wp, lp):
    try:
        if n >= 0 and wp in (0x0100, 0x0104):  # WM_KEYDOWN / WM_SYSKEYDOWN
            kb = ctypes.cast(lp, ctypes.POINTER(_KBLL)).contents
            if not (kb.flags & 0x10) and kb.vkCode in (0x0D, 0x20, 0x59, 0x4E, 0x1B):
                f = _focus_of_foreground()
                if f:
                    r = _classify(f)
                    if r and r[0] == "save" and kb.vkCode in (0x0D, 0x20):
                        _Q.put(r + (time.time(),))
                    elif r and r[0] == "answer":
                        # 질문창: Enter/Space = 포커스 버튼, Y = Yes, N/ESC = No
                        ans = r[1] if kb.vkCode in (0x0D, 0x20) else ("Yes" if kb.vkCode == 0x59 else "No")
                        _Q.put(("answer", ans, time.time()))
    except Exception:
        pass
    return _u.CallNextHookEx(None, n, wp, lp)


def _hook_thread():
    hinst = _k.GetModuleHandleW(None)
    mp, kp = _HOOKPROC(_mouse_proc), _HOOKPROC(_kbd_proc)
    _refs[:] = [mp, kp]
    hm = _u.SetWindowsHookExW(14, mp, hinst, 0)  # WH_MOUSE_LL
    hk = _u.SetWindowsHookExW(13, kp, hinst, 0)  # WH_KEYBOARD_LL
    logging.info("이지폼 저장 자동반영: 감시 시작(마우스훅=%s 키훅=%s)", bool(hm), bool(hk))
    msg = wintypes.MSG()
    while _u.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
        pass


def _other_job_running() -> bool:
    try:
        if bulk._JOB.get("state") == "running":
            return True
    except Exception:
        pass
    try:
        if ef._EF_PULL.get("state") == "running":
            return True
    except Exception:
        pass
    return False


def _dispatch_thread():
    while True:
        item = _Q.get()
        try:
            if item[0] == "answer":
                _ANSWER.update(text=item[1], at=item[2])
                continue
            if item[0] == "save":
                with _LOCK:
                    if _STATE["busy"]:
                        continue  # 이전 저장 처리 중(같은 저장 이중 클릭 등)
                    _STATE["busy"] = True
                if _other_job_running():
                    logging.info("이지폼 저장 감지 — 다른 이지폼 작업 중이라 건너뜀")
                    with _LOCK:
                        _STATE["busy"] = False
                    continue
                threading.Thread(target=_handle_save, args=(item[1], item[2]), daemon=True).start()
        except Exception:
            logging.exception("이지폼 저장 감지 처리 오류")


# ── 저장 1건 처리 ────────────────────────────────────────────────────────────────
def _main_of(form):
    h = form
    for _ in range(12):
        p = _u.GetParent(h)
        if not p:
            break
        h = p
        if _cls(h) == "TfrmBookMain":
            return h
    return None


def _biz_of(main) -> "tuple[str, str]":
    for m in bulk._mains():
        if m["hwnd"] == main:
            return m["biz"], m["name"]
    return "", ""


def _wait_saved(main, t_click: float) -> "tuple[bool, str]":
    """저장 클릭 뒤 — 질문창이 뜨면 사람이 답할 때까지 기다린다. (저장됐나, 이유)."""
    t0 = time.time()
    seen = None
    # 기존 명세서의 '동일한 고유번호' 질문창은 클릭 직후 뜬다 → 0.5초만 보고 바로 묻기(예전 1.2초, 사용자 2026-11-25
    # '반영할까요?가 늦게 뜬다'). 느린 PC 에서 더 늦게 뜨면 _handle_save 가 [예] 뒤에 마저 기다린다.
    while time.time() - t0 < 0.5:
        pops = [p for p in bulk._popups(main) if p[1] == "TMessageForm"]
        if pops:
            seen = pops[0][0]
            break
        time.sleep(0.05)
    if not seen:
        return True, "새 명세서(질문창 없음)"
    btns = sorted(bulk._txt(x).replace("&", "") for x in bulk._kids(seen, "TButton"))
    while bulk._popups(main):  # 사람이 답할 때까지(최대 10분)
        if time.time() - t0 > 600:
            return False, "질문창에 답이 없음"
        time.sleep(0.05)
    time.sleep(0.08)  # 답 버튼 클릭이 감시 스레드에서 기록될 틈
    ans = _ANSWER["text"] if _ANSWER["at"] >= t_click else ""
    if btns != ["No", "Yes"]:
        return False, f"예상 밖 창({', '.join(btns)}) — 저장 안 된 것으로 봄"
    if ans == "Yes":
        time.sleep(0.1)
        while bulk._popups(main):  # 저장 뒤 또 뜨는 창이 있으면 그것도 끝날 때까지
            if time.time() - t0 > 600:
                return False, "저장 뒤 창이 안 닫힘"
            time.sleep(0.05)
        return True, "고쳐서 저장(Yes)"
    return False, f"저장 안 함({ans or '답 모름'})"


def _handle_save(form, t_click: float) -> None:
    try:
        main = _main_of(form)
        if not main:
            return
        ok, why = _wait_saved(main, t_click)
        logging.info("이지폼 저장 감지 — %s", why)
        if not ok:
            return
        if not _ask_reflect(form):
            logging.info("이지폼 저장 자동반영 — 사람이 [아니오]")
            return
        if bulk._shown(form) and bulk._popups(main):
            # 이지폼 질문창이 늦게 뜬 경우(느린 PC) — 사람이 답할 때까지 기다렸다가 저장됐을 때만 이어감
            ok2, why2 = _wait_saved(main, t_click)
            logging.info("이지폼 저장 감지(늦은 질문창) — %s", why2)
            if not ok2:
                return
        if not bulk._shown(form) or bulk._popups(main):
            ef.ef_messagebox("명세서 창이 닫혀서 읽지 못했어요.\n명세서를 다시 열고 [저장]을 눌러주세요.", "홈페이지 반영")
            return
        # [예] 즉시 홈페이지를 앞으로 + '읽는 중' 표시(읽기는 화면을 안 쓰는 메시지 방식이라 뒤에서 그대로 진행).
        # 예전엔 다 읽고 → 홈페이지 신호 기다림 → 앞으로 라서 반응이 늦었다(사용자 2026-11-20).
        with _LOCK:
            _STATE["reading"] = True
        threading.Thread(target=_front_admin, daemon=True).start()
        try:
            ev = _read_saved(main, form)
        finally:
            with _LOCK:
                _STATE["reading"] = False
        if ev is None:
            return
        _push(ev)
    except Exception as e:  # noqa: BLE001
        logging.exception("이지폼 저장 자동반영 오류")
        ef.ef_messagebox(f"홈페이지 반영 중 오류가 났어요.\n{e}", "홈페이지 반영")
    finally:
        with _LOCK:
            _STATE["busy"] = False


def _ask_reflect(form) -> bool:
    """"홈페이지에도 반영할까요?" — 워처 화면이 있으면 큰 카드(화면 어둡게 + 가운데 + 맨 앞, Enter=예/Esc=아니오),
    없으면(GUI 미설치) Windows 확인창. 10분 답 없으면 아니오."""
    if getattr(ef, "EF_ASK_READY", False):
        info = ""
        try:
            date, total = bulk._form_header(form)
            m = ef._re.match(r"\d{4}\.(\d{1,2})\.(\d{1,2})", date or "")
            info = (f"{int(m.group(1))}월 {int(m.group(2))}일 발행" if m else date) + (f" · 합계 {total}원" if total else "")
        except Exception:
            pass
        holder = {"ev": threading.Event(), "ans": False}
        st = _web_status()
        status = ("✅ 홈페이지 연결됨", True) if st != "none" else             ("⚠ 홈페이지가 꺼져 있거나 로그인이 안 돼 있어요 — [예]를 누르면 홈페이지를 열어요(로그인하면 이어서 진행)", False)
        ef._EF_UI_QUEUE.put(("auto_ask", holder, info, status))
        if holder["ev"].wait(600):
            return bool(holder["ans"])
        ef._EF_UI_QUEUE.put(("auto_ask_cancel", holder))
        return False
    return ef.ef_confirm("이지폼에 명세서를 저장했어요.\n\n홈페이지에도 반영할까요?\n\n"
                         "[예]를 누르면 명세서를 읽는 동안(2~3초) 마우스가 잠깁니다.", "홈페이지 반영")


def _overlay(text: "str | None", sub: "str | None" = None) -> None:
    try:
        ef._EF_UI_QUEUE.put(("auto_overlay", text, sub) if text else ("auto_overlay_hide",))
    except Exception:
        pass


def _read_saved(main, form) -> "dict | None":
    # 읽기 전에 명세서 창을 기준 위치(이지폼 자동입력과 같은 EF_FORM_HOME)로 — 매번 같은 조건에서 OCR·표 읽기
    # (사용자 지시 2026-11-20: 창이 잘리거나 엉뚱한 곳에 있어도 거래처명을 똑같이 읽게). 포커스는 안 건드림.
    # 기준 위치 = 이지폼 메인 작업영역의 왼쪽 위(클라이언트 0,0). 예전 EF_FORM_HOME 은 '화면' 좌표라 이지폼을
    # 전체화면 아닌 작은 창으로 한쪽(예: 오른쪽 절반)에 띄워 쓰면 명세서가 메인 영역 밖으로 밀려 거의 안 보이게
    # 됐다(2026-11-20 점검). 메인 안쪽 왼쪽 위면 메인 크기·위치와 무관하게 최대한 보이고, 메인보다 커서 오른쪽·
    # 아래가 잘려도 PrintWindow(0)는 창 전체를 그리고 표는 메시지로 읽으므로 괜찮다.
    try:
        parent = _u.GetParent(form)
        if parent:
            pt = wintypes.POINT(0, 0)
            _u.ClientToScreen(parent, ctypes.byref(pt))
            ef._ef_move_to_screen(form, pt.x, pt.y)
        else:
            ef._ef_move_to_screen(form, ef.EF_FORM_HOME[0], ef.EF_FORM_HOME[1])
        time.sleep(0.25)
    except Exception:
        logging.exception("명세서 창 기준 위치 이동 실패(그 자리에서 읽음)")
    date, total = bulk._form_header(form)
    _overlay("이지폼 명세서를 읽고 있어요.\n이지폼 내용은 바뀌지 않아요.")
    ef.ef_guard_start()
    done = threading.Event()

    def esc_relay():  # 잠금 중 ESC(입력가드가 잡음) → 읽기 멈춤
        while not done.is_set():
            if ef.ef_aborted():
                bulk._ABORT.set()
                return
            time.sleep(0.05)

    try:
        bulk._ABORT.clear()
        threading.Thread(target=esc_relay, daemon=True).start()
        rows = bulk._read_form(form)
        nos: list = []
        for r in rows:
            for m in ef._EF_ORDER_NO_RE.finditer(r.get("remark") or ""):
                if m.group(1) not in nos:
                    nos.append(m.group(1))
        if len(nos) == 1:
            # 지시서 1개짜리 — 번호가 맨 위(비고 빈 첫 줄)가 아니면 **읽은 김에 바로** 옮겨 적고 저장(잠금 그대로).
            # 홈페이지 확인 뒤 이지폼에 다시 오는 두 번째 순회를 없앤다(사용자 2026-11-20: 두 번 돌아 느림).
            try:
                _res, edits, _row = _plan(rows, nos, True, None)
                if edits:
                    _overlay("이지폼 비고의 주문번호만 맨 위 줄로 옮기고 있어요.")
                    r2 = _apply(main, form, edits)
                    if r2.get("ok"):
                        _commit_rows(rows, edits)
                    logging.info("이지폼 저장 자동반영 — 번호 맨 위로 %s", r2)
            except bulk.Stop:
                raise
            except Exception:
                logging.exception("이지폼 저장 자동반영 — 번호 맨 위로 옮기기 실패(그대로 반영)")
    except bulk.Stop as e:
        ef.ef_messagebox(f"명세서를 다 못 읽어서 홈페이지에 반영 안 했어요.\n{e}", "홈페이지 반영")
        return None
    finally:
        done.set()
        ef.ef_guard_stop()
        _overlay(None)
        bulk._ABORT.clear()
    biz, name = _biz_of(main)
    client, biz_no = _client_from_list(main, date, total, rows)
    logging.info("이지폼 저장 자동반영 — 읽음 %s %s원 거래처(목록)='%s' %s %d줄 비고번호=%s",
                 date, total, client, biz_no, len(rows), nos)
    return {"biz": biz, "bizName": name, "client": client, "bizNo": biz_no, "date": date, "total": total,
            "rows": rows, "nos": nos, "form": int(form)}


def _client_from_list(main, date: str, total: str, rows: list) -> "tuple[str, str]":
    """거래처명·사업자번호 = 이지폼 목록(엑셀)에 적힌 그대로(사용자 2026-11-24: OCR 금지 — '건화'를 '건하'로 읽은 일).
    그날 목록에서 합계(+첫 품목)가 같은 명세서가 한 거래처뿐일 때만. 애매하거나 못 뽑으면 빈칸(틀린 이름보다 나음)."""
    try:
        m = next((x for x in bulk._mains() if x["hwnd"] == main), None)
        if not m or not date or not total:
            return "", ""
        lst = bulk._export_one(m, 0, lambda _s: None, period=(date, date), forms_ok=True)
        hit = [r for r in lst if r["date"] == date and bulk._digits(r["total"]) == bulk._digits(total)]
        first = next(((r.get("item") or "").strip() for r in rows if (r.get("item") or "").strip()), "")
        if len({r.get("bizNo") for r in hit}) > 1 and first:
            hit = [r for r in hit if (r.get("firstItem") or "").strip() == first]
        if hit and len({r.get("bizNo") for r in hit}) == 1:
            return hit[0].get("client", ""), hit[0].get("bizNo", "")
    except bulk.Stop as e:
        logging.warning("이지폼 저장 자동반영 — 목록에서 거래처 못 찾음: %s", e)
    except Exception:
        logging.exception("이지폼 저장 자동반영 — 목록에서 거래처 찾기 실패")
    return "", ""


def _front_admin() -> bool:
    """관리자 화면을 맨 앞으로 — ① 창 제목(관리자 탭이 보이는 탭이면 바로) ② 숨은 탭이면 Chrome 탭 목록에서 골라."""
    found: list = []

    def cb(h, _):
        if _u.IsWindowVisible(h) and ADMIN_TAB_MARK in _itext(h):
            found.append(h)
        return True

    try:
        _u.EnumWindows(bulk._ENUM(cb), 0)
        if found and ef.ef_force_foreground(found[0]):
            return True
        h = _select_chrome_tab(ADMIN_TAB_MARK, select=True)
        return bool(h and ef.ef_force_foreground(h))
    except Exception:
        logging.exception("관리자 화면 앞으로 실패")
        return False


def _web_status() -> str:
    """'live' = 로그인된 관리자 화면이 방금 신호를 보냄 / 'tab' = 관리자 탭은 열려 있음(뒤에 숨어 신호가 느림 —
    Chrome 이 숨은 탭 타이머를 늦춤) / 'none' = 관리자 화면이 안 열렸거나 로그인 안 됨.
    (홈페이지는 관리자로 로그인된 화면에서만 신호를 보내고 제목에 ADMIN_TAB_MARK 를 붙인다.)"""
    with _LOCK:
        if time.time() - _STATE["last_poll"] < 5:
            return "live"
    return "tab" if _select_chrome_tab(ADMIN_TAB_MARK, select=False) else "none"


def _push(ev: dict) -> None:
    with _LOCK:
        _STATE["seq"] += 1
        ev.update(id=_STATE["seq"], at=time.time(), claimed=False)
        now = time.time()
        _STATE["events"] = [e for e in _STATE["events"] if now - e["at"] < _EVENT_TTL] + [ev]
        web_alive = now - _STATE["last_poll"] < 4
    if web_alive:
        return  # 관리자 화면이 바로 가져가 앞으로 나온다
    # 관리자 탭이 뒤에 숨어 있으면(신호 느림) 그 탭을 골라 앞으로 → 숨김이 풀려 바로 신호 → 카드
    if _front_admin():
        logging.info("이지폼 저장 자동반영 — 관리자 화면을 앞으로")
        return
    # 관리자 화면이 없거나 로그인 안 됨 → 관리자 페이지(명세서 탭)를 연다. 로그인하면 쌓인 건을 바로 가져간다.
    logging.info("이지폼 저장 자동반영 — 관리자 화면이 없어 관리자 페이지를 엶(로그인 필요)")
    try:
        webbrowser.open(ADMIN_URL)
    except Exception:
        logging.exception("관리자 페이지 열기 실패")


# ── 거래처명 OCR(화면에 그려진 글자라 창 글자로 못 읽음) ─────────────────────────────
# 발행일 칸(TMaskEdit) 기준 상대 위치 — 실측(2026-11-20): 발행일 칸 왼위 (71,127) 일 때 거래처명 (52,152)-(183,176).
_CLIENT_BOX = (-19, 25, 112, 49)


def _capture_client(form) -> "str | None":
    """명세서 창을 PrintWindow 로 떠서 거래처명 칸만 잘라 4배 키우고 흑백으로 → BMP 파일 경로."""
    try:
        date_edit = next(iter(bulk._kids(form, "TMaskEdit")), None)
        if not date_edit:
            return None
        fl, ft, fr, fb = bulk._rect(form)
        dl, dt, _dr, _db = bulk._rect(date_edit)
        w, h = fr - fl, fb - ft
        x0, y0 = dl - fl + _CLIENT_BOX[0], dt - ft + _CLIENT_BOX[1]
        x1, y1 = dl - fl + _CLIENT_BOX[2], dt - ft + _CLIENT_BOX[3]
        hdc = _u.GetWindowDC(form)
        mdc = _g.CreateCompatibleDC(hdc)
        bmp = _g.CreateCompatibleBitmap(hdc, w, h)
        old = _g.SelectObject(mdc, bmp)
        # 플래그 0(WM_PRINT 식). 2(PW_RENDERFULLCONTENT)는 창이 이지폼 메인 밖으로 잘리면 보이는 부분만 왼쪽으로
        # 당겨 그려 거래처 칸이 어긋났다(실측 2026-11-20, 왼쪽 25px 잘림 → "(주)" 잘림). 0 은 잘려도 창 전체를 제자리에.
        _u.PrintWindow(form, mdc, 0)
        _g.SelectObject(mdc, old)  # GetDIBits 는 DC 에서 빼낸 비트맵으로
        hdr = (ctypes.c_uint32 * 10)(40, w, (-h) & 0xFFFFFFFF, 1 | (32 << 16), 0, 0, 0, 0, 0, 0)
        buf = ctypes.create_string_buffer(w * h * 4)
        _g.GetDIBits(mdc, bmp, 0, h, buf, hdr, 0)
        _g.DeleteObject(bmp)
        _g.DeleteDC(mdc)
        _u.ReleaseDC(form, hdc)
        raw = buf.raw
        cw, ch, S = x1 - x0, y1 - y0, 4
        path = os.path.join(tempfile.gettempdir(), "hdsign_ef_client.bmp")
        try:
            # 실측(2026-11-20): 3배 LANCZOS + 흑백 기준 150~180 에서 '(주)에이치디사인' 정확(그냥 확대는 '메미치').
            from PIL import Image, ImageOps
            full = Image.frombuffer("RGB", (w, h), raw, "raw", "BGRX", 0, 1)
            im = full.crop((x0, y0, x1, y1)).convert("L")
            im = im.resize((cw * 3, ch * 3), Image.LANCZOS).point(lambda p: 255 if p > 165 else 0)
            ImageOps.expand(im, border=20, fill=255).convert("RGB").save(path)
            return path
        except ImportError:
            pass  # 경량 에이전트(Pillow 없음) — 아래 손으로 4배·흑백
        gray = [[0] * cw for _ in range(ch)]
        for yy in range(ch):
            base = ((y0 + yy) * w + x0) * 4
            for xx in range(cw):
                b, g, r = raw[base + xx * 4], raw[base + xx * 4 + 1], raw[base + xx * 4 + 2]
                gray[yy][xx] = 255 if (r * 299 + g * 587 + b * 114) // 1000 > 150 else 0
        pad = 20
        W, H = cw * S + pad * 2, ch * S + pad * 2
        row_bytes = (W * 3 + 3) & ~3
        out = bytearray()
        for yy in range(H - 1, -1, -1):  # BMP 는 아래 줄부터
            line = bytearray()
            sy = (yy - pad) // S
            for xx in range(W):
                sx = (xx - pad) // S
                v = gray[sy][sx] if 0 <= sy < ch and 0 <= sx < cw and yy >= pad and xx >= pad else 255
                line += bytes((v, v, v))
            line += b"\0" * (row_bytes - W * 3)
            out += line
        import struct
        head = struct.pack("<2sIHHI", b"BM", 54 + len(out), 0, 0, 54) + \
            struct.pack("<IiiHHIIiiII", 40, W, H, 1, 24, 0, len(out), 2835, 2835, 0, 0)
        path = os.path.join(tempfile.gettempdir(), "hdsign_ef_client.bmp")
        with open(path, "wb") as f:
            f.write(head + out)
        return path
    except Exception:
        logging.exception("거래처명 캡처 실패")
        return None


_OCR_PS = r"""
param($path)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$null=[Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime]
$null=[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
$null=[Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]
$asTask=([System.WindowsRuntimeSystemExtensions].GetMethods()|?{$_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'})[0]
function Await($op,$t){$task=$asTask.MakeGenericMethod($t).Invoke($null,@($op));$task.Wait();$task.Result}
$f=Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
$s=Await ($f.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$d=Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($s)) ([Windows.Graphics.Imaging.BitmapDecoder])
$b=Await ($d.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$e=[Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('ko'))
$r=Await ($e.RecognizeAsync($b)) ([Windows.Media.Ocr.OcrResult])
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$r.Text
"""


def _ocr(path: str) -> str:
    """Windows 기본 OCR(한국어) — PowerShell 로 부른다(추가 설치 없음). 실패하면 ''."""
    try:
        ps = os.path.join(tempfile.gettempdir(), "hdsign_ef_ocr.ps1")
        with open(ps, "w", encoding="utf-8-sig") as f:
            f.write(_OCR_PS)
        path = os.path.abspath(os.path.normpath(path))  # StorageFile 은 '/' 경로를 못 연다
        r = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps, path],
                           capture_output=True, timeout=15,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return r.stdout.decode("utf-8", "replace").strip()
    except Exception:
        logging.exception("거래처명 OCR 실패")
        return ""


# ── HTTP(홈페이지가 부름) ───────────────────────────────────────────────────────
def handle_events(after: int) -> dict:
    """GET /easyform/autosync?after=N — 아직 아무 탭도 가져가지 않은 이벤트."""
    now = time.time()
    with _LOCK:
        _STATE["last_poll"] = now
        evs = [{k: v for k, v in e.items() if k != "claimed"} for e in _STATE["events"]
               if e["id"] > after and not e["claimed"] and now - e["at"] < _EVENT_TTL]
        busy = _STATE["busy"]
        reading = _STATE["reading"]
    return {"available": bool(ef.EASYFORM_AVAILABLE and _STATE["started"]), "events": evs, "busy": busy,
            "reading": reading}


def handle_claim(eid: int, tab: str = "") -> dict:
    """POST /easyform/autosync/claim?id=N&tab=T — 이 PC 의 홈페이지 탭이 여러 개여도 한 탭만 카드를 띄우게.
    release 한 탭(안 보이는 탭)은 같은 건을 다시 못 가져간다(새로 연 탭이 가져가게)."""
    with _LOCK:
        for e in _STATE["events"]:
            if e["id"] == eid:
                if e["claimed"] or (tab and tab in e.get("noTabs", ())):
                    return {"ok": False}
                e["claimed"] = True
                return {"ok": True}
    return {"ok": False}


def handle_release(eid: int, tab: str = "") -> dict:
    """POST /easyform/autosync/release?id=N&tab=T — 카드를 가져간 탭이 브라우저에서 **안 보이는 탭**이라 앞으로
    못 띄움 → 내려놓고 관리자 페이지를 새 탭으로 연다(새 탭은 저절로 맨 앞 + 이 건을 가져가 카드를 띄움)."""
    with _LOCK:
        ev = next((e for e in _STATE["events"] if e["id"] == eid), None)
        if not ev:
            return {"ok": False}
        ev["claimed"] = False
        ev.setdefault("noTabs", [])
        if tab:
            ev["noTabs"].append(tab)
    logging.info("이지폼 저장 자동반영 — 홈페이지 탭이 안 보여서 관리자 페이지를 새 탭으로 엶")
    try:
        webbrowser.open(ADMIN_URL)
    except Exception:
        logging.exception("관리자 페이지 열기 실패")
    return {"ok": True}


def handle_back(eid: int) -> dict:
    """POST /easyform/autosync/back?id=N — 카드에서 다 끝남 → 이지폼 명세서 창을 다시 맨 앞으로(사용감)."""
    with _LOCK:
        ev = next((e for e in _STATE["events"] if e["id"] == eid), None)
    if not ev or not ef.EASYFORM_AVAILABLE:
        return {"ok": False}
    form = ev["form"]
    main = _main_of(form)
    if not main:
        return {"ok": False}
    ok = ef.ef_force_foreground(main)
    try:
        if bulk._shown(form):
            ef._user32.BringWindowToTop(form)
    except Exception:
        pass
    return {"ok": bool(ok)}


# Chrome 탭 목록(UI Automation)에서 이름에 그 글자가 든 탭을 골라(선택) 그 창 핸들을 돌려준다.
# 관리자 로그인은 탭마다(sessionStorage)라 새 탭을 열면 다시 로그인해야 함 → 이미 열린 관리자 탭을 앞으로(사용자 2026-11-20).
_TAB_PS = r"""
param($mark, $select = '1')
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$root = $A::RootElement
$wc = New-Object System.Windows.Automation.PropertyCondition($A::ClassNameProperty, 'Chrome_WidgetWin_1')
$tc = New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $wc)) {
  foreach ($t in $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tc)) {
    if ($t.Current.Name -like "*$mark*") {
      if ($select -eq '1') {
        try { $t.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select() } catch {
          try { $t.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() } catch {}
        }
      }
      "HWND=" + $w.Current.NativeWindowHandle
      exit 0
    }
  }
}
"NONE"
"""


def _select_chrome_tab(mark: str, select: bool = True):
    """이름에 mark 가 든 Chrome 탭 → 그 창 핸들(select=True 면 그 탭을 골라 둠). 없으면 None."""
    try:
        ps = os.path.join(tempfile.gettempdir(), "hdsign_ef_tab.ps1")
        with open(ps, "w", encoding="utf-8-sig") as f:
            f.write(_TAB_PS)
        r = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps, mark,
                            "1" if select else "0"],
                           capture_output=True, timeout=15,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        out = r.stdout.decode("utf-8", "replace")
        for line in out.splitlines():
            if line.startswith("HWND="):
                return int(line[5:].strip() or 0) or None
    except Exception:
        logging.exception("Chrome 탭 고르기 실패")
    return None


def handle_front(body: dict) -> dict:
    """POST /easyform/autosync/front {title} — 그 글자가 제목에 든 홈페이지를 맨 앞으로.
    ① 창 제목(관리자 탭이 그 창의 보이는 탭일 때) ② 안 보이는 탭이면 Chrome 탭 목록에서 골라 선택 후 그 창을 앞으로."""
    want = str((body or {}).get("title") or "").strip()
    if not want or not ef.EASYFORM_AVAILABLE:
        return {"ok": False}
    found: list = []

    def cb(h, _):
        if _u.IsWindowVisible(h) and want in _itext(h):
            found.append(h)
        return True

    _u.EnumWindows(bulk._ENUM(cb), 0)
    if found and ef.ef_force_foreground(found[0]):
        return {"ok": True, "how": "window"}
    h = _select_chrome_tab(want)
    if h:
        time.sleep(0.15)
        ok = ef.ef_force_foreground(h)
        logging.info("이지폼 저장 자동반영 — 숨은 관리자 탭을 골라 앞으로: %s", ok)
        return {"ok": bool(ok), "how": "tab"}
    return {"ok": False}


# ── 비고 적기(빠른 길) ──────────────────────────────────────────────────────────
# 방금 표 전체를 읽었으니(ev rows) 비고 칸을 다시 훑지 않고, 고칠 줄만 품목·비고 2칸 확인 → 적기 → 비고 1칸 확인.
# (예전 bulk._stamp_row_fast = 비고 전체 훑기 + 줄마다 6칸×2번 → 느렸음, 사용자 2026-11-20)
def _plan(rows: list, nos: list, move: bool, want_row: "int | None"):
    """어느 줄 비고를 어떻게 바꿀지 → (결과 dict, 고칠 것[(줄, 품목, 지금 비고, 바꿀 비고)], 번호 적힌 줄).
    고칠 게 없으면 edits=[] 이고 결과 dict 가 답(skipped/오류)."""
    text = ", ".join(nos)
    if move:
        # 지시서 1개짜리 명세서 — 번호는 항상 '위에서부터 비고가 빈 첫 줄'(그 번호 말고 다른 글이 있으면 그 밑).
        # 맨 위에 줄을 끼워 넣으면 이지폼 비고가 한 칸 밑으로 밀린다 → 제자리로 옮겨 적는다(사용자 2026-11-20).
        if len(nos) != 1:
            return {"ok": False, "message": "옮겨 적기는 주문번호 1개일 때만"}, [], None
        no = nos[0]
        holders = [i for i, r in enumerate(rows) if no in ef._EF_ORDER_NO_RE.findall(r.get("remark") or "")]
        cand = [i for i, r in enumerate(rows)
                if bulk._has_content(r) and not bulk._strip_nos(r.get("remark") or "", [no]).strip()]
        if not cand:
            return {"ok": True, "message": "번호를 옮길 빈 비고 칸이 없어서 그대로 뒀어요", "skipped": True}, [], None
        row = cand[0]
        if holders == [row]:
            return {"ok": True, "message": "이미 맨 위에 적혀 있어요", "skipped": True}, [], row
        edits = []
        base = (rows[row].get("remark") or "").strip()
        if row not in holders:
            edits.append((row, rows[row].get("item") or "", base, no))
        for i in holders:
            if i != row:
                old = (rows[i].get("remark") or "").strip()
                edits.append((i, rows[i].get("item") or "", old, bulk._strip_nos(old, [no])))
        return {"ok": True}, edits, row
    if want_row is not None and 0 <= want_row < len(rows):
        # 합친 명세서 — 밑에 새로 쓴 줄의 첫 줄(기존 비고 뒤에 붙임). 이미 명세서에 든 지시서 번호여도 적는다
        # (그 줄부터 그 지시서 구간 — 합친 명세서에서 추가한 줄이 어느 지시서인지 고른 경우, 사용자 2026-11-20).
        if all(n in (rows[want_row].get("remark") or "") for n in nos):
            return {"ok": True, "message": "이미 그 줄 비고에 적혀 있어요", "skipped": True}, [], want_row
        row = want_row
    elif any(all(n in (r.get("remark") or "") for n in nos) for r in rows):
        return {"ok": True, "message": "이미 비고에 적혀 있어요", "skipped": True}, [], None
    else:
        cand = [i for i, r in enumerate(rows) if bulk._has_content(r) and not (r.get("remark") or "").strip()]
        if not cand:
            return {"ok": False, "message": "이지폼 명세서에 빈 비고 칸이 없어서 안 적었어요."}, [], None
        row = cand[0]
    base = (rows[row].get("remark") or "").strip()
    return {"ok": True}, [(row, rows[row].get("item") or "", base, f"{base} {text}".strip() if base else text)], row


def _plan_places(rows: list, places: list):
    """합친 명세서 — 지시서마다 직원이 고른 시작 줄 비고에 그 번호(사용자 2026-11-25).
    places=[(줄, 번호)]. 다른 줄에 붙어 있던 같은 번호들은 지우고(구간이 꼬이지 않게), 고른 줄엔 기존 비고 뒤에 붙임."""
    nos = [no for _r, no in places]
    want_at: dict = {}
    for r, no in places:
        if not (0 <= r < len(rows)):
            return {"ok": False, "message": f"{r + 1}행이 명세서에 없어요"}, [], None
        want_at.setdefault(r, []).append(no)
    edits = []
    for i, r in enumerate(rows):
        old = (r.get("remark") or "").strip()
        new = bulk._strip_nos(old, nos)
        if i in want_at:
            new = f"{new} {', '.join(want_at[i])}".strip() if new else ", ".join(want_at[i])
        if new != old:
            edits.append((i, r.get("item") or "", old, new))
    if not edits:
        return {"ok": True, "message": "이미 그 줄들 비고에 적혀 있어요", "skipped": True}, [], places[0][0]
    return {"ok": True}, edits, places[0][0]


def _quick_set(main, grid, row: int, item: str, base: str, want: str) -> "str | None":
    """한 줄 비고 base → want. 품목·비고가 읽은 것과 같아야 적고, 적은 뒤 비고 1칸만 확인. 문제면 이유 글자."""
    cells = bulk._row_cells(grid, row)
    ix, iy = cells["item"]
    rx, ry = cells["remark"]
    got_item = bulk._cell_text(grid, ix, iy, 0.4)
    if got_item is None or got_item != (item or ""):
        return f"{row + 1}행 품목이 읽은 것과 달라서 안 적었어요"
    got = bulk._cell_text(grid, rx, ry, 0.4)  # 비고 칸 클릭 = 그 칸 편집칸이 뜸
    if got is None or got != (base or ""):
        return f"{row + 1}행 비고가 읽은 것과 달라서 안 적었어요"
    gl, gt, _r, _b = bulk._rect(grid)
    px, py = gl + rx, gt + ry

    def at(e):
        l, t, r, b = bulk._rect(e)
        return l - 2 <= px <= r + 2 and t - 2 <= py <= b + 2

    edit = next((e for e in bulk._kids(grid, "TAdvInplaceEdit") if at(e)), None)
    if not edit:
        return "비고 편집칸이 안 떠서 안 적었어요"
    bulk._u.SendMessageW(edit, 0x000C, 0, ctypes.c_wchar_p(want))  # WM_SETTEXT
    time.sleep(0.1)
    bulk._click(grid, "품목", ix, iy)  # 같은 줄 다른 칸 = 비고 확정
    time.sleep(0.25)
    if bulk._popups(main):
        raise bulk.Stop("비고를 적다가 이지폼 창이 떠서 멈췄어요. 이지폼을 직접 확인해주세요.")
    chk = bulk._cell_text(grid, rx, ry, 0.4)
    if chk != want:
        return f"{row + 1}행 비고가 '{chk}'(으)로 들어가서 저장 안 했어요"
    return None


def _apply(main, form, edits: list) -> dict:
    """고칠 것들 적고 저장 1번. 중간에 어긋나면 적은 칸을 되돌리고 저장 안 함(작업자 명세서 창이라 변경을 남기지 않게)."""
    grid = next(iter(bulk._kids(form, "TAdvStringGrid")), None)
    if not grid:
        return {"ok": False, "message": "명세서 표를 못 찾아서 안 적었어요"}
    done: list = []

    def undo():
        for row, item, base, want in reversed(done):
            try:
                _quick_set(main, grid, row, item, want, base)
            except Exception:
                logging.exception("비고 되돌리기 실패 %d행", row + 1)

    for e in edits:
        err = _quick_set(main, grid, *e)
        if err:
            undo()
            return {"ok": False, "message": err}
        done.append(e)
    res = bulk._save_with_yes(main, form)
    if not res.get("ok"):
        undo()
    return res


def _commit_rows(rows: list, edits: list) -> None:
    for row, _item, _base, want in edits:
        rows[row]["remark"] = want


def handle_stamp(body: dict) -> dict:
    """POST /easyform/autosync/stamp {id, nos:[주문번호], row?} — 아직 열려 있는 그 명세서의 비고에 주문번호를 적고 저장.
    row 를 주면 그 줄(합친 명세서의 새 지시서 시작 줄), 없으면
    비고 빈 칸 = 내용 있는 첫 줄(일괄 가져오기와 같은 규칙). 예상 밖이면 저장 안 함."""
    if not ef.EASYFORM_AVAILABLE:
        return {"ok": False, "message": "이 PC 에서는 이지폼 자동화를 쓸 수 없어요."}
    try:
        eid = int((body or {}).get("id") or 0)
    except (TypeError, ValueError):
        eid = 0
    nos = [str(n) for n in ((body or {}).get("nos") or []) if n][:10]
    places = []
    for p in ((body or {}).get("places") or [])[:10]:
        try:
            if p.get("no"):
                places.append((int(p.get("row")), str(p.get("no"))))
        except (TypeError, ValueError, AttributeError):
            pass
    if places and not nos:
        nos = [no for _r, no in places]
    with _LOCK:
        ev = next((e for e in _STATE["events"] if e["id"] == eid), None)
        if _STATE["busy"]:
            return {"ok": False, "message": "이지폼에서 다른 저장을 처리하는 중이에요."}
        _STATE["busy"] = True
    try:
        if not ev or not nos:
            return {"ok": False, "message": "반영할 명세서를 못 찾았어요."}
        form = ev["form"]
        main = _main_of(form)
        if not main or not bulk._shown(form):
            return {"ok": False, "message": "이지폼 명세서 창이 닫혀서 비고엔 못 적었어요."}
        date, total = bulk._form_header(form, ev["total"])
        if date != ev["date"] or bulk._digits(total) != bulk._digits(ev["total"]):
            return {"ok": False, "message": f"이지폼에 다른 명세서({date})가 열려 있어서 비고엔 못 적었어요."}
        if bulk._popups(main):
            return {"ok": False, "message": "이지폼에 질문창이 떠 있어서 비고엔 못 적었어요."}
        rows = ev["rows"]
        want_row = (body or {}).get("row")
        if places:
            res, edits, row = _plan_places(rows, places)
        else:
            res, edits, row = _plan(rows, nos, bool((body or {}).get("move")),
                                    want_row if isinstance(want_row, int) else None)
        if edits:
            _overlay("이지폼 비고에 주문번호만 적고 있어요.", ef.EF_SUB_NOESC)
            ef.ef_guard_start()
            try:
                bulk._ABORT.clear()
                res = _apply(main, form, edits)
            except bulk.Stop as e:
                res = {"ok": False, "message": str(e)}
            finally:
                ef.ef_guard_stop()
                _overlay(None)
            if res.get("ok"):
                _commit_rows(rows, edits)
                res.update(row=row, remark=rows[row].get("remark") or "")
        res["rows"] = rows  # 홈페이지는 이 줄들(비고 반영된)로 저장
        logging.info("이지폼 저장 자동반영 — 비고 적기 %s", {k: v for k, v in res.items() if k != "rows"})
        return res
    except Exception as e:  # noqa: BLE001
        logging.exception("이지폼 저장 자동반영 — 비고 적기 오류")
        return {"ok": False, "message": f"오류: {e}"}
    finally:
        with _LOCK:
            _STATE["busy"] = False


def start() -> None:
    """워처/에이전트 시작 때 1번. 이지폼 자동화가 안 되는 PC 면 아무것도 안 함."""
    if not ef.EASYFORM_AVAILABLE or sys.platform != "win32":
        return
    with _LOCK:
        if _STATE["started"]:
            return
        _STATE["started"] = True
    threading.Thread(target=_hook_thread, daemon=True, name="ef-autosync-hook").start()
    threading.Thread(target=_dispatch_thread, daemon=True, name="ef-autosync").start()
