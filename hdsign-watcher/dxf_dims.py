"""FlexiSIGN 이 내보낸 DXF 에서 '오브젝트별 가로세로(mm)' 만 뽑아내는 경량 파서.

배경 — 왜 이게 있나:
  지시서를 만든 FlexiSIGN 작업공간은 1:1 실측(인치). 웹에 올라가는 PDF 는 인쇄(PDF24)로
  A4 에 축소돼 실제 mm 가 사라지지만, 같은 .fs 를 DXF 로 내보내면 좌표가 1:1 인치 그대로
  남는다. 그래서 워처가 인쇄 시 DXF 를 자동 내보내 → 이 파서로 오브젝트 bbox(mm)만 추려
  → 서버에 작은 JSON 으로 올린다(=명세서 작성 화면의 '클릭 시 W×H' 오버레이용). DXF 원본은
  파싱 후 삭제한다.

검증(2026-06-17): 테스트 .fs→DXF 의 네모박스가 FlexiSIGN DesignCentral 표시값
  189.4 x 111.5 mm 와 0.04mm 오차로 일치. 글자(윤곽선)도 각각 POLYLINE 으로 분리돼 잡힘.

설계 원칙:
  - 외부 의존성 없음(워처는 PyInstaller 번들이라 ezdxf 같은 큰 의존성 추가를 피한다).
    DXF 는 '그룹코드/값' 2줄짜리 ASCII 라 표준 라이브러리만으로 충분.
  - 실패는 조용히 — 어떤 엔티티 하나가 깨져도 그 오브젝트만 건너뛰고 계속. 측정은 부차
    기능이라 절대 인쇄/업로드 본류를 막지 않는다.
  - 좌표는 DXF 원좌표계(원점 좌하단, Y 위쪽)를 그대로 두고 mm 로만 환산. 화면 정렬(Y 뒤집기,
    PDF 와 맞추기)은 프론트가 전체 extent 기준으로 처리한다.
"""

from __future__ import annotations

import math
from pathlib import Path

# $INSUNITS 코드 → mm 환산 계수.
# ★ 우리 파이프라인: 워처가 '외부 파일로 저장' 시 '옵션 무시' 체크를 해제하고 내보낸다(필수 —
#   안 그러면 사이즈가 틀림). 그러면 'DXF 선택 사항' 옵션이 적용돼 좌표가 FlexiSIGN 표시단위
#   (HD사인=mm)로 저장된다. $INSUNITS 표기는 없음. 검증(2026-06-17): 박스 원시값 189.35 = 실제 189.4mm.
#   → $INSUNITS 가 없으면(미지정) 'mm(=1.0)' 로 본다. ($INSUNITS 가 명시되면 그 값을 따른다.)
#   (참고: '옵션 무시'를 켜고 내보내면 인치(raw 7.455)로 나오지만, 우리는 항상 해제하므로 mm.)
_INSUNITS_TO_MM = {
    0: 1.0,     # 미지정 — 옵션무시 해제 export = 표시단위(mm)
    1: 25.4,    # inch
    2: 304.8,   # feet
    4: 1.0,     # mm
    5: 10.0,    # cm
    6: 1000.0,  # m
    8: 0.0254,  # microinch
    9: 0.0254,  # mil(1/1000 inch)
}
_DEFAULT_UNIT_MM = 1.0  # $INSUNITS 없을 때 기본(mm)


def _read_pairs(path: Path) -> list[tuple[str, str]]:
    """DXF 를 (그룹코드, 값) 쌍 리스트로 읽는다. 인코딩은 utf-8 → cp949 → latin-1 폴백."""
    raw = Path(path).read_bytes()
    txt = None
    for enc in ("utf-8", "cp949", "latin-1"):
        try:
            txt = raw.decode(enc)
            break
        except Exception:
            continue
    if txt is None:
        txt = raw.decode("latin-1", errors="replace")
    lines = txt.splitlines()
    pairs: list[tuple[str, str]] = []
    # DXF 는 코드/값이 한 줄씩 번갈아 나온다. 홀수 줄 깨짐 방어.
    for i in range(0, len(lines) - 1, 2):
        pairs.append((lines[i].strip(), lines[i + 1].strip()))
    return pairs


def _split_entities(pairs: list[tuple[str, str]]) -> list[list[tuple[str, str]]]:
    """그룹코드 0(엔티티 경계)으로 잘라 엔티티 단위 리스트로 묶는다."""
    ents: list[list[tuple[str, str]]] = []
    cur: list[tuple[str, str]] = []
    for code, val in pairs:
        if code == "0":
            if cur:
                ents.append(cur)
            cur = [(code, val)]
        else:
            cur.append((code, val))
    if cur:
        ents.append(cur)
    return ents


def _header_units_mm(pairs: list[tuple[str, str]]) -> float:
    """$INSUNITS 를 읽어 mm 환산계수 반환. 없으면 mm(=1.0, 우리 파이프라인 기본)."""
    for i, (code, val) in enumerate(pairs):
        if code == "9" and val == "$INSUNITS":
            # 다음 (70, <int>) 가 값
            for c2, v2 in pairs[i + 1:i + 3]:
                if c2 == "70":
                    try:
                        return _INSUNITS_TO_MM.get(int(v2), _DEFAULT_UNIT_MM)
                    except Exception:
                        return _DEFAULT_UNIT_MM
    return _DEFAULT_UNIT_MM


def _floats(entity: list[tuple[str, str]], code: str) -> list[float]:
    out = []
    for c, v in entity:
        if c == code:
            try:
                out.append(float(v))
            except Exception:
                pass
    return out


_ARC_SEGS = 72  # 원 한 바퀴를 몇 점으로 쪼갤지(호는 비율만큼). 곡선을 점으로 근사. 48→72(곡선 더 매끄럽게).


def _points_of_entity(etype: str, ent: list[tuple[str, str]],
                      follow_vertices: list[list[tuple[str, str]]]) -> list[tuple[float, float]]:
    """엔티티 하나의 실제 윤곽 꼭짓점(x,y) 리스트를 원좌표(환산 전)로 반환. 없으면 [].

    LED 계산은 bbox 가 아닌 '실제 모양'이 필요하므로 점들을 보존한다(원/호/타원은 곡선을 점으로 변환).
    follow_vertices: POLYLINE 뒤에 따라오는 VERTEX 엔티티들(SEQEND 전까지).
    """
    pts: list[tuple[float, float]] = []

    if etype == "POLYLINE":
        for ve in follow_vertices:
            vx = _floats(ve, "10")
            vy = _floats(ve, "20")
            if vx and vy:
                pts.append((vx[0], vy[0]))
    elif etype == "LWPOLYLINE":
        xs = _floats(ent, "10")
        ys = _floats(ent, "20")
        pts = list(zip(xs, ys))
    elif etype == "LINE":
        xs = _floats(ent, "10") + _floats(ent, "11")
        ys = _floats(ent, "20") + _floats(ent, "21")
        pts = list(zip(xs, ys))
    elif etype in ("CIRCLE", "ARC"):
        cx = _floats(ent, "10")
        cy = _floats(ent, "20")
        r = _floats(ent, "40")
        if cx and cy and r:
            a0, a1 = 0.0, 2 * math.pi
            if etype == "ARC":
                s = _floats(ent, "50")
                e = _floats(ent, "51")
                if s and e:
                    a0 = math.radians(s[0])
                    a1 = math.radians(e[0])
                    if a1 <= a0:
                        a1 += 2 * math.pi
            n = max(8, int(round((a1 - a0) / (2 * math.pi) * _ARC_SEGS)))
            for k in range(n + 1):
                a = a0 + (a1 - a0) * k / n
                pts.append((cx[0] + r[0] * math.cos(a), cy[0] + r[0] * math.sin(a)))
    elif etype == "ELLIPSE":
        cx = _floats(ent, "10")
        cy = _floats(ent, "20")
        mx = _floats(ent, "11")  # major axis endpoint(중심 상대)
        my = _floats(ent, "21")
        if cx and cy and mx and my:
            a = math.hypot(mx[0], my[0])
            ratio = (_floats(ent, "40") or [1.0])[0]
            b = a * ratio
            rot = math.atan2(my[0], mx[0])  # 장축 회전각
            s = _floats(ent, "41")
            e = _floats(ent, "42")
            a0 = s[0] if s else 0.0
            a1 = e[0] if e else 2 * math.pi
            if a1 <= a0:
                a1 += 2 * math.pi
            n = max(8, int(round((a1 - a0) / (2 * math.pi) * _ARC_SEGS)))
            ca, sa = math.cos(rot), math.sin(rot)
            for k in range(n + 1):
                t = a0 + (a1 - a0) * k / n
                ex = a * math.cos(t)
                ey = b * math.sin(t)
                pts.append((cx[0] + ex * ca - ey * sa, cy[0] + ex * sa + ey * ca))
    elif etype in ("SPLINE", "POINT", "3DFACE", "SOLID"):
        # SPLINE 은 fit/control 점만 — 곡선 근사는 거칠지만 윤곽 표시엔 충분.
        xs = _floats(ent, "10")
        ys = _floats(ent, "20")
        pts = list(zip(xs, ys))

    return pts


def _bbox_from_points(pts: list[tuple[float, float]]):
    """점 리스트 → (minx,miny,maxx,maxy). 비면 None."""
    if not pts:
        return None
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return (min(xs), min(ys), max(xs), max(ys))


def parse_dxf_objects(path) -> dict:
    """DXF 파일에서 오브젝트별 bbox(mm) 목록 + 전체 extent 를 추출한다.

    반환:
      {
        "unit_mm": <환산계수>,
        "extent": {"x": minx, "y": miny, "w": W, "h": H}  # 전체(mm),
        "objects": [ {"x":..,"y":..,"w":..,"h":..,"type":"POLYLINE",
                      "points": [[x,y], ...]} , ... ]  # mm, Y=위쪽 원좌표. points=실제 윤곽(LED용)
      }
    좌표는 DXF 원좌표(원점 좌하단). 화면 정렬은 호출측(프론트)에서 extent 기준 정규화.
    실패해도 예외를 던지지 않고 objects=[] 로 반환(부차 기능 보호).
    """
    try:
        pairs = _read_pairs(path)
    except Exception:
        return {"unit_mm": 25.4, "extent": None, "objects": []}

    unit = _header_units_mm(pairs)
    ents = _split_entities(pairs)

    objs: list[dict] = []
    skipped: dict[str, int] = {}
    types: dict[str, int] = {}  # 진단용 — 모든 최상위 엔티티 타입 카운트(0개일 때 원인 파악).
    i = 0
    # ENTITIES 섹션만 대상으로. (간단히 전체를 훑되 SECTION/HEADER 등 비-도형은 bbox 가 안 나와 무시됨)
    while i < len(ents):
        ent = ents[i]
        etype = ent[0][1]
        types[etype] = types.get(etype, 0) + 1
        if etype == "POLYLINE":
            verts = []
            j = i + 1
            while j < len(ents) and ents[j][0][1] == "VERTEX":
                verts.append(ents[j])
                j += 1
            # SEQEND 스킵
            if j < len(ents) and ents[j][0][1] == "SEQEND":
                j += 1
            pts = _points_of_entity("POLYLINE", ent, verts)
            bb = _bbox_from_points(pts)
            if bb:
                objs.append(_mk(bb, pts, unit, "POLYLINE"))
            i = j
            continue
        elif etype in ("LWPOLYLINE", "LINE", "CIRCLE", "ARC", "ELLIPSE",
                       "SPLINE", "SOLID", "3DFACE"):
            pts = _points_of_entity(etype, ent, [])
            bb = _bbox_from_points(pts)
            if bb:
                objs.append(_mk(bb, pts, unit, etype))
        elif etype in ("SECTION", "ENDSEC", "TABLE", "ENDTAB", "LAYER",
                       "VPORT", "STYLE", "LTYPE", "APPID", "BLOCK_RECORD",
                       "DIMSTYLE", "CLASS", "EOF", "SEQEND", "VERTEX",
                       "BLOCK", "ENDBLK", "DICTIONARY", "INSERT", "TEXT",
                       "MTEXT", "ATTDEF", "ATTRIB", "VIEWPORT"):
            # 알려진 비대상(또는 추후 확장 대상). INSERT/TEXT 는 실제 export 샘플 보고 확장.
            if etype in ("INSERT", "TEXT", "MTEXT"):
                skipped[etype] = skipped.get(etype, 0) + 1
        else:
            skipped[etype] = skipped.get(etype, 0) + 1
        i += 1

    # 면적 0(선 한 줄 등) 제외 — 클릭 대상이 못 됨. 아주 작은 것도 둔다(글자 획).
    objs = [o for o in objs if o["w"] > 0.05 and o["h"] > 0.05]

    extent = None
    if objs:
        x0 = min(o["x"] for o in objs)
        y0 = min(o["y"] for o in objs)
        x1 = max(o["x"] + o["w"] for o in objs)
        y1 = max(o["y"] + o["h"] for o in objs)
        extent = {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0}

    return {"unit_mm": unit, "extent": extent, "objects": objs, "skipped": skipped, "types": types}


_SIMPLIFY_TOL_MM = 0.3  # 이 거리 미만으로 붙은 연속 꼭짓점은 제거(살짝 단순화). 0.5→0.3(더 자세히).
_MAX_POINTS = 900       # 객체당 점 상한(안전장치) — 넘으면 균등 솎아냄. 600→900(정밀도↑ 반영).


def _simplify_mm(pts_mm: list[tuple[float, float]], tol: float = _SIMPLIFY_TOL_MM) -> list[list[float]]:
    """연속 꼭짓점 중 tol(mm) 미만으로 붙은 것 제거 + mm 소수1자리 반올림. 마지막 점은 보존."""
    out: list[list[float]] = []
    for x, y in pts_mm:
        if not out or math.hypot(x - out[-1][0], y - out[-1][1]) >= tol:
            out.append([round(x, 1), round(y, 1)])
    if pts_mm:
        last = [round(pts_mm[-1][0], 1), round(pts_mm[-1][1], 1)]
        if not out or out[-1] != last:
            out.append(last)
    if len(out) > _MAX_POINTS:
        step = len(out) / _MAX_POINTS
        out = [out[int(k * step)] for k in range(_MAX_POINTS)]
    return out


def _mk(bb, pts, unit, etype) -> dict:
    minx, miny, maxx, maxy = bb
    pts_mm = [(px * unit, py * unit) for px, py in pts]
    return {
        "x": round(minx * unit, 2),
        "y": round(miny * unit, 2),
        "w": round((maxx - minx) * unit, 2),
        "h": round((maxy - miny) * unit, 2),
        "type": etype,
        "points": _simplify_mm(pts_mm),  # 실제 윤곽(mm, DXF Y=위쪽 원좌표). LED 모드에서 테두리/채움에 사용.
    }


if __name__ == "__main__":
    import json
    import sys

    default = (r"\\Main\현대공유\00000 2026년 자료\000 2026년 거래처"
               r"\테스트회사1 (자동생성)\6-17dxf내보내기테스트\내보내기테스트.dxf")
    p = sys.argv[1] if len(sys.argv) > 1 else default
    res = parse_dxf_objects(p)
    objs = sorted(res["objects"], key=lambda o: -o["w"])
    print(f"unit_mm={res['unit_mm']}  objects={len(objs)}  skipped={res.get('skipped')}")
    if res["extent"]:
        e = res["extent"]
        print(f"extent: {e['w']:.1f} x {e['h']:.1f} mm  @({e['x']:.1f},{e['y']:.1f})")
    total_pts = sum(len(o.get("points", [])) for o in objs)
    print(f"points: 총 {total_pts}개 (객체당 평균 {total_pts / max(1, len(objs)):.1f})")
    print("biggest objects (mm):")
    for o in objs[:6]:
        print(f"  {o['w']:7.1f} x {o['h']:7.1f}   {o['type']}  pts={len(o.get('points', []))}  @({o['x']:.1f},{o['y']:.1f})")
    # 자체검증: 가장 큰 박스가 189.4 x 111.5 (±0.5) 인가
    if objs:
        b = objs[0]
        ok = abs(b["w"] - 189.4) < 0.5 and abs(b["h"] - 111.5) < 0.5
        print(f"\nSELF-TEST 박스 189.4x111.5 매칭: {'PASS' if ok else 'FAIL'} "
              f"(got {b['w']} x {b['h']})")
