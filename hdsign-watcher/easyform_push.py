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
    return out


def _blank(r: dict) -> bool:
    return not any((r.get(c) or "") for c in COLS)


def _strip_tail(rows: list) -> list:
    rows = list(rows)
    while rows and _blank(rows[-1]):
        rows.pop()
    return rows


def _sig(r: dict) -> tuple:
    return tuple(r[c] for c in BODY)


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
    지문 없음: 기간 안에서 거래처 비슷한 것(없으면 전부) 최대 40건, 비고 주문번호로만."""
    cl = str(body.get("client") or "")
    if exact:
        date, total = str(body.get("date") or ""), str(body.get("total") or "")
        same_day = [r for r in lst if r["date"] == date]
        first = [r for r in same_day if b._digits(r["total"]) == b._digits(total)]
        rest = [r for r in same_day if r not in first]
        rest.sort(key=lambda r: 0 if cl and _client_like(cl, r.get("client", "")) else 1)
        lone = first[0] if len(first) == 1 and (not cl or _client_like(cl, first[0].get("client", ""))) else None
        return (first + rest)[:40], lone
    cands = ([r for r in lst if _client_like(cl, r.get("client", ""))] if cl else []) or lst
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
            progress(f"그날엔 없어서 앞뒤 7일({period[0]}~{period[1]})에서 찾는 중")
        per = []
        seen = set()
        # 기억해 둔 이지폼(지난번에 찾은 주식회사/개인)이 있으면 그쪽 목록만 먼저 뽑아 합계 맞는 것부터 —
        # 찾으면 다른 이지폼 목록은 안 뽑는다(다시 열 때 ~10초 → ~5초, 사용자 2026-11-23).
        if exact and hint and any(m["biz"] == hint for m in mains):
            m, cs, lone = load(next(m for m in mains if m["biz"] == hint), period, pi, exact)
            per.append((m, cs, lone))
            for it in [x for x in cs if hit_total(x)]:
                stop_check()
                seen.add((m["biz"], it["idx"]))
                yield m, it, lone, len(cs)
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
            yield m, it, lone, len(order)


def find_and_read(body: dict, progress) -> dict:
    """명세서를 찾아 열고 읽고 닫는다 → {biz, idx, date, total, rows, nos}.
    body: date+total(지문이 있을 때, 그날 하루치) 또는 from~to+client(지문 없을 때, 비고 주문번호로 확인), nos."""
    want_nos = [n for n in (body.get("nos") or []) if n]
    k = 0
    for m, it, lone, n in _each_candidate(body, progress, forms_ok=False):
        main = m["hwnd"]
        k += 1
        progress(f"이지폼 명세서 확인 중 {k} · {it['date']} {it.get('client', '')}")
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
        time.sleep(0.08)
        if enter:
            b._key(e, 0x0D)  # 다음 칸으로(수량→단가, 단가→재계산). 비고 칸엔 절대 Enter 안 함(새 줄 생김).
            time.sleep(0.3)
        self._check()

    def write_row(self, row: int, to: dict, cols=None, remark: "str | None" = None) -> None:
        """그 줄을 to 로. 글자칸은 바뀐 것만, 수량·단가는 늘 다시 넣고 단가 Enter = 재계산."""
        cols = list(cols) if cols is not None else list(BODY)
        for c in ("item_code", "item", "spec"):
            if c in cols:
                self.put(row, c, to[c], enter=False)
        self.put(row, "qty", to["qty"], enter=True)
        self.put(row, "unit_price", to["unit_price"], enter=True)
        if remark is not None and remark != "":
            self.put(row, "remark", remark, enter=False)
            ix, iy = b._row_cells(self.grid, row)["item"]
            b._click(self.grid, "품목", ix, iy)  # 같은 줄 다른 칸 = 비고 확정(Enter 금지)
            time.sleep(0.3)
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

    def append_after(self, last: int) -> None:
        """마지막 줄(last) 비고 칸 Enter → 맨 밑 새 줄."""
        e = self.editor(last, "remark")
        b._key(e, 0x0D)
        time.sleep(0.45)
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
    saved = False
    try:
        plan = make_plan(cur, target)
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
    b._assert_clean(main)  # 열린 명세서·질문창 있으면 멈춤
    progress("이지폼 새 명세서를 여는 중")
    mid = b._menu_id(main, "거래명세서", "[매출] 거래명세서 작성")
    if not mid:
        raise Stop("이지폼 메뉴에서 '[매출] 거래명세서 작성'을 못 찾았어요.")
    before = b._forms(main)
    b._u.PostMessageW(main, 0x0111, mid, 0)
    form = b._wait(lambda: next((x for x in b._kids(main, "TfrmExchange") if x not in before), None), 6.0)
    if not form:
        raise Stop("이지폼 새 명세서 창이 안 열렸어요.")
    saved = False
    try:
        time.sleep(0.6)
        b._click(b._named(form, "TBitBtn", "새로작성"), "새로작성")
        date_edit = next(iter(b._kids(form, "TMaskEdit")), None)
        if not b._wait(lambda: "_" not in b._txt(date_edit) and b._txt(date_edit).strip(), 3.0):
            raise Stop("이지폼 [새로작성]이 안 눌렸어요.")
        if b._popups(main):
            raise Stop("새로작성 중 이지폼 창이 떠서 멈췄어요.")
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
        F = _Form(main, form)
        for i, row in enumerate(target):
            progress(f"줄 입력 중 {i + 1}/{len(target)}")
            if i > 0:
                F.append_after(i - 1)
            F.write_row(i, row, cols=[c for c in ("item_code", "item", "spec") if row[c]],
                        remark=row["remark"] or None)
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


def open_show(body: dict, progress) -> dict:
    """find_and_read 와 같은 방법으로 찾되 비고만 확인하고, 맞는 명세서는 **열어 둔 채** 이지폼을 앞으로."""
    want_nos = [n for n in (body.get("nos") or []) if n]
    mains = b._mains()
    if not mains:
        raise Stop("켜져 있는 이지폼이 없어요.")
    # 찾는 명세서가 이미 열려 있으면 목록 안 뽑고 바로 앞으로 — 비고에 이 주문번호가 있거나, 비고에 주문번호가 없는
    # 옛 명세서면 발행일·합계가 홈페이지 기록(지문)과 같을 때(첫 열기는 '같은 날 같은 합계 하나'로 찾았는데 두 번째엔
    # 비고만 봐서 다시 조회하던 것 — 사용자 2026-11-23).
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
                    _opened_notice(m["biz"], str(body.get("client") or ""), d, t)
                    return {"biz": m["biz"], "date": d, "total": b._digits(t), "client": "",
                            "nos": fnos}
    k = 0
    for m, it, lone, n in _each_candidate(body, progress, forms_ok=True):
        main = m["hwnd"]
        k += 1
        progress(f"이지폼 명세서 찾는 중 {k} · {it['date']} {it.get('client', '')}")
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
            _opened_notice(m["biz"], it.get('client', ''), it['date'], it['total'])
            return {"biz": m["biz"], "date": it["date"], "total": it["total"], "client": it.get("client", ""),
                    "nos": nos}
    raise Stop("주식회사·개인 이지폼 모두에서 이 주문의 명세서를 못 찾았어요. (비고에 이 주문번호가 적힌 명세서가 없어요)")


def plan_summary(cur_raw: list, target_raw: list) -> dict:
    cur = _strip_tail([norm_row(r) for r in cur_raw])
    tgt = _strip_tail([norm_target(r) for r in target_raw if isinstance(r, dict)])
    p = make_plan(cur, tgt)
    return {"same": p["same"], "mods": p["mods"], "dels": p["dels"], "ins": p["ins"], "lostNos": p["lostNos"]}


def run(phase: str, body: dict, progress, on_result) -> str:
    if phase == "open_show":
        res = open_show(body, progress)
        on_result({"key": "push", "ok": True, **res})
        return "이지폼에서 명세서를 열었어요."
    if phase == "new_fill":
        res = new_fill(body, progress)
        on_result({"key": "push", "ok": True, **res})
        return "이지폼에 새 명세서를 저장했어요."
    if phase == "push_read":
        found = find_and_read(body, progress)
        found["plan"] = plan_summary(found["rows"], body.get("target") or [])
        on_result({"key": "push", "ok": True, **found})
        return "이지폼 명세서를 찾았어요."
    res = apply(body, progress)
    on_result({"key": "push", "ok": True, **res})
    return "이지폼 명세서에 반영했어요." if not res.get("same") else "이미 같아요."
