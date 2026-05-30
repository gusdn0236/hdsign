"""easyform price JSON → 명세서별 HTML (검토용).

enriched(date/client/total/supply_total) 있으면 헤더+CSV 합계 대조 표시,
없으면 자재 테이블만. 빈 명세서·자재합≠CSV공급가액은 경고 표시.

사용:
    py -3 make_html.py --json <easyform_YYYY_price.json> --out <out.html> --title "2024 주식회사"
"""
import argparse
import html
import json
import sys
from pathlib import Path


def num(s) -> int:
    try:
        return int(str(s).replace(",", "").replace(" ", "").strip() or 0)
    except ValueError:
        return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--title", default="명세서")
    args = ap.parse_args()

    invs = sorted(json.loads(Path(args.json).read_text(encoding="utf-8"))["invoices"],
                  key=lambda x: x["invoice_idx"])

    empties = sum(1 for i in invs if i["grid_row_count"] == 0)
    ebills = sum(1 for i in invs if i.get("grid_stop_reason") == "EBILL")

    cards = []
    for inv in invs:
        idx = inv["invoice_idx"]
        date = inv.get("date", "")
        client = inv.get("client", "")
        total = inv.get("total", "")
        rows = inv["grid"]
        ebill = inv.get("grid_stop_reason") == "EBILL"
        calc = sum(num(r.get("qty", "")) * num(r.get("unit_price", "")) for r in rows)

        trs = ""
        for r in rows:
            trs += ("<tr>"
                    f"<td>{html.escape(r.get('item_code',''))}</td>"
                    f"<td>{html.escape(r.get('item',''))}</td>"
                    f"<td>{html.escape(r.get('spec',''))}</td>"
                    f"<td class=n>{html.escape(r.get('qty',''))}</td>"
                    f"<td class=n>{html.escape(r.get('unit_price',''))}</td>"
                    "</tr>")

        badges = ""
        if ebill:
            badges += "<span class=ebill>전자</span>"
        if not rows:
            badges += "<span class=warn>빈 명세서</span>"

        cmp = ""
        if total:
            csv_supply = num(inv.get("supply_total", ""))
            ok = "✓" if csv_supply == calc else f"⚠ 차이 {csv_supply - calc:,}"
            cls = "" if csv_supply == calc else " mism"
            cmp = (f"<div class='cmp{cls}'>자재합(수량×단가)={calc:,} · "
                   f"CSV공급가액={csv_supply:,} {ok}</div>")

        hd_meta = f"<b>{html.escape(date)}</b> {html.escape(client)}" if date else "<i>(CSV 미매칭 — 월일/거래처 없음)</i>"
        tot = f"<span class=tot>합계 {html.escape(str(total))}</span>" if total else ""
        cards.append(
            f"<div class=card><div class=hd>#{idx} {badges} {hd_meta} {tot}</div>"
            f"<table><colgroup><col class=c-code><col class=c-item><col class=c-spec>"
            f"<col class=c-qty><col class=c-price></colgroup>"
            f"<tr><th>품목코드</th><th>품목</th><th>규격</th><th>수량</th><th>단가</th></tr>"
            f"{trs}</table>{cmp}</div>"
        )

    doc = (
        "<!doctype html><meta charset=utf-8>"
        f"<title>{html.escape(args.title)}</title>"
        "<style>"
        "body{font-family:'맑은 고딕',sans-serif;margin:16px;background:#f4f5f7;color:#222}"
        ".sum{background:#fff;border:1px solid #ddd;border-radius:6px;padding:10px;margin-bottom:12px;position:sticky;top:0}"
        ".card{background:#fff;border:1px solid #ddd;border-radius:6px;margin:8px 0;padding:10px}"
        ".hd{font-size:14px;margin-bottom:6px}.tot{float:right;color:#06c;font-weight:bold}"
        "table{table-layout:fixed;border-collapse:collapse;width:100%;font-size:13px}"
        "th,td{border:1px solid #eee;padding:3px 7px;text-align:left;"
        "word-break:break-all;vertical-align:top}"
        "th{background:#fafafa}.n{text-align:right}"
        ".c-code{width:130px}.c-spec{width:120px}.c-qty{width:52px}.c-price{width:92px}"
        ".ebill{background:#fc6;padding:1px 6px;border-radius:3px;font-size:11px;margin-right:4px}"
        ".warn{background:#e44;color:#fff;padding:1px 6px;border-radius:3px;font-size:11px;margin-right:4px}"
        ".cmp{font-size:12px;color:#999;margin-top:4px}.cmp.mism{color:#c30;font-weight:bold}"
        "</style>"
        f"<div class=sum><h2 style=margin:4px>{html.escape(args.title)} — {len(invs)}건</h2>"
        f"빈 명세서 {empties} · 전자명세서 {ebills}</div>"
        + "".join(cards)
    )
    Path(args.out).write_text(doc, encoding="utf-8")
    print(f"생성: {args.out} ({len(invs)}건, 빈 {empties}, 전자 {ebills})")
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore
    sys.exit(main())
