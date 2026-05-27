"""EasyForm 전체 + Windows Temp + LocalAppData 변화 감시 — [물품내역 복사하기] 직후 변화 추적."""
from __future__ import annotations
import os
import sys
from pathlib import Path
from typing import Dict, Tuple

WATCH_DIRS = [
    Path(r"C:\EasyformNetC"),
    Path(os.environ.get("TEMP", "")),
    Path(os.environ.get("LOCALAPPDATA", "")) / "EasyForm",
    Path(os.environ.get("LOCALAPPDATA", "")) / "세경멀티뱅크",
    Path(os.environ.get("APPDATA", "")) / "EasyForm",
    Path(os.environ.get("APPDATA", "")) / "세경멀티뱅크",
    Path.home() / "Documents" / "EasyForm",
]


def snapshot() -> Dict[str, Tuple[int, float]]:
    out: Dict[str, Tuple[int, float]] = {}
    for d in WATCH_DIRS:
        if not d.is_dir():
            continue
        try:
            for p in d.rglob("*"):
                if p.is_file():
                    try:
                        st = p.stat()
                        out[str(p)] = (st.st_size, st.st_mtime)
                    except Exception:
                        pass
        except Exception as e:
            print(f"  스캔 실패 {d}: {e}")
    return out


def diff(before: dict, after: dict) -> None:
    bset = set(before)
    aset = set(after)

    added = aset - bset
    removed = bset - aset
    common = bset & aset
    modified = [p for p in common if before[p] != after[p]]

    # %TEMP% 의 Python pip/PowerShell 정상 활동 제거
    def is_noise(p: str) -> bool:
        lp = p.lower()
        return any(s in lp for s in [
            "\\pip", "\\msi", "\\powershell", "\\windows\\temp",
            "\\__pycache__", ".tmp.crdownload", "ms-iac", "\\edge",
            "\\chrome", "logs\\", "diagnostic", "\\dump",
        ])

    added = {p for p in added if not is_noise(p)}
    modified = [p for p in modified if not is_noise(p)]
    removed = {p for p in removed if not is_noise(p)}

    print(f"\n변화 (noise 제거): 추가 {len(added)} · 삭제 {len(removed)} · 수정 {len(modified)}")

    if added:
        print(f"\n[추가됨]")
        for p in sorted(added):
            sz, _ = after[p]
            print(f"  + {p}  ({sz} bytes)")

    if modified:
        print(f"\n[수정됨]")
        for p in sorted(modified):
            b_sz, b_mt = before[p]
            a_sz, a_mt = after[p]
            print(f"  ~ {p}  ({b_sz} → {a_sz} bytes, Δ{a_sz - b_sz:+d})")

    if removed:
        print(f"\n[삭제됨]")
        for p in sorted(removed):
            print(f"  - {p}")

    if not (added or modified or removed):
        print("  (변화 없음 — 디스크 안 씀. 메모리 only 가능성)")


def main() -> int:
    print("감시 대상:")
    for d in WATCH_DIRS:
        exists = "✓" if d.is_dir() else "✗"
        print(f"  {exists} {d}")
    print("\nsnapshot 중... (수 초 걸릴 수 있음)")
    before = snapshot()
    print(f"  {len(before)} 파일 기록")
    print()
    print("=" * 60)
    print("이지폼에서:")
    print("  1. 명세서 상세 화면 (자재 디테일 보이는)")
    print("  2. [물품내역 복사하기] 클릭")
    print("그 후 여기로 돌아와 Enter ↩")
    print("=" * 60)
    try:
        input()
    except (EOFError, KeyboardInterrupt):
        pass
    print("snapshot 중...")
    after = snapshot()
    diff(before, after)
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore
    sys.exit(main())
