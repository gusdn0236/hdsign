# -*- coding: utf-8 -*-
"""raw fast 추출 파일의 건수(N) 만 출력 — 명세서 업데이트 런처에서 seek/start 값으로 씀.
사용: py -3 easyform_n.py <corp|personal> [year=2026]
"""
import sys, json, io
kind = sys.argv[1] if len(sys.argv) > 1 else "corp"
year = sys.argv[2] if len(sys.argv) > 2 else "2026"
p = r"C:\Users\USER\Desktop\hdsign\easyform-data\easyform_%s_%s_fast.json" % (year, kind)
try:
    d = json.load(io.open(p, encoding="utf-8"))
    inv = d.get("invoices", d if isinstance(d, list) else [])
    print(len(inv))
except Exception:
    print(0)
