"""90개 셀 좌표 calibration — 10행 × 9컬럼.

사용법:
    1. 이지폼 명세서 상세 화면 띄우기 (자재 여러 줄, 위 캡처의 (주)진성커뮤니티 12-31 추천)
    2. PowerShell:
        py -3 C:\\Users\\USER\\Desktop\\hdsign\\scripts\\calibrate_layout.py
    3. 안내된 셀에 마우스로 *클릭으로 활성화* 후 F8 → 좌표 기록
    4. 90번 + 그리드 영역 2번 = 92번
    5. 저장: easyform_layout.json

순서:
    행 1 (월일→비고 9개) → 행 2 → ... → 행 10
    + 그리드 좌상단 + 그리드 우하단
"""
from __future__ import annotations
import ctypes
import json
import sys
import time
from ctypes import wintypes
from pathlib import Path

user32 = ctypes.WinDLL("user32", use_last_error=True)

# DPI awareness — 측정 좌표가 physical pixel 기반이도록
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    try:
        user32.SetProcessDPIAware()
    except Exception:
        pass


class POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


user32.GetCursorPos.argtypes = [ctypes.POINTER(POINT)]
user32.GetCursorPos.restype = wintypes.BOOL
user32.GetAsyncKeyState.argtypes = [ctypes.c_int]
user32.GetAsyncKeyState.restype = ctypes.c_short

VK_F7 = 0x76           # 기록 (이지폼 미할당)
VK_F10 = 0x79          # 직전 행 되돌리기 (이지폼 미할당)
VK_ESC = 0x1B

COLS = ["월일", "품목코드", "품목", "규격", "수량", "단가", "공급가액", "세액", "비고"]
ROWS_VISIBLE = 10      # 한 화면에 보이는 최대 행 수
COL_KEYS = ["month_day", "item_code", "item", "spec", "qty", "unit_price", "supply", "tax", "remark"]


def get_mouse() -> tuple[int, int]:
    p = POINT()
    user32.GetCursorPos(ctypes.byref(p))
    return p.x, p.y


def is_pressed(vk: int) -> bool:
    return bool(user32.GetAsyncKeyState(vk) & 0x8000)


def wait_for_key() -> str:
    """F7 (기록), F10 (직전 행 되돌리기), Esc (중단) 중 하나 대기. 0.6s debounce."""
    while True:
        if is_pressed(VK_F7):
            time.sleep(0.6)
            return "F7"
        if is_pressed(VK_F10):
            time.sleep(0.6)
            return "F10"
        if is_pressed(VK_ESC):
            return "ESC"
        time.sleep(0.03)


def main() -> int:
    print("=" * 70)
    print(" EasyForm 명세서 90개 셀 좌표 calibration")
    print("=" * 70)
    print()
    print("준비:")
    print("  1. 이지폼 명세서 상세 화면 (자재 여러 줄 — 예: 진성커뮤니티 12-31)")
    print("  2. 명세서 창은 평소 위치 그대로")
    print()
    print("키:")
    print("  F8 = 현재 마우스 위치 기록 (다음 셀로 이동)")
    print("  F9 = 직전 행(9칸) 통째로 되돌리기")
    print("  Esc = 중단")
    print()
    print(f"총 측정 = {ROWS_VISIBLE} 행 × {len(COLS)} 칸 + 그리드 영역 2 = {ROWS_VISIBLE*len(COLS)+2} 번")
    print()
    print("⚠ 빈 행도 그리드 라인 위에서 클릭하면 OK. 셀 영역 안만 맞으면 됨.")
    print("준비됐으면 Enter ↩")
    try:
        input()
    except (EOFError, KeyboardInterrupt):
        return 1

    # 90개 셀 좌표
    cells: list[list[dict]] = [[None] * len(COLS) for _ in range(ROWS_VISIBLE)]  # type: ignore

    row_idx = 0
    col_idx = 0
    while row_idx < ROWS_VISIBLE:
        col_name = COLS[col_idx]
        print(f"  행 {row_idx+1}/{ROWS_VISIBLE} - {col_name} ({col_idx+1}/9) → F8")
        result = wait_for_key()
        if result == "ESC":
            print("\n중단됨.")
            return 1
        if result == "F10":
            # 직전 행 되돌리기
            if row_idx == 0 and col_idx == 0:
                print("    되돌릴 행 없음.")
                continue
            # 현재 행을 None 으로 초기화하고 직전 행으로 이동
            cells[row_idx] = [None] * len(COLS)  # type: ignore
            if row_idx > 0:
                row_idx -= 1
                cells[row_idx] = [None] * len(COLS)  # type: ignore
                col_idx = 0
                print(f"    행 {row_idx+1} 부터 다시 측정.")
            continue
        # F7
        x, y = get_mouse()
        cells[row_idx][col_idx] = {"x": x, "y": y}
        print(f"    → ({x}, {y})")
        col_idx += 1
        if col_idx >= len(COLS):
            col_idx = 0
            row_idx += 1
            if row_idx < ROWS_VISIBLE:
                print(f"  --- 행 {row_idx+1} 시작 ---")

    # 그리드 영역
    print()
    print(f"  그리드 좌상단 (월일 컬럼 헤더 좌측 위 근처) → F8")
    r = wait_for_key()
    if r == "ESC":
        return 1
    grid_tl = get_mouse()
    print(f"    → {grid_tl}")
    print(f"  그리드 우하단 (비고 컬럼의 마지막 행 우측 아래 근처) → F8")
    r = wait_for_key()
    if r == "ESC":
        return 1
    grid_br = get_mouse()
    print(f"    → {grid_br}")

    # JSON 저장
    layout = {
        "format": "90-cell explicit",
        "rows": ROWS_VISIBLE,
        "cols": len(COLS),
        "col_names": COL_KEYS,
        "cells": [
            [
                {"x": cell["x"], "y": cell["y"], "col": COL_KEYS[j]}
                for j, cell in enumerate(row)
            ]
            for row in cells
        ],
        "grid_left": grid_tl[0],
        "grid_top": grid_tl[1],
        "grid_right": grid_br[0],
        "grid_bottom": grid_br[1],
    }
    out_path = Path(r"C:\Users\USER\Desktop\hdsign\scripts\easyform_layout.json")
    out_path.write_text(json.dumps(layout, ensure_ascii=False, indent=2), encoding="utf-8")
    print()
    print("=" * 70)
    print(f"저장됨: {out_path}")
    # 행 높이 평균 출력 (검증용)
    ys = [row[0]["y"] for row in cells]
    diffs = [ys[i+1] - ys[i] for i in range(len(ys)-1)]
    print(f"행 Y 좌표 (1행 월일 기준): {ys}")
    print(f"행간 간격: {diffs}  (평균 {sum(diffs)/len(diffs):.1f} px)")
    print(f"그리드 영역: ({grid_tl[0]}, {grid_tl[1]}) ~ ({grid_br[0]}, {grid_br[1]})")
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore
    sys.exit(main())
