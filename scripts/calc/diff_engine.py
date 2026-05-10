"""
prices_baseline.json + prices_excel.json → diff_report.json

Walks every priced cell in both files, classifies each as:
  - unchanged              both equal
  - changed                both have values, different (with suspicion flag)
  - missing_in_excel       baseline has, excel doesn't
  - missing_in_baseline    excel has, baseline doesn't (new cell)

For 'changed' cells, attaches a suspicion flag:
  - digit_missing          excel × 10 ≈ baseline   (likely 0 dropped — strong typo signal)
  - extra_digit            baseline × 10 ≈ excel
  - monotonicity_break     excel value breaks an ascending size/band trend that baseline has
  - clean_change           plausible legitimate price update

Usage:
    py scripts/calc/diff_engine.py

Reads:  frontend/src/data/calc/prices_baseline.json
        frontend/src/data/calc/prices_excel.json
Writes: frontend/src/data/calc/diff_report.json
"""
import json
import re
import sys
import io
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

ROOT = Path(__file__).resolve().parents[2]
BASELINE_PATH = ROOT / "frontend" / "src" / "data" / "calc" / "prices_baseline.json"
EXCEL_PATH    = ROOT / "frontend" / "src" / "data" / "calc" / "prices_excel.json"
OUT           = ROOT / "frontend" / "src" / "data" / "calc" / "diff_report.json"


# ---------------------------------------------------------------------------
# Flatten priced cells per calculator
# ---------------------------------------------------------------------------
def collect_channel(calc):
    out = {}
    for t in calc.get("types", []):
        tk = t["key"]
        if t.get("needsLang"):
            for lang in ("eng", "kor"):
                for size, price in t.get("pricesByLang", {}).get(lang, {}).items():
                    out[f"channel.{tk}.{lang}.{size}"] = price
        else:
            for size, price in t.get("prices", {}).items():
                out[f"channel.{tk}.{size}"] = price
    return out


def collect_gomu(calc):
    out = {}
    for tk, bands in calc.get("prices", {}).items():
        for band, price in bands.items():
            out[f"gomu.{tk}.{band}"] = price
    return out


def collect_acryl(calc):
    out = {}
    for tk, by_tt in calc.get("prices", {}).items():
        for tt, bands in by_tt.items():
            for band, price in bands.items():
                out[f"acryl.{tk}.{tt}.{band}"] = price
    return out


def collect_epoxy(calc):
    out = {}
    for mat, by_tt in calc.get("prices", {}).items():
        for tt, by_size in by_tt.items():
            for size, by_stroke in by_size.items():
                for stroke, price in by_stroke.items():
                    out[f"epoxy.{mat}.{tt}.{size}.{stroke}"] = price
    return out


def collect_gold_silver(calc):
    out = {}
    for mat, by_tk in calc.get("prices", {}).items():
        for tk, by_tt in by_tk.items():
            for tt, by_band in by_tt.items():
                for band, price in by_band.items():
                    out[f"goldSilver.{mat}.{tk}.{tt}.{band}"] = price
    return out


COLLECTORS = {
    "channel":    collect_channel,
    "gomu":       collect_gomu,
    "acryl":      collect_acryl,
    "epoxy":      collect_epoxy,
    "goldSilver": collect_gold_silver,
    # 'led' and 'frame' are not in the xlsx — skip them entirely.
}


# ---------------------------------------------------------------------------
# Suspicion classifier
# ---------------------------------------------------------------------------
def classify_change(baseline_v: int, excel_v: int) -> tuple[str, str]:
    """Return (suspicion, human-readable message)."""
    if baseline_v == excel_v * 10:
        return ("digit_missing", f"엑셀이 baseline의 1/10 ({excel_v} vs {baseline_v}). 0 누락 가능성 매우 높음.")
    if baseline_v == excel_v * 100:
        return ("digit_missing", f"엑셀이 baseline의 1/100. 0 두 개 누락 가능성.")
    if excel_v == baseline_v * 10:
        return ("extra_digit", f"엑셀이 baseline의 10배 ({excel_v} vs {baseline_v}). 0 추가 가능성.")
    if excel_v == baseline_v * 100:
        return ("extra_digit", f"엑셀이 baseline의 100배. 0 두 개 추가 가능성.")
    # ratio check for non-exact 10x typos
    ratio = excel_v / baseline_v if baseline_v else 0
    if ratio < 0.2:
        return ("digit_missing", f"엑셀이 baseline의 {ratio:.0%}. 자릿수 누락 의심.")
    if ratio > 5:
        return ("extra_digit", f"엑셀이 baseline의 {ratio:.1f}배. 과도한 증가.")
    # normal price change
    delta_pct = (excel_v - baseline_v) / baseline_v * 100 if baseline_v else 0
    return ("clean_change", f"{delta_pct:+.1f}% 변동")


# ---------------------------------------------------------------------------
# Monotonicity check
# Every calculator has at least one ordered axis (size for channel/epoxy,
# height-band for acryl/gomu). When walking that axis with all other dims
# fixed, baseline values typically increase. If a baseline-respecting sequence
# becomes non-monotonic in the excel data, flag it.
# ---------------------------------------------------------------------------
def _band_sort_key(band: str) -> int:
    """Sort '~149' / '150~199' / '~30' / '31~40' etc. by their lower bound."""
    band = band.replace("mm", "")
    if band.startswith("~"):
        return int(band.lstrip("~"))
    m = re.match(r"(\d+)", band)
    return int(m.group(1)) if m else 0


def detect_monotonicity_breaks(baseline_calc_flat: dict, excel_calc_flat: dict, calc_key: str) -> set[str]:
    """Return set of paths that are excel monotonicity breaks (strictly less than predecessor)."""
    flagged = set()

    if calc_key == "channel":
        # Group by (type, [lang]); the variable axis is size.
        groups = {}
        for path, v in excel_calc_flat.items():
            parts = path.split(".")
            # channel.<type>.<lang?>.<size>
            if len(parts) == 4:  # has lang
                key = (parts[1], parts[2])
                size = int(parts[3])
            else:
                key = (parts[1],)
                size = int(parts[2])
            groups.setdefault(key, []).append((size, path, v))
        for key, items in groups.items():
            items.sort()
            for i in range(len(items)):
                _, path, v = items[i]
                prev_v = items[i - 1][2] if i > 0 else None
                next_v = items[i + 1][2] if i < len(items) - 1 else None
                # Decrease relative to predecessor (current rule)
                if prev_v is not None and v < prev_v:
                    flagged.add(path)
                # Suspicious spike: 5x larger than BOTH neighbors → likely typo (extra 0)
                neighbors = [n for n in (prev_v, next_v) if n is not None]
                if neighbors and v > 5 * max(neighbors):
                    flagged.add(path)

    elif calc_key in ("gomu", "acryl"):
        # Group by everything except band; variable axis is band.
        groups = {}
        for path, v in excel_calc_flat.items():
            parts = path.split(".")
            band = parts[-1]
            key = ".".join(parts[:-1])
            groups.setdefault(key, []).append((_band_sort_key(band), path, v))
        for key, items in groups.items():
            items.sort()
            for i in range(len(items)):
                _, path, v = items[i]
                prev_v = items[i - 1][2] if i > 0 else None
                next_v = items[i + 1][2] if i < len(items) - 1 else None
                # Decrease relative to predecessor (current rule)
                if prev_v is not None and v < prev_v:
                    flagged.add(path)
                # Suspicious spike: 5x larger than BOTH neighbors → likely typo (extra 0)
                neighbors = [n for n in (prev_v, next_v) if n is not None]
                if neighbors and v > 5 * max(neighbors):
                    flagged.add(path)

    elif calc_key == "epoxy":
        # Two axes (size, stroke). Check size-axis monotonicity per (mat, tt, stroke).
        groups = {}
        for path, v in excel_calc_flat.items():
            # epoxy.<mat>.<tt>.<size>.<stroke>
            parts = path.split(".")
            key = (parts[1], parts[2], parts[4])  # mat, tt, stroke
            size = int(parts[3])
            groups.setdefault(key, []).append((size, path, v))
        for key, items in groups.items():
            items.sort()
            for i in range(len(items)):
                _, path, v = items[i]
                prev_v = items[i - 1][2] if i > 0 else None
                next_v = items[i + 1][2] if i < len(items) - 1 else None
                # Decrease relative to predecessor (current rule)
                if prev_v is not None and v < prev_v:
                    flagged.add(path)
                # Suspicious spike: 5x larger than BOTH neighbors → likely typo (extra 0)
                neighbors = [n for n in (prev_v, next_v) if n is not None]
                if neighbors and v > 5 * max(neighbors):
                    flagged.add(path)

    elif calc_key == "goldSilver":
        # goldSilver.<mat>.<thickness>.<textType>.<band>
        groups = {}
        for path, v in excel_calc_flat.items():
            parts = path.split(".")
            key = (parts[1], parts[2], parts[3])
            band = parts[4]
            groups.setdefault(key, []).append((_band_sort_key(band), path, v))
        for key, items in groups.items():
            items.sort()
            for i in range(len(items)):
                _, path, v = items[i]
                prev_v = items[i - 1][2] if i > 0 else None
                next_v = items[i + 1][2] if i < len(items) - 1 else None
                # Decrease relative to predecessor (current rule)
                if prev_v is not None and v < prev_v:
                    flagged.add(path)
                # Suspicious spike: 5x larger than BOTH neighbors → likely typo (extra 0)
                neighbors = [n for n in (prev_v, next_v) if n is not None]
                if neighbors and v > 5 * max(neighbors):
                    flagged.add(path)

    return flagged


# ---------------------------------------------------------------------------
# Diff
# ---------------------------------------------------------------------------
SUSPICION_SEVERITY = {
    "digit_missing":      "high",
    "extra_digit":        "high",
    "monotonicity_break": "medium",
    "clean_change":       "low",
}


def diff_calculator(calc_key: str, baseline_calc: dict, excel_calc: dict) -> dict:
    if calc_key not in COLLECTORS:
        return None
    collector = COLLECTORS[calc_key]
    base_flat = collector(baseline_calc) if baseline_calc else {}
    xlsx_flat = collector(excel_calc) if excel_calc else {}

    monotonic_breaks = detect_monotonicity_breaks(base_flat, xlsx_flat, calc_key)

    paths = sorted(set(base_flat.keys()) | set(xlsx_flat.keys()))
    diffs = []
    counts = {"unchanged": 0, "changed": 0, "missing_in_excel": 0, "missing_in_baseline": 0}
    suspicion_counts = {"digit_missing": 0, "extra_digit": 0, "monotonicity_break": 0, "clean_change": 0}

    for path in paths:
        b = base_flat.get(path)
        x = xlsx_flat.get(path)
        if b is None and x is None:
            continue
        if b is None:
            # Excel-only cell. Promote to monotonicity_break severity if applicable.
            is_break = path in monotonic_breaks
            diffs.append({
                "path": path,
                "calculator": calc_key,
                "baselineValue": None,
                "excelValue": x,
                "status": "missing_in_baseline",
                "suspicion": "monotonicity_break" if is_break else None,
                "severity": "medium" if is_break else "info",
                "message": (
                    "이전 사이즈/밴드보다 가격이 작아짐 — 단조성 위배. 엑셀에만 존재."
                    if is_break else "엑셀에만 존재. baseline에 신규 추가 가능."
                ),
                "needsReview": True,
            })
            counts["missing_in_baseline"] += 1
            if is_break:
                suspicion_counts["monotonicity_break"] += 1
        elif x is None:
            diffs.append({
                "path": path,
                "calculator": calc_key,
                "baselineValue": b,
                "excelValue": None,
                "status": "missing_in_excel",
                "suspicion": None,
                "severity": "info",
                "message": "baseline에 있지만 엑셀 셀이 비어있음. baseline 값 유지 추천.",
                "needsReview": False,  # safe to keep baseline
            })
            counts["missing_in_excel"] += 1
        elif b == x:
            counts["unchanged"] += 1
            # don't list unchanged in diffs[] to keep payload small
        else:
            suspicion, msg = classify_change(b, x)
            # promote to monotonicity_break if applicable AND not a digit-mismatch already
            if path in monotonic_breaks and suspicion == "clean_change":
                suspicion = "monotonicity_break"
                msg = "이전 사이즈/밴드보다 가격이 작아짐 — 단조성 위배. " + msg
            severity = SUSPICION_SEVERITY[suspicion]
            diffs.append({
                "path": path,
                "calculator": calc_key,
                "baselineValue": b,
                "excelValue": x,
                "status": "changed",
                "suspicion": suspicion,
                "severity": severity,
                "message": msg,
                # Every changed cell needs a decision — user said xlsx contains
                # many wrong values. Severity field lets the UI prioritize.
                "needsReview": True,
            })
            counts["changed"] += 1
            suspicion_counts[suspicion] += 1

    return {
        "summary": {
            "totalBaselineCells": len(base_flat),
            "totalExcelCells": len(xlsx_flat),
            **counts,
            "suspicionBreakdown": suspicion_counts,
        },
        "diffs": diffs,
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    baseline = json.loads(BASELINE_PATH.read_text(encoding="utf-8"))
    excel    = json.loads(EXCEL_PATH.read_text(encoding="utf-8"))

    bcalc = baseline["calculators"]
    ecalc = excel["calculators"]

    report = {
        "_meta": {
            "baselineFrom": baseline["_meta"].get("extractedFrom"),
            "excelFrom":    excel["_meta"].get("extractedFrom"),
            "engine": "scripts/calc/diff_engine.py",
            "doc": (
                "셀 단위 diff 결과. needsReview=true 인 항목만 사용자가 결정 필요. "
                "missing_in_excel 은 기본적으로 baseline 유지(안전). "
                "digit_missing 은 0 누락으로 의심되는 오타. monotonicity_break 는 사이즈가 커지는데 가격이 작아지는 케이스."
            ),
        },
        "calculators": {},
    }

    overall_high = []
    overall_medium = []

    for calc_key in ("channel", "gomu", "acryl", "epoxy", "goldSilver"):
        result = diff_calculator(calc_key, bcalc.get(calc_key), ecalc.get(calc_key))
        if result is None:
            continue
        report["calculators"][calc_key] = result
        for d in result["diffs"]:
            if d["severity"] == "high":
                overall_high.append(d)
            elif d["severity"] == "medium":
                overall_medium.append(d)

    OUT.write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    # Console summary
    print(f"OK → {OUT.relative_to(ROOT)}")
    print()
    for calc_key, res in report["calculators"].items():
        s = res["summary"]
        print(f"[{calc_key}]")
        print(f"  baseline cells: {s['totalBaselineCells']}    excel cells: {s['totalExcelCells']}")
        print(f"  unchanged: {s['unchanged']}  changed: {s['changed']}  "
              f"missing_in_excel: {s['missing_in_excel']}  missing_in_baseline: {s['missing_in_baseline']}")
        sb = s["suspicionBreakdown"]
        if sb["digit_missing"] or sb["extra_digit"] or sb["monotonicity_break"]:
            print(f"  ⚠ suspicions: digit_missing={sb['digit_missing']}  "
                  f"extra_digit={sb['extra_digit']}  monotonicity_break={sb['monotonicity_break']}  "
                  f"clean_change={sb['clean_change']}")
        else:
            print(f"  clean_change: {sb['clean_change']}")
        print()

    if overall_high:
        print("━━━ HIGH severity (자릿수 오타 의심) ━━━")
        for d in overall_high[:20]:
            print(f"  {d['path']:50}  baseline={d['baselineValue']:>10}  excel={d['excelValue']:>10}  →  {d['message']}")
        if len(overall_high) > 20:
            print(f"  ... 외 {len(overall_high) - 20}건")
        print()

    if overall_medium:
        print("━━━ MEDIUM severity (단조성 위배) ━━━")
        for d in overall_medium[:20]:
            b = "(없음)" if d["baselineValue"] is None else f"{d['baselineValue']:>10}"
            x = "(없음)" if d["excelValue"]    is None else f"{d['excelValue']:>10}"
            print(f"  {d['path']:55}  baseline={b}  excel={x}")
        if len(overall_medium) > 20:
            print(f"  ... 외 {len(overall_medium) - 20}건")


if __name__ == "__main__":
    main()
