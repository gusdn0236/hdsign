#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
사진↔명세서 매칭 '판정 배치' 생성기 (Claude 가 세션에서 사진을 읽어 판정 → API 과금 0).

모드:
  recheck : 이미 매칭된 invoice(groups.json) — 사진이 명세서와 정말 맞는지 재점검
  new     : 미매칭(사진기간) 중 후보 사진이 있는 invoice — 새로 매칭 시도

출력(JSON): 각 항목 = {file, idx, client, date, items[], photos[{path, name}]}
  items   = priced_index 의 그 invoice 품목 라인(품목/규격/단가) — 사진과 대조용
  photos  = recheck=현재 매칭 사진 1장 / new=후보 사진들(work-order-photos-sorted 절대경로)

사용:
  python scripts/make_match_batch.py --mode recheck --n 6 --offset 0 --out batch.json
  python scripts/make_match_batch.py --mode new --n 6 --out batch_new.json
"""
import argparse
import collections
import json
import os

DATA = r"C:\Users\USER\Desktop\hdsign\auto-quote-data"
LEARN = os.path.join(DATA, "learning")
PHOTOS = os.path.join(DATA, "work-order-photos-sorted")


def load():
    pi = json.load(open(os.path.join(LEARN, "priced_index.json"), encoding="utf-8"))
    items = collections.defaultdict(list)  # (file, idx) -> [ {item, code, spec, qty, up} ]
    meta = {}
    for _cl, rows in pi["by_client"].items():
        for r in rows:
            if not r.get("file") or r.get("idx") is None:
                continue
            k = (r["file"], str(r["idx"]))
            items[k].append({
                "item": r.get("item"), "code": r.get("code"),
                "spec": r.get("spec"), "qty": r.get("qty"), "up": r.get("up"),
            })
            meta.setdefault(k, {"client": _cl, "date": r.get("date", "")})
    groups = json.load(open(os.path.join(LEARN, "groups.json"), encoding="utf-8"))
    g_top = {}   # (file, idx) -> best photo filename
    for e in groups:
        ph = e.get("photos") or []
        if ph:
            g_top[(e.get("invoice_file"), str(e.get("invoice_idx")))] = ph[0]["filename"]
    cand = json.load(open(os.path.join(LEARN, "candidates.json"), encoding="utf-8"))
    inv2photos = collections.defaultdict(list)  # (file, idx) -> [photo filenames]
    for e in cand:
        for c in (e.get("candidates") or []):
            inv2photos[(c.get("file"), str(c.get("invoice_idx")))].append(e["filename"])
    return items, meta, g_top, inv2photos


def inphoto(d):
    d = (d or "").replace(".", "-")
    return d[:7] >= "2023-09"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["recheck", "new", "rematch"], required=True)
    ap.add_argument("--n", type=int, default=6)
    ap.add_argument("--offset", type=int, default=0)
    ap.add_argument("--out", default="batch.json")
    ap.add_argument("--stdout", action="store_true", help="배치 전체 JSON 을 stdout 으로(파일 안 씀)")
    args = ap.parse_args()

    items, meta, g_top, inv2photos = load()

    gset = set(g_top.keys())
    if args.mode == "recheck":
        keys = sorted(g_top.keys())
    elif args.mode == "new":
        keys = sorted(k for k in items
                      if k not in gset and inphoto(meta.get(k, {}).get("date")) and k in inv2photos)
    else:  # rematch — 재점검에서 틀린/애매했던 것 + 미매칭(사진기간·후보있음). 후보 사진들 중 맞는 걸 재탐색.
        bad = set()
        vp = os.path.join(LEARN, "match_verdicts.json")
        if os.path.exists(vp):
            data = json.load(open(vp, encoding="utf-8"))
            for v in (data["verdicts"] if isinstance(data, dict) else data):
                if v.get("verdict") in ("mismatch", "uncertain"):
                    bad.add((v.get("file"), str(v.get("idx"))))
        unmatched = set(k for k in items
                        if k not in gset and inphoto(meta.get(k, {}).get("date")))
        keys = sorted((bad | unmatched) & set(inv2photos.keys()))

    keys = keys[args.offset: args.offset + args.n]
    batch = []
    for k in keys:
        fl, idx = k
        if args.mode == "recheck":
            names = [g_top[k]]
        else:
            names = list(dict.fromkeys(inv2photos[k]))[:6]  # 후보 최대 6, 중복 제거
        photos = []
        for nm in names:
            p = os.path.join(PHOTOS, nm)
            photos.append({"name": nm, "path": p, "exists": os.path.exists(p)})
        batch.append({
            "file": fl, "idx": idx,
            "client": meta.get(k, {}).get("client", ""),
            "date": meta.get(k, {}).get("date", ""),
            "items": items[k],
            "photos": photos,
        })

    if args.stdout:
        print(json.dumps(batch, ensure_ascii=False))
        return

    out = os.path.join(os.path.dirname(__file__), args.out) if not os.path.isabs(args.out) else args.out
    json.dump(batch, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("배치 %d건 → %s (mode=%s, offset=%d)" % (len(batch), out, args.mode, args.offset))
    for b in batch:
        its = " / ".join((it.get("item") or "") + (("(" + it["spec"] + ")") if it.get("spec") else "")
                         for it in b["items"][:4])
        print("\n[%s #%s] %s · %s" % (b["file"].replace("easyform_", "").replace(".json", ""),
                                      b["idx"], b["client"], b["date"]))
        print("  품목:", its[:160])
        for ph in b["photos"]:
            print("  사진:", ph["path"], "" if ph["exists"] else "(없음)")


if __name__ == "__main__":
    main()
