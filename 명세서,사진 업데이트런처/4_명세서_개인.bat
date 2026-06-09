@echo off
chcp 65001 >nul
REM === 명세서 추출(개인) — seek 자동 + 마지막5 표시 + 테넷 fast ===
set "RAW=C:\Users\USER\Desktop\hdsign\easyform-data\easyform_2026_personal_fast.json"
set "CSV=C:\Users\USER\Desktop\hdsign\easyform-data\26년도매출거래목록(개인).csv"
set "ENR=C:\Users\USER\Desktop\hdsign\auto-quote-data\invoices\easyform_2026_personal.json"
set "FAST=C:\Users\USER\Desktop\tenet-test\.tenet\learning\easyform_fast.py"
set "SEEK=C:\Users\USER\Desktop\hdsign\scripts\easyform_seek.py"
set "ENRICH=C:\Users\USER\Desktop\hdsign\scripts\enrich_2026_aligned.py"

echo ============== 명세서 추출 (개인) ==============
echo.
echo  [0단계] 이지폼에서 26년 개인 매출거래목록을 [엑셀(csv)] 로 내보내기.
echo    * 저장 폴더 (여기에 덮어쓰기):
echo        C:\Users\USER\Desktop\hdsign\easyform-data\
echo    * 파일 이름 (정확히 이 이름으로):
echo        26년도매출거래목록(개인).csv
echo    * !!! 주의: 'auto-quote-data\invoices' 폴더에는 절대 넣지 마세요 !!!
echo          (거기는 프로그램이 자동으로 만드는 곳 - CSV 넣으면 데이터 깨짐)
echo.
py -3 "C:\Users\USER\Desktop\hdsign\scripts\easyform_csv_check.py" personal
echo.
echo CSV 새로 했으면 아무 키. 이지폼 개인 목록 정순/최대화/1번째 행 클릭(Enter 금지) 해두세요.
pause >nul

echo.
for /f %%n in ('py -3 "C:\Users\USER\Desktop\hdsign\scripts\easyform_n.py" personal') do set N=%%n
echo 목록을 아래로 %N% 칸 자동으로 내립니다. 키 누른 즉시 '이지폼 창'을 클릭해 활성 상태로 두세요.
pause >nul
py -3 "%SEEK%" %N%

echo.
py -3 "C:\Users\USER\Desktop\hdsign\scripts\easyform_last.py" personal 5
echo.
echo  이지폼에서 위 '마지막 추출'(맨 아래 줄) '다음' 명세서의 상세화면을 여세요.
echo  (지나쳤으면 위로 스크롤). 상세화면 띄우고 준비되면 아무 키.
pause >nul
echo.
echo *** '상세명세서'에 포커스 주고 가만히! 5초 뒤 추출 (끝=자동정지, 중단=Ctrl+Esc 꾹) ***
timeout /t 5 /nobreak
py -3 "%FAST%" --max 2000 --start %N% --out "%RAW%"

echo.
echo [보강] CSV 정렬로 invoices 갱신...
py -3 "%ENRICH%" --json "%RAW%" --csv "%CSV%" --out "%ENR%" --save

echo.
echo ===================================================================
echo   개인 명세서 완료
echo -------------------------------------------------------------------
echo   [다음 할 일]
echo    - 다른 종류 명세서 아직이면 실행 (3_명세서_주식회사 / 4_명세서_개인)
echo    - 사진(1,2번) + 명세서(3,4번) 전부 끝났으면:
echo        ==^> 클로드(이 작업 채팅)에게 "데이터 수집 다 했어, 비전 돌려줘" 라고 하세요.
echo        그럼 비전추출 -^> 매칭 -^> R2업로드 -^> 백엔드 재시작(웹 반영) 진행.
echo ===================================================================
pause