#!/usr/bin/env python3
"""
Derive the auto-quote static priors artifact from the confidential corpus.

Reads  src/main/resources/autoquote/corpus.json  (the JWT-served corpus, `lines[]`)
Writes src/main/resources/autoquote/priors.json   (the JWT-served learned priors)

Output shape matches the frontend engine `Priors` contract
(frontend/src/pages/admin/autoquote/engine/types.ts):

    {
      "bridges":      [...],   # cross-item co-occurrence (slice 1: none mined yet)
      "reorderPairs": [...],   # frequent reorder pairs   (slice 1: none mined yet)
      "sizeBuckets":  { "<category>": [{ "maxHeight": mm, "unitPrice": won }, ...] },
      "synthDigest":  { ...corpus summary stats... }
    }

Deterministic: no timestamps, sorted keys, LF newlines, UTF-8. Re-running on the
same corpus is byte-identical (so the served ETag is stable). Build-time only;
read-only against the corpus — never edits hdsign data.
"""
import json
import os
import statistics

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, "..", "src", "main", "resources", "autoquote")
CORPUS = os.path.join(RES, "corpus.json")
PRIORS = os.path.join(RES, "priors.json")

# Height bin width (mm). Lines are grouped into [0,STEP), [STEP,2*STEP), ... and
# the bin's representative price is the median unit price of its members. This
# yields a monotone-ish size->price curve per category without overfitting.
STEP = 100
# A category needs at least this many sized lines to get a bucket curve at all,
# and a bin needs at least this many members to be emitted (noise floor).
MIN_CATEGORY_SUPPORT = 8
MIN_BIN_SUPPORT = 3


def is_discount(line):
    cat = (line.get("category") or "")
    return "할인" in cat or "DC" in cat.upper() or (line.get("unitPrice", 0) or 0) < 0


def main():
    with open(CORPUS, "r", encoding="utf-8") as f:
        corpus = json.load(f)
    lines = corpus.get("lines", [])

    # --- sizeBuckets: category -> [{maxHeight, unitPrice}] ---
    by_cat = {}
    for ln in lines:
        if is_discount(ln):
            continue
        h = ln.get("height")
        p = ln.get("unitPrice")
        cat = ln.get("category")
        if not cat or h is None or p is None or h <= 0 or p <= 0:
            continue
        by_cat.setdefault(cat, []).append((float(h), float(p)))

    size_buckets = {}
    for cat in sorted(by_cat):
        pts = by_cat[cat]
        if len(pts) < MIN_CATEGORY_SUPPORT:
            continue
        bins = {}
        for h, p in pts:
            top = int(((int(h) // STEP) + 1) * STEP)
            bins.setdefault(top, []).append(p)
        curve = []
        for top in sorted(bins):
            prices = bins[top]
            if len(prices) < MIN_BIN_SUPPORT:
                continue
            curve.append({
                "maxHeight": top,
                "unitPrice": int(round(statistics.median(prices))),
            })
        if curve:
            size_buckets[cat] = curve

    # --- synthDigest: corpus summary used by the UI / future tiers ---
    cat_counts = {}
    cat_prices = {}
    for ln in lines:
        cat = ln.get("category") or "기타"
        cat_counts[cat] = cat_counts.get(cat, 0) + 1
        p = ln.get("unitPrice")
        if p is not None and not is_discount(ln) and p > 0:
            cat_prices.setdefault(cat, []).append(float(p))

    category_digest = {}
    for cat in sorted(cat_counts):
        entry = {"lineCount": cat_counts[cat]}
        prices = cat_prices.get(cat)
        if prices:
            entry["medianUnitPrice"] = int(round(statistics.median(prices)))
            entry["minUnitPrice"] = int(min(prices))
            entry["maxUnitPrice"] = int(max(prices))
        category_digest[cat] = entry

    meta = corpus.get("_meta", {}) or {}
    all_prices = [p for ps in cat_prices.values() for p in ps]
    synth_digest = {
        "invoiceCount": meta.get("invoiceCount"),
        "lineCount": len(lines),
        "discountLineCount": meta.get("discountLineCount"),
        "pricedLineCount": len(all_prices),
        "overallMedianUnitPrice": int(round(statistics.median(all_prices))) if all_prices else None,
        "categoryCount": len(category_digest),
        "categories": category_digest,
        "source": "derived from corpus.json _meta + lines (build_autoquote_priors.py)",
    }

    priors = {
        # Cross-item co-occurrence / reorder mining are deferred (slice 1 has no
        # ordered basket data). Served as empty arrays so the endpoint always
        # returns the full documented shape and the engine can read them safely.
        "bridges": [],
        "reorderPairs": [],
        "sizeBuckets": size_buckets,
        "synthDigest": synth_digest,
        "_meta": {
            "generatedBy": "scripts/build_autoquote_priors.py",
            "derivedFrom": "autoquote/corpus.json",
            "note": "Build-time ingest. Deterministic. Re-run after corpus changes.",
        },
    }

    text = json.dumps(priors, ensure_ascii=False, indent=2, sort_keys=False)
    with open(PRIORS, "w", encoding="utf-8", newline="\n") as f:
        f.write(text + "\n")

    print("wrote", os.path.normpath(PRIORS))
    print("  sizeBuckets categories:", len(size_buckets))
    print("  synthDigest categories:", len(category_digest))
    print("  bytes:", os.path.getsize(PRIORS))


if __name__ == "__main__":
    main()
