"""
HDCalc.js → prices_baseline.json

Extracts every hardcoded price/quantity from the legacy ChannelCalc source so we
have a frozen, code-as-truth reference. Excel imports are diff'd against this
file, never trusted blindly.

Usage:
    py scripts/calc/extract_baseline.py

Reads:  legacy/channelcalc/HDCalc.js
Writes: frontend/src/data/calc/prices_baseline.json
"""
import json
import re
import sys
import io
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "legacy" / "channelcalc" / "HDCalc.js"
OUT = ROOT / "frontend" / "src" / "data" / "calc" / "prices_baseline.json"

text = SRC.read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def parse_array_of_numbers(s: str) -> list:
    """Parse a JS array literal of numbers into a Python list. Tolerates trailing commas/whitespace/comments."""
    s = s.strip()
    if not s.startswith("["):
        raise ValueError(f"expected array, got: {s[:40]!r}")
    # Strip JS line comments: // ...
    cleaned = re.sub(r"//[^\n]*", "", s)
    # Strip trailing comma before closing bracket: [1,2,3,] -> [1,2,3]
    cleaned = re.sub(r",(\s*[\]\}])", r"\1", cleaned)
    return json.loads(cleaned)


def find_matching_bracket(s: str, open_idx: int) -> int:
    """Given index of '[', return index of the matching ']' (skipping nested brackets and JS comments)."""
    assert s[open_idx] == "["
    depth = 0
    i = open_idx
    in_line_comment = False
    while i < len(s):
        c = s[i]
        if in_line_comment:
            if c == "\n":
                in_line_comment = False
            i += 1
            continue
        if c == "/" and i + 1 < len(s) and s[i + 1] == "/":
            in_line_comment = True
            i += 2
            continue
        if c == "[":
            depth += 1
        elif c == "]":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    raise RuntimeError("unmatched [")


def extract_array_after(label_pat: str, src: str = None) -> str:
    """Find `<label_pat> = [...]` in src/text, return the array slice including outer brackets."""
    if src is None:
        src = text
    m = re.search(label_pat, src)
    if not m:
        raise RuntimeError(f"pattern not found: {label_pat}")
    open_idx = src.index("[", m.end())
    close_idx = find_matching_bracket(src, open_idx)
    return src[open_idx : close_idx + 1]


def channel_size_for_index(i: int) -> int:
    """Map index → physical size (mm) per HDCalc.js calculate() logic."""
    if i <= 16:
        return 200 + i * 50
    return 1000 + (i - 16) * 100


def array_to_size_map(arr: list) -> dict:
    """Convert positional price array → {sizeMM: price}. Skips falsy/missing slots."""
    out = {}
    for i, v in enumerate(arr):
        if v is None or v == 0:
            continue
        out[str(channel_size_for_index(i))] = v
    return out


# ---------------------------------------------------------------------------
# 1. Channel (calculate function, switch cases 1-10)
# ---------------------------------------------------------------------------
CHANNEL_TYPES = [
    # (case, key, label, needsLang)
    (1, "galvaBackEng",  "갈바후광영문", False),
    (2, "galvaBackKor",  "갈바후광한글", False),
    (3, "galvaOsai",     "갈바오사이",   True),
    (4, "galvaCap",      "갈바캡잔넬",   True),
    (5, "ilcheType",     "일체형잔넬",   False),
    (6, "takaType",      "타카잔넬",     True),
    (7, "stenAlumCap",   "스텐알미늄캡", False),
    (8, "stenOsai",      "스텐오사이",   True),
    (9, "stenBack",      "스텐후광",     True),
    (10, "goldSten",     "골드스텐",     True),
]


def extract_channel():
    """For each switch case, capture priceTable = [...] (and kor/eng branches if needsLang)."""
    types = []
    for case, key, label, needs_lang in CHANNEL_TYPES:
        # Slice text from "case N:" to "case (N+1):" or "default:"
        start_pat = re.compile(rf"case\s+{case}\s*:", re.MULTILINE)
        m = start_pat.search(text)
        if not m:
            raise RuntimeError(f"case {case} not found")
        next_pat = re.compile(r"case\s+\d+\s*:|default\s*:", re.MULTILINE)
        n = next_pat.search(text, m.end())
        block = text[m.end() : n.start()] if n else text[m.end() :]

        if needs_lang:
            # Two priceTable assignments inside if (selectedLang === 'kor') / else
            kor_match = re.search(
                r"selectedLang\s*===\s*'kor'\s*\)\s*\{\s*priceTable\s*=\s*(\[.*?\]);",
                block, re.DOTALL,
            )
            else_match = re.search(
                r"\}\s*else\s*\{\s*priceTable\s*=\s*(\[.*?\]);",
                block, re.DOTALL,
            )
            if not kor_match or not else_match:
                raise RuntimeError(f"case {case} kor/eng arrays not found")
            kor_arr = parse_array_of_numbers(kor_match.group(1))
            eng_arr = parse_array_of_numbers(else_match.group(1))
            types.append({
                "key": key,
                "label": label,
                "needsLang": True,
                "pricesByLang": {
                    "kor": array_to_size_map(kor_arr),
                    "eng": array_to_size_map(eng_arr),
                },
            })
        else:
            arr_match = re.search(r"priceTable\s*=\s*(\[.*?\]);", block, re.DOTALL)
            if not arr_match:
                raise RuntimeError(f"case {case} array not found")
            arr = parse_array_of_numbers(arr_match.group(1))
            types.append({
                "key": key,
                "label": label,
                "needsLang": False,
                "prices": array_to_size_map(arr),
            })
    return {
        "label": "잔넬 단가",
        "sheetName": "잔넬 26. 4.인상 적용",
        "sizeAxis": {
            "smallStep": {"from": 200, "to": 1000, "step": 50},
            "largeStep": {"from": 1100, "to": 2000, "step": 100},
        },
        "types": types,
    }


# ---------------------------------------------------------------------------
# 2. LED (ledCount switch cases — array per size)
# ---------------------------------------------------------------------------
def extract_led():
    """ledNumberTable = [headLine, godik, square, circle] per size."""
    counts = {}
    for m in re.finditer(
        r"case\s+(\d+)\s*:\s*ledNumberTable\s*=\s*(\[[^\]]+\]);",
        text,
    ):
        size = int(m.group(1))
        arr = parse_array_of_numbers(m.group(2))
        counts[str(size)] = {
            "headLine": arr[0],
            "godik":    arr[1],
            "square":   arr[2],
            "circle":   arr[3],
        }
    return {
        "label": "LED 추가",
        "_note": "엑셀에 없음. 코드에서만 관리.",
        "componentPrices": {"kpl": 750, "mid2": 740},
        "rules": {
            "useMid2When": {
                "sizes": [200, 250],
                "fonts": ["headLine", "godik"],
                "_meaning": "200/250mm + 헤드라인·고딕만 미들2구(740). 그 외 모두 KPL(750).",
            }
        },
        "ledCount": counts,
    }


# ---------------------------------------------------------------------------
# 3. Frame (fixed numbers in event handlers)
# ---------------------------------------------------------------------------
def extract_frame():
    return {
        "label": "후렘",
        "_note": "엑셀에 없음. 코드에서만 관리.",
        "alminumBar": {"pricePerMeter": 45000},
        "galbaBar": {
            "byHeight": {"200": 45000, "300": 50000, "400": 60000},
            "_unit": "원/M (높이별)",
        },
        "normal": {
            "pricePerSquareMeter": 120000,
            "_formula": "(width_mm * height_mm / 1_000_000) * pricePerSquareMeter",
        },
    }


# ---------------------------------------------------------------------------
# 4. Epoxy (EPOXY_PRICE_TABLE, EPOXY_SIZE, EPOXY_STROKE constants)
# ---------------------------------------------------------------------------
def extract_epoxy():
    # EPOXY_SIZE = [100, 125, ..., 400];
    size_match = re.search(r"const\s+EPOXY_SIZE\s*=\s*(\[[^\]]+\]);", text)
    sizes = parse_array_of_numbers(size_match.group(1))

    # EPOXY_STROKE = [{value: '30', text: '30(1줄)'}, ...]
    stroke_block = re.search(
        r"const\s+EPOXY_STROKE\s*=\s*\[(.*?)\];", text, re.DOTALL
    ).group(1)
    strokes = [int(v) for v in re.findall(r"value:\s*'(\d+)'", stroke_block)]

    # EPOXY_PRICE_TABLE = { galvalume: { korean: [...], englishNumber: [...] }, stainless: {...} }
    table_match = re.search(
        r"const\s+EPOXY_PRICE_TABLE\s*=\s*(\{.*?\n\};)", text, re.DOTALL
    )
    raw = table_match.group(1).rstrip(";")
    # Quote bare keys so json.loads accepts it
    quoted = re.sub(r"(\b[a-zA-Z_][a-zA-Z0-9_]*\b)(\s*:)", r'"\1"\2', raw)
    quoted = re.sub(r",(\s*[\]\}])", r"\1", quoted)
    table = json.loads(quoted)

    # Convert to size→stroke→price maps for clarity
    structured = {}
    for material, by_text_type in table.items():
        structured[material] = {}
        for text_type, rows in by_text_type.items():
            by_size = {}
            for i, row in enumerate(rows):
                size = sizes[i]
                size_map = {}
                for j, price in enumerate(row):
                    if price is None or price == 0:
                        continue
                    size_map[str(strokes[j])] = price
                by_size[str(size)] = size_map
            structured[material][text_type] = by_size

    return {
        "label": "에폭시 잔넬",
        "sheetName": "에폭시잔넬고딕체 26. 4월 적용",
        "axes": {
            "material": [
                {"key": "galvalume", "label": "갈바"},
                {"key": "stainless", "label": "스텐"},
            ],
            "textType": [
                {"key": "korean", "label": "한글"},
                {"key": "englishNumber", "label": "영문/숫자"},
            ],
            "sizes": sizes,
            "strokes": [
                {"value": 30,  "label": "30(1줄)"},
                {"value": 50,  "label": "50(2줄)"},
                {"value": 70,  "label": "70(3줄)"},
                {"value": 90,  "label": "90(4줄)"},
                {"value": 110, "label": "110(5줄)"},
            ],
        },
        "prices": structured,
    }


# ---------------------------------------------------------------------------
# 5. Acryl (priceTable inside acrylCalc — 2D array)
# ---------------------------------------------------------------------------
def extract_acryl():
    """
    HDCalc.js logic:
      firstIndex (row): acrylH ≤ 30 → 0; else ceil((acrylH - 30) / 10)
      → row 0 = ~30mm, row 1 = 31-40mm, row 2 = 41-50mm, ..., row 87 = 901-910mm (out of range)
    secondIndex (col):
      2T:  영=0, 한=1
      3T:  영=2, 한=3
      5T:  영=4, 한=5
      8T:  영=6, 한=7
      10T: 영=8, 한=9
      15T: 영=10, 한=11
      20T: 영=12, 한=13
    Max valid row: 87 (acrylH > 900 → out of range)
    """
    # Find acrylCalc body, then the priceTable 2D array via balanced-bracket scan
    fn_match = re.search(r"function\s+acrylCalc\s*\([^)]*\)\s*\{", text)
    body_start = fn_match.end()
    arr_str = extract_array_after(r"let\s+priceTable\s*=", text[body_start:])
    rows_2d = parse_array_of_numbers(arr_str)

    # Build size-band labels per row
    def band_label(row_idx):
        if row_idx == 0:
            return "~30"
        low = 31 + (row_idx - 1) * 10
        high = low + 9
        return f"{low}~{high}"

    thicknesses = ["2T", "3T", "5T", "8T", "10T", "15T", "20T"]
    text_types = ["영문", "한글"]

    structured = {}  # by thickness → text_type → band → price
    for t_idx, thickness in enumerate(thicknesses):
        structured[thickness] = {}
        for tt_idx, tt in enumerate(text_types):
            col = t_idx * 2 + tt_idx
            band_map = {}
            for r_idx, row in enumerate(rows_2d):
                if col < len(row) and row[col] not in (None, 0):
                    band_map[band_label(r_idx)] = row[col]
            structured[thickness][tt] = band_map

    return {
        "label": "아크릴/포맥스",
        "sheetName": "아크릴.포맥스26.4인상적용",
        "axes": {
            "thickness": thicknesses,
            "textType": text_types,
            "heightBands": [band_label(i) for i in range(len(rows_2d))],
        },
        "_heightBandRule": "row 0 = ~30mm, row 1 = 31-40, row 2 = 41-50, ..., 10mm 폭. 최대 900mm.",
        "prices": structured,
    }


# ---------------------------------------------------------------------------
# 6. Gomu (priceTable inside gomuCalc — 2D array)
# ---------------------------------------------------------------------------
def extract_gomu():
    """
    HDCalc.js logic:
      gomuH ≤ 149: row 0
      150 ≤ gomuH ≤ 1000: row = ceil((gomuH - 149) / 50)   → row 1=150-199mm, row 2=200-249, ...
        wait — actually ceil((150-149)/50)=1, ceil((199-149)/50)=1, ceil((200-149)/50)=2 → row 1=150-199, row 2=200-249.
      1001 ≤ gomuH ≤ 2000: row = 17 + ceil((gomuH - 999) / 100)
        ceil((1001-999)/100)=1 → row 18 (1001-1099 mm)
        ceil((1100-999)/100)=2 → row 19 (1100-1199 mm) ... hmm — actually row 18 covers 1001-1099, row 19 covers 1100-1199, etc.
        wait — ceil((1099-999)/100)=ceil(100/100)=1, ceil((1100-999)/100)=ceil(101/100)=2. So row 18=1001-1099? Let me recompute:
        gomuH=1100: ceil((1100-999)/100) = ceil(101/100) = 2 → row 19.
        gomuH=1099: ceil((1099-999)/100) = ceil(100/100) = 1 → row 18.
        So row 18 = 1001..1099, row 19 = 1100..1199, row 20 = 1200..1299, ..., row 27 = 1900..1999, row 28 = 2000.
        Row count: rows 0..28 → 29 rows.
    columns:
      10T=0, 10T-금은색=1, 20,30T=2, 20,30T-금은색=3, 50T=4, 50T-금은색=5
    """
    fn_match = re.search(r"function\s+gomuCalc\s*\([^)]*\)\s*\{", text)
    body_start = fn_match.end()
    arr_str = extract_array_after(r"let\s+priceTable\s*=", text[body_start:])
    rows_2d = parse_array_of_numbers(arr_str)

    def gomu_band(row_idx):
        # JS: gomuH ≤ 149 → 0;
        #     150-1000  → ceil((gomuH-149)/50);   produces rows 1..18 (row 18 = exactly gomuH=1000)
        #     1001-2000 → 17 + ceil((gomuH-999)/100);  produces rows 18..28 (row 18 also covers 1001-1099)
        # → row 18 is shared by 1000 (50-step) and 1001-1099 (100-step) → band = 1000~1099
        if row_idx == 0:
            return "~149"
        if row_idx <= 17:
            low = 150 + (row_idx - 1) * 50
            return f"{low}~{low + 49}"
        # row 18+: 100mm bands. row 18 = 1000~1099 (special — includes the 1000 boundary)
        low = 1000 + (row_idx - 18) * 100
        return f"{low}~{low + 99}"

    thickness_keys = ["10T", "10T-금은색", "20,30T", "20,30T-금은색", "50T", "50T-금은색"]
    structured = {}
    for col, tk in enumerate(thickness_keys):
        band_map = {}
        for r_idx, row in enumerate(rows_2d):
            if col < len(row) and row[col] not in (None, 0):
                band_map[gomu_band(r_idx)] = row[col]
        structured[tk] = band_map

    return {
        "label": "고무스카시",
        "sheetName": "스카시 26. 4월 적용",
        "axes": {
            "thickness": thickness_keys,
            "heightBands": [gomu_band(i) for i in range(len(rows_2d))],
        },
        "_heightBandRule": "row 0 = ~149mm, row 1-17 = 50mm 폭(150~999mm), row 18+ = 100mm 폭(1000mm 초과).",
        "prices": structured,
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    baseline = {
        "_meta": {
            "version": "baseline-from-HDCalc.js",
            "extractedFrom": "legacy/channelcalc/HDCalc.js",
            "extractor": "scripts/calc/extract_baseline.py",
            "doc": (
                "이 파일은 HDCalc.js 의 하드코딩 가격을 그대로 떠놓은 영구 baseline. "
                "엑셀 업로드는 이 파일과 diff 후 셀별 승인 절차를 거쳐야 prices.json 에 반영됨. "
                "수동 편집 금지 — 추출 스크립트 재실행 또는 별도 마이그레이션으로만 갱신."
            ),
        },
        "calculators": {
            "channel": extract_channel(),
            "led":     extract_led(),
            "frame":   extract_frame(),
            "epoxy":   extract_epoxy(),
            "acryl":   extract_acryl(),
            "gomu":    extract_gomu(),
            "goldSilver": {
                "label": "금은경 (금경/은경 아크릴)",
                "sheetName": "금은경 26. 4월 인상적용",
                "_note": (
                    "신규 7번째 계산기. HDCalc.js 에 코드가 없어 baseline 가격값은 비어있음. "
                    "구조(axes)는 엑셀 시트 레이아웃에서 결정. "
                    "초기 prices.json 시드는 엑셀값을 사용자가 Phase 6 UI 에서 셀별 검토 후 채움."
                ),
                "axes": {
                    "material": [
                        {"key": "gold",   "label": "금경"},
                        {"key": "silver", "label": "은경"},
                    ],
                    # 엑셀 레이아웃 기준: gold 와 silver 가 서로 다른 두께 범위.
                    # 8T·10T 가 두 재질에 모두 존재. gold 10T 는 한글 컬럼이 없음(엑셀 미수록).
                    "thicknessByMaterial": {
                        "gold":   ["2T", "3T", "5T", "8T", "10T"],
                        "silver": ["8T", "10T", "15T", "20T"],
                    },
                    "textType": ["영문", "한글"],
                    "missingTextTypes": [
                        {"material": "gold", "thickness": "10T", "missing": ["한글"]},
                    ],
                    "heightBandRule": (
                        "행 0 = ~20mm, 행 1 = 21~30mm, 행 N = (10 + 10*N)~(20 + 10*N) (10mm 폭, "
                        "엑셀 데이터 28행 = 251~260mm 까지). 엑셀에는 261~300mm 행이 빈칸으로 남아있음."
                    ),
                },
                # prices 키 의도적으로 비움 — 엑셀에서 가져와 사용자 확정 후 prices.json 으로.
                "prices": {},
            },
        },
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(baseline, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    # Print summary
    c = baseline["calculators"]
    print(f"OK → {OUT.relative_to(ROOT)}")
    print(f"  channel:  {len(c['channel']['types'])} types")
    print(f"  led:      {len(c['led']['ledCount'])} sizes")
    print(f"  frame:    fixed prices ({c['frame']['alminumBar']['pricePerMeter']}, ...)")
    print(f"  epoxy:    {len(c['epoxy']['axes']['sizes'])} sizes × "
          f"{len(c['epoxy']['axes']['strokes'])} strokes × "
          f"{len(c['epoxy']['axes']['material'])} materials × "
          f"{len(c['epoxy']['axes']['textType'])} textTypes")
    total_acryl = sum(
        len(d) for tk in c['acryl']['prices'].values() for d in tk.values()
    )
    print(f"  acryl:    {total_acryl} cells across {len(c['acryl']['axes']['heightBands'])} bands × "
          f"{len(c['acryl']['axes']['thickness'])} thickness × {len(c['acryl']['axes']['textType'])} textTypes")
    total_gomu = sum(len(d) for d in c['gomu']['prices'].values())
    print(f"  gomu:     {total_gomu} cells across {len(c['gomu']['axes']['heightBands'])} bands × "
          f"{len(c['gomu']['axes']['thickness'])} thickness")


if __name__ == "__main__":
    main()
