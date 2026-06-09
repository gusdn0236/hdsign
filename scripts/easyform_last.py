# -*- coding: utf-8 -*-
"""마지막 추출된 명세서 몇 건(날짜/거래처/품목)을 보여줘 — 추출 시작 경계를 사람이 눈으로 찾게.
사용: py -3 easyform_last.py <corp|personal> [n=5] [year=2026]
"""
import sys, json, io, os
kind = sys.argv[1] if len(sys.argv) > 1 else "corp"
n = int(sys.argv[2]) if len(sys.argv) > 2 else 5
year = sys.argv[3] if len(sys.argv) > 3 else "2026"
p = r"C:\Users\USER\Desktop\hdsign\auto-quote-data\invoices\easyform_%s_%s.json" % (year, kind)
try:
    inv = json.load(io.open(p, encoding="utf-8")).get("invoices", [])
except Exception as e:
    print("읽기 실패:", e); sys.exit(0)
print("------ 마지막 추출 %d건 (이지폼 목록에서 이걸 찾아, 그 '다음' 명세서를 여세요) ------" % min(n, len(inv)))
for v in inv[-n:]:
    items = [r.get("item", "").strip() for r in v.get("grid", []) if r.get("item", "").strip()]
    print("  %s | %-16s | 품목: %s" % (v.get("date", "?"), (v.get("client") or "")[:16], ", ".join(items[:3])[:48]))
print("--------------------------------------------------------------------")
print("  ↑ 맨 아래 줄이 '마지막 추출' 명세서. 이지폼에서 이걸 찾아 그 바로 다음(아래) 행을 Enter로 여세요.")
