"""이지폼 일괄 가져오기 — 웹 명세서 탭 [📥 이지폼에서 가져오기] 의 워처 쪽.

두 단계(웹이 차례로 부른다):
  1) export : 떠 있는 이지폼(주식회사·개인) 각각에서 [자료관리 → 거래명세서 → 거래명세서 목록보기]
              → 기간 올해 1/1~12/31 → [조회] → [엑셀(csv)] → 경로창 [저장] → 안내창 [No]
              → CSV 를 읽어 목록으로 돌려주고 **파일은 지운다**.
  2) read   : 웹이 짝지어 고른 명세서들만 목록에서 N번째 줄을 열어(Enter) 품목 표를 읽고 ESC 로 닫는다.

안전 규칙(사용자 지시 2026-11-18 — 이지폼은 함부로 누르면 안 됨):
  - 시작 전에 그 이지폼에 명세서 작성/상세 창(TfrmExchange)·질문창·경로창 등 **우리가 띄운 게 아닌 창**이
    하나라도 떠 있으면 아무것도 누르지 않고 멈춘다.
  - 누르기 직전 그 자리(WindowFromPoint)가 정말 누르려던 버튼인지 확인 — 다른 창이 덮고 있으면 멈춘다.
  - 누르는 '저장'은 엑셀 경로창(TfrmSavePath, 경로가 EasyformNetC\\temp\\*.csv)의 [저장] 하나뿐.
    안내창은 제목 'Information' + Yes/No 두 버튼일 때만 [No]. 그 밖의 창이 뜨면 멈춘다.
  - 명세서는 읽기만(셀 클릭·표 보기 스크롤·ESC). 닫을 때 질문창이 뜨면 아무것도 안 누르고 멈춘다.
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
    _u.WindowFromPoint.argtypes = [wintypes.POINT]
    _u.WindowFromPoint.restype = wintypes.HWND
    _u.IsChild.argtypes = [wintypes.HWND, wintypes.HWND]
    _u.GetParent.argtypes = [wintypes.HWND]
    _u.GetParent.restype = wintypes.HWND
    _u.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]


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


def _vis(h) -> bool:
    return bool(h and _u.IsWindow(h) and _u.IsWindowVisible(h))


def _rect(h):
    r = wintypes.RECT()
    _u.GetWindowRect(h, ctypes.byref(r))
    return r.left, r.top, r.right, r.bottom


def _kids(h, klass=None, visible=True) -> list:
    out: list = []

    def cb(x, _):
        if (klass is None or _cls(x) == klass) and (not visible or _u.IsWindowVisible(x)):
            out.append(x)
        return True

    _u.EnumChildWindows(h, _ENUM(cb), 0)
    return out


def _pid(h) -> int:
    p = wintypes.DWORD()
    _u.GetWindowThreadProcessId(h, ctypes.byref(p))
    return p.value


def _mains() -> list:
    """떠 있는 이지폼들 → [{hwnd, biz:'corp'|'personal', name}]. 제목 '...: (주)에이치디사인(138-81-...)'."""
    out: list = []

    def cb(h, _):
        if _cls(h) == "TfrmBookMain" and _u.IsWindowVisible(h):
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
    """메인 창 안의 MDI 자식 폼(Tfrm*) 중 보이는 것 → [(hwnd, class, 제목)]."""
    return [(h, _cls(h), _txt(h)) for h in _kids(main) if _cls(h).startswith("Tfrm")]


def _assert_clean(main, allow=("TfrmListExchange",)) -> None:
    """우리가 띄운 것 말고 다른 창이 있으면 멈춘다. allow = 있어도 되는 MDI 폼 클래스."""
    pops = _popups(main)
    if pops:
        raise Stop(f"이지폼에 '{pops[0][2] or pops[0][1]}' 창이 떠 있어서 멈췄어요. 그 창을 닫고 다시 해주세요.")
    for h, c, t in _mdi_forms(main):
        if c not in allow:
            what = "명세서 작성/상세 창" if c == "TfrmExchange" else f"'{t or c}' 창"
            raise Stop(f"이지폼에 {what}이 열려 있어서 멈췄어요. 그 창을 닫고 다시 해주세요.")


def _front(main) -> None:
    if not ef.ef_force_foreground(main):
        time.sleep(0.2)
        if not ef.ef_force_foreground(main):
            raise Stop("이지폼 창을 앞으로 가져오지 못했어요.")
    time.sleep(0.15)


def _safe_click(target, what: str) -> None:
    """target 컨트롤 가운데를 누른다 — 누르기 직전 그 자리가 정말 target 인지 확인(다른 창이 덮으면 멈춤)."""
    if not _vis(target):
        raise Stop(f"'{what}' 버튼이 안 보여서 멈췄어요.")
    l, t, r, b = _rect(target)
    x, y = (l + r) // 2, (t + b) // 2
    hit = _u.WindowFromPoint(wintypes.POINT(x, y))
    if not (hit == target or _u.IsChild(target, hit)):
        raise Stop(f"'{what}' 버튼 위에 다른 창이 있어서 누르지 않고 멈췄어요.")
    saved = (ef._EF_OFFSET[0], ef._EF_OFFSET[1])
    ef._EF_OFFSET[0] = ef._EF_OFFSET[1] = 0
    try:
        ef.ef_click(x, y)
    finally:
        ef._EF_OFFSET[0], ef._EF_OFFSET[1] = saved


def _wait(cond, timeout: float, step: float = 0.1):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if ef.ef_aborted():
            raise Stop("ESC 로 중단했어요.")
        v = cond()
        if v:
            return v
        time.sleep(step)
    return None


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
    """'기간으로 조회' 탭의 목록 표(TwwDBGrid)."""
    sheet = _named(lst, "TTabSheet", "기간으로 조회")
    if not sheet:
        return None, None
    grids = _kids(sheet, "TwwDBGrid")
    return sheet, (grids[0] if grids else None)


def _count_text(lst) -> str:
    for p in _kids(lst, "TPanel"):
        t = _txt(p)
        if "자료가 있습니다" in t:
            return t
    return ""


def _open_list(main):
    """매출 거래명세서 목록 창을 연다(이미 있으면 그대로) + 앞으로."""
    lst = _sales_list(main)
    if not lst:
        mid = _menu_id(main, "거래명세서", "거래명세서 목록보기")
        if not mid:
            raise Stop("이지폼 메뉴에서 '거래명세서 목록보기'를 못 찾았어요.")
        _u.PostMessageW(main, 0x0111, mid, 0)  # WM_COMMAND — 메뉴 누른 것과 같음(클릭 없음)
        lst = _wait(lambda: _sales_list(main), 8.0)
        if not lst:
            raise Stop("거래명세서 목록 창이 안 열렸어요.")
        time.sleep(0.6)
    mdi = _u.GetParent(lst)
    _u.SendMessageW(mdi, 0x0222, lst, None)  # WM_MDIACTIVATE — 목록 창을 맨 앞 자식으로
    time.sleep(0.25)
    return lst


# ── 1) 엑셀(csv) 뽑기 ──────────────────────────────────────────────────────────
def _export_one(m: dict, year: int, progress) -> list:
    main = m["hwnd"]
    label = "주식회사" if m["biz"] == "corp" else "개인"
    progress(f"{label} 이지폼에서 명세서 목록을 뽑고 있어요")
    _assert_clean(main)
    _front(main)
    lst = _open_list(main)
    _assert_clean(main)
    sheet, grid = _period_grid(lst)
    if not grid:
        raise Stop(f"{label} 이지폼 목록 창에서 '기간으로 조회' 탭을 못 찾았어요. 그 탭을 한 번 눌러두고 다시 해주세요.")
    # 기간 — 왼쪽 칸 = 시작, 오른쪽 칸 = 끝. 글자만 바꾼다(WM_SETTEXT, 클릭 없음).
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
        _safe_click(radio, "발행일자")
        time.sleep(0.2)
    before = _count_text(lst)
    _safe_click(_named(sheet, "TButton", "조회"), "조회")
    # 조회 끝 = 건수 글자가 바뀌거나(같은 조건이면 안 바뀜) 잠깐 뒤 그대로
    _wait(lambda: _count_text(lst) and _count_text(lst) != before, 4.0)
    time.sleep(0.5)
    _assert_clean(main)

    btn = _named(lst, "TBitBtn", "엑셀(csv)")
    dlg = None
    for _ in range(2):  # 첫 클릭은 창 활성화로 먹힐 때가 있다
        _safe_click(btn, "엑셀(csv)")
        dlg = _wait(lambda: next((h for h in _kids(main, "TfrmSavePath")), None), 3.0)
        if dlg:
            break
        _assert_clean(main)
    if not dlg:
        raise Stop("엑셀(csv) 저장 창이 안 떴어요.")
    edit = next(iter(_kids(dlg, "TEdit")), None)
    path = _txt(edit).strip() if edit else ""
    if not (path.lower().endswith(".csv") and _CSV_DIR_HINT in path.lower()):
        raise Stop(f"저장 경로가 예상과 달라서 멈췄어요({path or '경로 없음'}). [닫기]를 눌러주세요.")
    if os.path.exists(path):
        raise Stop("같은 이름의 엑셀 파일이 이미 있어서 멈췄어요.")
    _safe_click(_named(dlg, "TBitBtn", "저장"), "저장")
    if not _wait(lambda: os.path.exists(path), 20.0, 0.2):
        raise Stop("엑셀 파일이 만들어지지 않았어요.")

    def info_popup():
        for h, c, t in _popups(main):
            if c == "TMessageForm":
                return h
        return None

    pop = _wait(info_popup, 8.0)
    if pop:
        btns = sorted(_txt(b).replace("&", "") for b in _kids(pop, "TButton"))
        if _txt(pop) != "Information" or btns != ["No", "Yes"]:
            raise Stop("이지폼에 예상과 다른 창이 떠서 멈췄어요. 직접 확인해주세요.")
        _safe_click(_named(pop, "TButton", "No"), "No")
        _wait(lambda: not _vis(pop), 3.0)
    # 파일 다 써질 때까지(크기 변화 없음)
    last = -1
    for _ in range(30):
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
        raise Stop("엑셀 저장 뒤에 창이 남아 있어서 멈췄어요. 직접 닫아주세요.")
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


# ── 2) 고른 명세서 읽기 ─────────────────────────────────────────────────────────
def _digits(s) -> str:
    return re.sub(r"[^0-9-]", "", str(s or ""))


def _read_items(items: list, progress, on_result) -> None:
    by_biz: dict = {}
    for it in items:
        by_biz.setdefault(it.get("biz"), []).append(it)
    mains = {m["biz"]: m for m in _mains()}
    done = 0
    total_n = len(items)
    for biz, its in by_biz.items():
        m = mains.get(biz)
        if not m:
            for it in its:
                on_result({"key": it.get("key"), "ok": False,
                           "message": ("주식회사" if biz == "corp" else "개인") + " 이지폼이 꺼져 있어요."})
            continue
        main = m["hwnd"]
        _assert_clean(main)
        _front(main)
        lst = _open_list(main)
        _sheet, grid = _period_grid(lst)
        if not grid:
            raise Stop("목록 창의 '기간으로 조회' 표를 못 찾았어요.")
        # 맨 위로 — 표 보기 맨 위 + 첫 줄 클릭(거래처명 칸) + PageUp 여러 번
        _u.SendMessageW(grid, 0x0115, 6, None)  # WM_VSCROLL SB_TOP
        time.sleep(0.2)
        gl, gt, gr, gb = _rect(grid)
        hit = _u.WindowFromPoint(wintypes.POINT(gl + 200, gt + 30))
        if not (hit == grid or _u.IsChild(grid, hit)):
            raise Stop("목록 표 위에 다른 창이 있어서 멈췄어요.")
        saved = (ef._EF_OFFSET[0], ef._EF_OFFSET[1])
        ef._EF_OFFSET[0] = ef._EF_OFFSET[1] = 0
        ef.ef_click(gl + 200, gt + 30)
        ef._EF_OFFSET[0], ef._EF_OFFSET[1] = saved
        time.sleep(0.2)
        for _ in range(80):
            ef.ef_key(0x21)  # PageUp
            time.sleep(0.015)
        cur = 0
        for it in sorted(its, key=lambda x: int(x.get("idx") or 0)):
            if ef.ef_aborted():
                raise Stop("ESC 로 중단했어요.")
            idx = int(it.get("idx") or 0)
            progress(f"이지폼 명세서 읽는 중 {done + 1}/{total_n} · {it.get('date', '')} {it.get('client', '')}")
            if idx < cur:  # 정렬했으니 안 생기지만 안전하게
                for _ in range(cur - idx):
                    ef.ef_key(0x26)
                    time.sleep(0.02)
            for _ in range(idx - cur):
                ef.ef_key(0x28)  # ↓
                time.sleep(0.02)
            cur = idx
            time.sleep(0.15)
            _assert_clean(main)
            ef.ef_key(0x0D)  # Enter = 열기
            form = _wait(lambda: next((f for f in _kids(main, "TfrmExchange")
                                       if (ef._ef_form_header(f)[0] or "_").find("_") < 0
                                       and ef._ef_form_header(f)[0]), None), 5.0, 0.08)
            if not form:
                raise Stop(f"{it.get('date', '')} 명세서가 안 열려서 멈췄어요.")
            time.sleep(0.2)
            date, tot = ef._ef_form_header(form)
            res = {"key": it.get("key"), "ok": False, "date": date, "total": tot}
            if date != it.get("date") or _digits(tot) != _digits(it.get("total")):
                res["message"] = f"목록이 바뀌었어요({date} {tot}원이 열림)."
            else:
                if not ef.ef_dock_and_offset():
                    raise Stop("명세서 창 위치를 맞추지 못했어요.")
                time.sleep(0.1)
                rows = ef._ef_read_open_form()
                ef._EF_OFFSET[0] = ef._EF_OFFSET[1] = 0
                if rows is None:
                    raise Stop("ESC 로 중단했어요.")
                res.update(ok=True, rows=rows)
            # 닫기 — ESC 한 번. 질문창이 뜨거나 안 닫히면 아무것도 안 누르고 멈춤.
            ef.ef_key(0x1B)
            closed = _wait(lambda: not _kids(main, "TfrmExchange"), 3.0, 0.05)
            on_result(res)
            done += 1
            if not closed or _popups(main):
                raise Stop(f"{date} 명세서를 닫을 때 이지폼 창이 떠서 멈췄어요. 저장하지 말고 직접 닫아주세요.")


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
    ef.ef_guard_start()  # 작업 중 사람 마우스/키 막기(ESC = 중단)
    try:
        if phase == "export":
            year = int(body.get("year") or time.localtime().tm_year)
            ms = _mains()
            if not ms:
                raise Stop("떠 있는 이지폼이 없어요.")
            lists = []
            for m in ms:
                rows = _export_one(m, year, progress)
                lists.append({"biz": m["biz"], "name": m["name"], "rows": rows})
                with _LOCK:
                    if _JOB["id"] == jid:
                        _JOB["lists"] = list(lists)
            msg = " · ".join(f"{x['name']} {len(x['rows'])}건" for x in lists)
        else:
            items = [x for x in (body.get("items") or []) if isinstance(x, dict)][:300]
            _read_items(items, progress, on_result)
            msg = "읽기를 마쳤어요."
    except Stop as e:
        ok, msg = False, str(e)
    except Exception as e:  # noqa: BLE001
        logging.exception("이지폼 일괄 %s 실패", phase)
        ok, msg = False, f"오류: {e}"
    finally:
        ef._EF_OFFSET[0] = ef._EF_OFFSET[1] = 0
        ef.ef_guard_stop()
        with _LOCK:
            if _JOB["id"] == jid:
                _JOB.update(state="done" if ok else "error", message=msg)
                ret = _JOB.get("return_hwnd")
            else:
                ret = None
        if ret:
            ef.ef_force_foreground(ret)  # 끝나면 홈페이지(브라우저)로 돌아가기
        logging.info("이지폼 일괄 %s %s — %s", phase, "완료" if ok else "멈춤", msg)


def handle_start(body: "dict | None") -> "tuple[int, dict]":
    """POST /easyform/bulk {phase:'export'|'read', year?, items?}"""
    if not ef.EASYFORM_AVAILABLE:
        return 200, {"started": False, "message": "이 PC 에서는 이지폼 자동화를 쓸 수 없어요."}
    body = body if isinstance(body, dict) else {}
    phase = "read" if body.get("phase") == "read" else "export"
    with _LOCK:
        if _JOB["state"] == "running":
            return 200, {"started": False, "message": "이미 이지폼 작업이 진행 중이에요."}
        _JOB["id"] += 1
        jid = _JOB["id"]
        try:
            ret = ef._user32.GetForegroundWindow()
        except Exception:
            ret = None
        _JOB.update(state="running", phase=phase, message="", progress="", lists=[], results=[],
                    at=time.time(), return_hwnd=ret)
    threading.Thread(target=_run, args=(phase, jid, body), daemon=True).start()
    return 200, {"started": True, "id": jid}


def handle_status(jid: int) -> dict:
    """GET /easyform/bulk?id=N — 진행/결과. results 는 읽은 순서대로 계속 늘어난다."""
    with _LOCK:
        if jid != _JOB["id"]:
            return {"state": "gone"}
        return {"state": _JOB["state"], "phase": _JOB["phase"], "message": _JOB["message"],
                "progress": _JOB["progress"], "lists": list(_JOB["lists"]),
                "results": list(_JOB["results"])}


def handle_cancel(jid: int) -> dict:
    """POST /easyform/bulk/cancel — ESC 와 같다(지금 하던 칸까지만 하고 멈춤)."""
    with _LOCK:
        live = jid == _JOB["id"] and _JOB["state"] == "running"
    if live:
        try:
            ef._EF_ABORT.set()
        except Exception:
            pass
    return {"ok": True}
