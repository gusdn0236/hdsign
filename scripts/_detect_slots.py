"""분배함 사진(빨간 박스)에서 16칸 좌표를 추출.
사용자 마우스 단차 보정: 같은 행은 top/bottom 평균, 같은 열은 left/right 평균.

전략:
1) 빨간 마스크 → BFS connected components
2) 컴포넌트들을 y 좌표로 4 row 그룹핑 (y gap > 100 이면 새 행)
3) 각 row 그룹 안에서 컴포넌트 폭으로 칸 수 결정 (W/4 단위로 반올림)
4) 컴포넌트를 가로 등분 → 행당 4개 박스 = 총 16개
5) 행 단위 평균 top/bottom, 열 단위 평균 left/right 적용
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image

IMG = Path(__file__).resolve().parent / "assets" / "distribution.jpg"

img = Image.open(IMG).convert("RGB")
W, H = img.size
arr = np.asarray(img)
r = arr[:, :, 0].astype(np.int32)
g = arr[:, :, 1].astype(np.int32)
b = arr[:, :, 2].astype(np.int32)
mask = (r > 160) & (g < 110) & (b < 110) & ((r - g) > 60) & ((r - b) > 60)
print(f"image {W}x{H}, red pixels {int(mask.sum())}", file=sys.stderr)


def components(mask: np.ndarray) -> list[tuple[int, int, int, int, int]]:
    Hh, Ww = mask.shape
    visited = np.zeros_like(mask, dtype=bool)
    out: list[tuple[int, int, int, int, int]] = []
    ys, xs = np.where(mask)
    for y0, x0 in zip(ys.tolist(), xs.tolist()):
        if visited[y0, x0]:
            continue
        stack = [(y0, x0)]
        min_y = max_y = y0
        min_x = max_x = x0
        count = 0
        while stack:
            y, x = stack.pop()
            if visited[y, x] or not mask[y, x]:
                continue
            visited[y, x] = True
            count += 1
            if y < min_y: min_y = y
            if y > max_y: max_y = y
            if x < min_x: min_x = x
            if x > max_x: max_x = x
            if x + 1 < Ww: stack.append((y, x + 1))
            if x - 1 >= 0: stack.append((y, x - 1))
            if y + 1 < Hh: stack.append((y + 1, x))
            if y - 1 >= 0: stack.append((y - 1, x))
        if count > 500:
            out.append((min_x, min_y, max_x, max_y, count))
    return out


comps = components(mask)
print(f"components: {len(comps)}", file=sys.stderr)
for c in sorted(comps, key=lambda c: c[1]):
    print(f"  l={c[0]:>4} t={c[1]:>4} r={c[2]:>4} b={c[3]:>4}  w={c[2]-c[0]:>4} h={c[3]-c[1]:>4}", file=sys.stderr)

# 1) 행 그룹핑 — 다음 컴포넌트의 top 이 이전 그룹의 max bottom 보다 50px 이상 크면 새 행.
# 50px 은 아래 분배함 위층/아래층 사이의 좁은 gap(~65px) 도 분리하면서 같은 행 안에서의
# 작은 어긋남(< 30px)은 흡수할 정도.
comps_sy = sorted(comps, key=lambda c: c[1])
row_groups: list[list] = [[comps_sy[0]]]
for c in comps_sy[1:]:
    last_bot = max(x[3] for x in row_groups[-1])
    if c[1] > last_bot + 50:
        row_groups.append([c])
    else:
        row_groups[-1].append(c)

print(f"row groups: {len(row_groups)}", file=sys.stderr)
if len(row_groups) != 4:
    print(f"WARN: expected 4 rows, got {len(row_groups)}", file=sys.stderr)

# 2) 각 행에서 컴포넌트를 가로 위치로 정렬 + 폭에 따라 N칸 분할 → 행당 4개 박스
expected_cell_w = W / 4

def split_into_cells(comp, n_cols: int):
    l, t, rr, bb, _ = comp
    step = (rr - l) / n_cols
    return [(int(round(l + step * i)), t, int(round(l + step * (i + 1))), bb) for i in range(n_cols)]

all_cells: list[list[tuple[int, int, int, int]]] = []  # 행별 [(l,t,r,b) × 4]
for ri, grp in enumerate(row_groups):
    grp_x = sorted(grp, key=lambda c: c[0])
    cells_in_row: list[tuple[int, int, int, int]] = []
    for c in grp_x:
        w = c[2] - c[0]
        n = max(1, int(round(w / expected_cell_w)))
        print(f"  row {ri} comp w={w} → split into {n} cell(s)", file=sys.stderr)
        cells_in_row.extend(split_into_cells(c, n))
    if len(cells_in_row) != 4:
        print(f"WARN row {ri}: got {len(cells_in_row)} cells (need 4)", file=sys.stderr)
        # 4 미만이면 마지막 컴포넌트를 더 잘게 쪼갬 (가장 큰 컴포넌트를 대신해도 OK)
        while len(cells_in_row) < 4:
            biggest_idx = max(range(len(cells_in_row)),
                              key=lambda i: cells_in_row[i][2] - cells_in_row[i][0])
            big = cells_in_row[biggest_idx]
            mid = (big[0] + big[2]) // 2
            left_part = (big[0], big[1], mid, big[3])
            right_part = (mid, big[1], big[2], big[3])
            cells_in_row[biggest_idx:biggest_idx + 1] = [left_part, right_part]
    all_cells.append(cells_in_row[:4])

# 3) 단차 보정 — 같은 행 top/bottom 평균, 같은 열 left/right 평균.
row_top = [int(round(np.mean([c[1] for c in row]))) for row in all_cells]
row_bot = [int(round(np.mean([c[3] for c in row]))) for row in all_cells]
col_lft = [int(round(np.mean([all_cells[ri][ci][0] for ri in range(4)]))) for ci in range(4)]
col_rgt = [int(round(np.mean([all_cells[ri][ci][2] for ri in range(4)]))) for ci in range(4)]

labels = [
    "캡/일체형작업실", "시트/도안실", "에폭시실", "아크릴/실리콘네온",
    "후레임실", "도장실", "레이져용접", "최창영부장",
    "조립부", "아크릴부(레이져)", "배송1팀", "배송2팀",
    "홍철웅팀장", "LED조립", "고무스카시(CNC)", "이휘원실장",
]
mapped = [
    "완조립부", "완조립부", "에폭시부", "CNC가공부",
    "완조립부", "도장부", "CNC가공부", "CNC가공부",
    "완조립부", "아크릴가공부(5층)", "배송팀", "",
    "", "LED조립부", "CNC가공부", "완조립부",
]

print()
print(f"# auto-detected from {IMG.name} ({W}x{H}). 행/열 평균 정렬됨.")
for i, (lab, dept) in enumerate(zip(labels, mapped)):
    ri, ci = i // 4, i % 4
    l, t, rr, bb = col_lft[ci], row_top[ri], col_rgt[ci], row_bot[ri]
    label_pad = f'"{lab}"'
    dept_pad = f'"{dept}"'
    print(f"    ({label_pad:<22} {dept_pad:<20} ({l:>4}, {t:>4}, {rr:>4}, {bb:>4})),")
