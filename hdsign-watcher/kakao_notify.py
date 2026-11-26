# kakao_notify.py
# 지시서 웹반영(인쇄) 직후 → PC 카카오톡 단톡방에 '지시서 사진 + 거래처명' 자동 전송.
#
# 카카오 공식 API 는 단톡방 전송이 없어서 PC 카톡 창을 직접 다룬다(사람이 하던 순서 그대로):
#   ① 방 창 찾기(제목 = 방 이름 정확 일치) — 없으면 카톡 메인창 검색칸에 이름 넣고 Enter 로 열기
#   ② 사진: 클립보드에 이미지 → 방 창을 잠깐 앞으로 → Ctrl+V → 뜨는 '사진 보내기' 확인창 Enter
#   ③ 거래처명: 입력칸(RICHEDIT50W)에 WM_SETTEXT → Enter (백그라운드로 됨)
#   ④ 원래 쓰던 창으로 포커스 돌려줌. 도중엔 입력잠금(물리 키/마우스만 막음, ESC=중단)
# 카톡 창 구조(2026-11 실측): 방 창 = 최상위 'EVA_Window_Dblclk'(제목=방 이름) 밑에 RICHEDIT50W(입력칸)
#   메인 = 제목 '카카오톡' → ChatRoomListView 밑 Edit(검색칸).
# 카톡 업데이트로 구조가 바뀌면 실패 → 호출부가 '직접 올려주세요' 알림 + 실패 원인 복사.

from __future__ import annotations

import ctypes
import io
import time
import unicodedata
from ctypes import wintypes
from pathlib import Path

u = ctypes.windll.user32
k = ctypes.windll.kernel32

u.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
u.FindWindowExW.argtypes = [wintypes.HWND, wintypes.HWND, wintypes.LPCWSTR, wintypes.LPCWSTR]
u.FindWindowExW.restype = wintypes.HWND
u.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
u.FindWindowW.restype = wintypes.HWND
u.SendMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
u.SendMessageW.restype = ctypes.c_ssize_t
u.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
u.GetForegroundWindow.restype = wintypes.HWND
u.SetForegroundWindow.argtypes = [wintypes.HWND]
u.BringWindowToTop.argtypes = [wintypes.HWND]
u.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
u.IsIconic.argtypes = [wintypes.HWND]
u.IsWindow.argtypes = [wintypes.HWND]
u.IsWindowVisible.argtypes = [wintypes.HWND]
u.GetWindow.argtypes = [wintypes.HWND, ctypes.c_uint]
u.GetWindow.restype = wintypes.HWND
u.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
u.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
u.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
u.GetWindowTextLengthW.argtypes = [wintypes.HWND]
u.OpenClipboard.argtypes = [wintypes.HWND]
u.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
u.SetClipboardData.restype = wintypes.HANDLE
k.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
k.GlobalAlloc.restype = wintypes.HGLOBAL
k.GlobalLock.argtypes = [wintypes.HGLOBAL]
k.GlobalLock.restype = ctypes.c_void_p
k.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
k.GlobalFree.argtypes = [wintypes.HGLOBAL]

_ENUM_PROTO = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)

WM_SETTEXT = 0x000C
WM_KEYDOWN = 0x0100
WM_KEYUP = 0x0101
VK_RETURN = 0x0D
VK_CONTROL = 0x11
VK_MENU = 0x12
VK_V = 0x56
CF_DIB = 8

MAIN_TITLE = "카카오톡"
ROOM_CLASS = "EVA_Window_Dblclk"


class KakaoError(Exception):
    pass


# ── 창 헬퍼 ──────────────────────────────────────────────────────────────────

def _cls(h) -> str:
    b = ctypes.create_unicode_buffer(256)
    u.GetClassNameW(h, b, 256)
    return b.value or ""


def _txt(h) -> str:
    n = u.GetWindowTextLengthW(h)
    if n <= 0:
        return ""
    b = ctypes.create_unicode_buffer(n + 1)
    u.GetWindowTextW(h, b, n + 1)
    return b.value or ""


def _norm(s: str) -> str:
    return unicodedata.normalize("NFC", (s or "").strip())


def _kakao_pids() -> set[int]:
    """KakaoTalk.exe 프로세스 id — 메인창('카카오톡') 주인으로 찾음(tasklist 안 띄움)."""
    pids: set[int] = set()
    h = u.FindWindowW(ROOM_CLASS, MAIN_TITLE)
    if h:
        p = wintypes.DWORD()
        u.GetWindowThreadProcessId(h, ctypes.byref(p))
        if p.value:
            pids.add(p.value)
    return pids


def _top_windows(pids: set[int]) -> list[int]:
    out: list[int] = []

    def cb(h, _l):
        p = wintypes.DWORD()
        u.GetWindowThreadProcessId(h, ctypes.byref(p))
        if p.value in pids:
            out.append(h)
        return True

    u.EnumWindows(_ENUM_PROTO(cb), 0)
    return out


def _room_input(h) -> int:
    return u.FindWindowExW(h, None, "RICHEDIT50W", None) or 0


def is_running() -> bool:
    return bool(_kakao_pids())


def list_open_rooms() -> list[str]:
    """지금 따로 열려 있는 카톡 채팅방 창 제목(=방 이름) 목록. 설정창에서 고를 때 씀."""
    pids = _kakao_pids()
    if not pids:
        return []
    names = []
    for h in _top_windows(pids):
        if _cls(h) != ROOM_CLASS:
            continue
        t = _norm(_txt(h))
        if not t or t == MAIN_TITLE:
            continue
        if _room_input(h):
            names.append(t)
    seen = set()
    return [n for n in names if not (n in seen or seen.add(n))]


def _find_room(name: str) -> int:
    pids = _kakao_pids()
    want = _norm(name)
    for h in _top_windows(pids):
        if _cls(h) == ROOM_CLASS and _norm(_txt(h)) == want and _room_input(h):
            return h
    return 0


def _main_search_edit() -> int:
    main = u.FindWindowW(ROOM_CLASS, MAIN_TITLE)
    if not main:
        return 0
    online = u.FindWindowExW(main, None, "EVA_ChildWindow", None)
    while online:
        # 채팅 탭(ChatRoomListView) 밑 검색칸 우선, 없으면 친구 탭(ContactListView) 검색칸
        for view_prefix in ("ChatRoomListView", "ContactListView"):
            v = u.FindWindowExW(online, None, "EVA_Window", None)
            while v:
                if _txt(v).startswith(view_prefix):
                    e = u.FindWindowExW(v, None, "Edit", None)
                    if e:
                        return e
                v = u.FindWindowExW(online, v, "EVA_Window", None)
        online = u.FindWindowExW(main, online, "EVA_ChildWindow", None)
    return 0


def _post_enter(h) -> None:
    u.PostMessageW(h, WM_KEYDOWN, VK_RETURN, 0x001C0001)
    time.sleep(0.03)
    u.PostMessageW(h, WM_KEYUP, VK_RETURN, 0xC01C0001)


def _set_text(h, s: str) -> None:
    buf = ctypes.create_unicode_buffer(s)
    u.SendMessageW(h, WM_SETTEXT, 0, ctypes.cast(buf, ctypes.c_void_p).value)


def _open_room(name: str, timeout: float = 4.0) -> int:
    """방 창이 안 열려 있으면 카톡 메인 검색칸에 방 이름 → Enter 로 연다. 제목이 정확히 같은 창이 떠야 성공."""
    h = _find_room(name)
    if h:
        return h
    edit = _main_search_edit()
    if not edit:
        raise KakaoError("카톡 메인창 검색칸을 못 찾음(카톡 로그인/화면 구조 확인)")
    _set_text(edit, name)
    time.sleep(0.6)  # 검색 결과 갱신 대기
    _post_enter(edit)
    end = time.time() + timeout
    while time.time() < end:
        time.sleep(0.2)
        h = _find_room(name)
        if h:
            break
    try:
        _set_text(edit, "")  # 검색칸 원상복구
    except Exception:
        pass
    if not h:
        raise KakaoError(f"'{name}' 방을 못 열었어요(방 이름이 정확한지 확인)")
    return h


# ── 사진 ─────────────────────────────────────────────────────────────────────

def render_pdf_image(pdf_path: Path, out_path: Path, long_side: int = 1600, quality: int = 85) -> Path:
    """지시서 PDF 첫 장 → JPG (홈페이지 작업지시서 카드처럼 한 장 전체). 긴 변 1600px·품질 85 ≈ 200~500KB."""
    import fitz  # type: ignore
    from PIL import Image

    doc = fitz.open(str(pdf_path))
    try:
        page = doc[0]
        r = page.rect
        scale = long_side / max(r.width, r.height, 1)
        pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
        img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    finally:
        doc.close()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(str(out_path), "JPEG", quality=quality, optimize=True)
    return out_path


def _clipboard_set_image(img_path: Path) -> None:
    from PIL import Image

    img = Image.open(str(img_path)).convert("RGB")
    bio = io.BytesIO()
    img.save(bio, "BMP")
    data = bio.getvalue()[14:]  # BITMAPFILEHEADER 떼면 CF_DIB
    for _ in range(10):
        if u.OpenClipboard(None):
            break
        time.sleep(0.05)
    else:
        raise KakaoError("클립보드를 열 수 없음")
    try:
        u.EmptyClipboard()
        hmem = k.GlobalAlloc(0x0002, len(data))  # GMEM_MOVEABLE
        p = k.GlobalLock(hmem)
        ctypes.memmove(p, data, len(data))
        k.GlobalUnlock(hmem)
        if not u.SetClipboardData(CF_DIB, hmem):
            k.GlobalFree(hmem)
            raise KakaoError("클립보드에 사진 넣기 실패")
    finally:
        u.CloseClipboard()


def _clipboard_set_text(text: str) -> None:
    data = (text + "\0").encode("utf-16-le")
    for _ in range(10):
        if u.OpenClipboard(None):
            break
        time.sleep(0.05)
    else:
        raise KakaoError("클립보드를 열 수 없음")
    try:
        u.EmptyClipboard()
        hmem = k.GlobalAlloc(0x0002, len(data))
        p = k.GlobalLock(hmem)
        ctypes.memmove(p, data, len(data))
        k.GlobalUnlock(hmem)
        if not u.SetClipboardData(13, hmem):  # CF_UNICODETEXT
            k.GlobalFree(hmem)
            raise KakaoError("클립보드에 글자 넣기 실패")
    finally:
        u.CloseClipboard()


def _key(vk: int, up: bool = False) -> None:
    s = u.MapVirtualKeyW(vk, 0)
    u.keybd_event(vk, s, 2 if up else 0, 0)


def _force_fg(h) -> bool:
    if u.IsIconic(h):
        u.ShowWindow(h, 9)  # SW_RESTORE
    if u.GetForegroundWindow() == h:
        return True
    for _ in range(4):
        # 전면화 잠금 풀기용 '아무 키' — ⚠ Alt 는 카톡 창에 시스템 메뉴(이동/크기/닫기)를 띄워 뒤 Enter 를
        #   먹어버림(2026-11-26 실측). 단독 Ctrl 은 아무 동작 없음.
        _key(VK_CONTROL)
        _key(VK_CONTROL, up=True)
        fg = u.GetForegroundWindow()
        tid_fg = u.GetWindowThreadProcessId(fg, None) if fg else 0
        tid_me = k.GetCurrentThreadId()
        attached = bool(tid_fg and tid_fg != tid_me and u.AttachThreadInput(tid_me, tid_fg, True))
        try:
            u.BringWindowToTop(h)
            u.SetForegroundWindow(h)
        except Exception:
            pass
        finally:
            if attached:
                u.AttachThreadInput(tid_me, tid_fg, False)
        time.sleep(0.15)
        if u.GetForegroundWindow() == h:
            return True
    return False


def _click_center(h) -> None:
    """입력칸을 마우스로 진짜 클릭(주입). ⚠ SetFocus 로 포커스만 주면 글자는 붙어도 카톡이 사진 붙여넣기를
    무시함(2026-11-26 실측) — 클릭해야 '클립보드 이미지 전송' 창이 뜬다. 커서는 원래 자리로 돌려놓음."""
    r = wintypes.RECT()
    u.GetWindowRect(h, ctypes.byref(r))
    pt = wintypes.POINT()
    u.GetCursorPos(ctypes.byref(pt))
    u.SetCursorPos((r.left + r.right) // 2, (r.top + r.bottom) // 2)
    time.sleep(0.05)
    u.mouse_event(0x0002, 0, 0, 0, 0)
    time.sleep(0.03)
    u.mouse_event(0x0004, 0, 0, 0, 0)
    time.sleep(0.2)
    u.SetCursorPos(pt.x, pt.y)


def _owned_popup(room: int, before: set[int]) -> int:
    """방 창이 주인인 새 창(= '클립보드 이미지 전송'). 카톡 새 메시지 알림창 같은 건 주인이 달라 제외."""
    for h in _top_windows(_kakao_pids()):
        if h in before or not u.IsWindowVisible(h):
            continue
        if u.GetWindow(h, 4) == room:  # GW_OWNER
            return h
    return 0


def _send_image(room: int, img_path: Path, guard_aborted) -> None:
    _clipboard_set_image(img_path)
    if not _force_fg(room):
        raise KakaoError("카톡 방 창을 앞으로 못 가져옴")
    inp = _room_input(room)
    _click_center(inp)
    before = {h for h in _top_windows(_kakao_pids()) if u.IsWindowVisible(h)}
    if guard_aborted():
        raise KakaoError("ESC 로 중단")
    _key(VK_CONTROL)
    _key(VK_V)
    _key(VK_V, up=True)
    _key(VK_CONTROL, up=True)
    # 붙여넣으면 '클립보드 이미지 전송' 창(방 창 소유)이 뜸 → Enter(=전송)
    dlg = 0
    end = time.time() + 4.0
    while time.time() < end:
        time.sleep(0.15)
        dlg = _owned_popup(room, before)
        if dlg:
            break
    if not dlg:
        raise KakaoError("사진 붙여넣기 후 '클립보드 이미지 전송' 창이 안 뜸")
    if guard_aborted():
        raise KakaoError("ESC 로 중단")
    time.sleep(0.3)
    _force_fg(dlg)
    _key(VK_RETURN)
    _key(VK_RETURN, up=True)
    end = time.time() + 4.0
    while time.time() < end and u.IsWindow(dlg) and u.IsWindowVisible(dlg):
        time.sleep(0.15)
    if u.IsWindow(dlg) and u.IsWindowVisible(dlg):
        raise KakaoError("사진 전송 확인창이 안 닫힘")


def _text_len(h) -> int:
    return int(u.SendMessageW(h, 0x000E, 0, 0) or 0)  # WM_GETTEXTLENGTH (GetWindowTextLength 는 0 만 줌)


def _send_text(room: int, text: str) -> None:
    """글 넣기는 WM_SETTEXT, 전송은 진짜 Enter(주입) — 백그라운드 PostMessage Enter 는 카톡이 무시(2026-11-26 실측)."""
    inp = _room_input(room)
    if not inp:
        raise KakaoError("방 입력칸(RICHEDIT50W) 못 찾음")
    if u.GetForegroundWindow() != room and not _force_fg(room):
        raise KakaoError("카톡 방 창을 앞으로 못 가져옴")
    _click_center(inp)
    # ⚠ WM_SETTEXT 로 넣으면 카톡이 '바뀜'을 몰라 전송 버튼이 회색 → Enter 무시. 클립보드 글자 + Ctrl+V 로 넣음.
    _clipboard_set_text(text)
    _key(VK_CONTROL)
    _key(VK_V)
    _key(VK_V, up=True)
    _key(VK_CONTROL, up=True)
    time.sleep(0.25)
    if _text_len(inp) <= 0:
        raise KakaoError("거래처명 붙여넣기 실패")
    _key(VK_RETURN)
    _key(VK_RETURN, up=True)
    # (보낸 뒤 입력칸 길이는 카톡이 화면상 비워도 옛 값을 돌려줘서 확인에 못 씀 — 2026-11-26 실측)
    time.sleep(0.3)


def send_worksheet(rooms: list[str], img_path: Path | None, text: str,
                   guard_start=None, guard_stop=None, guard_aborted=None) -> list[tuple[str, bool, str]]:
    """방마다 사진(있으면) + 글 전송. 결과 [(방, 성공, 사유)]. 예외 밖으로 안 던짐."""
    guard_aborted = guard_aborted or (lambda: False)
    results: list[tuple[str, bool, str]] = []
    if not is_running():
        return [(r, False, "카카오톡이 안 켜져 있음(로그인 필요)") for r in rooms]
    prev_fg = u.GetForegroundWindow()
    guarded = False
    try:
        if img_path is not None and guard_start:
            guarded = bool(guard_start())
        for name in rooms:
            try:
                was_open = bool(_find_room(name))
                room = _open_room(name)
                if img_path is not None:
                    _send_image(room, img_path, guard_aborted)
                if text:
                    _send_text(room, text)
                results.append((name, True, ""))
                if not was_open:
                    time.sleep(0.5)
                    u.PostMessageW(room, 0x0010, 0, 0)  # 우리가 연 방 창은 다시 닫음(WM_CLOSE)
            except Exception as e:  # noqa: BLE001
                results.append((name, False, str(e)))
                if guard_aborted():
                    for rest in rooms[len(results):]:
                        results.append((rest, False, "ESC 로 중단"))
                    break
    finally:
        if guarded and guard_stop:
            guard_stop()
        try:
            if prev_fg and u.IsWindow(prev_fg):
                _force_fg(prev_fg)
        except Exception:
            pass
    return results
