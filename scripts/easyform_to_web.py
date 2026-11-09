"""이지폼 → 홈페이지 명세서 옮기기 (1건).

지금 이지폼에 열려 있는 상세명세서 1건의 표(품목코드/품목/규격/수량/단가)를 읽어서
클립보드에 넣는다. 그 다음 홈페이지 명세서 작성 화면에서 Ctrl+V(또는 [📋 이지폼 붙여넣기])
하면 표가 한 번에 채워진다.

읽기는 검증된 easyform_fast.py 의 extract_grid 를 그대로 쓴다(우클릭 [복사] 메뉴만 —
Ctrl+C 는 전자명세서에서 '수정불가' 팝업을 띄워 셀을 오염시키므로 절대 안 씀).
이지폼 쪽엔 클릭/우클릭/Enter 만 보내고 입력·저장은 하지 않는다(읽기 전용).

클립보드 형식: 첫 줄 표식 `HDSIGN_EASYFORM_V1`, 다음 줄부터 탭 구분 5칸.
중간에 멈추려면 Ctrl+Esc 를 길게.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

FAST = Path(r"C:\Users\USER\Desktop\tenet-test\.tenet\learning")
sys.path.insert(0, str(FAST))

import easyform_fast as ef  # noqa: E402  (import 시 Ctrl+Esc 감시 스레드도 같이 뜸)

MARKER = "HDSIGN_EASYFORM_V1"
COLS = ("item_code", "item", "spec", "qty", "unit_price")


def _clean(v: str) -> str:
    return " ".join(str(v or "").replace("\t", " ").split())


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    print("이지폼 명세서 읽는 중… 끝날 때까지 마우스·키보드를 만지지 마세요. (멈춤: Ctrl+Esc 길게)")
    time.sleep(0.8)
    ef.focus_easyform()
    ef.wait_if_busy()
    rows, stop = ef.extract_grid(ef.LAYOUT)
    rows = [r for r in rows if any(_clean(r.get(c, "")) for c in COLS)]
    if not rows:
        print("읽은 줄이 없어요. 이지폼에서 상세명세서가 열려 있는지(그리고 창 위치가 평소와 같은지) 확인하세요.")
        _beep(False)
        return 1
    lines = [MARKER] + ["\t".join(_clean(r.get(c, "")) for c in COLS) for r in rows]
    ef.set_clipboard("\r\n".join(lines))
    print(f"완료: {len(rows)}줄 복사됨 (stop={stop}). 홈페이지 명세서 작성 화면에서 Ctrl+V 하세요.")
    for r in rows:
        print("  ", " | ".join(_clean(r.get(c, "")) for c in COLS))
    _beep(True)
    return 0


def _beep(ok: bool) -> None:
    try:
        import winsound
        winsound.MessageBeep(winsound.MB_OK if ok else winsound.MB_ICONHAND)
    except Exception:
        pass


if __name__ == "__main__":
    sys.exit(main())
