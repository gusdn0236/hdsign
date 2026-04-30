"""남은 거래처 (picks 안 된 것) 중 xls 매칭 행수별 분류."""
import json
import re
import sys
from pathlib import Path

import xlrd

sys.path.insert(0, r"C:\Users\USER\Desktop\hdsign")
from tmp_filter_xls import keys_for, keys_overlap
from tmp_pick_by_phone import parse_picks, digits

XLS = Path(r"C:\Users\USER\Documents\카카오톡 받은 파일\거래처정보_20260430181444.xls")
CLIENTS_JSON = Path(r"C:\Users\USER\Desktop\hdsign\tmp_clients.json")
PICKS = Path(r"C:\Users\USER\Desktop\hdsign\tmp_picks.txt")

book = xlrd.open_workbook(str(XLS))
sh = book.sheet_by_index(0)
header = [str(sh.cell_value(0, c)).strip() for c in range(sh.ncols)]
name_col = next(i for i, h in enumerate(header) if "상호" in h)
tel_col = next(i for i, h in enumerate(header) if "전화1" in h)
hp_col = next(i for i, h in enumerate(header) if "HP1" in h)

rows = []
for r in range(1, sh.nrows):
    rows.append(tuple(sh.cell_value(r, c) for c in range(sh.ncols)))

clients = json.loads(CLIENTS_JSON.read_text(encoding="utf-8"))

# 거래처별 매칭 xls 행
client_rows = {}
client_keys_map = {}
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
    client_keys_map[c["id"]] = keys
    matched = []
    for row in rows:
        xname = str(row[name_col]).strip()
        if not xname:
            continue
        if keys_overlap(keys, keys_for(xname)):
            matched.append(row)
    client_rows[c["id"]] = matched

# picks/excludes 처리
picks, excludes = parse_picks(PICKS)
picked_names = {p[0] for p in picks}

# picked client ids
cn_to_clients = {}
for c in clients:
    for n in (c.get("companyName"), c.get("networkFolderName")):
        if n:
            cn_to_clients.setdefault(n.strip(), []).append(c)

picked_ids = set()
for name, _ in picks:
    if name in cn_to_clients:
        for c in cn_to_clients[name]:
            picked_ids.add(c["id"])
    else:
        tk = keys_for(name)
        for c in clients:
            if keys_overlap(client_keys_map[c["id"]], tk):
                picked_ids.add(c["id"])

excluded_ids = set()
for ex in excludes:
    if ex in cn_to_clients:
        for c in cn_to_clients[ex]:
            excluded_ids.add(c["id"])
    else:
        ek = keys_for(ex)
        for c in clients:
            if keys_overlap(client_keys_map[c["id"]], ek):
                excluded_ids.add(c["id"])

# 남은 거래처
remaining = [c for c in clients if c["id"] not in picked_ids and c["id"] not in excluded_ids]
remaining.sort(key=lambda x: (x.get("companyName") or "").strip())

# 매칭 행수별 분류
buckets = {0: [], 1: [], 2: [], 3: [], "many": []}
for c in remaining:
    n = len(client_rows.get(c["id"], []))
    if n == 0:
        buckets[0].append(c)
    elif n == 1:
        buckets[1].append(c)
    elif n == 2:
        buckets[2].append(c)
    elif n == 3:
        buckets[3].append(c)
    else:
        buckets["many"].append(c)

print(f"남은 거래처: {len(remaining)}개\n")
print(f"  매칭 0행 (xls 누락): {len(buckets[0])}개")
print(f"  매칭 1행 (1:1, 전화 없이 자동선택 가능): {len(buckets[1])}개")
print(f"  매칭 2행: {len(buckets[2])}개")
print(f"  매칭 3행: {len(buckets[3])}개")
print(f"  매칭 4행 이상: {len(buckets['many'])}개")

print("\n[매칭 0행 — xls 에 없음]")
for c in buckets[0]:
    print(f"  - {c.get('companyName')}")

print(f"\n[매칭 1행 — 1:1] {len(buckets[1])}개")
for c in buckets[1]:
    cn = c.get("companyName") or ""
    row = client_rows[c["id"]][0]
    xname = str(row[name_col]).strip()
    tel = digits(str(row[tel_col]))
    hp = digits(str(row[hp_col]))
    print(f"  - {cn}  ↔  xls:{xname}  (tel={tel} hp={hp})")

print(f"\n[매칭 2행]")
for c in buckets[2]:
    cn = c.get("companyName") or ""
    rs = client_rows[c["id"]]
    names = [str(r[name_col]).strip() for r in rs]
    print(f"  - {cn}  ↔  {names}")

print(f"\n[매칭 3행]")
for c in buckets[3]:
    cn = c.get("companyName") or ""
    rs = client_rows[c["id"]]
    names = [str(r[name_col]).strip() for r in rs]
    print(f"  - {cn}  ↔  {names}")

print(f"\n[매칭 4행 이상]")
for c in buckets["many"]:
    cn = c.get("companyName") or ""
    rs = client_rows[c["id"]]
    names = [str(r[name_col]).strip() for r in rs]
    print(f"  - {cn}  ({len(rs)}행) ↔  {names[:6]}")
