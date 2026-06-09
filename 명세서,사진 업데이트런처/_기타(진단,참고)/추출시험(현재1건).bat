@echo off
chcp 65001 >nul
echo =====================================================
echo   추출 시험 (현재 열린 상세 1건만) - 좌표/포커스 진단
echo =====================================================
echo.
echo 1) 이지폼에서 아무 명세서나 '상세화면'(자재 보이는 화면)을 여세요.
echo 2) 이지폼 창은 calibration 때와 같게 '최대화' 해주세요.
echo 3) 준비됐으면 아무 키. 그 뒤 '상세명세서'에 포커스 주고 가만히 두세요.
pause >nul
echo.
echo *** 지금 상세명세서 창 클릭해 포커스! 5초 뒤 시험추출(현재 1건) ***
timeout /t 5 /nobreak
py -3 "C:\Users\USER\Desktop\tenet-test\.tenet\learning\easyform_fast.py" --bench
echo.
echo ↑ rows= 값이 0보다 크면 추출 정상(좌표 OK), rows=0 이면 좌표/포커스 문제.
echo (화면이 어두워지고 자물쇠 패널 뜨며 마우스가 셀을 우클릭/복사하는지도 봐주세요)
pause