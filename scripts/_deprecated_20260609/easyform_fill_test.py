"""EasyForm 자동기입 매크로 — 단독 테스트(웹/HTTP 없이 좌표·삽입·붙여넣기만 검증).

slice-14 의 run_easyform_fill 을 가짜 2행으로 직접 호출한다. 좌표가 새 명세서 창에 맞는지,
삽입/붙여넣기가 되는지 눈으로 확인하는 용도.

사용:
    1. 이지폼 → 매출 거래명세서 → [새로작성] → 거래처 선택까지 한다.
       (그 '매출 거래명세서' 창을 맨 앞에 둔다. 캡처할 때와 같은 위치/크기여야 함)
    2. PowerShell:
         py -3 C:\\Users\\USER\\Desktop\\hdsign\\scripts\\easyform_fill_test.py
    3. 5초 카운트다운 동안 이지폼 창을 클릭해 맨 앞으로. 그 뒤 마우스/키보드 만지지 마세요.
    4. 매크로가: 품목칸 클릭 → 흰박스 더블클릭+'2' → 삽입 2번 → 2행 채움.
    5. 결과를 보고: 칸이 제대로 들어갔는지 / 어긋났는지 / 공급가액·세액칸이 먹는지 알려주세요.

⚠ 저장(F5)/전자전송(F11)/Enter 는 절대 안 누릅니다 — 확인 후 직접 저장하세요.
   잘못되면 이지폼에서 그냥 [닫기](Esc) 로 저장 안 하고 빠져나오면 됩니다.
"""
import sys
import time

sys.path.insert(0, r"C:\Users\USER\Desktop\hdsign\field-agent")
import field_agent as f  # noqa: E402

# 가짜 2행 — item_code/item/spec/qty/unit_price/supply/tax (월일=자동, 비고=미사용)
ROWS = [
    {"item_code": "AQ-1", "item": "테스트간판", "spec": "1000x500 · 3도",
     "qty": "2", "unit_price": "15000", "supply": "30000", "tax": "3000"},
    {"item_code": "AQ-2", "item": "아크릴판", "spec": "600x300",
     "qty": "1", "unit_price": "8000", "supply": "8000", "tax": "800"},
]


def main() -> int:
    if not f.EASYFORM_AVAILABLE:
        print("EASYFORM_AVAILABLE=False — 이 PC 는 Win32 자동기입 불가.")
        return 1
    print("=" * 60)
    print(f"이지폼 자동기입 매크로 테스트 — DPI {f.EF_DPI_SCALE:.2f}x, {len(ROWS)}행")
    print(f"흰박스={f.EF_WHITEBOX}  삽입={f.EF_INSERT_BTN}")
    print("=" * 60)
    print("이지폼 [새로작성→거래처선택] '매출 거래명세서' 창을 맨 앞에 두세요.")
    print("5초 후 시작 — 그 다음엔 마우스/키보드 만지지 마세요.")
    for i in range(5, 0, -1):
        print(f"  {i}...", end="\r", flush=True)
        time.sleep(1)
    print()
    ok, msg = f.run_easyform_fill(ROWS)
    print(("성공: " if ok else "실패: ") + msg)
    print("→ 칸이 어긋났으면 좌표를 다시 찍어 조정합니다. 저장은 직접 확인 후 하세요.")
    return 0 if ok else 1


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore
    except Exception:
        pass
    raise SystemExit(main())
