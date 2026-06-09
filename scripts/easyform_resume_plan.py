# -*- coding: utf-8 -*-
"""이지폼 증분 추출 '시작점' 도우미 (읽기전용, 화면 조작 없음).

주기 추출 때 '목록에서 몇 번 내려야 하는지' + 실행 명령을 연도/종류별로 알려준다.

핵심 함정: **내릴 횟수 = raw(영속 grid 추출) 건수**, 폴더(enriched) 건수가 아니다.
enrich 가 CSV 에 없는 미발행 명세서를 떨궈서(enriched < raw) 폴더 숫자로 내리면 모자란다.
이지폼 목록엔 미발행도 그대로 있으므로 raw 건수만큼 내려야 첫 새 명세서에 선다.

사용: py -3 easyform_resume_plan.py [--year 2026]
"""
from __future__ import annotations
import argparse, csv, datetime, io, json
from pathlib import Path

BASE = Path(r"C:\Users\USER\Desktop\hdsign")
RAW = BASE / "easyform-data"                      # 영속 grid 추출 + CSV 매출거래목록
INV = BASE / "auto-quote-data" / "invoices"        # enriched 최종(매칭/웹이 읽는 것)
FAST = r"C:\Users\USER\Desktop\tenet-test\.tenet\learning\easyform_fast.py"
ENRICH = r"C:\Users\USER\Desktop\hdsign\scripts\enrich_2026_aligned.py"
SEEK = r"C:\Users\USER\Desktop\hdsign\scripts\easyform_seek.py"
KINDS = [("corp", "주식회사"), ("personal", "개인")]


def load_invoices(p: Path):
    if not p.is_file():
        return None
    d = json.load(io.open(p, encoding="utf-8"))
    return d.get("invoices", d if isinstance(d, list) else [])


def csv_rows(p: Path) -> int | None:
    if not p.is_file():
        return None
    try:
        rows = list(csv.reader(open(p, encoding="cp949")))
    except Exception:
        return None
    hi = next((i for i, r in enumerate(rows) if r and r[0] == "사업자번호"), None)
    if hi is None:
        return None
    return sum(1 for r in rows[hi + 1:] if len(r) >= 11 and r[0].strip())


def first_item(inv) -> str:
    for r in inv.get("grid", []):
        if (r.get("item") or "").strip():
            return r["item"].strip()
    return ""


def plan(year: int):
    yy = year % 100
    print(f"=== {year} 이지폼 증분 추출 시작점 ===\n")
    print("이지폼: [매출 거래명세서 목록] · '역순으로 보기' 끄기(정순) · 1번째(가장 오래된) 행 클릭.\n")
    for kind, kor in KINDS:
        rawf = RAW / f"easyform_{year}_{kind}_fast.json"
        enrf = INV / f"easyform_{year}_{kind}.json"
        csvf = RAW / f"{yy}년도매출거래목록({kor}).csv"
        raw = load_invoices(rawf)
        enr = load_invoices(enrf)
        n_raw = len(raw) if raw is not None else None
        n_enr = len(enr) if enr is not None else 0
        n_csv = csv_rows(csvf)
        print(f"■ {year} {kor}({kind})")
        if n_raw is None:
            print(f"  raw 추출 파일 없음 → 이 종류는 첫 추출(--start 0)로 시작.\n")
            continue
        last = enr[-1] if enr else {}
        print(f"  raw(목록 기준) {n_raw}건  /  enriched(폴더) {n_enr}건  /  CSV {n_csv if n_csv is not None else '없음'}행")
        print(f"  마지막 추출: {last.get('date','?')} · {(last.get('client') or '')[:18]} · '{first_item(last)[:18]}'")
        if n_csv is not None:
            newish = n_csv - n_enr
            print(f"  CSV-enriched = {newish}건 (대략 새 발행 명세서 수; 미발행분 때문에 정확치 아님)")
        print(f"  ▶ 내릴 횟수 N = {n_raw}  (raw 기준! 폴더 {n_enr} 아님)")
        print(f"    1) py -3 {SEEK} {n_raw}            # 목록에서 ↓ {n_raw}회 → {n_raw+1}번째 활성")
        print(f"    2) (검증) 활성 행 날짜가 위 '마지막 추출' 보다 뒤인지 눈으로 확인 → Enter 로 상세 열기")
        print(f"    3) py -3 {FAST} --max 2000 --start {n_raw} --out {rawf}      # raw 에 새것만 append, 목록끝 자동정지")
        print(f"    4) py -3 {ENRICH} --json {rawf} --csv {csvf} --out {enrf} --save   # raw 보존, enriched 최종 갱신")
        print()
    print("주의: 추출 후 enriched 가 갱신되면 invoice_idx 는 접두부가 유지되어 기존 R2 사진키도 보존됨.")
    print("      매칭/병합/R2 업로드/배포는 런북(PERIODIC_PIPELINE.md) 참고.")


if __name__ == "__main__":
    import sys
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, default=datetime.date.today().year)
    a = ap.parse_args()
    plan(a.year)
