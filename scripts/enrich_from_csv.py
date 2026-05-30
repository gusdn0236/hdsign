"""이지폼 매출거래목록 CSV → easyform JSON 에 월일/합계/공급/세액/거래처 부여.

매칭 원리: CSV(발행일자 역순) 를 뒤집으면 easyform(정순) 과 1:1.
즉 easyform[i] = CSV역순[i]. (품목 대조로 검증)

사용:
    py -3 enrich_from_csv.py --json <easyform_YYYY.json> --csv <주식회사.csv>

CSV 컬럼: 사업자번호 거래처명 발행일자 품목 합계금액 공급가액 세액 면세금액 작성일자 발행방법 상태
부여 필드(명세서 단위): date(발행일자) client(거래처) total(합계) supply_total(공급가액)
                        tax_total(세액) issue_method(발행방법)
"""
import argparse
import csv
import json
import re
import shutil
import sys
from pathlib import Path


def load_csv(path: str):
    """거래처명에 쉼표가 있으면 컬럼이 밀리므로, 뒤 9개 컬럼을 고정 인덱싱으로 파싱.
    (사업자번호 | 거래처명... | 발행일자 품목 합계 공급 세액 면세 작성일자 발행방법 상태)"""
    with open(path, encoding="cp949") as fh:
        rows = list(csv.reader(fh))
    hi = next(i for i, r in enumerate(rows) if r and r[0] == "사업자번호")
    out = []
    for r in rows[hi + 1:]:
        if len(r) < 11 or not r[0].strip():
            continue
        out.append({
            "사업자번호": r[0].strip(),
            "거래처명": ",".join(r[1:-9]).strip(),  # 쉼표로 분리된 거래처명 복원
            "발행일자": r[-9].strip(),
            "품목": r[-8].strip(),
            "합계금액": r[-7].strip(),
            "공급가액": r[-6].strip(),
            "세액": r[-5].strip(),
            "면세금액": r[-4].strip(),
            "작성일자": r[-3].strip(),
            "발행방법": r[-2].strip(),
            "상태": r[-1].strip(),
        })
    return out


def first_item(inv: dict) -> str:
    for r in inv.get("grid", []):
        it = r.get("item", "").strip()
        if it:
            return it
    return ""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", required=True)
    ap.add_argument("--csv", required=True)
    ap.add_argument("--dry-run", action="store_true", help="저장 안 하고 검증만")
    args = ap.parse_args()

    data = load_csv(args.csv)
    # CSV 정렬 방향 자동 감지 — 25년은 역순(12→01), 24년은 정순(01→12) 등 export 마다 다름.
    # easyform 은 정순(01→12)이라 CSV 가 역순이면 뒤집고, 정순이면 그대로.
    first_d, last_d = data[0]["발행일자"], data[-1]["발행일자"]
    if first_d > last_d:
        csv_rev = data[::-1]
        print(f"CSV 발행일자 역순 감지 ({first_d} → {last_d}) — 뒤집어서 매칭")
    else:
        csv_rev = data
        print(f"CSV 발행일자 정순 ({first_d} → {last_d}) — 그대로 매칭")

    jpath = Path(args.json)
    d = json.loads(jpath.read_text(encoding="utf-8"))
    invs = sorted(d["invoices"], key=lambda x: x["invoice_idx"])

    print(f"easyform: {len(invs)}건 / CSV: {len(csv_rev)}행")
    if len(invs) != len(csv_rev):
        print(f"⚠ 행 수 불일치 — min({len(invs)}, {len(csv_rev)}) 만 매칭")

    norm = lambda s: re.sub(r"[^가-힣A-Za-z0-9]", "", s)
    n = min(len(invs), len(csv_rev))
    match = mismatch = 0
    mismatch_samples = []
    for i in range(n):
        inv, row = invs[i], csv_rev[i]
        # 품목 대조 (정렬 검증) — 특수문자/공백 무시
        csv_item = row["품목"]
        ef_item = first_item(inv)
        if norm(csv_item) == norm(ef_item):
            match += 1
            inv["csv_item_match"] = True
        else:
            mismatch += 1
            inv["csv_item_match"] = False   # 검토 flag (합계·세액 정확도 확인용)
            inv["csv_item"] = csv_item        # CSV 대표 품목 (대조용)
            if len(mismatch_samples) < 15:
                mismatch_samples.append((inv["invoice_idx"], ef_item, csv_item))
        # 메타 부여
        inv["date"] = row["발행일자"]
        inv["client"] = row["거래처명"]
        inv["total"] = row["합계금액"]
        inv["supply_total"] = row["공급가액"]
        inv["tax_total"] = row["세액"]
        inv["issue_method"] = row["발행방법"]

    rate = match / n * 100 if n else 0
    print(f"품목 대조: 일치 {match} / 불일치 {mismatch} ({rate:.1f}% 일치)")
    if mismatch_samples:
        print("불일치 샘플 (idx | easyform 첫품목 | CSV 품목):")
        for idx, ef, cv in mismatch_samples:
            print(f"  {idx:4} | {ef[:26]!r:28} | {cv[:26]!r}")

    if args.dry_run:
        print("(dry-run — 저장 안 함)")
        return 0
    if rate < 80:
        print(f"⚠ 일치율 {rate:.1f}% < 80% — 정렬 의심. 저장 중단. --dry-run 으로 먼저 확인하세요.")
        return 1

    backup = jpath.with_name(jpath.stem + ".backup_before_enrich.json")
    shutil.copy(jpath, backup)
    d["invoices"] = invs
    d["enriched_from_csv"] = Path(args.csv).name
    jpath.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"백업: {backup.name}")
    print(f"저장: {jpath.name} — {n}건에 월일/합계/공급/세액/거래처 부여 완료")
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore
    sys.exit(main())
