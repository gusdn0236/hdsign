"""2026 easyform(fast 추출) → CSV 매출거래목록으로 보강.
enrich_from_csv.py 와 같은 매핑이되, **품목 시퀀스 2-포인터 정렬**로 매출목록에 없는
미발행 명세서(easyform 여분)를 찾아 제거한 뒤 1:1 매칭한다. (단순 index zip 은 여분 때문에
드리프트가 나서 못 씀.)

사용: py -3 enrich_2026_aligned.py --json <easyform_2026_x.json> --csv <26년..csv> [--save]
"""
from __future__ import annotations
import argparse, csv, json, re, sys
from pathlib import Path

norm = lambda s: re.sub(r"[^가-힣A-Za-z0-9]", "", s or "")


def num(s):
    m = re.search(r"-?\d[\d,]*", str(s or ""))
    return int(m.group().replace(",", "")) if m else 0


def amt(inv):
    """easyform 그리드 공급가액 추정 = Σ(수량 × 단가)."""
    s = 0
    for r in inv.get("grid", []):
        u = num(r.get("unit_price"))
        if u > 0:
            q = num(r.get("qty"))
            s += (q if q > 0 else 1) * u
    return s


def match(inv, row):
    """품목 표기 일치 OR 금액(공급가액) 근사 일치 → 같은 명세서."""
    if norm(first_item(inv)) == norm(row["품목"]):
        return True
    a, b = amt(inv), num(row["공급가액"])
    return a > 0 and b > 0 and abs(a - b) <= max(100, b * 0.02)


def load_csv(path):
    rows = list(csv.reader(open(path, encoding="cp949")))
    hi = next(i for i, r in enumerate(rows) if r and r[0] == "사업자번호")
    out = []
    for r in rows[hi + 1:]:
        if len(r) < 11 or not r[0].strip():
            continue
        out.append({
            "거래처명": ",".join(r[1:-9]).strip(),
            "발행일자": r[-9].strip(), "품목": r[-8].strip(),
            "합계금액": r[-7].strip(), "공급가액": r[-6].strip(),
            "세액": r[-5].strip(), "발행방법": r[-2].strip(),
        })
    return out


def first_item(inv):
    for r in inv.get("grid", []):
        if (r.get("item") or "").strip():
            return r["item"].strip()
    return ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", required=True, help="raw fast 추출(영속 grid) — 읽기만, 덮어쓰지 않음")
    ap.add_argument("--csv", required=True)
    ap.add_argument("--out", default=None, help="보강 결과 저장 경로(기본=--json 덮어쓰기). "
                                                "증분 파이프라인은 raw 보존 위해 enriched 최종경로를 지정.")
    ap.add_argument("--save", action="store_true")
    a = ap.parse_args()

    data = load_csv(a.csv)
    if data[0]["발행일자"] > data[-1]["발행일자"]:
        data = data[::-1]  # 역순 → 정순
    d = json.loads(Path(a.json).read_text(encoding="utf-8"))
    ef = [i for i in sorted(d["invoices"], key=lambda x: x["invoice_idx"]) if i["grid_row_count"] > 0]
    print(f"easyform 비어있지않은 {len(ef)}건 / CSV {len(data)}행")

    W = 6  # lookahead 윈도우(연속 여분 대응)
    e = c = 0
    aligned, dropped, softdiff = [], [], 0
    while e < len(ef) and c < len(data):
        if match(ef[e], data[c]):
            soft = norm(first_item(ef[e])) != norm(data[c]["품목"])
            aligned.append((ef[e], data[c])); softdiff += soft; e += 1; c += 1
            continue
        # easyform 여분? 앞쪽 W건 중 csv[c] 와 맞는 게 있으면 그 사이를 여분으로 제거
        k = next((j for j in range(1, W) if e + j < len(ef) and match(ef[e + j], data[c])), None)
        # CSV 여분? 앞쪽 W건 중 ef[e] 와 맞는 게 있으면 csv 쪽을 skip
        m = next((j for j in range(1, W) if c + j < len(data) and match(ef[e], data[c + j])), None)
        if k is not None and (m is None or k <= m):
            for _ in range(k):
                dropped.append(ef[e]["invoice_idx"]); e += 1
        elif m is not None:
            c += m
        else:
            aligned.append((ef[e], data[c])); softdiff += 1; e += 1; c += 1  # 품목표기 차이 — 매칭 유지
    n = len(aligned)
    exact = n - softdiff
    print(f"정렬: 매칭 {n} (정확품목 {exact}, 표기차이 {softdiff}), easyform 여분제거 {len(dropped)}개 {dropped}")
    print(f"  남은 easyform {len(ef)-e}, 남은 CSV {len(data)-c} (트레일링)")
    print(f"  정확품목 일치율 {exact/n*100:.1f}%")

    # 보강
    invs = []
    for k, (inv, row) in enumerate(aligned):
        inv = dict(inv)
        inv["invoice_idx"] = k
        inv["csv_item_match"] = norm(first_item(inv)) == norm(row["품목"])
        if not inv["csv_item_match"]:
            inv["csv_item"] = row["품목"]
        inv["date"] = row["발행일자"]; inv["client"] = row["거래처명"]
        inv["total"] = row["합계금액"]; inv["supply_total"] = row["공급가액"]
        inv["tax_total"] = row["세액"]; inv["issue_method"] = row["발행방법"]
        invs.append(inv)

    if not a.save:
        print("(dry-run — --save 로 저장)")
        # 샘플 표기차이
        ms = [(i["invoice_idx"], first_item(i), i.get("csv_item")) for i in invs if not i["csv_item_match"]][:10]
        for idx, ef_i, cv in ms:
            print(f"   diff {idx:4} | {ef_i[:24]!r:26} | {cv[:24]!r}")
        return 0
    if exact / n < 0.9:
        print(f"⚠ 정확일치율 {exact/n*100:.1f}% < 90% — 저장 중단"); return 1
    out = {"invoices": invs, "extracted_at": d.get("extracted_at"),
           "enriched_from_csv": Path(a.csv).name}
    dst = Path(a.out) if a.out else Path(a.json)
    dst.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"저장: {dst.name} — {len(invs)}건 보강 완료 (raw {Path(a.json).name} 는 보존)")
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
