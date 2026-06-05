"""이지폼 매크로 진단 — 워처 easyform 모듈의 run_easyform_fill 만 직접 호출(오버레이 없음).

목적: '마우스만 움직이고 셀 입력 안 됨' 원인 가르기.
  - 이 테스트가 **되면** → 범인은 딤/패널 오버레이(클릭 가로챔). 오버레이를 고친다.
  - 이 테스트도 **안 되면** → 범인은 ef_click(SendInput 절대좌표) 또는 입력가드. 클릭 방식을 고친다.

사용:
  1. 워처(HD사인 지시서)를 **종료**(이중 가드/충돌 방지).
  2. 이지폼 → 매출 거래명세서 → 새로작성 → 거래처 선택까지 하고 그 창을 맨 앞에 둔다.
  3. PowerShell:
       py -3 C:\\Users\\USER\\Desktop\\hdsign\\hdsign-watcher\\easyform_selftest.py
  4. 5초 카운트다운 동안 이지폼 창 클릭해 맨 앞으로 → 그 뒤 마우스/키보드 만지지 마세요.
  5. 매크로가 2행을 채웁니다. 입력가드 때문에 마우스 잠깁니다(ESC 로 중단 가능).
  6. 결과(셀에 들어갔나/마우스만 움직였나)를 알려주세요.

⚠ 저장(F5)/전자전송 안 함. 잘못되면 Esc 로 저장 없이 닫으세요.
"""
import sys
import time

sys.path.insert(0, r"C:\Users\USER\Desktop\hdsign\hdsign-watcher")
import easyform as e  # noqa: E402

# 행 수 = 첫 인자(기본 20). 20 으로 10행 초과 스크롤 채우기를 검증한다.
N = int(sys.argv[1]) if len(sys.argv) > 1 else 20
ROWS = []
for i in range(1, N + 1):
    up = 1000 * i
    ROWS.append({
        "item_code": f"AQ-{i}", "item": f"테스트{i}", "spec": f"{100 * i}x{50 * i}",
        "qty": str(i), "unit_price": str(up), "supply": str(up * i),
        "tax": str(round(up * i * 0.1)),
    })


def main() -> int:
    if not e.EASYFORM_AVAILABLE:
        print("EASYFORM_AVAILABLE=False")
        return 1
    print("=" * 60)
    print(f"매크로 단독 진단(오버레이 없음) — {N}행, DPI {e.EF_DPI_SCALE:.2f}x, 화면 {e.EF_SCREEN_W}x{e.EF_SCREEN_H}")
    print("이지폼 [새로작성→거래처선택] 창을 맨 앞에 두세요. 5초 후 시작, 마우스 만지지 마세요.")
    for i in range(5, 0, -1):
        print(f"  {i}...", end="\r", flush=True)
        time.sleep(1)
    print()
    ok, msg = e.run_easyform_fill(ROWS)
    print(("성공: " if ok else "실패: ") + msg)
    return 0 if ok else 1


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore
    except Exception:
        pass
    raise SystemExit(main())
