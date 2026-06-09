"""EasyForm 명세서 상세 화면의 그리드 컨트롤을 UIA 로 읽을 수 있는지 진단.

사용법:
    1. 이지폼에서 명세서 더블클릭 → 상세 화면 띄워둠
    2. PowerShell:
        py -3 C:\\Users\\USER\\Desktop\\hdsign\\scripts\\easyform_uia_probe.py
    3. 결과 = 화면 + C:\\Users\\USER\\Desktop\\uia_probe.txt 양쪽

진단 흐름:
    1. 이지폼 창 찾기 (제목 키워드)
    2. UIA / win32 두 backend 로 컨트롤 트리 dump
    3. 그리드/리스트뷰/테이블 후보 식별
    4. 각 후보의 텍스트 추출 시도
"""
from __future__ import annotations
import sys
import traceback
from pathlib import Path

try:
    from pywinauto import Desktop, findwindows
    from pywinauto.application import Application
except Exception as e:
    print("pywinauto import 실패. 설치 필요:")
    print("  py -3 -m pip install --user pywinauto comtypes")
    sys.exit(2)


KEYWORDS = ["거래명세서", "EasyForm", "이지폼", "매출"]
OUTPUT = Path(r"C:\Users\USER\Desktop\hdsign\easyform-data\uia_probe.txt")
OUTPUT.parent.mkdir(parents=True, exist_ok=True)


def find_easyform_windows() -> list:
    """이지폼 관련 windows 찾기 (UIA + win32 둘 다)."""
    found = []
    for backend in ("uia", "win32"):
        try:
            d = Desktop(backend=backend)
            for w in d.windows():
                try:
                    title = w.window_text()
                except Exception:
                    title = ""
                if not title:
                    continue
                if any(k in title for k in KEYWORDS):
                    found.append((backend, title, w))
        except Exception as e:
            print(f"[{backend}] enum windows 실패: {e}")
    return found


def dump_control_tree(w, lines: list[str], depth: int = 0, max_depth: int = 6, idx_path: str = "") -> None:
    indent = "  " * depth
    try:
        ctrl_type = w.element_info.control_type if hasattr(w.element_info, "control_type") else "?"
    except Exception:
        ctrl_type = "?"
    try:
        class_name = w.class_name() if hasattr(w, "class_name") else "?"
    except Exception:
        class_name = "?"
    try:
        text = w.window_text()
    except Exception:
        text = ""
    try:
        rect = w.rectangle()
    except Exception:
        rect = "?"
    name_part = (text or "").replace("\n", " ")[:80]
    lines.append(
        f"{indent}{idx_path or '·'}  type={ctrl_type}  class='{class_name}'  text='{name_part}'  rect={rect}"
    )
    if depth >= max_depth:
        lines.append(f"{indent}  ...(max depth)")
        return
    try:
        children = w.children()
    except Exception:
        children = []
    for i, c in enumerate(children):
        sub_path = f"{idx_path}.{i}" if idx_path else str(i)
        dump_control_tree(c, lines, depth + 1, max_depth, sub_path)


def try_grid_extraction(w, lines: list[str]) -> None:
    """그리드/리스트 후보에서 데이터 뽑기 시도."""
    candidates = []

    def collect(node, depth=0):
        if depth > 8:
            return
        try:
            cn = node.class_name() if hasattr(node, "class_name") else ""
        except Exception:
            cn = ""
        try:
            ct = node.element_info.control_type if hasattr(node.element_info, "control_type") else ""
        except Exception:
            ct = ""
        # Delphi 그리드 후보 클래스명 패턴
        if any(s in (cn or "").upper() for s in [
            "STRINGGRID", "DBGRID", "DRAWGRID", "TCXGRID", "TGRID",
            "LISTVIEW", "SYSLISTVIEW32", "TLISTBOX",
        ]) or any(s in (ct or "") for s in ["DataGrid", "Table", "List"]):
            candidates.append(node)
        try:
            for c in node.children():
                collect(c, depth + 1)
        except Exception:
            pass

    collect(w)
    lines.append(f"\n  >> 그리드 후보: {len(candidates)}개")
    for i, c in enumerate(candidates[:5]):
        try:
            cn = c.class_name()
        except Exception:
            cn = "?"
        try:
            ct = c.element_info.control_type
        except Exception:
            ct = "?"
        lines.append(f"\n  --- 후보 {i}: class='{cn}' type='{ct}' ---")

        # 시도 1: texts()
        try:
            t = c.texts()
            lines.append(f"    texts(): {t[:5]}{'...' if len(t) > 5 else ''}")
        except Exception as e:
            lines.append(f"    texts() err: {e}")

        # 시도 2: get_value (UIA only)
        try:
            v = c.get_value() if hasattr(c, "get_value") else None
            if v:
                lines.append(f"    get_value(): {v!r}")
        except Exception:
            pass

        # 시도 3: item_count (ListView)
        try:
            if hasattr(c, "item_count"):
                n = c.item_count()
                lines.append(f"    item_count(): {n}")
                if n > 0 and n < 20 and hasattr(c, "items"):
                    items = c.items()
                    for j, it in enumerate(items[:5]):
                        lines.append(f"      item[{j}]: {it!r}")
        except Exception:
            pass

        # 시도 4: 자식 컨트롤 (그리드의 row/cell)
        try:
            children = c.children()
            lines.append(f"    children: {len(children)}개")
            for j, ch in enumerate(children[:3]):
                try:
                    ct = ch.class_name()
                    tx = ch.window_text()
                    lines.append(f"      child[{j}]: class={ct!r}, text={tx!r}")
                except Exception:
                    pass
        except Exception:
            pass


def main() -> int:
    lines: list[str] = []
    lines.append("=== EasyForm UIA 진단 ===\n")

    found = find_easyform_windows()
    lines.append(f"\n발견된 EasyForm 창: {len(found)}개")
    for backend, title, w in found:
        lines.append(f"  [{backend}] {title!r}")

    if not found:
        lines.append("\n⚠ EasyForm 창을 못 찾음. 이지폼 켜고 명세서 상세 화면 띄워두세요.")
        OUTPUT.write_text("\n".join(lines), encoding="utf-8")
        print("\n".join(lines))
        return 1

    # 각 창에 대해 컨트롤 트리 + 그리드 시도
    for backend, title, w in found:
        lines.append(f"\n\n{'='*60}")
        lines.append(f"창 [{backend}] {title!r}")
        lines.append(f"{'='*60}")
        try:
            lines.append("\n--- control tree (max depth 6) ---")
            dump_control_tree(w, lines)
            lines.append("\n--- grid candidates ---")
            try_grid_extraction(w, lines)
        except Exception:
            lines.append("UNEXPECTED:")
            lines.append(traceback.format_exc())

    result = "\n".join(lines)
    OUTPUT.write_text(result, encoding="utf-8")
    print(result)
    print(f"\n저장됨: {OUTPUT}")
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore
    sys.exit(main())
