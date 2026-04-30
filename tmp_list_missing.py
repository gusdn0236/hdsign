import json
import re
import sys
sys.path.insert(0, r"C:\Users\USER\Desktop\hdsign")
from tmp_filter_xls import keys_for, keys_overlap

import xlrd

clients = json.load(open(r"C:\Users\USER\Desktop\hdsign\tmp_clients.json", encoding="utf-8"))
book = xlrd.open_workbook(r"C:\Users\USER\Documents\카카오톡 받은 파일\거래처정보_20260430181444.xls")
sh = book.sheet_by_index(0)
xls_keys = []
for r in range(1, sh.nrows):
    name = str(sh.cell_value(r, 2)).strip()
    if name:
        xls_keys.append((name, keys_for(name)))

matched = set()
for c in clients:
    names = []
    for f in ("companyName", "networkFolderName"):
        v = (c.get(f) or "").strip()
        if v:
            names.append(v)
    ali = (c.get("aliases") or "").strip()
    if ali:
        for tok in re.split(r"[,\s/|]+", ali):
            tok = tok.strip()
            if tok:
                names.append(tok)
    keys = set()
    for n in names:
        keys |= keys_for(n)
    for _, xks in xls_keys:
        if keys_overlap(keys, xks):
            matched.add(c["id"])
            break

unmatched = [c for c in clients if c["id"] not in matched]
unmatched.sort(key=lambda x: (x.get("companyName") or "").strip())
print(f"누락 {len(unmatched)}개:")
for c in unmatched:
    cn = c.get("companyName") or ""
    nf = c.get("networkFolderName") or ""
    al = c.get("aliases") or ""
    print(f"  - {cn}  | folder={nf}  | aliases={al}")
