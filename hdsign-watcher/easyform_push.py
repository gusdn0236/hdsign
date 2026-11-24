"""홈페이지 → 이지폼 '기존 명세서 수정 반영' — 웹 [✏️ 이지폼 명세서 수정] 의 워처 쪽. **백그라운드 동작**.

두 단계(easyform_bulk 작업 통로 /easyform/bulk 에 phase 로 실린다):
  push_read  : 그 명세서를 찾아 열고(목록을 그날/그 기간만 조회 → 엑셀(csv) → 줄 번호로 Enter) 표를 읽고 닫는다.
               홈페이지 내용(target)과 비교해 무엇이 바뀌는지(plan) 돌려준다. 이지폼은 안 건드림.
  push_apply : 다시 열어 표가 read 때와 같은지 확인 → 바뀐 줄만 고치고(칸 고치기·줄 끼우기·줄 지우기·맨 밑 추가)
               → 표 전체를 다시 읽어 홈페이지와 **완전히 같을 때만** [저장] → Yes. 다르면 ESC(= 묻지 않고 변경 버림).

실측(2026-11-23 테스트 명세서, 전부 PostMessage — 이지폼을 앞으로 안 띄움):
  - 칸 = 클릭 → 편집칸(TAdvInplaceEdit) WM_SETTEXT. **재계산은 단가 칸을 Enter 로 빠져나갈 때만**
    (수량 Enter → 단가로 이동, 단가에서 Enter → 공급가액·세액·합계 갱신).
  - 맨 밑 추가 = 마지막 줄 비고 칸 Enter → 새 줄.  줄 끼우기 = 그 줄 클릭 → 오른쪽 패널 [삽입] → 그 자리에 빈 줄.
  - 줄 지우기 = 그 줄 클릭 → 패널 [삭제] → 'Information' "N번째 줄을 삭제하시겠습니까?" Yes.
  - ⚠ 맨 위 툴바 [삭제](TBitBtn) = 명세서 통째 삭제 — 절대 안 누름(패널 TPanel 에 좌표로만 누른다).
  - ⚠ ESC = 명세서 창을 묻지 않고 닫음(수정분 버림) — 안전 탈출용으로만.
  - "현재 □ 줄 선택됨" 상자(TEdit) = 클릭한 줄 번호 → 칸을 누를 때마다 맞는 줄인지 이 상자로 확인한다.

규칙(사용자 결정 2026-11-23): 마지막에 저장 누른 쪽이 덮어쓴다. 이지폼엔 바뀐 줄만. 비고는 홈페이지에 칸이 없으므로
남아 있는 줄의 비고는 절대 안 바꾼다(주문번호 보호) — 새로 들어가는 줄만 홈페이지 비고를 적는다.
"""
from __future__ import annotations

import ctypes
import logging
import re
import time

import easyform as ef
import easyform_bulk as b
from easyform_bulk import Stop

COLS = ("item_code", "item", "spec", "qty", "unit_price", "remark")
BODY = COLS[:5]           # 비교·고치기 대상(비고 제외)
NUM = ("qty", "unit_price")
_ORDER_NO = re.compile(r"(?<!\d)(\d{6}-\d{1,4})(?!\d)")

# 폼(창 왼위) 기준 오른쪽 패널 위치 — 실측 2026-11-23
_BOX_REL = (745, 366)      # "현재 □ 줄 선택됨" 상자 왼위
_INSERT_REL = (745, 412)   # 패널 [삽입]
_DELETE_REL = (745, 445)   # 패널 [삭제](줄 삭제)


# ── 칸 순회 중 잠금 ────────────────────────────────────────────────────────────
# 사용자 2026-11-24: 작업 내내 잠그면 [정지]를 못 누름 → **이지폼 칸을 실제로 도는 동안만**(명세서 열기·칸 읽기·칸 쓰기)
# 화면을 가리고(ef_busy) 마우스·키보드를 잠근다. 겹쳐 불러도 되고(횟수), 끝나면 0.5초 뒤 풂(연달아 칸을 돌 때 깜빡임 방지).
import threading as _th

_LK = _th.Lock()
_LOCK = {"depth": 0, "on": False, "gen": 0}
_LOCK_TEXT = "이지폼 칸을 읽고 쓰는 중이에요. 잠시만 기다려 주세요."


def _lock_on() -> None:
    with _LK:
        _LOCK["depth"] += 1
        _LOCK["gen"] += 1
        start = not _LOCK["on"]
        _LOCK["on"] = True
    if start:
        ef.ef_busy(_LOCK_TEXT)
        ef.ef_guard_start()


def _lock_off() -> None:
    with _LK:
        _LOCK["depth"] = max(0, _LOCK["depth"] - 1)
        if _LOCK["depth"]:
            return
        g = _LOCK["gen"]

    def later():
        time.sleep(0.5)
        with _LK:
            if _LOCK["depth"] or _LOCK["gen"] != g or not _LOCK["on"]:
                return
            _LOCK["on"] = False
        ef.ef_guard_stop()
        ef.ef_busy(None)

    _th.Thread(target=later, daemon=True).start()


def _lock_release_now() -> None:
    """사람이 답해야 할 때(확인 카드)·작업 끝 — 남은 잠금·가림을 바로 푼다."""
    with _LK:
        on = _LOCK["on"]
        _LOCK.update(depth=0, on=False)
        _LOCK["gen"] += 1
    if on:
        ef.ef_guard_stop()
        ef.ef_busy(None)


def _locked(fn):
    import functools

    @functools.wraps(fn)
    def w(*a, **k):
        _lock_on()
        try:
            return fn(*a, **k)
        finally:
            _lock_off()
    return w


# ── 값 정리 ────────────────────────────────────────────────────────────────────
def _norm_cell(col: str, v) -> str:
    s = " ".join(str(v or "").split())
    if col in NUM:
        s = s.replace(",", "").replace(" ", "")
        if re.fullmatch(r"-?0*(\.0*)?", s):
            s = ""  # 이지폼은 빈 수량·단가를 '0' 으로 보여준다
        elif re.fullmatch(r"-?\d+\.0+", s):
            s = s.split(".")[0]
    return s


def norm_row(r: dict) -> dict:
    return {c: _norm_cell(c, (r or {}).get(c)) for c in COLS}


def norm_target(r: dict) -> dict:
    """홈페이지 줄 → 이지폼에 들어갈 모양. 홈페이지는 수량 빈칸 = 1 로 계산하므로 단가 있는 줄은 수량 1."""
    out = norm_row(r)
    if out["unit_price"] and not out["qty"]:
        out["qty"] = "1"
    # 품목코드는 빈 채로 둔다(보통 비어 있음, 사용자 2026-11-24) — 빈 품목코드 경고창은 _Form._check 가 [OK]로 넘김
    return out


def _blank(r: dict) -> bool:
    return not any((r.get(c) or "") for c in COLS)


def _strip_tail(rows: list) -> list:
    rows = list(rows)
    while rows and _blank(rows[-1]):
        rows.pop()
    return rows


def _sig(r: dict) -> tuple:
    # 품목코드 '0'(빈 품목코드 대신 넣는 값) = 빈칸 — 옛 명세서의 품목코드 빈 줄을 0 때문에 '바뀐 줄'로 안 보게.
    # 고치거나 새로 넣는 줄은 그대로 '0'을 적는다(경고창 방지).
    return tuple("" if c == "item_code" and r[c] == "0" else r[c] for c in BODY)


def _nos(rows: list) -> list:
    out: list = []
    for r in rows:
        for m in _ORDER_NO.finditer(r.get("remark") or ""):
            if m.group(1) not in out:
                out.append(m.group(1))
    return out


# ── 비교 → 할 일(plan) ────────────────────────────────────────────────────────
def make_plan(cur: list, tgt: list) -> dict:
    """cur(이지폼, 정리·끝 빈줄 제거) vs tgt(홈페이지) → 같은 줄은 그대로, 사이 구간은 위치대로 고치기/지우기/끼우기.
    gaps = [{start, cur:[i..], tgt:[j..]}] (위에서 아래 순). expected = 반영 후 이지폼에 있어야 할 줄(비고 포함)."""
    n, m = len(cur), len(tgt)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            dp[i][j] = dp[i + 1][j + 1] + 1 if _sig(cur[i]) == _sig(tgt[j]) else max(dp[i + 1][j], dp[i][j + 1])
    pairs = []
    i = j = 0
    while i < n and j < m:
        if _sig(cur[i]) == _sig(tgt[j]):
            pairs.append((i, j))
            i += 1
            j += 1
        elif dp[i + 1][j] >= dp[i][j + 1]:
            i += 1
        else:
            j += 1
    pairs.append((n, m))
    gaps = []
    expected = []
    pi = pj = -1
    mods, dels, ins = [], [], []
    for (ci, tj) in pairs:
        cs = list(range(pi + 1, ci))
        ts = list(range(pj + 1, tj))
        k = min(len(cs), len(ts))
        for x in range(k):
            row = dict(tgt[ts[x]])
            row["remark"] = cur[cs[x]]["remark"]  # 남는 줄 비고는 그대로(주문번호 보호)
            expected.append(row)
            changed = [c for c in BODY if cur[cs[x]][c] != tgt[ts[x]][c]]
            mods.append({"row": cs[x], "from": cur[cs[x]], "to": row, "cols": changed})
        for x in cs[k:]:
            dels.append({"row": x, "from": cur[x]})
        for y in ts[k:]:
            expected.append(dict(tgt[y]))
            ins.append({"to": tgt[y]})
        if cs or ts:
            gaps.append({"start": pi + 1, "cur": cs, "tgt": ts})
        if ci < n:
            expected.append(dict(cur[ci]))  # 같은 줄(비고 포함 그대로)
        pi, pj = ci, tj
    lost = [no for no in _nos([d["from"] for d in dels]) if no not in _nos(expected)]
    return {"gaps": gaps, "expected": expected, "mods": mods, "dels": dels, "ins": ins, "lostNos": lost,
            "same": not gaps}


# ── 명세서 찾기·열기 ───────────────────────────────────────────────────────────
def _client_key(s: str) -> str:
    s = re.sub(r"\(주\)|㈜|주식회사|\(유\)|유한회사|\s", "", s or "")
    return s.lower()


def _client_like(a: str, bb: str) -> bool:
    ka, kb = _client_key(a), _client_key(bb)
    return bool(ka and kb) and (ka in kb or kb in ka or ka[:2] == kb[:2])


def _names(body: dict) -> list:
    """이 주문의 거래처 이름들 — 홈페이지 이름 + 이지폼에 끊는 이름(기억해 둔 것, 웹이 clients 로 보냄)."""
    out = []
    for s in [body.get("client")] + list(body.get("clients") or []):
        s = str(s or "").strip()
        if s and s not in out:
            out.append(s)
    return out


def _is_client(r: dict, body: dict) -> bool:
    """목록 줄 r 이 이 거래처 명세서인가 — 사업자번호가 같거나 이름이 비슷(이지폼에서 다른 이름으로 끊는 곳은 그 이름도)."""
    no = str(body.get("bizNo") or "").replace("-", "")
    if no and str(r.get("bizNo") or "").replace("-", "") == no:
        return True
    return any(_client_like(n, r.get("client", "")) for n in _names(body))


def _day_gap(a: str, bb: str) -> int:
    from datetime import datetime
    try:
        return abs((datetime.strptime(a, "%Y.%m.%d") - datetime.strptime(bb, "%Y.%m.%d")).days)
    except ValueError:
        return 999


def _goto_list_row(main, idx: int):
    """목록(기간으로 조회) 맨 위에서 idx 번째 줄로. 목록 표 hwnd 반환."""
    lst = b._open_list(main)
    _sheet, grid = b._ensure_period_tab(lst)
    if not grid:
        raise Stop("목록 창의 '기간으로 조회' 표를 못 찾았어요.")
    ctypes.windll.user32.SendMessageW(grid, 0x0115, 6, 0)  # SB_TOP
    time.sleep(0.15)
    b._click(grid, "목록 표", 200, 30)
    time.sleep(0.25)
    b._key(grid, 0x24)  # Home
    for _ in range(80):
        b._key(grid, 0x21)  # PageUp
    time.sleep(0.3)
    for _ in range(max(0, idx)):
        b._key(grid, 0x28)
        time.sleep(0.012)
    time.sleep(0.3)
    return grid


@_locked
def _open_row(main, it: dict, forms_ok: bool = False):
    """목록에서 it(idx·date·total) 명세서를 연다. 사람이 연 명세서가 있으면 멈춤(저장하는 작업이라).
    forms_ok=True([이지폼에서 열기] — 저장 안 함, 사용자 2026-11-23): 열린 명세서가 있어도 연다. 이지폼은 그 창에
    덮어 띄운다(저장 안 한 수정은 이지폼이 묻지 않고 버림). 새로작성 중이라 저장확인창이 뜨면 아무것도 안 누르고 멈춤."""
    b._assert_clean(main, forms_ok=forms_ok)
    grid = _goto_list_row(main, int(it.get("idx") or 0))
    b._assert_clean(main, forms_ok=forms_ok)
    want = str(it.get("total") or "")
    if forms_ok:
        before_h = b._headers(main)
        b._key(grid, 0x0D)
        form = b._opened_form(main, before_h, it.get("date", ""), want)
    else:
        before = b._forms(main)
        b._key(grid, 0x0D)
        form = b._new_form(main, before)
    if not form:
        raise Stop(f"{it.get('date', '')} 명세서가 안 열려서 멈췄어요.")
    b._wait(lambda: b._digits(b._form_header(form, want)[1]) == b._digits(want), 2.5, 0.05)
    time.sleep(0.15)
    d, t = b._form_header(form, want)
    if d != it.get("date") or b._digits(t) != b._digits(want):
        _close(main, form)
        raise Stop(f"목록이 바뀌어서 다른 명세서({d} {t}원)가 열렸어요. 다시 해주세요.")
    return form


@_locked
def _close(main, form) -> None:
    """ESC — 저장 안 한 변경은 버리고 닫힘(실측). 질문창이 떠 있으면 아무것도 안 누름."""
    if b._gone(form) or b._popups(main):
        return
    fgrid = next(iter(b._kids(form, "TAdvStringGrid")), None)
    target = next(iter(b._kids(fgrid, "TAdvInplaceEdit")), None) if fgrid else None
    b._key(target or fgrid or form, 0x1B)
    if not b._wait(lambda: b._gone(form), 2.0, 0.05) and fgrid and not b._popups(main):
        b._key(fgrid, 0x1B)
        b._wait(lambda: b._gone(form), 2.5, 0.05)


@_locked
def _read_all(form) -> list:
    """표 전체(빈 줄 위치 유지) — 6칸. 첫 칸에 편집칸이 안 뜨면 표 끝. 10줄 넘으면 보기만 한 줄씩 내림."""
    grid = next(iter(b._kids(form, "TAdvStringGrid")), None)
    if not grid:
        raise Stop("명세서 표를 못 찾았어요.")
    ref = ef.EF_GRID_REF
    cells = [[(c[0] - ref[0], c[1] - ref[1]) for c in row] for row in ef.EF_CELLS]
    ctypes.windll.user32.SendMessageW(grid, 0x0115, 6, 0)  # SB_TOP
    time.sleep(0.05)

    def read_row(rc):
        out = {}
        for i, col in enumerate(COLS):
            x, y = rc[ef.EF_COLS.index(col)]
            v = b._cell_text(grid, x, y, 0.35)
            if v is None:
                v = b._cell_text(grid, x, y, 0.2)
            if v is None:
                if i == 0:
                    return None
                v = ""
            out[col] = v
        return out

    rows: list = []
    for rc in cells:
        if b._aborted():
            raise Stop("정지했어요.")
        r = read_row(rc)
        if r is None:
            return rows
        rows.append(r)
    while len(rows) < 200:
        if b._aborted():
            raise Stop("정지했어요.")
        before = ef._ef_vpos(grid)
        ctypes.windll.user32.SendMessageW(grid, 0x0115, 1, 0)  # SB_LINEDOWN — 보기만
        time.sleep(0.06)
        after = ef._ef_vpos(grid)
        if before and after and after == before:
            break
        r = read_row(cells[-1])
        if r is None:
            break
        rows.append(r)
    return rows


@_locked
def _read_remarks(form) -> list:
    """비고 칸만 위에서부터(편집칸이 안 뜨면 끝)."""
    grid = next(iter(b._kids(form, "TAdvStringGrid")), None)
    if not grid:
        return []
    ref = ef.EF_GRID_REF
    ci = ef.EF_COLS.index("remark")
    cells = [(row[ci][0] - ref[0], row[ci][1] - ref[1]) for row in ef.EF_CELLS]
    ctypes.windll.user32.SendMessageW(grid, 0x0115, 6, 0)
    time.sleep(0.05)
    out: list = []
    for x, y in cells:
        v = b._cell_text(grid, x, y, 0.3)
        if v is None:
            return out
        out.append(v)
    while len(out) < 200:
        before = ef._ef_vpos(grid)
        ctypes.windll.user32.SendMessageW(grid, 0x0115, 1, 0)
        time.sleep(0.05)
        after = ef._ef_vpos(grid)
        if before and after and after == before:
            break
        v = b._cell_text(grid, *cells[-1], 0.3)
        if v is None:
            break
        out.append(v)
    return out


def _list_candidates(m: dict, period: tuple, progress, forms_ok: bool = False) -> list:
    rows = b._export_one(m, 0, progress, period=period, forms_ok=forms_ok)
    return rows


def _order_cands(lst: list, body: dict, exact: bool) -> "tuple[list, dict | None]":
    """볼 순서 + 'lone'(비고에 주문번호 없는 옛 명세서여도 받아들일 단 하나).
    exact(지문 있음): ① 같은 날·같은 합계 → ② 같은 날 나머지(거래처 비슷한 것 먼저). ②는 **비고 주문번호가 맞아야만**.
      지문 합계가 옛 값일 수 있어서(이지폼에서 고쳐 저장하고 홈페이지 반영 '아니오' 등 — 2026-11-23 실제로 못 찾음).
      lone = ①이 딱 하나이고 거래처도 비슷할 때만.
    지문 없음: 기간 안에서 **그 거래처 것만**(납기에 가까운 날부터) 최대 40건, 비고 주문번호로만.
    ⚠ 예전엔 거래처가 안 맞으면 전부를 봐서 오늘 다른 거래처 명세서부터 열었음(느림, 사용자 2026-11-24)."""
    named = bool(_names(body) or body.get("bizNo"))
    if exact:
        date, total = str(body.get("date") or ""), str(body.get("total") or "")
        same_day = [r for r in lst if r["date"] == date]
        first = [r for r in same_day if b._digits(r["total"]) == b._digits(total)]
        rest = [r for r in same_day if r not in first and (not named or _is_client(r, body))]
        lone = first[0] if len(first) == 1 and (not named or _is_client(first[0], body)) else None
        return (first + rest)[:40], lone
    if not named:
        return lst[:40], None
    due = str(body.get("due") or "")
    cands = [r for r in lst if _is_client(r, body)]
    if due:
        cands.sort(key=lambda r: _day_gap(r["date"], due))
    return cands[:40], None


def _shift_day(d: str, days: int) -> str:
    from datetime import datetime, timedelta
    try:
        return (datetime.strptime(d, "%Y.%m.%d") + timedelta(days=days)).strftime("%Y.%m.%d")
    except ValueError:
        return d


def _passes(body: dict) -> list:
    """찾는 순서 [(기간, exact)]. 지문 있음: ① 그날 하루(합계 맞는 것 먼저) → ② 못 찾으면 앞뒤 7일(그날 빼고)을
    비고 주문번호로(이지폼에서 발행일을 바꾼 경우 등 — 사용자 2026-11-23). 지문 없음: 웹이 준 기간을 비고 주문번호로."""
    date, total = str(body.get("date") or ""), str(body.get("total") or "")
    if date and total:
        return [((date, date), True), ((_shift_day(date, -7), _shift_day(date, 7)), False)]
    f, t = str(body.get("from") or ""), str(body.get("to") or "")
    if not (f and t):
        raise Stop("이지폼에서 찾을 날짜가 없어요.")
    return [((f, t), False)]


def _each_candidate(body: dict, progress, forms_ok: bool):
    """(m, it, lone) 을 찾는 순서대로. 기간마다 두 이지폼(지난번 쪽 먼저) 목록을 새로 뽑고 그 목록의 줄 번호로 연다."""
    mains = b._mains()
    if not mains:
        raise Stop("켜져 있는 이지폼이 없어요.")
    mains.sort(key=lambda x: 0 if x["biz"] == body.get("biz") else 1)
    date, total = str(body.get("date") or ""), str(body.get("total") or "")
    hint = body.get("biz")
    hit_total = lambda r: b._digits(r["total"]) == b._digits(total)  # noqa: E731

    def load(m, period, pi, exact):
        lst = _list_candidates(m, period, progress, forms_ok=forms_ok)
        if pi > 0 and date:
            lst = [r for r in lst if r["date"] != date]  # 그날은 이미 봄
        cands, lone = _order_cands(lst, body, exact)
        return m, (cands if exact else cands[:30]), lone

    def stop_check():
        if b._aborted():
            raise Stop("정지했어요.")

    for pi, (period, exact) in enumerate(_passes(body)):
        if pi > 0:
            progress("그날엔 없어서 앞뒤 7일에서 찾는 중")
        per = []
        seen = set()
        # 기억해 둔 이지폼(지난번에 찾은 주식회사/개인)이 있으면 그쪽 목록만 먼저 뽑아 합계 맞는 것부터 —
        # 찾으면 다른 이지폼 목록은 안 뽑는다(다시 열 때 ~10초 → ~5초, 사용자 2026-11-23).
        if exact and hint and any(m["biz"] == hint for m in mains):
            m, cs, lone = load(next(m for m in mains if m["biz"] == hint), period, pi, exact)
            per.append((m, cs, lone))
            hits = [x for x in cs if hit_total(x)]
            for it in hits:
                stop_check()
                seen.add((m["biz"], it["idx"]))
                yield m, it, lone, len(hits)
        # 나머지 이지폼 목록도 뽑고(각자 자기 목록 창이라 서로 안 섞임) → 합계 맞는 것(양쪽) → 나머지 순
        for m in mains:
            if not any(p[0] is m for p in per):
                per.append(load(m, period, pi, exact))
        if exact:
            order = [(m, it, lone) for m, cs, lone in per for it in cs if hit_total(it)] + \
                    [(m, it, lone) for m, cs, lone in per for it in cs if not hit_total(it)]
        else:
            order = [(m, it, lone) for m, cs, lone in per for it in cs]
        order = [x for x in order if (x[0]["biz"], x[1]["idx"]) not in seen]
        for m, it, lone in order:
            stop_check()
            yield m, it, lone, len(seen) + len(order)  # 진행 'k / n' 의 n(이 기간에 볼 전체)


def find_and_read(body: dict, progress) -> dict:
    """명세서를 찾아 열고 읽고 닫는다 → {biz, idx, date, total, rows, nos}.
    body: date+total(지문이 있을 때, 그날 하루치) 또는 from~to+client(지문 없을 때, 비고 주문번호로 확인), nos."""
    want_nos = [n for n in (body.get("nos") or []) if n]
    k = 0
    for m, it, lone, n in _each_candidate(body, progress, forms_ok=False):
        main = m["hwnd"]
        k += 1
        progress(f"{k} / {max(k, n)}")
        form = _open_row(main, it)
        try:
            # 비고만 먼저, 맞으면 그때 전체
            nos = _nos([{"remark": x} for x in _read_remarks(form)])
            hit = any(no in nos for no in want_nos) if want_nos else False
            rows = _read_all(form) if (hit or (it is lone and not nos)) else []
        finally:
            _close(main, form)
        if b._popups(main) or not b._gone(form):
            raise Stop("명세서를 닫을 때 이지폼 창이 떠서 멈췄어요. 저장하지 말고 직접 닫아주세요.")
        if hit or (it is lone and not nos):
            return {"biz": m["biz"], "idx": it["idx"], "date": it["date"], "total": it["total"],
                    "client": it.get("client", ""), "rows": rows, "nos": nos}
    raise Stop("주식회사·개인 이지폼 모두에서 이 주문의 명세서를 못 찾았어요. (비고에 이 주문번호가 적힌 명세서가 없어요)")


# ── 고치기 ─────────────────────────────────────────────────────────────────────
def _ok_code_warning(main) -> bool:
    """품목코드가 빈 줄에서 다음 줄로 넘어가면 이지폼이 띄우는 안내창 — 'Easyformnetc' "물품코드나 물품명을 기록하지 않고
    저장하면 …오류가 생길 수 있습니다" [OK] 하나(2026-11-24 실측, 명세서마다 처음 한 번). 사람처럼 [OK] 누르고 계속 —
    누르고 넘어가도 저장은 잘 됨(실측). 줄 입력 중에 뜨는 OK 하나짜리 이지폼 안내창만 누른다."""
    hit = False
    for h, c, t in b._popups(main):
        if c == "TMessageForm" and t == "Easyformnetc" and                 [b._txt(x).replace("&", "") for x in b._kids(h, "TButton")] == ["OK"]:
            logging.info("이지폼 빈 품목코드 안내창 → OK")
            b._click(b._named(h, "TButton", "OK"), "OK")
            b._wait(lambda: b._gone(h), 2.0, 0.05)
            hit = True
    if hit:
        time.sleep(0.25)
    return hit


class _Form:
    def __init__(self, main, form):
        self.main, self.form = main, form
        self.grid = next(iter(b._kids(form, "TAdvStringGrid")), None)
        if not self.grid:
            raise Stop("명세서 표를 못 찾았어요.")
        fl, ft, _r, _b = b._rect(form)
        self.fl, self.ft = fl, ft
        self.box = next((h for h in b._kids(form, "TEdit")
                         if abs(b._rect(h)[0] - fl - _BOX_REL[0]) <= 6 and abs(b._rect(h)[1] - ft - _BOX_REL[1]) <= 6),
                        None)
        if not self.box:
            raise Stop("이지폼 '현재 □ 줄 선택됨' 칸을 못 찾아서 멈췄어요.")

    def _check(self):
        if b._aborted():
            raise Stop("정지했어요.")
        if b._popups(self.main):
            raise Stop("고치는 중에 이지폼 창이 떠서 멈췄어요. 저장하지 말고 직접 닫아주세요.")

    def editor(self, row: int, col: str):
        """row 줄 col 칸을 눌러 편집칸을 띄우고, 상자 줄 번호로 맞는 줄인지 확인."""
        self._check()
        cells = b._row_cells(self.grid, row)
        x, y = cells[col]
        b._click(self.grid, col, x, y)
        gl, gt, _r, _b = b._rect(self.grid)

        def at(e):
            l, t, r, bb = b._rect(e)
            return l - 2 <= gl + x <= r + 2 and t - 2 <= gt + y <= bb + 2

        e = b._wait(lambda: next((e for e in b._kids(self.grid, "TAdvInplaceEdit") if at(e)), None), 1.2, 0.03)
        if not e:
            raise Stop(f"{row + 1}번째 줄 칸이 안 눌려서 멈췄어요.")
        if b._wait(lambda: b._txt(self.box).strip() == str(row + 1), 0.8, 0.03) is None:
            raise Stop(f"{row + 1}번째 줄을 못 맞춰서 멈췄어요(선택된 줄 {b._txt(self.box).strip() or '?'}).")
        return e

    def put(self, row: int, col: str, val: str, enter: bool) -> None:
        e = self.editor(row, col)
        if col in NUM:
            val = val.replace(",", "")
        b._u.SendMessageW(e, 0x000C, 0, ctypes.c_wchar_p(val))  # WM_SETTEXT
        time.sleep(0.04)
        if enter:
            b._key(e, 0x0D)  # 다음 칸으로(수량→단가, 단가→재계산). 비고 칸엔 절대 Enter 안 함(새 줄 생김).
            # 예전 자동기입(칸마다 ~0.2초) 정도로만 — 더 줄이지 않음(사용자 2026-11-24). 끝에 다시 읽어 확인
            time.sleep(0.2 if col == "unit_price" else 0.1)
        self._check()

    def write_row(self, row: int, to: dict, cols=None, remark: "str | None" = None) -> None:
        """그 줄을 to 로. 글자칸은 바뀐 것만, 수량·단가는 늘 다시 넣고 단가 Enter = 재계산."""
        cols = list(cols) if cols is not None else list(BODY)
        for c in ("item_code", "item", "spec"):
            if c in cols:
                self.put(row, c, to[c], enter=False)
        # 내용 있는 줄의 빈 수량·단가 = '0'(사용자 2026-11-24 — 이지폼엔 0 으로 적는다). 비교는 0 = 빈칸이라 그대로 같음.
        filled = any(to[c] for c in ("item_code", "item", "spec", "qty", "unit_price"))
        self.put(row, "qty", to["qty"] or ("0" if filled else ""), enter=True)
        self.put(row, "unit_price", to["unit_price"] or ("0" if filled else ""), enter=True)
        if remark is not None and remark != "":
            self.put(row, "remark", remark, enter=False)
            ix, iy = b._row_cells(self.grid, row)["item"]
            b._click(self.grid, "품목", ix, iy)  # 같은 줄 다른 칸 = 비고 확정(Enter 금지)
            time.sleep(0.15)
            self._check()

    def _panel_click(self, rel, what: str) -> None:
        px, py = self.fl + rel[0], self.ft + rel[1]
        best = None
        for h in b._kids(self.form, "TPanel"):
            l, t, r, bb = b._rect(h)
            if l <= px < r and t <= py < bb and b._shown(h):
                if best is None or (r - l) * (bb - t) < (b._rect(best)[2] - b._rect(best)[0]) * (b._rect(best)[3] - b._rect(best)[1]):
                    best = h
        if not best:
            raise Stop(f"줄 {what} 버튼을 못 찾아서 멈췄어요.")
        l, t, _r, _b = b._rect(best)
        b._click(best, f"줄 {what}", px - l, py - t)

    def delete_row(self, row: int) -> None:
        self.editor(row, "item")
        self._panel_click(_DELETE_REL, "삭제")
        pop = b._wait(lambda: next((h for h, c, _t in b._popups(self.main) if c == "TMessageForm"), None), 3.0, 0.05)
        if not pop:
            raise Stop("줄 삭제 확인창이 안 떠서 멈췄어요.")
        btns = sorted(b._txt(x).replace("&", "") for x in b._kids(pop, "TButton"))
        if b._txt(pop) != "Information" or btns != ["No", "Yes"]:
            raise Stop("줄 삭제 확인창이 예상과 달라서 아무것도 안 눌렀어요. 이지폼을 직접 확인해주세요.")
        b._click(b._named(pop, "TButton", "Yes"), "Yes")
        b._wait(lambda: not b._u.IsWindow(pop) or not b._shown(pop), 3.0, 0.05)
        time.sleep(0.3)
        self._check()

    def insert_at(self, row: int) -> None:
        """row 자리에 빈 줄(원래 row 줄부터 아래로 밀림)."""
        self.editor(row, "item")
        self._panel_click(_INSERT_REL, "삽입")
        time.sleep(0.4)
        self._check()
        e = self.editor(row, "item")
        if (b._txt(e) or "").strip():
            raise Stop(f"{row + 1}번째에 빈 줄이 안 생겨서 멈췄어요.")

    def insert_below_first(self, n: int) -> None:
        """새 명세서 — '현재 □ 줄 선택됨' 칸에 2 → [삽입] n번 = 둘째 줄 자리에 빈 줄 n개(첫 줄 월일은 그대로 맨 위).
        그냥 첫 줄에서 [삽입]하면 월일 적힌 줄이 밑으로 밀린다(사용자 2026-11-24). 예전 자동기입도 이 방식."""
        self.editor(0, "item")  # 표 활성화(첫 줄 월일 자동 기입)
        b._u.SendMessageW(self.box, 0x000C, 0, ctypes.c_wchar_p("2"))  # WM_SETTEXT
        time.sleep(0.15)
        if b._txt(self.box).strip() != "2":
            raise Stop("'현재 □ 줄' 칸에 2를 못 넣어서 멈췄어요.")
        for _ in range(n):
            self._panel_click(_INSERT_REL, "삽입")
            time.sleep(0.15)
            self._check()
        e = self.editor(n, "item")  # 끼운 뒤 줄 수 확인 — n+1 번째 줄이 있어야
        if (b._txt(e) or "").strip():
            raise Stop("빈 줄이 안 생겨서 멈췄어요.")

    def month_day(self, row: int) -> str:
        x, y = b._row_cells(self.grid, row)["month_day"]
        return (b._cell_text(self.grid, x, y, 0.3) or "").strip()

    def append_after(self, last: int) -> None:
        """마지막 줄(last) 비고 칸 Enter → 맨 밑 새 줄."""
        e = self.editor(last, "remark")
        b._key(e, 0x0D)
        time.sleep(0.45)
        # 기존 명세서에 맨 밑 줄 추가 — 바로 윗줄 품목코드가 비었으면 이 Enter 순간에만 그 안내창이 뜬다 → 이때만 [OK]
        _ok_code_warning(self.main)
        self._check()
        e2 = self.editor(last + 1, "item")
        if (b._txt(e2) or "").strip():
            raise Stop("맨 밑에 새 줄이 안 생겨서 멈췄어요.")


def apply(body: dict, progress) -> dict:
    """다시 열기 → read 때와 같은지 확인 → 고치기 → 다시 읽어 확인 → 저장. 결과 {date,total,rows}."""
    mains = {m["biz"]: m for m in b._mains()}
    m = mains.get(body.get("biz"))
    if not m:
        raise Stop("그 이지폼이 꺼져 있어요.")
    main = m["hwnd"]
    date, total = str(body.get("date") or ""), str(body.get("total") or "")
    target = [norm_target(r) for r in (body.get("target") or []) if isinstance(r, dict)]
    target = _strip_tail([r for r in target])
    if not target:
        raise Stop("반영할 줄이 없어요.")
    expect = _strip_tail([norm_row(r) for r in (body.get("expect") or [])])
    progress("이지폼 명세서를 다시 여는 중")
    lst = _list_candidates(m, (date, date), progress)
    cands = [r for r in lst if r["date"] == date and b._digits(r["total"]) == b._digits(total)]
    if not cands:
        raise Stop("그 사이 이지폼 명세서가 바뀌었거나 없어졌어요. 다시 해주세요.")
    form = None
    for it in cands:
        f = _open_row(main, it)
        raw = _read_all(f)
        cur = _strip_tail([norm_row(r) for r in raw])
        if cur == expect:
            form = f
            break
        _close(main, f)
    if not form:
        raise Stop("그 사이 이지폼 명세서 내용이 바뀌었어요. 다시 [이지폼에 적용하기]를 눌러주세요.")
    return _apply_on_form(main, form, raw, target, date, total, progress)


@_locked
def _apply_on_form(main, form, raw: list, target: list, date: str, total: str, progress,
                   plan: "dict | None" = None) -> dict:
    """열려 있는 그 명세서(raw = 지금 표)에 target 을 반영 → 다시 읽어 같을 때만 저장 → 닫기. 결과 {date,total,rows,same}."""
    cur = _strip_tail([norm_row(r) for r in raw])
    saved = False
    try:
        plan = plan or make_plan(cur, target)
        if plan["lostNos"]:
            raise Stop(f"주문번호({', '.join(plan['lostNos'])})가 적힌 줄을 지우게 돼서 멈췄어요. 이지폼에서 직접 고쳐주세요.")
        if plan["same"]:
            return {"date": date, "total": total, "rows": raw, "same": True}
        F = _Form(main, form)
        count = len(raw)  # 끝 빈 줄 포함 실제 줄 수
        nb = len(plan["gaps"])
        for gi, g in enumerate(reversed(plan["gaps"])):  # 아래 구간부터 — 위쪽 줄 번호가 안 바뀜
            progress(f"이지폼 명세서 고치는 중 {gi + 1}/{nb}")
            s, cs, ts = g["start"], g["cur"], g["tgt"]
            k = min(len(cs), len(ts))
            for x in range(k):
                to = target[ts[x]]
                changed = [c for c in BODY if cur[cs[x]][c] != to[c]]
                F.write_row(s + x, to, cols=changed)
            for x in reversed(range(k, len(cs))):
                F.delete_row(s + x)
                count -= 1
            extra = ts[k:]
            if extra:
                p = s + k
                if p >= count:  # 맨 밑에 추가
                    for y in extra:
                        F.append_after(count - 1)
                        count += 1
                        F.write_row(count - 1, target[y], remark=target[y]["remark"])
                else:
                    for _ in extra:
                        F.insert_at(p)
                        count += 1
                    for q, y in enumerate(extra):
                        F.write_row(p + q, target[y], remark=target[y]["remark"])
        progress("고친 명세서를 다시 읽어 확인하는 중")
        after = _strip_tail([norm_row(r) for r in _read_all(form)])
        want = [norm_row(r) for r in plan["expected"]]
        if after != want:
            bad = next((i for i in range(max(len(after), len(want)))
                        if i >= len(after) or i >= len(want) or after[i] != want[i]), 0)
            logging.warning("이지폼 반영 검증 실패 %d번째: %s vs %s", bad + 1,
                            after[bad] if bad < len(after) else None, want[bad] if bad < len(want) else None)
            raise Stop(f"고친 뒤 {bad + 1}번째 줄이 홈페이지와 달라서 저장 안 했어요(이지폼은 그대로예요).")
        new_date, new_total = b._form_header(form)  # 재계산된 합계금액(저장 전 화면 = 저장될 값)
        progress("이지폼에 저장하는 중")
        r = b._save_with_yes(main, form)
        if not r.get("ok"):
            raise Stop(r.get("message") or "저장 못 했어요.")
        saved = True
        return {"date": new_date or date, "total": new_total, "rows": after, "same": False}
    finally:
        # 저장 안 했으면 ESC = 변경 버림. 저장했어도 창이 열린 채 남으므로(실측 2026-11-23) 닫는다.
        time.sleep(0.3 if saved else 0)
        _close(main, form)


# ── 새 명세서 작성(홈페이지 → 이지폼 새로작성 → 거래처 선택 → 입력 → 저장) ─────────────────────────
# 실측(2026-11-23): 메뉴 '[매출] 거래명세서 작성'(WM_COMMAND) → 보기 상태 창 → [새로작성] 마우스 메시지 → 발행일=오늘
# → 거래처명 옆 📁(창에 그려진 버튼, 폼 왼위 (194,163)) → '매출처선택'(TfrmSelectComout): 콤보 '사업자번호' +
# 검색칸 + Enter → '찾기결과' 탭(TTabSheet) 안의 TAdvStringGrid 에 Enter(⚠ 다른 탭 목록에 보내면 엉뚱한 거래처!)
# → 거래처명 = 그려진 글자라 OCR 로 확인 → 줄 입력 → [저장] = 새 명세서는 확인창 없이 저장, 창은 열린 채 → ESC 닫기.
# 저장 전 닫기 = 'Information' "작성중인 자료가 저장되지 않았습니다" → [No] = 버리고 닫기.
_FOLDER_REL = (194, 163)


@_locked
def _discard_new(main, form) -> None:
    """저장 안 한 새 명세서 버리고 닫기(ESC → 'Information' [No]). 거래처선택 창이 떠 있으면 [닫기] 먼저.
    OK 하나짜리 안내창이 떠 있으면 그것부터 OK(안 그러면 이지폼 Access violation). 그 밖의 창이면 아무것도 안 누름."""
    for h, c, _t in b._popups(main):
        btns = [b._txt(x).replace("&", "") for x in b._kids(h, "TButton")]
        if c == "TMessageForm" and btns == ["OK"]:
            b._click(b._named(h, "TButton", "OK"), "OK")
            b._wait(lambda: b._gone(h), 2.0, 0.05)
    if b._popups(main):
        return
    for s in b._kids(main, "TfrmSelectComout"):
        btn = b._named(s, "TBitBtn", "닫기")
        if btn:
            b._click(btn, "닫기")
            b._wait(lambda: b._gone(s), 2.0, 0.05)
    if b._gone(form):
        return
    fgrid = next(iter(b._kids(form, "TAdvStringGrid")), None)
    b._key(fgrid or form, 0x1B)
    pop = b._wait(lambda: next((h for h, c, _t in b._popups(main) if c == "TMessageForm"), None)
                  or (b._gone(form) and -1), 2.5, 0.05)
    if pop and pop != -1:
        btns = sorted(b._txt(x).replace("&", "") for x in b._kids(pop, "TButton"))
        if b._txt(pop) == "Information" and btns == ["No", "Yes"]:
            b._click(b._named(pop, "TButton", "No"), "No")  # No = 저장하지 않고 닫기(실측)
            b._wait(lambda: b._gone(form), 2.5, 0.05)


@_locked
def _fill_new(F: "_Form", target: list, progress) -> None:
    """새 명세서에 줄 넣기 — [삽입]으로 줄 수만큼 빈 줄을 **먼저** 만들고 위에서부터 채운다(예전 자동기입 방식, 사용자
    2026-11-24). 첫 줄(월일=발행일)이 밑으로 밀리지 않게 '현재 □ 줄' 칸에 2를 넣고 삽입 = 둘째 줄부터 끼움. 줄마다 Enter 로 새 줄을 만들면 품목코드가 빈 줄에서 이지폼 경고창("물품코드나 물품명을 기록하지 않고…")이
    떠서 멈췄다. 기존 명세서 고치기는 줄 위치가 바뀌면 안 되므로 예전대로(_apply_on_form: 끼우기·맨 밑 Enter)."""
    if len(target) > 1:
        progress("빈 줄 만드는 중")
        F.insert_below_first(len(target) - 1)
    for i, row in enumerate(target):
        progress(f"줄 입력 중 {i + 1}/{len(target)}")
        F.write_row(i, row, cols=[c for c in ("item_code", "item", "spec") if row[c]],
                    remark=row["remark"] or None)
    if not F.month_day(0):
        raise Stop("첫 줄 월일(날짜)이 밑으로 밀려서 저장 안 했어요(새 명세서는 버렸어요).")


def _blank_total(form) -> bool:
    return b._digits(b._form_header(form)[1]).lstrip("0-") == ""


def _open_new_form(main):
    """메뉴 '[매출] 거래명세서 작성' → 명세서 창. 다른 명세서가 이미 열려 있으면 이지폼이 새 창을 띄우거나 그 창을
    다시 쓸 수 있다(목록 Enter 는 덮어 띄움 — 2026-11-20 실측) → 새 창이 없으면 지금 앞(활성)에 있는 명세서 창."""
    mid = b._menu_id(main, "거래명세서", "[매출] 거래명세서 작성")
    if not mid:
        raise Stop("이지폼 메뉴에서 '[매출] 거래명세서 작성'을 못 찾았어요.")
    before = b._forms(main)
    b._u.PostMessageW(main, 0x0111, mid, 0)
    form = b._wait(lambda: next((x for x in b._kids(main, "TfrmExchange") if x not in before), None), 4.0)
    if form:
        return form
    if b._popups(main):
        raise Stop("이지폼에 작성중인 명세서가 있어서 저장확인창이 떴어요. 매크로는 아무것도 안 눌렀어요 — "
                   "이지폼에서 직접 저장(또는 취소)한 뒤 다시 해주세요.")
    shown = [f for f in b._kids(main, "TfrmExchange") if b._shown(f)]
    if shown:
        u32 = ctypes.windll.user32
        act = u32.SendMessageW(u32.GetParent(shown[0]), 0x0229, 0, 0)  # WM_MDIGETACTIVE
        hit = next((f for f in shown if f == act), None) or (shown[0] if len(shown) == 1 else None)
        if hit:
            logging.info("이지폼 새로작성: 새 창 대신 열린 명세서 창을 씀")
            return hit
    raise Stop("이지폼 새 명세서 창이 안 열렸어요.")


@_locked
def _press_new(main, form) -> None:
    """[새로작성] → 발행일이 채워지고 합계가 빈(0) 새 명세서가 될 때까지. 질문창이 뜨면(작성중이던 것) 멈춤."""
    time.sleep(0.6)
    b._click(b._named(form, "TBitBtn", "새로작성"), "새로작성")
    date_edit = next(iter(b._kids(form, "TMaskEdit")), None)

    def ready():
        if b._popups(main):
            return "pop"
        t = b._txt(date_edit) if date_edit else ""
        return "_" not in t and t.strip() and _blank_total(form)

    got = b._wait(ready, 3.5)
    if got == "pop":
        raise Stop("새로작성을 누르자 이지폼 창이 떠서 멈췄어요(작성중이던 명세서가 있어요). 매크로는 아무것도 안 눌렀어요.")
    if not got:
        raise Stop("이지폼 [새로작성]이 안 눌렸어요.")


def _same_client(a: str, ocr: str) -> bool:
    import difflib
    ka, ko = _client_key(a), _client_key(ocr)
    if not ka or not ko:
        return True  # OCR 실패 — 사업자번호 1건 검색이 이미 확정(판단 보류)
    if ka in ko or ko in ka:
        return True
    return difflib.SequenceMatcher(None, ka, ko).ratio() >= 0.5


def new_fill(body: dict, progress) -> dict:
    """body: biz, bizNo, client(이지폼 거래처명), target:[6칸 줄](첫 줄 비고 = 주문번호). → {date,total,client,rows}."""
    import easyform_autosync as A
    mains = {m["biz"]: m for m in b._mains()}
    m = mains.get(body.get("biz"))
    if not m:
        raise Stop(("주식회사" if body.get("biz") == "corp" else "개인") + " 이지폼이 꺼져 있어요.")
    main = m["hwnd"]
    biz_no = str(body.get("bizNo") or "").strip()
    client = str(body.get("client") or "").strip()
    if not biz_no:
        raise Stop("거래처 사업자번호가 없어요.")
    target = _strip_tail([norm_target(r) for r in (body.get("target") or []) if isinstance(r, dict)])
    if not target:
        raise Stop("입력할 줄이 없어요.")
    # 다른 명세서가 열려 있어도 진행(사용자 2026-11-24) — 질문창만 있으면 멈춤.
    b._assert_clean(main, forms_ok=True)
    progress("이지폼 새 명세서를 여는 중")
    form = _open_new_form(main)
    saved = False
    _lock_on()  # 새로작성·거래처 고르기·채우기·저장 동안 화면 가림 + 입력 잠금
    try:
        _press_new(main, form)
        # 거래처 선택 — 사업자번호로 검색해 딱 1건일 때만
        progress(f"거래처 고르는 중 · {client}")
        b._click(form, "거래처 선택", *_FOLDER_REL)
        sel = b._wait(lambda: next(iter(b._kids(main, "TfrmSelectComout")), None), 4.0)
        if not sel:
            raise Stop("거래처 선택 창이 안 떴어요.")
        time.sleep(0.4)
        cbx = next(iter(b._kids(sel, "TComboBox")), None)
        if not cbx:
            raise Stop("거래처 검색 기준 칸을 못 찾았어요.")
        u32 = ctypes.windll.user32
        n = b._u.SendMessageW(cbx, 0x0146, 0, None)  # CB_GETCOUNT
        want_i = None
        for i in range(n):
            ln = b._u.SendMessageW(cbx, 0x0149, i, None)
            buf = ctypes.create_unicode_buffer(ln + 1)
            b._u.SendMessageW(cbx, 0x0148, i, buf)
            if buf.value == "사업자번호":
                want_i = i
        if want_i is None:
            raise Stop("거래처 검색 기준에 '사업자번호'가 없어요.")
        b._u.SendMessageW(cbx, 0x014E, want_i, None)  # CB_SETCURSEL
        cid = u32.GetDlgCtrlID(cbx)
        u32.SendMessageW(u32.GetParent(cbx), 0x0111, (1 << 16) | (cid & 0xFFFF), cbx)  # CBN_SELCHANGE
        time.sleep(0.2)
        if b._txt(cbx).strip() != "사업자번호":
            raise Stop("거래처 검색 기준을 '사업자번호'로 못 바꿨어요.")
        ed = next((x for x in b._kids(sel, "TEdit") if b._shown(x)), None)
        b._u.SendMessageW(ed, 0x000C, 0, ctypes.c_wchar_p(biz_no))
        time.sleep(0.1)
        b._key(ed, 0x0D)

        def nf_popup():  # 결과 없음 = 'Easyformnetc' 안내창(OK 하나) "…찾을 수 없습니다"
            for h, c, t in b._popups(main):
                if c == "TMessageForm" and [b._txt(x).replace("&", "") for x in b._kids(h, "TButton")] == ["OK"]:
                    return h
            return None

        def sheet_or_popup():
            p = nf_popup()
            if p:
                return ("pop", p)
            s = b._named(sel, "TTabSheet", "찾기결과")
            return ("sheet", s) if s and b._shown(s) else None

        got = b._wait(sheet_or_popup, 3.0)
        if got and got[0] == "pop":
            # ⚠ 안내창 OK 를 **먼저** — 안내창이 뜬 채로 명세서를 닫으면 이지폼이 Access violation(실측 2026-11-23)
            b._click(b._named(got[1], "TButton", "OK"), "OK")
            b._wait(lambda: not nf_popup(), 2.0, 0.05)
            raise Stop(f"이지폼에 사업자번호 {biz_no} 거래처가 없어요. 이지폼 거래처 정보를 확인해주세요.")
        if not got:
            raise Stop("거래처 '찾기결과'가 안 나왔어요.")
        sheet = got[1]

        def count():
            for p in b._kids(sheet, "TPanel"):
                mm = re.search(r"(\d+)개의 자료", b._txt(p))
                if mm:
                    return mm.group(1)
            return None

        c = b._wait(count, 3.0)
        if c != "1":
            raise Stop(f"사업자번호 {biz_no} 거래처가 이지폼에 {c or 0}개 있어서 멈췄어요(1개여야 해요).")
        grid = next((x for x in b._kids(sheet, "TAdvStringGrid") if b._u.GetParent(x) == sheet and b._shown(x)), None)
        if not grid:
            raise Stop("거래처 찾기결과 목록을 못 찾았어요.")
        b._key(grid, 0x0D)  # ⚠ 반드시 찾기결과 탭 목록에만
        if not b._wait(lambda: not b._kids(main, "TfrmSelectComout"), 3.0):
            raise Stop("거래처가 안 골라졌어요.")
        time.sleep(0.4)
        shot = A._capture_client(form)
        ocr = (A._ocr(shot) if shot else "").strip()
        logging.info("이지폼 새로작성 거래처 OCR='%s' (원하는 '%s' %s)", ocr, client, biz_no)
        if not _same_client(client, ocr):
            raise Stop(f"고른 거래처가 '{ocr}'로 보여서 멈췄어요(원하는 거래처 '{client}'). 저장 안 했어요.")
        # 줄 입력 — 첫 줄은 이미 있음, 다음 줄은 마지막 줄 비고 Enter 로
        _fill_new(_Form(main, form), target, progress)
        progress("입력한 명세서를 다시 읽어 확인하는 중")
        after = _strip_tail([norm_row(r) for r in _read_all(form)])
        if after != target:
            bad = next((i for i in range(max(len(after), len(target)))
                        if i >= len(after) or i >= len(target) or after[i] != target[i]), 0)
            logging.warning("이지폼 새로작성 검증 실패 %d번째: %s vs %s", bad + 1,
                            after[bad] if bad < len(after) else None, target[bad] if bad < len(target) else None)
            raise Stop(f"입력한 뒤 {bad + 1}번째 줄이 홈페이지와 달라서 저장 안 했어요(새 명세서는 버렸어요).")
        date, total = b._form_header(form)
        progress("이지폼에 저장하는 중")
        save = b._named(form, "TBitBtn", "저장")
        if not save or not b._u.IsWindowEnabled(save):
            raise Stop("이지폼 [저장] 버튼을 못 찾았어요.")
        b._u.PostMessageW(save, 0x00F5, 0, 0)  # BM_CLICK — 새 명세서는 확인창 없이 저장(실측)
        time.sleep(1.2)
        if b._popups(main):
            raise Stop("저장을 눌렀더니 이지폼 창이 떠서 멈췄어요. 이지폼을 직접 확인해주세요.")
        # 저장 확인 — 그날 목록에 같은 거래처·합계·첫 품목이 있어야
        progress("저장됐는지 확인하는 중")
        saved = True  # 여기부터는 버리지 않는다(이미 눌렀음)
        _close(main, form)
        lst = b._export_one(m, 0, progress, period=(date, date), forms_ok=True)
        hit = [r for r in lst if b._digits(r["total"]) == b._digits(total) and r.get("bizNo") == biz_no
               and (r.get("firstItem") or "").strip() == (target[0]["item"] or "").strip()]
        if not hit:
            raise Stop("저장 버튼은 눌렀는데 이지폼 목록에서 새 명세서가 안 보여요. 이지폼을 직접 확인해주세요.")
        return {"date": date, "total": total, "client": hit[0].get("client") or client, "rows": after}
    finally:
        if not saved:
            _discard_new(main, form)
        _lock_release_now()


# ── 이지폼에서 열기(찾아서 열어 둔 채 이지폼을 앞으로) ───────────────────────────────
def _bring_front(main, form) -> None:
    """이지폼(최소화면 복원) → 맨 앞 → 그 명세서 창 활성화."""
    app = b._app_of(main)
    if app and not b._u.IsWindowVisible(main):
        b._u.PostMessageW(app, 0x0112, 0xF120, 0)  # SC_RESTORE
        b._wait(lambda: b._u.IsWindowVisible(main), 2.0, 0.05)
    u32 = ctypes.windll.user32
    if u32.IsIconic(main):
        u32.ShowWindow(main, 9)  # SW_RESTORE
    ef.ef_force_foreground(main)
    mdi = u32.GetParent(form)
    if mdi:
        u32.SendMessageW(mdi, 0x0222, form, 0)  # WM_MDIACTIVATE


def _opened_notice(biz: str, client: str, date: str, total) -> None:
    """화면 가운데 맨 앞 큰 카드 — '주식회사 (주)OO 명세서를 열었어요' + 발행일·합계 [확인](사용자 2026-11-23).
    작업은 기다리지 않고 끝난다."""
    tag = ("주식회사", "#2563eb") if biz == "corp" else ("개인", "#d97706")
    amt = int(b._digits(total) or 0)
    ef.ef_notice(f"{client or '이지폼'} 명세서를 열었어요", f"{date}  ·  합계 {amt:,}원", tag)


def _find_open(body: dict, progress) -> "tuple[dict, int, dict]":
    """찾아서 **열어 둔 채** 이지폼을 앞으로 → (m, form, {biz,date,total,client,nos}). 열린 명세서가 있어도 됨.
    이미 열려 있으면(비고에 이 주문번호, 또는 비고에 번호 없는 옛 명세서는 발행일·합계가 기록과 같을 때) 목록 안 뽑음."""
    want_nos = [n for n in (body.get("nos") or []) if n]
    mains = b._mains()
    if not mains:
        raise Stop("켜져 있는 이지폼이 없어요.")
    date, total = str(body.get("date") or ""), str(body.get("total") or "")
    if want_nos or (date and total):
        for m in mains:
            for f in b._kids(m["hwnd"], "TfrmExchange"):
                d, t = b._form_header(f, total)
                if not d or "_" in d:
                    continue
                fnos = _nos([{"remark": x} for x in _read_remarks(f)])
                same_key = bool(date and total) and d == date and b._digits(t) == b._digits(total)
                if any(n in fnos for n in want_nos) or (same_key and not fnos):
                    _bring_front(m["hwnd"], f)
                    return m, f, {"biz": m["biz"], "date": d, "total": b._digits(t),
                                  "client": str(body.get("client") or ""), "nos": fnos}
    k = 0
    for m, it, lone, n in _each_candidate(body, progress, forms_ok=True):
        main = m["hwnd"]
        k += 1
        progress(f"{k} / {max(k, n)}")  # 웹이 '이지폼에서 명세서를 찾고 있어요 k / n' 으로 보여 줌(사용자 2026-11-24)
        form = _open_row(main, it, forms_ok=True)
        keep = False
        try:
            nos = _nos([{"remark": x} for x in _read_remarks(form)])
            ok = any(no in nos for no in want_nos) if want_nos else False
            keep = ok or (it is lone and not nos)
        finally:
            if not keep:
                _close(main, form)
        if keep:
            ctypes.windll.user32.SendMessageW(next(iter(b._kids(form, "TAdvStringGrid"))), 0x0115, 6, 0)
            _bring_front(main, form)
            return m, form, {"biz": m["biz"], "date": it["date"], "total": it["total"],
                             "client": it.get("client", ""), "nos": nos}
    raise Stop("주식회사·개인 이지폼 모두에서 이 주문의 명세서를 못 찾았어요. (비고에 이 주문번호가 적힌 명세서가 없어요)")


def open_quick(body: dict, progress) -> dict:
    """[이지폼에서 열기] — 홈페이지와 아직 연동 안 된 명세서(사용자 2026-11-24). 웹은 '명세서를 찾고 있어요'(k / n)를 띄우고
    이걸 돌린다: **그 거래처 명세서만**, 납기일 앞뒤 days(기본 1)일(납기일에 가까운 것부터) 빠르게 열어 본다.
      · 비고에 이 주문번호 → 바로 띄움.
      · 없고, 납기일 그날 그 거래처 명세서 중 비고에 주문번호 없는 게 딱 하나 → 띄우고 '이 명세서가 맞나요?'.
    못 찾으면 {found: False} — 웹이 '찾지 못했어요' → 키워드로 찾기 화면(에러 아님)."""
    want_nos = [n for n in (body.get("nos") or []) if n]
    due = str(body.get("due") or "")
    if not due:
        return {"found": False}
    mains = b._mains()
    if not mains:
        return {"found": False}
    # 이미 열려 있으면(비고에 이 주문번호) 목록 안 뽑고 바로
    if want_nos:
        for m in mains:
            for f in b._kids(m["hwnd"], "TfrmExchange"):
                d, t = b._form_header(f)
                if not d or "_" in d:
                    continue
                fnos = _nos([{"remark": x} for x in _read_remarks(f)])
                if any(n in fnos for n in want_nos):
                    _bring_front(m["hwnd"], f)
                    return {"found": True, "biz": m["biz"], "date": d, "total": b._digits(t),
                            "client": "", "nos": fnos}
    mains.sort(key=lambda x: 0 if x["biz"] == body.get("biz") else 1)
    days = max(0, min(7, int(body.get("days") or 1)))
    period = (_shift_day(due, -days), _shift_day(due, days))
    cands = []
    for m in mains:
        for r in _list_candidates(m, period, progress, forms_ok=True):
            if _is_client(r, body):
                cands.append((m, r))
    cands.sort(key=lambda x: (_day_gap(x[1]["date"], due), 0 if x[0]["biz"] == body.get("biz") else 1))
    cands = cands[:20]
    lone_pool = []
    for k, (m, it) in enumerate(cands, 1):
        if b._aborted():
            raise Stop("정지했어요.")
        progress(f"{k} / {len(cands)}")
        main = m["hwnd"]
        form = _open_row(main, it, forms_ok=True)
        keep = False
        try:
            nos = _nos([{"remark": x} for x in _read_remarks(form)])
            keep = bool(want_nos) and any(no in nos for no in want_nos)
        finally:
            if not keep:
                _close(main, form)
        if keep:
            ctypes.windll.user32.SendMessageW(next(iter(b._kids(form, "TAdvStringGrid"))), 0x0115, 6, 0)
            _bring_front(main, form)
            return {"found": True, "biz": m["biz"], "date": it["date"], "total": it["total"],
                    "client": it.get("client", ""), "nos": nos}
        if not nos and it["date"] == due:
            lone_pool.append((m, it))
    if len(lone_pool) != 1:
        return {"found": False}
    m, it = lone_pool[0]
    main = m["hwnd"]
    if b._aborted():
        raise Stop("정지했어요.")
    form = _open_row(main, it, forms_ok=True)
    ctypes.windll.user32.SendMessageW(next(iter(b._kids(form, "TAdvStringGrid"))), 0x0115, 6, 0)
    _bring_front(main, form)
    tag = ("주식회사", "#2563eb") if m["biz"] == "corp" else ("개인", "#d97706")
    amt = int(b._digits(it["total"]) or 0)
    _lock_release_now()
    ok = ef.ef_ask("이 명세서가 맞나요?", f"{it.get('client') or '이지폼'}  ·  {it['date']}  ·  합계 {amt:,}원",
                   [], tag, yes="네, 이 명세서예요", no="아니오")
    if not ok:
        _close(main, form)
        _go_home()
        return {"found": False, "asked": True}
    return {"found": True, "biz": m["biz"], "date": it["date"], "total": it["total"],
            "client": it.get("client", ""), "nos": []}


# ── 직접 고를게요(사람이 이지폼에서 새로작성 → 거래처 선택) → 매크로가 입력하고 저장까지 ────────────────────
def _new_forms() -> list:
    """새로작성 중인(발행일 있음·합계 빈) 명세서 창들 → [(m, form)]. 앞에 있는 이지폼·활성 창 먼저."""
    u32 = ctypes.windll.user32
    fg_pid = b._pid(u32.GetForegroundWindow() or 0) if u32.GetForegroundWindow() else 0
    out = []
    for m in b._mains():
        forms = [f for f in b._kids(m["hwnd"], "TfrmExchange") if b._shown(f)]
        act = u32.SendMessageW(u32.GetParent(forms[0]), 0x0229, 0, 0) if forms else 0
        for f in forms:
            d = b._form_header(f)[0]
            if d and "_" not in d and _blank_total(f):
                out.append((0 if b._pid(m["hwnd"]) == fg_pid else 1, 0 if f == act else 1, m, f))
    out.sort(key=lambda x: (x[0], x[1]))
    return [(m, f) for _a, _b, m, f in out]


def manual_fill(body: dict, progress) -> dict:
    """[직접 고를게요] — 워처 코너 창에 3단계 안내 + [작성 시작하기 ▶](사용자 2026-11-24).
    사람이 이지폼에서 새로작성 → 거래처를 고르고 버튼을 누르면, 그 새 명세서에 줄을 넣고 다시 읽어 같을 때만 **저장까지**
    → 목록에서 저장됐나 확인 → 홈페이지 화면으로. 사람이 [저장]을 안 누르므로 '홈페이지에 반영할까요?'도 안 뜬다.
    취소(코너 창 ✕ / 웹 [취소]) = 아무것도 안 함 → {cancelled: True} — 홈페이지는 '작성완료'로 안 바뀜."""
    import threading

    import easyform_autosync as A
    target = _strip_tail([norm_target(r) for r in (body.get("target") or []) if isinstance(r, dict)])
    if not target:
        raise Stop("입력할 줄이 없어요.")
    if not b._mains():
        raise Stop("켜져 있는 이지폼이 없어요.")
    note = ""
    asked_client = False
    while True:
        holder = {"ev": threading.Event(), "ans": False}
        ef.ef_manual_show(holder, note)
        progress("wait")
        t0 = time.time()
        while not holder["ev"].wait(0.2):
            if b._aborted() or time.time() - t0 > 1800:
                ef.ef_manual_hide(holder)
                return {"cancelled": True}
        if not holder["ans"]:
            return {"cancelled": True}
        found = _new_forms()
        if not found:
            note = "새로작성 창을 못 찾았어요. 이지폼에서 [새로작성]을 눌러주세요."
            continue
        m, form = found[0]
        main = m["hwnd"]
        first = _read_all(form)[:1]
        if first and any(first[0].get(c) for c in COLS):
            note = "이미 내용이 있는 명세서예요. 이지폼에서 [새로작성]을 눌러주세요."
            continue
        if b._popups(main) or b._kids(main, "TfrmSelectComout"):
            note = "이지폼에 거래처 선택 창(또는 질문창)이 떠 있어요. 닫고 다시 눌러주세요."
            continue
        shot = A._capture_client(form)
        ocr = (A._ocr(shot) if shot else "").strip()
        logging.info("이지폼 직접 고르기 거래처 OCR='%s'", ocr)
        if not ocr and not asked_client:  # 거래처를 아직 안 골랐거나 OCR 실패 — 한 번만 묻고, 또 누르면 그대로 진행
            asked_client = True
            note = "거래처가 아직 안 보여요. 거래처를 선택하고 다시 눌러주세요."
            continue
        break
    saved = False
    tag = ("주식회사", "#2563eb") if m["biz"] == "corp" else ("개인", "#d97706")
    _lock_on()  # 칸 채우기·저장 동안 화면 가림 + 입력 잠금
    try:
        _fill_new(_Form(main, form), target, progress)
        progress("입력한 명세서를 다시 읽어 확인하는 중")
        after = _strip_tail([norm_row(r) for r in _read_all(form)])
        if after != target:
            bad = next((i for i in range(max(len(after), len(target)))
                        if i >= len(after) or i >= len(target) or after[i] != target[i]), 0)
            logging.warning("이지폼 직접 고르기 검증 실패 %d번째: %s vs %s", bad + 1,
                            after[bad] if bad < len(after) else None, target[bad] if bad < len(target) else None)
            raise Stop(f"입력한 뒤 {bad + 1}번째 줄이 홈페이지와 달라서 저장 안 했어요(새 명세서는 버렸어요).")
        date, total = b._form_header(form)
        progress("이지폼에 저장하는 중")
        save = b._named(form, "TBitBtn", "저장")
        if not save or not b._u.IsWindowEnabled(save):
            raise Stop("이지폼 [저장] 버튼을 못 찾았어요.")
        b._u.PostMessageW(save, 0x00F5, 0, 0)  # BM_CLICK — 새 명세서는 확인창 없이 저장(실측)
        time.sleep(1.2)
        if b._popups(main):
            raise Stop("저장을 눌렀더니 이지폼 창이 떠서 멈췄어요. 이지폼을 직접 확인해주세요.")
        saved = True
        _close(main, form)
    finally:
        if not saved:
            _discard_new(main, form)
        _lock_release_now()
    progress("저장됐는지 확인하는 중")
    lst = b._export_one(m, 0, progress, period=(date, date), forms_ok=True)
    hit = [r for r in lst if b._digits(r["total"]) == b._digits(total)
           and (r.get("firstItem") or "").strip() == (target[0]["item"] or "").strip()]
    if ocr and len(hit) > 1:
        hit.sort(key=lambda r: 0 if _same_client(r.get("client", ""), ocr) else 1)
    _go_home()
    if not hit:
        raise Stop("저장 버튼은 눌렀는데 이지폼 목록에서 새 명세서가 안 보여요. 이지폼을 직접 확인해주세요.")
    client = hit[0].get("client") or ocr
    ef.ef_notice("이지폼에 작성하고 저장했어요", f"{client}  ·  {date}  ·  합계 {int(b._digits(total) or 0):,}원", tag)
    return {"date": date, "total": total, "client": client, "biz": m["biz"], "bizNo": hit[0].get("bizNo", ""),
            "rows": after}


def open_show(body: dict, progress) -> dict:
    """[이지폼에서 열기] — 찾아서 띄우고 '…명세서를 열었어요' 카드."""
    _m, _f, info = _find_open(body, progress)
    _opened_notice(info["biz"], info["client"], info["date"], info["total"])
    return info


def _plan_lines(plan: dict, limit: int = 6) -> list:
    """확인 카드에 보일 바뀔 내용(짧게)."""
    lab = {"item_code": "품목코드", "item": "품목", "spec": "규격", "qty": "수량", "unit_price": "단가"}
    out = []
    for m_ in plan["mods"]:
        ch = ", ".join(f"{lab[c]} {m_['from'][c] or '빈칸'}→{m_['to'][c] or '빈칸'}" for c in m_["cols"])
        out.append(f"✏️ {m_['row'] + 1}번째 줄 {m_['from']['item']} — {ch}")
    for i_ in plan["ins"]:
        t = i_["to"]
        out.append(f"➕ 추가: {t['item'] or '(품목 없음)'}" + (f" {t['spec']}" if t["spec"] else "") +
                   (f" · {t['qty'] or '1'}×{int(b._digits(t['unit_price']) or 0):,}" if t["unit_price"] else ""))
    for d_ in plan["dels"]:
        out.append(f"➖ 삭제: {d_['row'] + 1}번째 줄 {d_['from']['item'] or '(품목 없음)'}")
    if len(out) > limit:
        out = out[:limit] + [f"… 외 {len(out) - limit}가지"]
    return out


def push_confirm(body: dict, progress) -> dict:
    """[이지폼에 적용하기] — 그 명세서를 이지폼에 띄우고 '이 명세서가 맞나요?'(네/아니오, 사용자 2026-11-23)
    → 네 = 띄워 둔 그 명세서에 바뀐 줄만 고치고 다시 읽어 같을 때만 저장, 아니오 = 아무것도 안 바꿈(띄운 채 둠)."""
    target = _strip_tail([norm_target(r) for r in (body.get("target") or []) if isinstance(r, dict)])
    if not target:
        raise Stop("반영할 줄이 없어요.")
    m, form, info = _find_open(body, progress)
    main = m["hwnd"]
    progress("이지폼 명세서를 읽는 중")
    raw = _read_all(form)
    cur = _strip_tail([norm_row(r) for r in raw])
    plan = make_plan(cur, target)
    tag = ("주식회사", "#2563eb") if info["biz"] == "corp" else ("개인", "#d97706")
    amt = int(b._digits(info["total"]) or 0)
    sub = f"{info['client'] or '이지폼'}  ·  {info['date']}  ·  합계 {amt:,}원"
    base = {**info, "rows": raw}
    if plan["lostNos"]:
        raise Stop(f"주문번호({', '.join(plan['lostNos'])})가 적힌 줄을 지우게 돼서 멈췄어요. 이지폼에서 직접 고쳐주세요.")
    if plan["same"]:
        ef.ef_notice("이미 홈페이지와 같아요", sub, tag)
        return {**base, "same": True}
    progress("이지폼 화면에서 '이 명세서가 맞나요?'에 답해주세요")
    _lock_release_now()
    ok = ef.ef_ask("이 명세서가 맞나요?", sub, _plan_lines(plan), tag, yes="네, 적용할게요", no="아니오")
    if not ok:
        _go_home()  # 아니오 = 아무것도 안 바꾸고 홈페이지 화면으로(사용자 2026-11-23)
        return {**base, "cancelled": True}
    # 적용(칸 고치기·저장)은 _apply_on_form 이 화면을 가리고 입력을 잠근 채로(ESC = 중단)
    res = _apply_on_form(main, form, raw, target, info["date"], info["total"], progress, plan=plan)
    _lock_release_now()
    _go_home()
    ef.ef_notice("이지폼에 적용하고 저장했어요", f"{info['client'] or '이지폼'}  ·  {res['date']}  ·  합계 "
                 f"{int(b._digits(res.get('total') or '') or 0):,}원", tag)
    return {**base, **res}


def _go_home() -> None:
    """웹 버튼을 누른 순간 앞에 있던 창(= 홈페이지 브라우저)을 다시 앞으로."""
    with b._LOCK:
        home = b._JOB.get("home")
    try:
        if home and b._u.IsWindow(home):
            ef.ef_force_foreground(home)
    except Exception:
        logging.exception("홈페이지 창 앞으로 실패")


def plan_summary(cur_raw: list, target_raw: list) -> dict:
    cur = _strip_tail([norm_row(r) for r in cur_raw])
    tgt = _strip_tail([norm_target(r) for r in target_raw if isinstance(r, dict)])
    p = make_plan(cur, tgt)
    return {"same": p["same"], "mods": p["mods"], "dels": p["dels"], "ins": p["ins"], "lostNos": p["lostNos"]}


def run(phase: str, body: dict, progress, on_result) -> str:
    """칸을 도는 동안만 잠금(_locked/_lock_on — 사용자 2026-11-24: 전달 중 키 입력으로 오류, 그러나 [정지]는 눌러야 함).
    잠긴 동안 ESC = 정지(입력 잠금이 ESC 를 받아 여기서 작업 정지로 넘김). 끝나면 남은 잠금을 바로 푼다."""
    import threading
    done = threading.Event()

    def esc_relay():
        while not done.wait(0.1):
            if ef.ef_aborted():
                b._ABORT.set()
                return

    threading.Thread(target=esc_relay, daemon=True).start()
    try:
        return _run(phase, body, progress, on_result)
    finally:
        done.set()
        _lock_release_now()


def _run(phase: str, body: dict, progress, on_result) -> str:
    if phase == "push_confirm":
        res = push_confirm(body, progress)
        on_result({"key": "push", "ok": True, **res})
        return "취소했어요." if res.get("cancelled") else ("이미 같아요." if res.get("same") else "이지폼에 적용했어요.")
    if phase == "open_show":
        res = open_show(body, progress)
        on_result({"key": "push", "ok": True, **res})
        return "이지폼에서 명세서를 열었어요."
    if phase == "new_fill":
        res = new_fill(body, progress)
        on_result({"key": "push", "ok": True, **res})
        return "이지폼에 새 명세서를 저장했어요."
    if phase == "open_quick":
        res = open_quick(body, progress)
        on_result({"key": "push", "ok": True, **res})
        return "이지폼에서 명세서를 열었어요." if res.get("found") else "못 찾았어요."
    if phase == "manual_fill":
        res = manual_fill(body, progress)
        on_result({"key": "push", "ok": True, **res})
        return "취소했어요." if res.get("cancelled") else "이지폼에 새 명세서를 저장했어요."
    if phase == "push_read":
        found = find_and_read(body, progress)
        found["plan"] = plan_summary(found["rows"], body.get("target") or [])
        on_result({"key": "push", "ok": True, **found})
        return "이지폼 명세서를 찾았어요."
    res = apply(body, progress)
    on_result({"key": "push", "ok": True, **res})
    return "이지폼 명세서에 반영했어요." if not res.get("same") else "이미 같아요."
