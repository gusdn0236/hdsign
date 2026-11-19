"""이지폼 일괄 가져오기 — 웹 명세서 탭 [📥 이지폼에서 가져오기] 의 워처 쪽. **백그라운드 동작**.

두 단계(웹이 차례로 부른다):
  1) export : 켜져 있는 이지폼(주식회사·개인) 각각에서 [거래명세서 목록보기] → 기간 올해 1/1~12/31
              → [조회] → [엑셀(csv)] → 경로창 [저장] → 안내창 [No] → CSV 를 읽어 돌려주고 **파일은 지운다**.
  2) read   : 웹이 짝지어 고른 명세서들만 목록에서 N번째 줄을 열어(Enter) 품목 표를 읽고 ESC 로 닫는다.

백그라운드(2026-11-18 실측): 화면 클릭(SendInput) 대신 **그 컨트롤 창에 직접 마우스·키 메시지를 보낸다**
(PostMessage WM_LBUTTONDOWN/UP, WM_KEYDOWN/UP). 이지폼이 최소화돼 있어도(델파이 = 메인 창 숨김) 버튼·목록·
명세서 표 모두 반응한다 → 이지폼을 펼치지 않고, 홈페이지 화면만 보인 채로 끝난다. 사람 마우스·키보드는
막지 않는다(화면을 안 쓰므로). 정지·일시정지는 웹 버튼으로만(ESC 정지 없음 — 실수 방지). ⚠ 작업 중엔 이지폼을 직접 만지지 말 것.
(BM_CLICK·WM_COMMAND(BN_CLICKED)·CN_COMMAND 는 안 먹었음 — 마우스 메시지만 됨.)

안전 규칙(사용자 지시 2026-11-18 — 이지폼은 함부로 누르면 안 됨):
  - 시작 전·중간에 그 이지폼에 명세서 작성/상세 창(TfrmExchange)·질문창·경로창 등 **우리가 띄운 게 아닌 창**이
    있으면 아무것도 누르지 않고 멈춘다.
  - 누르는 '저장'은 엑셀 경로창(TfrmSavePath, 경로가 EasyformNetC\\temp\\*.csv)의 [저장] 하나뿐.
    안내창은 제목 'Information' + Yes/No 두 버튼일 때만 [No]. 그 밖의 창이 뜨면 멈춘다.
  - 명세서는 읽기만(칸 클릭 → 편집칸 글자 읽기, 표 보기 스크롤, ESC). 글자 입력·Enter(표 안)는 절대 안 보냄.
    닫을 때 질문창이 뜨거나 안 닫히면 아무것도 안 누르고 멈춘다.
"""
from __future__ import annotations

import csv
import io
import logging
import os
import re
import threading
import time

import easyform as ef

_LOCK = threading.Lock()
_JOB = {"id": 0, "state": "idle", "phase": "", "message": "", "progress": "",
        "lists": [], "results": [], "at": 0.0}
_CSV_DIR_HINT = "easyformnetc\\temp"
_ABORT = threading.Event()
_PAUSE = threading.Event()
_LAST_LISTS: dict = {}  # biz → 마지막 export 목록(읽기에서 줄 어긋남 보정용)

if ef.EASYFORM_AVAILABLE:
    import ctypes
    from ctypes import wintypes

    _u = ctypes.WinDLL("user32", use_last_error=True)  # easyform 의 argtypes 와 섞이지 않게 따로
    _ENUM = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    _u.EnumWindows.argtypes = [_ENUM, wintypes.LPARAM]
    _u.EnumChildWindows.argtypes = [wintypes.HWND, _ENUM, wintypes.LPARAM]
    _u.SendMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, ctypes.c_void_p]
    _u.SendMessageW.restype = ctypes.c_ssize_t
    _u.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    _u.GetMenu.argtypes = [wintypes.HWND]
    _u.GetMenu.restype = ctypes.c_void_p
    _u.GetSubMenu.argtypes = [ctypes.c_void_p, ctypes.c_int]
    _u.GetSubMenu.restype = ctypes.c_void_p
    _u.GetMenuItemCount.argtypes = [ctypes.c_void_p]
    _u.GetMenuItemID.argtypes = [ctypes.c_void_p, ctypes.c_int]
    _u.GetMenuItemID.restype = wintypes.UINT
    _u.GetMenuStringW.argtypes = [ctypes.c_void_p, wintypes.UINT, wintypes.LPWSTR, ctypes.c_int, wintypes.UINT]
    _u.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    _u.GetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int]
    _u.GetWindowLongW.restype = ctypes.c_long
    _u.IsWindowVisible.argtypes = [wintypes.HWND]
    _u.IsWindow.argtypes = [wintypes.HWND]
    _u.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    _u.ClientToScreen.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.POINT)]
    _u.GetAsyncKeyState.argtypes = [ctypes.c_int]
    _u.GetAsyncKeyState.restype = ctypes.c_short


class Stop(Exception):
    """안전하게 멈춤 — 아무것도 더 누르지 않고 이유를 웹에 보여준다."""


# ── 창 도구 ───────────────────────────────────────────────────────────────────
def _cls(h) -> str:
    b = ctypes.create_unicode_buffer(256)
    _u.GetClassNameW(h, b, 256)
    return b.value or ""


def _txt(h) -> str:
    b = ctypes.create_unicode_buffer(1024)
    _u.SendMessageW(h, 0x000D, 1024, b)  # WM_GETTEXT
    return b.value or ""


def _shown(h) -> bool:
    """창 자신의 '보임' 표시(WS_VISIBLE). 부모(이지폼 메인)가 최소화로 숨어 있어도 떠 있는 컨트롤이면 True."""
    return bool(h and _u.IsWindow(h) and (_u.GetWindowLongW(h, -16) & 0x10000000))


def _rect(h):
    r = wintypes.RECT()
    _u.GetWindowRect(h, ctypes.byref(r))
    return r.left, r.top, r.right, r.bottom


def _kids(h, klass=None) -> list:
    """자식 창들 중 떠 있는 것(WS_VISIBLE) — 이지폼이 최소화돼 숨어 있어도 찾는다."""
    out: list = []

    def cb(x, _):
        if (klass is None or _cls(x) == klass) and _shown(x):
            out.append(x)
        return True

    _u.EnumChildWindows(h, _ENUM(cb), 0)
    return out


def _pid(h) -> int:
    p = wintypes.DWORD()
    _u.GetWindowThreadProcessId(h, ctypes.byref(p))
    return p.value


def _app_of(main):
    """이 이지폼 프로세스의 TApplication 창(델파이 — 최소화하면 이 창만 남고 메인 창은 숨김)."""
    pid = _pid(main)
    found: list = []

    def cb(h, _):
        if _cls(h) == "TApplication" and _pid(h) == pid:
            found.append(h)
        return True

    _u.EnumWindows(_ENUM(cb), 0)
    return found[0] if found else None


def _mains() -> list:
    """켜져 있는 이지폼들 → [{hwnd, biz:'corp'|'personal', name}]. 제목 '...: (주)에이치디사인(138-81-...)'.
    ⚠ 이지폼(델파이)은 **최소화하면 메인 창(TfrmBookMain)을 숨긴다** → 같은 프로세스의 TApplication 창이
    보이면(작업표시줄에 있음) 켜진 것으로 본다."""
    out: list = []

    def cb(h, _):
        if _cls(h) == "TfrmBookMain":
            app = _app_of(h)
            if _u.IsWindowVisible(h) or (app and _u.IsWindowVisible(app)):
                t = _txt(h)
                name = t.split(":", 1)[1].strip() if ":" in t else t
                out.append({"hwnd": h, "biz": "corp" if "(주)" in name or "주식회사" in name else "personal",
                            "name": name})
        return True

    _u.EnumWindows(_ENUM(cb), 0)
    return out


def _popups(main) -> list:
    """이 이지폼 프로세스의 떠 있는 최상위 창(메인·풍선도움말 제외) → [(hwnd, class, 제목)]."""
    pid = _pid(main)
    out: list = []

    def cb(h, _):
        if h != main and _u.IsWindowVisible(h) and _pid(h) == pid \
                and _cls(h) not in ("TApplication", "THintWindow", "SysShadow", "TfrmBookMain", "IME"):
            out.append((h, _cls(h), _txt(h)))
        return True

    _u.EnumWindows(_ENUM(cb), 0)
    return out


def _mdi_forms(main) -> list:
    return [(h, _cls(h), _txt(h)) for h in _kids(main) if _cls(h).startswith("Tfrm")]


def _assert_clean(main, allow=("TfrmListExchange",)) -> None:
    """우리가 띄운 것 말고 다른 창이 있으면 멈춘다. allow = 있어도 되는 MDI 폼 클래스."""
    pops = _popups(main)
    if pops:
        raise Stop(f"이지폼에 '{pops[0][2] or pops[0][1]}' 창이 떠 있어서 멈췄어요. 그 창을 닫고 다시 해주세요.")
    for _h, c, t in _mdi_forms(main):
        if c not in allow:
            if c == "TfrmExchange":
                raise Stop("작성중인 명세서가 있어서 멈췄어요. 명세서를 닫고 실행해주세요.")
            raise Stop(f"이지폼에 '{t or c}' 창이 열려 있어서 멈췄어요. 그 창을 닫고 다시 해주세요.")


def _aborted() -> bool:
    """웹 [정지] 버튼으로만 멈춘다(사용자 지시 2026-11-18 — 실수로 ESC 를 눌러 멈추는 일이 있어 ESC 정지는 없앰)."""
    return _ABORT.is_set()


def _pause_point(progress=None) -> None:
    """웹 [일시정지] — 명세서를 다 닫고 다음 건으로 넘어가는 자리에서만 멈춘다(이지폼에 창이 열린 채 서지 않게).
    [계속] 이면 이어서, [정지] 면 멈춤."""
    if not _PAUSE.is_set():
        return
    with _LOCK:
        _JOB["paused"] = True
    if progress:
        progress("일시정지됨 — [계속]을 누르면 이어서 해요")
    while _PAUSE.is_set() and not _ABORT.is_set():
        time.sleep(0.15)
    with _LOCK:
        _JOB["paused"] = False
    if _ABORT.is_set():
        raise Stop("정지했어요.")


def _watch_front(stop: threading.Event, home) -> None:
    """작업 중 사람이 이지폼을 앞으로 불러오면(사용자 제안 2026-11-18): 즉시 마우스·키보드 잠금
    → 이지폼을 다시 내리고 홈페이지 창을 앞으로 → 잠금 해제. 자동화는 숨은 창에 메시지로 하므로 계속 진행된다.
    ⚠ 이지폼을 불러온 첫 클릭 자체는 못 막는다(이미 들어간 뒤 감지)."""
    pids = set()
    guarded = False
    while not stop.is_set():
        try:
            if not pids:
                pids = {_pid(m["hwnd"]) for m in _mains()}
            fg = _u.GetForegroundWindow()
            if fg and _pid(fg) in pids:
                if not guarded:
                    ef.ef_guard_start()
                    guarded = True
                    logging.info("이지폼 일괄: 작업 중 이지폼이 앞에 나옴 → 입력 잠금 + 다시 내림")
                for m in _mains():
                    app = _app_of(m["hwnd"])
                    if app and _u.IsWindowVisible(m["hwnd"]):
                        _u.PostMessageW(app, 0x0112, 0xF020, 0)  # SC_MINIMIZE
                if home and _u.IsWindow(home):
                    ef.ef_force_foreground(home)
                time.sleep(0.4)
            elif guarded:
                time.sleep(0.3)
                for m in _mains():  # 펼치는 중에 보낸 최소화가 씹혔으면 한 번 더
                    app = _app_of(m["hwnd"])
                    if app and _u.IsWindowVisible(m["hwnd"]):
                        _u.PostMessageW(app, 0x0112, 0xF020, 0)
                ef.ef_guard_stop()
                guarded = False
        except Exception:
            logging.exception("이지폼 앞 감시 오류")
        time.sleep(0.05)
    if guarded:
        ef.ef_guard_stop()


def _wait(cond, timeout: float, step: float = 0.08):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if _aborted():
            raise Stop("정지했어요.")
        v = cond()
        if v:
            return v
        time.sleep(step)
    return None


# ── 메시지로 누르기(화면 안 씀) ────────────────────────────────────────────────
def _client_xy(h, x: int, y: int) -> int:
    """창 왼위 기준 (x, y) → 그 창 클라이언트 좌표 lParam."""
    pt = wintypes.POINT(0, 0)
    _u.ClientToScreen(h, ctypes.byref(pt))
    l, t, _r, _b = _rect(h)
    cx, cy = x - (pt.x - l), y - (pt.y - t)
    return ((cy & 0xFFFF) << 16) | (cx & 0xFFFF)


def _click(h, what: str, x: "int | None" = None, y: "int | None" = None) -> None:
    """컨트롤에 마우스 왼쪽 누름/뗌 메시지. x,y 없으면 가운데(창 왼위 기준 좌표)."""
    if not _shown(h):
        raise Stop(f"'{what}'을(를) 못 찾아서 멈췄어요.")
    if x is None:
        l, t, r, b = _rect(h)
        x, y = (r - l) // 2, (b - t) // 2
    lp = _client_xy(h, x, y)
    _u.PostMessageW(h, 0x0201, 0x0001, lp)  # WM_LBUTTONDOWN (MK_LBUTTON)
    time.sleep(0.03)
    _u.PostMessageW(h, 0x0202, 0, lp)       # WM_LBUTTONUP


def _key(h, vk: int) -> None:
    """방향키·Enter·ESC·PageUp/Home 만 쓴다(글자 입력 없음)."""
    _u.PostMessageW(h, 0x0100, vk, 0x00000001)  # WM_KEYDOWN
    _u.PostMessageW(h, 0x0101, vk, 0xC0000001)  # WM_KEYUP


def _menu_id(main, parent_text: str, item_text: str):
    """메뉴에서 '거래명세서' 아래 '거래명세서 목록보기'(매출 쪽 = 첫 번째) 의 명령 ID."""
    hm = _u.GetMenu(main)
    if not hm:
        return None

    def s(menu, i):
        b = ctypes.create_unicode_buffer(256)
        _u.GetMenuStringW(menu, i, b, 256, 0x400)
        return (b.value or "").strip()

    for i in range(_u.GetMenuItemCount(hm)):
        sub = _u.GetSubMenu(hm, i)
        if not sub:
            continue
        for j in range(_u.GetMenuItemCount(sub)):
            if s(sub, j) != parent_text:
                continue
            ss = _u.GetSubMenu(sub, j)
            for k in range(_u.GetMenuItemCount(ss) if ss else 0):
                if s(ss, k) == item_text:
                    return _u.GetMenuItemID(ss, k)
    return None


def _sales_list(main):
    for h in _kids(main, "TfrmListExchange"):
        if "매출" in _txt(h):
            return h
    return None


def _named(parent, klass, text):
    for h in _kids(parent, klass):
        if _txt(h).replace("&", "").strip() == text:
            return h
    return None


def _period_grid(lst):
    """'기간으로 조회' 탭과 그 목록 표(TwwDBGrid)."""
    sheet = _named(lst, "TTabSheet", "기간으로 조회")
    if not sheet:
        return None, None
    grids = _kids(sheet, "TwwDBGrid")
    return sheet, (grids[0] if grids else None)


def _ensure_period_tab(lst):
    """'기간으로 조회' 탭이 앞에 없으면(매출처별 조회 등) 그 탭으로 바꾼다 — 클릭 없이 TCM_SETCURFOCUS.
    델파이는 안 보이는 탭의 페이지 창을 안 만들어 두므로 탭을 바꿔야 표가 생긴다. 실측: 탭 3개, 0번 = 기간으로 조회."""
    sheet, grid = _period_grid(lst)
    if grid:
        return sheet, grid
    pcs = [h for h in _kids(lst, "TPageControl") if _u.GetParent(h) == lst]
    for pc in pcs:
        n = _u.SendMessageW(pc, 0x1304, 0, 0)  # TCM_GETITEMCOUNT
        for i in [0] + list(range(1, n)):
            _u.SendMessageW(pc, 0x1330, i, 0)  # TCM_SETCURFOCUS — 탭 누른 것과 같이 바뀜 알림까지 보냄
            got = _wait(lambda: _period_grid(lst)[1], 2.0)
            if got:
                time.sleep(0.4)
                return _period_grid(lst)
    return None, None


def _count_text(lst) -> str:
    for p in _kids(lst, "TPanel"):
        t = _txt(p)
        if "자료가 있습니다" in t:
            return t
    return ""


def _open_list(main):
    """매출 거래명세서 목록 창(없으면 메뉴 명령으로 연다 — 클릭 없음)."""
    lst = _sales_list(main)
    if not lst:
        mid = _menu_id(main, "거래명세서", "거래명세서 목록보기")
        if not mid:
            raise Stop("이지폼 메뉴에서 '거래명세서 목록보기'를 못 찾았어요.")
        _u.PostMessageW(main, 0x0111, mid, 0)  # WM_COMMAND — 메뉴 누른 것과 같음
        lst = _wait(lambda: _sales_list(main), 8.0)
        if not lst:
            raise Stop("거래명세서 목록 창이 안 열렸어요.")
        time.sleep(0.6)
    return lst


# ── 1) 엑셀(csv) 뽑기 ──────────────────────────────────────────────────────────
def _export_one(m: dict, year: int, progress) -> list:
    main = m["hwnd"]
    label = "주식회사" if m["biz"] == "corp" else "개인"
    progress(f"{label} 이지폼에서 명세서 목록을 뽑고 있어요")
    _assert_clean(main)
    lst = _open_list(main)
    _assert_clean(main)
    sheet, grid = _ensure_period_tab(lst)
    _assert_clean(main)  # 탭 바꾸다 다른 창이 뜨면 멈춤
    if not grid:
        raise Stop(f"{label} 이지폼 목록 창에서 '기간으로 조회' 탭을 못 찾았어요. 그 탭을 한 번 눌러두고 다시 해주세요.")
    # 기간 — 왼쪽 칸 = 시작, 오른쪽 칸 = 끝. 글자만 바꾼다(WM_SETTEXT).
    edits = sorted(_kids(sheet, "TMaskEdit"), key=lambda h: _rect(h)[0])
    if len(edits) < 2:
        raise Stop("기간 입력칸을 못 찾았어요.")
    want = (f"{year}.01.01", f"{year}.12.31")
    for e, v in zip(edits[:2], want):
        if _txt(e).strip() != v:
            _u.SendMessageW(e, 0x000C, 0, ctypes.c_wchar_p(v))  # WM_SETTEXT
    if [_txt(e).strip() for e in edits[:2]] != list(want):
        raise Stop("기간을 넣지 못했어요.")
    radio = _named(sheet, "TRadioButton", "발행일자")
    if radio and _u.SendMessageW(radio, 0x00F0, 0, None) != 1:  # BM_GETCHECK
        _click(radio, "발행일자")
        time.sleep(0.3)
    before = _count_text(lst)
    _click(_named(sheet, "TButton", "조회"), "조회")
    _wait(lambda: _count_text(lst) and _count_text(lst) != before, 3.0)  # 조건 같으면 안 바뀜 → 시간만
    time.sleep(0.6)
    _assert_clean(main)

    _click(_named(lst, "TBitBtn", "엑셀(csv)"), "엑셀(csv)")
    dlg = _wait(lambda: next(iter(_kids(main, "TfrmSavePath")), None), 5.0)
    if not dlg:
        _assert_clean(main)
        raise Stop("엑셀(csv) 저장 창이 안 떴어요.")
    edit = next(iter(_kids(dlg, "TEdit")), None)
    path = _txt(edit).strip() if edit else ""
    if not (path.lower().endswith(".csv") and _CSV_DIR_HINT in path.lower()):
        raise Stop(f"저장 경로가 예상과 달라서 멈췄어요({path or '경로 없음'}). 이지폼 경로창에서 [닫기]를 눌러주세요.")
    if os.path.exists(path):
        raise Stop("같은 이름의 엑셀 파일이 이미 있어서 멈췄어요.")
    _click(_named(dlg, "TBitBtn", "저장"), "저장")
    if not _wait(lambda: os.path.exists(path), 20.0, 0.15):
        raise Stop("엑셀 파일이 만들어지지 않았어요.")

    def info_popup():
        for h, c, _t in _popups(main):
            if c == "TMessageForm":
                return h
        return None

    pop = _wait(info_popup, 8.0, 0.05)
    if pop:
        btns = sorted(_txt(b).replace("&", "") for b in _kids(pop, "TButton"))
        if _txt(pop) != "Information" or btns != ["No", "Yes"]:
            raise Stop("이지폼에 예상과 다른 창이 떠서 멈췄어요. 직접 확인해주세요.")
        _click(_named(pop, "TButton", "No"), "No")
        _wait(lambda: not _u.IsWindowVisible(pop), 3.0, 0.05)
    last = -1
    for _ in range(30):  # 파일 다 써질 때까지(크기 변화 없음)
        sz = os.path.getsize(path)
        if sz == last and sz > 0:
            break
        last = sz
        time.sleep(0.15)
    try:
        with open(path, "rb") as f:
            raw = f.read()
    finally:
        _delete_csv(path)
    rows = _parse_csv(raw, m)
    if _popups(main) or _kids(main, "TfrmSavePath"):
        raise Stop("엑셀 저장 뒤에 이지폼 창이 남아 있어서 멈췄어요. 직접 닫아주세요.")
    return rows


def _delete_csv(path: str) -> None:
    """사용자 지시: 자동화로 만든 엑셀 파일은 읽고 나서 지운다(같이 생기는 잠금파일 포함)."""
    d, base = os.path.split(path)
    for p in (path, os.path.join(d, "zNex~$hare" + base)):
        try:
            if os.path.exists(p):
                os.remove(p)
        except OSError:
            logging.warning("이지폼 CSV 삭제 실패: %s", p)


def _parse_csv(raw: bytes, m: dict) -> list:
    text = None
    for enc in ("cp949", "utf-8-sig"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        text = raw.decode("cp949", errors="replace")
    out: list = []
    started = False
    for r in csv.reader(io.StringIO(text)):
        if not started:
            started = bool(r) and r[0].strip() == "사업자번호"
            continue
        if len(r) < 9 or not re.match(r"\d{4}\.\d{2}\.\d{2}", r[2].strip()):
            continue
        # 거래처명에 쉼표가 들어가 칸이 밀리는 경우 — 뒤 9칸은 고정이라 뒤에서 센다.
        tail = r[-9:]
        head = r[:-9]
        out.append({
            "biz": m["biz"], "bizName": m["name"], "idx": len(out),
            "bizNo": head[0].strip() if head else "",
            "client": ",".join(head[1:]).strip() if len(head) > 1 else "",
            "date": tail[0].strip(), "firstItem": tail[1].strip(), "total": tail[2].strip(),
            "written": tail[6].strip(),
        })
    return out


# ── 2) 고른 명세서 읽기(숨은 채로) ──────────────────────────────────────────────
def _digits(s) -> str:
    return re.sub(r"[^0-9-]", "", str(s or ""))


def _form_header(form, want_total: str = "") -> "tuple[str, str]":
    """상세 창 발행일(TMaskEdit)·합계금액(표 위 TAdvEdit) — 숨은 창도 WM_GETTEXT 로 읽힌다.
    표 위 금액칸은 여러 개(합계·공급가·세액·잔액…)라 순서가 명세서마다 다를 수 있다 → want_total 과 같은
    칸이 있으면 그 값을, 없으면 첫 칸을 돌려준다."""
    date = next((_txt(e).strip() for e in _kids(form, "TMaskEdit")), "")
    grid = next(iter(_kids(form, "TAdvStringGrid")), None)
    gtop = _rect(grid)[1] if grid else 10 ** 6
    vals = [_txt(e).strip() for e in _kids(form, "TAdvEdit") if _rect(e)[3] <= gtop]
    want = _digits(want_total)
    total = next((v for v in vals if want and _digits(v) == want), vals[0] if vals else "")
    return date, total


_PULL_COLS = ("item_code", "item", "spec", "qty", "unit_price", "remark")


def _cell_text(grid, x: int, y: int, timeout: float):
    """표 칸(표 왼위 기준 x,y)을 눌러 뜨는 편집칸(TAdvInplaceEdit) 글자. 그 칸 위에 뜬 것만 인정. 없으면 None."""
    _click(grid, "명세서 표", x, y)
    gl, gt, _r, _b = _rect(grid)
    px, py = gl + x, gt + y
    t0 = time.time()
    while time.time() - t0 < timeout:
        for e in _kids(grid, "TAdvInplaceEdit"):
            l, t, r, b = _rect(e)
            if l - 2 <= px <= r + 2 and t - 2 <= py <= b + 2:
                return " ".join(_txt(e).replace("\t", " ").split())
        time.sleep(0.01)
    return None


def _read_form(form) -> list:
    """숨은 상세명세서 표 읽기 → [{item_code,item,spec,qty,unit_price,remark}].
    칸 위치 = 보정해 둔 EF_CELLS(화면 기준) - EF_GRID_REF(그때 표 왼위) = 표 기준 좌표. 10줄 넘으면 표 보기만 한 줄씩 내림."""
    grid = next(iter(_kids(form, "TAdvStringGrid")), None)
    if not grid:
        raise Stop("명세서 표를 못 찾았어요.")
    ref = ef.EF_GRID_REF
    cells = [[(c[0] - ref[0], c[1] - ref[1]) for c in row] for row in ef.EF_CELLS]
    _u.SendMessageW(grid, 0x0115, 6, None)  # SB_TOP — 첫 줄부터
    time.sleep(0.05)
    rows: list = []
    seen_editor = [False]

    def read_row(row_cells):
        out = {}
        for i, col in enumerate(_PULL_COLS):
            x, y = row_cells[ef.EF_COLS.index(col)]
            v = _cell_text(grid, x, y, 0.15 if seen_editor[0] else 0.35)
            if v is None and seen_editor[0]:
                v = _cell_text(grid, x, y, 0.12)
            if v is None:
                if i == 0:
                    return None  # 첫 칸에 편집칸이 안 뜸 = 표 끝
                v = ""
            else:
                seen_editor[0] = True
            out[col] = v
        return out

    empty = dup = 0
    prev = None

    def take(r) -> bool:
        nonlocal empty, dup, prev
        if r is None:
            return False
        if not any(v.strip() for v in r.values()):
            empty += 1
            return empty < 2
        empty = 0
        sig = tuple(r.values())
        dup = dup + 1 if sig == prev else 0
        if dup >= 4:
            return False
        prev = sig
        rows.append(r)
        return True

    going = True
    for rc in cells:
        if _aborted():
            raise Stop("정지했어요.")
        if not take(read_row(rc)):
            going = False
            break
    while going and len(rows) < 200:
        if _aborted():
            raise Stop("정지했어요.")
        before = ef._ef_vpos(grid)
        _u.SendMessageW(grid, 0x0115, 1, None)  # SB_LINEDOWN — 보기만 한 줄 아래(새 줄 안 생김)
        time.sleep(0.05)
        after = ef._ef_vpos(grid)
        if before and after and after == before and after[0] >= after[1]:
            break  # 맨 아래
        going = take(read_row(cells[-1]))
    # 같은 줄 반복으로 끝났으면 반복분 정리
    while len(rows) >= 2 and dup >= 4 and rows[-1] == rows[-2]:
        rows.pop()
        dup -= 1
    return rows


def _close_left_forms(main) -> None:
    """정지로 멈췄을 때 우리가 열어 둔 명세서(TfrmExchange) 창을 ESC 로 닫는다.
    순회 전에 _assert_clean 으로 명세서 창이 없음을 확인했으니 지금 떠 있는 건 우리가 연 것(읽기만, 수정 없음).
    (정지 표시가 켜져 있어 _wait 를 못 쓰므로 직접 기다린다.) 질문창이 뜨면 아무것도 안 누르고 그대로 둔다."""
    t_end = time.time() + 1.5  # Enter 직후 정지했으면 창이 조금 늦게 뜰 수 있음
    while time.time() < t_end and not _kids(main, "TfrmExchange"):
        time.sleep(0.05)
    for _ in range(3):
        forms = _kids(main, "TfrmExchange")
        if not forms or _popups(main):
            break
        for form in forms:
            fgrid = next(iter(_kids(form, "TAdvStringGrid")), None)
            target = next(iter(_kids(fgrid, "TAdvInplaceEdit")), None) if fgrid else None
            _key(target or fgrid or form, 0x1B)
        t_end = time.time() + 1.5
        while time.time() < t_end and _kids(main, "TfrmExchange") and not _popups(main):
            time.sleep(0.05)
    left = _kids(main, "TfrmExchange")
    logging.info("이지폼 일괄: 정지 — 열려 있던 명세서 창 정리 %s", "완료" if not left else f"실패({len(left)}개 남음)")


def _read_items(items: list, progress, on_result, keep_order: bool = False) -> None:
    """keep_order=True: 웹이 보낸 순서 그대로(= 화면 카드 순서 — 키워드 넣은 지시서 먼저, 오래된 날짜순) 읽는다.
    연속된 같은 이지폼 묶음마다 목록 맨 위로 맞춘 뒤 ↓/↑ 로 오간다. False: 이지폼별로 목록 위→아래(가장 빠름)."""
    runs: list = []
    if keep_order:
        for it in items:
            if runs and runs[-1][0] == it.get("biz"):
                runs[-1][1].append(it)
            else:
                runs.append((it.get("biz"), [it]))
    else:
        by_biz: dict = {}
        for it in items:
            by_biz.setdefault(it.get("biz"), []).append(it)
        runs = [(b, sorted(v, key=lambda x: int(x.get("idx") or 0))) for b, v in by_biz.items()]
    mains = {m["biz"]: m for m in _mains()}
    done = 0
    total_n = len(items)
    for biz, its in runs:
        m = mains.get(biz)
        if not m:
            for it in its:
                on_result({"key": it.get("key"), "ok": False,
                           "message": ("주식회사" if biz == "corp" else "개인") + " 이지폼이 꺼져 있어요."})
            continue
        main = m["hwnd"]
        _assert_clean(main)
        lst = _open_list(main)
        _sheet, grid = _ensure_period_tab(lst)
        _assert_clean(main)
        if not grid:
            raise Stop("목록 창의 '기간으로 조회' 표를 못 찾았어요.")
        # 맨 위로 — 표 보기 맨 위 + 첫 줄 클릭(거래처명 칸) + Home + PageUp 여러 번
        _u.SendMessageW(grid, 0x0115, 6, None)  # SB_TOP
        time.sleep(0.15)
        _click(grid, "목록 표", 200, 30)
        time.sleep(0.25)
        _key(grid, 0x24)  # Home
        for _ in range(80):
            _key(grid, 0x21)  # PageUp
        time.sleep(0.3)
        cur = 0
        known = _LAST_LISTS.get(biz) or []  # 마지막으로 뽑은 목록 — 어긋났을 때 실제 몇 번째 줄인지 찾는 데 씀

        def close_form(form, date):
            """ESC(편집칸이 떠 있으면 거기, 아니면 표). 질문창이 뜨거나 안 닫히면 아무것도 안 누르고 멈춤."""
            fgrid = next(iter(_kids(form, "TAdvStringGrid")), None)
            target = next(iter(_kids(fgrid, "TAdvInplaceEdit")), None) if fgrid else None
            _key(target or fgrid or form, 0x1B)
            closed = _wait(lambda: not _kids(main, "TfrmExchange"), 1.5, 0.05)
            if not closed and not _popups(main) and fgrid and _shown(fgrid):
                _key(fgrid, 0x1B)  # 편집칸 ESC 는 편집만 끝낼 수 있음 → 표에 한 번 더
                closed = _wait(lambda: not _kids(main, "TfrmExchange"), 2.5, 0.05)
            if not closed or _popups(main):
                raise Stop(f"{date} 명세서를 닫을 때 이지폼 창이 떠서 멈췄어요. 저장하지 말고 직접 닫아주세요.")

        try:
            for it in its:
                _pause_point(progress)
                if _aborted():
                    raise Stop("정지했어요.")
                idx = int(it.get("idx") or 0)
                want = str(it.get("total") or "")
                progress(f"이지폼 명세서 읽는 중 {done + 1}/{total_n} · {it.get('date', '')} {it.get('client', '')}")
                res = {"key": it.get("key"), "ok": False}
                for attempt in range(4):
                    step = 0x28 if idx >= cur else 0x26
                    for _ in range(abs(idx - cur)):
                        _key(grid, step)  # ↓(↑) — 너무 빨리 보내면 하나씩 씹힘 → 살짝 간격
                        time.sleep(0.012)
                    cur = idx
                    time.sleep(0.3)
                    _assert_clean(main)
                    _key(grid, 0x0D)  # Enter = 열기(목록 표에서만)
                    form = _wait(lambda: next((f for f in _kids(main, "TfrmExchange")
                                               if _form_header(f)[0] and "_" not in _form_header(f)[0]), None), 6.0, 0.06)
                    if not form:
                        raise Stop(f"{it.get('date', '')} 명세서가 안 열려서 멈췄어요.")
                    # 열린 직후엔 합계가 잠깐 '0' — 목록의 합계가 뜰 때까지(최대 2.5초) 기다린 뒤 비교·읽기.
                    _wait(lambda: _digits(_form_header(form, want)[1]) == _digits(want), 2.5, 0.05)
                    time.sleep(0.15)
                    date, tot = _form_header(form, want)
                    res.update(date=date, total=tot)
                    if date == it.get("date") and _digits(tot) == _digits(want):
                        res.update(ok=True, rows=_read_form(form), message="")
                        close_form(form, date)
                        break
                    close_form(form, date)
                    # 줄이 어긋남(↓ 씹힘 등) — 열린 명세서(발행일·합계)가 목록의 몇 번째인지 가까운 곳에서 찾아 맞춘다.
                    near = [k for k, r in enumerate(known)
                            if r.get("date") == date and _digits(r.get("total")) == _digits(tot)]
                    if not near:
                        res["message"] = f"목록이 바뀌었어요({date} {tot}원이 열림). 다시 [이지폼에서 가져오기] 해주세요."
                        break
                    cur = min(near, key=lambda k: abs(k - idx))
                    res["message"] = f"줄을 못 맞췄어요({date} {tot}원이 열림)."
                    logging.info("이지폼 일괄 읽기: %d번째 대신 %d번째가 열림 → 다시 맞춤", idx, cur)
                on_result(res)
                done += 1
        except Stop:
            if _aborted():
                _close_left_forms(main)  # [정지]/창 닫기 — 읽다 만 명세서 창을 남기지 않는다
            raise


# ── 3) 비고에 주문번호 적고 저장 ──────────────────────────────────────────────
# ⚠ 워처가 이지폼에 '저장'하는 유일한 곳(사용자 승인 2026-11-19 — 다른 이지폼 자동화는 여전히 저장 금지).
# 실측(테스트 명세서 11/19 (주)에이치디사인):
#   비고 칸 클릭 → 편집칸(TAdvInplaceEdit) WM_SETTEXT → 같은 줄 품목 칸 클릭 = 칸 확정
#   [저장](TBitBtn) → TMessageForm 'Information' [Yes]/[No]("동일한 고유번호… 갱신하려면 Yes") → Yes = 저장, 추가 창 없음
#   저장 전 ESC = 묻지 않고 변경 버림(그래서 검사에 걸리면 ESC 로 안전하게 빠진다)
# 바뀌어도 되는 것 = 고른 줄 비고 + 빈 줄의 수량·단가 ''↔'0'(이지폼이 편집 뒤 빈 줄에 0 을 채워 보임). 그 밖에 바뀌면 저장 안 함.
def _has_content(r: dict) -> bool:
    return any((r.get(k) or "").strip() for k in ("item_code", "item", "spec")) or \
        (r.get("unit_price") or "").strip() not in ("", "0")


def _rows_same_except(before: list, after: list, row: int, want: str) -> str:
    """바뀐 칸 검사 — 문제 없으면 '', 있으면 무엇이 바뀌었는지."""
    if len(after) < len(before):
        return f"줄 수가 줄었어요({len(before)}→{len(after)})"
    for i, a in enumerate(after):
        bf = before[i] if i < len(before) else {k: "" for k in a}
        for k, v in a.items():
            old = bf.get(k, "")
            if i == row and k == "remark":
                if v != want:
                    return f"{i + 1}행 비고가 '{v}'(으)로 들어갔어요"
                continue
            if v == old:
                continue
            if k in ("qty", "unit_price") and not _has_content(bf) and {old.strip(), v.strip()} <= {"", "0"}:
                continue
            return f"{i + 1}행 {k} 가 '{old}'→'{v}' 로 바뀌었어요"
    return ""


def _remark_cell(grid, row: int):
    """row(0부터) 줄의 비고·품목 칸 좌표(표 기준). 보이는 칸을 넘으면 표 보기를 내려 마지막 칸에 맞춘다."""
    ref = ef.EF_GRID_REF
    cells = [[(c[0] - ref[0], c[1] - ref[1]) for c in r] for r in ef.EF_CELLS]
    cap = len(cells)
    _u.SendMessageW(grid, 0x0115, 6, None)  # SB_TOP
    time.sleep(0.08)
    if row < cap:
        rc = cells[row]
    else:
        for _ in range(row - cap + 1):
            _u.SendMessageW(grid, 0x0115, 1, None)  # SB_LINEDOWN — 보기만
            time.sleep(0.05)
        rc = cells[-1]
    return rc[ef.EF_COLS.index("remark")], rc[ef.EF_COLS.index("item")]


def _stamp_form(main, form, it: dict) -> dict:
    """열린 명세서 1장 — 비고에 주문번호 적고 저장. 결과 {ok, message, row}."""
    nos = [n for n in (it.get("nos") or []) if n]
    text = ", ".join(nos)
    rows = _read_form(form)
    if any(all(n in (r.get("remark") or "") for n in nos) for r in rows):
        return {"ok": True, "message": "이미 비고에 적혀 있어요", "skipped": True}
    row = it.get("row")
    if isinstance(row, int) and 0 <= row < len(rows):
        base = (rows[row].get("remark") or "").strip()
    else:
        cand = [i for i, r in enumerate(rows) if _has_content(r) and not (r.get("remark") or "").strip()]
        if not cand:
            return {"ok": False, "message": "빈 비고 칸이 없어서 안 적었어요"}
        row, base = cand[0], ""
    want = f"{base} {text}".strip() if base else text
    grid = next(iter(_kids(form, "TAdvStringGrid")), None)
    (rx, ry), (ix, iy) = _remark_cell(grid, row)
    # 그 칸이 맞는 줄인지 — 품목·비고가 읽은 것과 같아야 쓴다
    got_item = _cell_text(grid, ix, iy, 0.5)
    got_rmk = _cell_text(grid, rx, ry, 0.5)
    if got_item is None or got_rmk is None or got_item != (rows[row].get("item") or "") or got_rmk != base:
        return {"ok": False, "message": f"{row + 1}행 칸을 못 맞춰서 안 적었어요"}
    gl, gt, _r, _b = _rect(grid)

    def _at(e):
        l, t, r, b = _rect(e)
        return l - 2 <= gl + rx <= r + 2 and t - 2 <= gt + ry <= b + 2

    edit = next((e for e in _kids(grid, "TAdvInplaceEdit") if _at(e)), None)
    if not edit:
        return {"ok": False, "message": "비고 편집칸이 안 떠서 안 적었어요"}
    _u.SendMessageW(edit, 0x000C, 0, ctypes.c_wchar_p(want))  # WM_SETTEXT
    time.sleep(0.15)
    _click(grid, "품목", ix, iy)  # 같은 줄 다른 칸 = 비고 확정
    time.sleep(0.35)
    if _popups(main):
        raise Stop("비고를 적다가 이지폼 창이 떠서 멈췄어요. 저장하지 말고 직접 닫아주세요.")
    after = _read_form(form)
    bad = _rows_same_except(rows, after, row, want)
    if bad:
        # 저장 전 ESC = 변경 버림(실측) → 아무것도 안 바뀐 채 닫힌다
        return {"ok": False, "message": f"비고 말고 다른 칸이 바뀌어서 저장 안 했어요 — {bad}"}
    save = _named(form, "TBitBtn", "저장")
    if not save or not _u.IsWindowEnabled(save):
        return {"ok": False, "message": "이지폼 [저장] 버튼을 못 찾아서 저장 안 했어요"}
    _u.PostMessageW(save, 0x00F5, 0, 0)  # BM_CLICK — Post(뜨는 확인창에 안 막히게)
    ask = _wait(lambda: _popups(main), 4.0, 0.05)
    if not ask or len(ask) != 1 or ask[0][1] != "TMessageForm":
        raise Stop("저장을 눌렀는데 예상한 확인창이 안 떠서 멈췄어요. 이지폼을 직접 확인해주세요.")
    h = ask[0][0]
    btns = sorted(_txt(x).replace("&", "") for x in _kids(h, "TButton"))
    yes = _named(h, "TButton", "Yes")
    if btns != ["No", "Yes"] or not yes:
        raise Stop(f"저장 확인창이 예상과 달라서({', '.join(btns)}) 아무것도 안 눌렀어요. 이지폼을 직접 확인해주세요.")
    _u.PostMessageW(yes, 0x00F5, 0, 0)  # '동일한 고유번호… 갱신?' → Yes
    _wait(lambda: not _u.IsWindow(h) or not _shown(h), 3.0, 0.05)
    time.sleep(0.8)
    if _popups(main):
        raise Stop("저장 뒤에 이지폼 창이 또 떠서 멈췄어요. 이지폼을 직접 확인해주세요.")
    return {"ok": True, "message": "", "row": row, "remark": want}


def _stamp_items(items: list, progress, on_result) -> None:
    """items: [{key, biz, idx, date, total, nos:[주문번호], row?}] — 목록에서 그 명세서를 열어 비고에 적고 저장."""
    mains = {m["biz"]: m for m in _mains()}
    for n, it in enumerate(items):
        _pause_point(progress)
        if _aborted():
            raise Stop("정지했어요.")
        m = mains.get(it.get("biz"))
        res = {"key": it.get("key"), "ok": False}
        if not m:
            res["message"] = "이지폼이 꺼져 있어요."
            on_result(res)
            continue
        main = m["hwnd"]
        progress(f"이지폼 비고에 주문번호 적는 중 {n + 1}/{len(items)} · {it.get('date', '')} {it.get('client', '')}")
        _assert_clean(main)
        lst = _open_list(main)
        _sheet, grid = _ensure_period_tab(lst)
        _assert_clean(main)
        if not grid:
            raise Stop("목록 창의 '기간으로 조회' 표를 못 찾았어요.")
        _u.SendMessageW(grid, 0x0115, 6, None)
        time.sleep(0.15)
        _click(grid, "목록 표", 200, 30)
        time.sleep(0.25)
        _key(grid, 0x24)
        for _ in range(80):
            _key(grid, 0x21)
        time.sleep(0.3)
        for _ in range(int(it.get("idx") or 0)):
            _key(grid, 0x28)
            time.sleep(0.012)
        time.sleep(0.3)
        _assert_clean(main)
        _key(grid, 0x0D)
        form = _wait(lambda: next((f for f in _kids(main, "TfrmExchange")
                                   if _form_header(f)[0] and "_" not in _form_header(f)[0]), None), 6.0, 0.06)
        if not form:
            raise Stop(f"{it.get('date', '')} 명세서가 안 열려서 멈췄어요.")
        want_total = str(it.get("total") or "")
        _wait(lambda: _digits(_form_header(form, want_total)[1]) == _digits(want_total), 2.5, 0.05)
        date, tot = _form_header(form, want_total)
        try:
            if date != it.get("date") or _digits(tot) != _digits(want_total):
                res["message"] = f"목록이 바뀌어서 다른 명세서({date} {tot}원)가 열렸어요 — 안 적었어요"
            else:
                res.update(_stamp_form(main, form, it))
        finally:
            # 저장했으면 그냥 닫힘, 저장 안 했으면 ESC = 변경 버림(실측). 확인창이 떠 있으면 아무것도 안 누름.
            if _kids(main, "TfrmExchange") and not _popups(main):
                fgrid = next(iter(_kids(form, "TAdvStringGrid")), None)
                target = next(iter(_kids(fgrid, "TAdvInplaceEdit")), None) if fgrid else None
                _key(target or fgrid or form, 0x1B)
                if not _wait(lambda: not _kids(main, "TfrmExchange"), 2.0, 0.05) and fgrid and not _popups(main):
                    _key(fgrid, 0x1B)
                    _wait(lambda: not _kids(main, "TfrmExchange"), 2.5, 0.05)
        logging.info("이지폼 비고 적기 %s: %s", it.get("key"), res)
        on_result(res)


# ── 작업 상태 + HTTP 핸들러 ────────────────────────────────────────────────────
def _run(phase: str, jid: int, body: dict) -> None:
    def progress(msg: str):
        with _LOCK:
            if _JOB["id"] == jid:
                _JOB["progress"] = msg

    def on_result(r: dict):
        with _LOCK:
            if _JOB["id"] == jid:
                _JOB["results"].append(r)

    ok, msg = True, ""
    _ABORT.clear()
    try:
        ef._EF_ABORT.clear()
    except Exception:
        pass
    with _LOCK:
        home = _JOB.get("home")
    watch_stop = threading.Event()
    threading.Thread(target=_watch_front, args=(watch_stop, home), daemon=True).start()
    _PAUSE.clear()
    try:
        if phase == "export":
            year = int(body.get("year") or time.localtime().tm_year)
            ms = _mains()
            if not ms:
                raise Stop("켜져 있는 이지폼이 없어요.")
            lists = []
            for m in ms:
                _pause_point(progress)
                rows = _export_one(m, year, progress)
                lists.append({"biz": m["biz"], "name": m["name"], "rows": rows})
                _LAST_LISTS[m["biz"]] = rows
                with _LOCK:
                    if _JOB["id"] == jid:
                        _JOB["lists"] = list(lists)
            msg = " · ".join(f"{x['name']} {len(x['rows'])}건" for x in lists)
        elif phase == "stamp":
            items = [x for x in (body.get("items") or []) if isinstance(x, dict)][:100]
            _stamp_items(items, progress, on_result)
            msg = "비고 적기를 마쳤어요."
        else:
            items = [x for x in (body.get("items") or []) if isinstance(x, dict)][:300]
            _read_items(items, progress, on_result, keep_order=bool(body.get("keepOrder")))
            msg = "읽기를 마쳤어요."
    except Stop as e:
        ok, msg = False, str(e)
    except Exception as e:  # noqa: BLE001
        logging.exception("이지폼 일괄 %s 실패", phase)
        ok, msg = False, f"오류: {e}"
    finally:
        watch_stop.set()
        with _LOCK:
            if _JOB["id"] == jid:
                _JOB.update(state="done" if ok else "error", message=msg)
        logging.info("이지폼 일괄 %s %s — %s", phase, "완료" if ok else "멈춤", msg)


def handle_start(body: "dict | None") -> "tuple[int, dict]":
    """POST /easyform/bulk {phase:'export'|'read', year?, items?}"""
    if not ef.EASYFORM_AVAILABLE:
        return 200, {"started": False, "message": "이 PC 에서는 이지폼 자동화를 쓸 수 없어요."}
    body = body if isinstance(body, dict) else {}
    phase = body.get("phase") if body.get("phase") in ("read", "stamp") else "export"
    with _LOCK:
        if _JOB["state"] == "running":
            return 200, {"started": False, "message": "이미 이지폼 작업이 진행 중이에요."}
        _JOB["id"] += 1
        jid = _JOB["id"]
        try:
            home = _u.GetForegroundWindow()  # 웹 버튼 누른 순간 앞 창 = 홈페이지 브라우저
        except Exception:
            home = None
        _JOB.update(state="running", phase=phase, message="", progress="", lists=[], results=[], at=time.time(),
                    home=home, paused=False)
    threading.Thread(target=_run, args=(phase, jid, body), daemon=True).start()
    return 200, {"started": True, "id": jid}


def handle_status(jid: int) -> dict:
    """GET /easyform/bulk?id=N — 진행/결과. results 는 읽은 순서대로 계속 늘어난다."""
    with _LOCK:
        if jid != _JOB["id"]:
            return {"state": "gone"}
        return {"state": _JOB["state"], "phase": _JOB["phase"], "message": _JOB["message"],
                "progress": _JOB["progress"], "lists": list(_JOB["lists"]),
                "results": list(_JOB["results"]), "paused": bool(_JOB.get("paused"))}


def handle_pause(jid: int, on: bool) -> dict:
    """POST /easyform/bulk/pause?id=N&on=1|0 — 일시정지/계속."""
    with _LOCK:
        live = jid == _JOB["id"] and _JOB["state"] == "running"
    if live:
        (_PAUSE.set if on else _PAUSE.clear)()
    return {"ok": True, "paused": on and live}


def handle_cancel(jid: int) -> dict:
    """POST /easyform/bulk/cancel — [정지]. 지금 하던 명세서까지만 닫고 멈춘다."""
    with _LOCK:
        live = jid == _JOB["id"] and _JOB["state"] == "running"
    if live:
        _ABORT.set()
        _PAUSE.clear()
    return {"ok": True}
