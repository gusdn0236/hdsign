"""이지폼 명세서 추출 테스트 (행 누락 진단용).

모드
  (기본)              지금 열린 상세명세서 1건만 추출 (이동 없음)
  --multi N --start K --kind corp|personal
                      3/4번 런처와 '똑같이' ef.run() 으로 연속 N건 (Esc/↓/Enter 이동 포함).
                      결과는 테스트 파일에만 저장(실제 추출 파일 안 건드림).
                      6월에 이미 추출한 구간이면 CSV 공급가액(정답)과 자동 비교.

easyform_fast.py 의 함수를 '그대로' 불러 씀(코드 복사 X) → 런처와 동일 동작 재현.
행을 읽을 때마다 그리드 화면 캡처 → hdsign/easyform-data/_test_one/
안전: easyform_fast 와 동일 — 좌/우클릭·Esc·↓·Enter 만, Ctrl·타이핑·저장 없음. 중단: Ctrl+Esc 꾹.
"""
import importlib.util, json, sys, time
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
FAST = Path(r"C:\Users\USER\Desktop\tenet-test\.tenet\learning\easyform_fast.py")
OUTDIR = Path(r"C:\Users\USER\Desktop\hdsign\easyform-data\_test_one")
INVDIR = Path(r"C:\Users\USER\Desktop\hdsign\auto-quote-data\invoices")

spec = importlib.util.spec_from_file_location("easyform_fast", FAST)
ef = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ef)

try:
    from PIL import ImageGrab
except Exception:
    ImageGrab = None

OUTDIR.mkdir(parents=True, exist_ok=True)

L = ef.LAYOUT
D = ef.DPI
# 그리드 영역 + 위아래 여유 (DPI aware 프로세스라 물리 좌표로 캡처)
BOX = (int((L["grid_left"] - 5) * D), int((L["grid_top"] - 30) * D),
       int((L["grid_right"] + 5) * D), int((L["grid_bottom"] + 40) * D))

state = {"n": 0, "inv": 0, "multi": False}
log = []


def shot(name, full=False):
    if ImageGrab is None:
        return
    try:
        img = ImageGrab.grab(all_screens=True) if full else ImageGrab.grab(bbox=BOX, all_screens=True)
        img.save(OUTDIR / name)
    except Exception as e:
        print(f"  (캡처 실패 {e})")


_orig_extract_row = ef.extract_row


def traced_extract_row(row_cells, timings=None):
    state["n"] += 1
    n = state["n"]
    pre = f"i{state['inv']:03d}_" if state["multi"] else ""
    shot(f"step_{pre}{n:02d}.png")
    cells, st = _orig_extract_row(row_cells, timings)
    y = row_cells[0]["y"] if row_cells else None
    log.append({"inv": state["inv"], "step": n, "y": y, "status": st, "cells": cells})
    if not state["multi"]:
        vals = [cells.get(c, "") for c in ef.TARGET]
        print(f"  step {n:>2} (y={y}) {st}: {' | '.join(vals)}", flush=True)
    return cells, st


_orig_extract_grid = ef.extract_grid


def traced_extract_grid(layout, timings=None):
    if state["multi"]:
        state["inv"] += 1
        state["n"] = 0
        shot(f"step_i{state['inv']:03d}_00_full.png", full=True)  # 창 위치 확인용 전체화면
    return _orig_extract_grid(layout, timings)


ef.extract_row = traced_extract_row
ef.extract_grid = traced_extract_grid


def num(s):
    try:
        return float(str(s).replace(",", "").strip() or 0)
    except Exception:
        return None


def grid_sum(g):
    return sum((num(r.get("qty")) or 0) * (num(r.get("unit_price")) or 0) for r in g)


def single():
    for p in OUTDIR.glob("step_*.png"):
        p.unlink()
    print("=" * 66)
    print(" 이지폼 긴 명세서 1건 테스트 (지금 열린 상세명세서만, 이동 없음)")
    print("=" * 66)
    print(" 5초 뒤 시작. 마우스/키보드 손대지 마세요. (중단 = Ctrl+Esc 꾹)")
    for i in range(5, 0, -1):
        print(f"  {i}...", end="\r", flush=True)
        time.sleep(1)
    print()
    ef.focus_easyform()
    ef.wait_if_busy()
    t0 = time.time()
    grid, stop = ef.extract_grid(L)
    dur = time.time() - t0
    print()
    print("-" * 66)
    print(f" 추출 결과: {len(grid)}행  (종료사유 {stop}, {dur:.1f}초)")
    print("-" * 66)
    for i, r in enumerate(grid, 1):
        q, p = num(r.get("qty")), num(r.get("unit_price"))
        amt = q * p if (q is not None and p is not None) else 0
        print(f" {i:>3}. {r.get('item_code',''):<12} {r.get('item',''):<28} "
              f"{r.get('spec',''):<14} {r.get('qty',''):>5} x {r.get('unit_price',''):>10} = {amt:>12,.0f}")
    print("-" * 66)
    print(f" 수량x단가 합계 = {grid_sum(grid):,.0f} 원")
    print(" -> 이지폼 화면 하단 '공급가액' 과 같으면 누락 없음, 다르면 누락/중복 있음.")
    print(f" 캡처/로그: {OUTDIR}")
    (OUTDIR / "result.json").write_text(json.dumps(
        {"rows": len(grid), "stop": stop, "sum_qty_x_price": grid_sum(grid), "grid": grid,
         "steps": log, "dpi": D, "box": BOX}, ensure_ascii=False, indent=1), encoding="utf-8")


def multi(n, start, kind):
    for p in OUTDIR.glob("step_i*.png"):
        p.unlink()
    out = OUTDIR / f"multi_{kind}.json"
    if out.exists():
        out.unlink()  # 재개(resume) 로딩 방지 — 항상 새로
    state["multi"] = True
    print("=" * 66)
    print(f" 연속 {n}건 테스트 ({kind}, idx {start}부터) - 3/4번 런처와 같은 방식")
    print("=" * 66)
    ef.run(n, start, str(out))
    res = json.loads(out.read_text(encoding="utf-8")).get("invoices", [])
    truth = {}
    tp = INVDIR / f"easyform_2026_{kind}.json"
    if tp.exists():
        for i in json.loads(tp.read_text(encoding="utf-8"))["invoices"]:
            truth[i["invoice_idx"]] = i
    print()
    print("-" * 66)
    print(f" {'idx':>5} {'행':>4} {'수량x단가합계':>14} {'CSV공급가액':>14} {'6월추출행':>8}  판정")
    bad = 0
    rows = []
    for i in res:
        g = i["grid"]
        s = grid_sum(g)
        t = truth.get(i["invoice_idx"]) or {}
        st = num(t.get("supply_total")) if t else None
        if st:
            ok = abs(s - st) <= max(10, st * 0.002)
            verdict = "OK" if ok else "불일치"
            bad += (not ok)
        else:
            verdict = "(정답없음)"
        rows.append({"idx": i["invoice_idx"], "rows": len(g), "sum": s, "csv": st, "verdict": verdict})
        print(f" {i['invoice_idx']:>5} {len(g):>4} {s:>14,.0f} {(st or 0):>14,.0f} "
              f"{len(t.get('grid', [])) if t else 0:>8}  {verdict}")
    print("-" * 66)
    print(f" 불일치 {bad}건 (DC/할인 있는 명세서는 원래 조금 다를 수 있음)")
    print(f" 캡처/결과: {OUTDIR}")
    (OUTDIR / f"multi_{kind}_report.json").write_text(json.dumps(
        {"start": start, "n": n, "rows": rows, "steps": log}, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--multi", type=int, default=0)
    ap.add_argument("--start", type=int, default=0)
    ap.add_argument("--kind", default="corp", choices=["corp", "personal"])
    a = ap.parse_args()
    if a.multi:
        multi(a.multi, a.start, a.kind)
    else:
        single()
