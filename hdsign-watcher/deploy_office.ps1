# ─────────────────────────────────────────────────────────────────────────────
#  HD사인 지시서(사무실) 워처 — 빌드 + 네트워크 배포 한 방 스크립트
# ─────────────────────────────────────────────────────────────────────────────
#  하는 일:
#    1) 이 PC 에서 PyInstaller --onedir 로 hdsign_worksheet.exe 를 새로 빌드
#    2) 산출물(dist\hdsign_worksheet\) 을 사무실 네트워크 마스터로 미러 복사
#         \\Main\현대공유\worksheet-program\hdsign_worksheet\   (= Z:\worksheet-program\...)
#  배포 후:
#    각 사무실 PC 는 바탕화면 "HD사인 지시서(사무실)" 바로가기만 껐다가 다시 실행하면 됨.
#    그 바로가기는 Z:\worksheet-program\launch_hdsign_worksheet.bat 을 가리키고,
#    이 .bat 가 실행 시 robocopy /MIR 로 네트워크 마스터 → C:\HDSign\hdsign_worksheet 에
#    "바뀐 파일만" 동기화한 뒤 로컬 .exe 를 띄운다(이미 떠 있으면 아무 것도 안 함).
#
#  사용:  powershell -NoProfile -ExecutionPolicy Bypass -File deploy_office.ps1
#         (빌드만:  -BuildOnly  /  배포만(이미 빌드됨):  -DeployOnly)
# ─────────────────────────────────────────────────────────────────────────────
param(
    [switch]$BuildOnly,
    [switch]$DeployOnly
)
$ErrorActionPreference = 'Stop'
$here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = 'C:\Users\USER\AppData\Local\Programs\Python\Python39\python.exe'
$distDir = Join-Path $here 'dist\hdsign_worksheet'
$exe     = Join-Path $distDir 'hdsign_worksheet.exe'
# 네트워크 마스터 — 사무실 공유. 한글 폴더명이라 매핑 드라이브(Z:)가 있으면 그쪽을 우선.
$netMaster = 'Z:\worksheet-program\hdsign_worksheet'
if (-not (Test-Path 'Z:\worksheet-program')) { $netMaster = '\\Main\현대공유\worksheet-program\hdsign_worksheet' }

function Step($m) { Write-Host "`n==== $m ====" -ForegroundColor Cyan }

if (-not $DeployOnly) {
    if (-not (Test-Path $python)) { throw "Python 3.9 not found: $python  (이 PC에 맞게 deploy_office.ps1 의 `$python 경로 수정)" }

    Step '실행 중인 워처 종료 (있으면)'
    Get-Process hdsign_worksheet -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

    Step '이전 빌드 산출물 정리'
    foreach ($p in @($distDir, (Join-Path $here 'build'),
                     (Join-Path $here 'dist\hdsign_worksheet.exe'),
                     (Join-Path $here 'hdsign_worksheet.spec'),
                     (Join-Path $here 'hdsign_watcher.spec'))) {
        if (Test-Path $p) { Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue }
    }
    Get-ChildItem (Join-Path $here 'dist') -Filter 'hdsign_worksheet.old_*.exe' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue

    Step '의존성 설치/확인 (pip)'
    # opencv-python-headless: pyzbar(zbar) 와 다른 QR 디코더(cv2.QRCodeDetector) — 인쇄→PDF24
    # 경유 QR 인식 보강. 미설치여도 워처는 cv2=None 으로 정상 동작(보강만 비활성).
    & $python -m pip install --disable-pip-version-check pyinstaller watchdog 'qrcode[pil]' Pillow pywin32 pymupdf pyzbar opencv-python-headless certifi
    if ($LASTEXITCODE -ne 0) { throw "pip install 실패 (인터넷 확인). exit=$LASTEXITCODE" }

    Step 'PyInstaller 빌드 (--onedir)'
    $assetsJpg = Join-Path $here 'assets\distribution.jpg'
    $icoPath   = Join-Path $here 'hdsign_worksheet.ico'
    $script    = Join-Path $here 'hdsign_watcher.py'
    $piArgs = @(
        '-m','PyInstaller','--clean','-y','--onedir','--windowed','--noupx',
        '--name','hdsign_worksheet','--icon',$icoPath,
        '--collect-all','pymupdf','--collect-all','pyzbar','--collect-all','cv2','--collect-all','certifi',
        '--hidden-import','fitz','--hidden-import','pyzbar','--hidden-import','pyzbar.pyzbar',
        '--hidden-import','cv2','--hidden-import','numpy','--hidden-import','encodings.idna','--hidden-import','certifi',
        '--add-data',"$assetsJpg;assets",'--add-data',"$icoPath;.",
        $script
    )
    Push-Location $here
    try { & $python @piArgs } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw "PyInstaller 빌드 실패. exit=$LASTEXITCODE" }
    if (-not (Test-Path $exe)) { throw "빌드 후 exe 없음: $exe" }

    Step 'SumatraPDF 동봉 (이 폴더에 있으면)'
    foreach ($f in @('SumatraPDF.exe','SumatraPDF-settings.txt')) {
        $s = Join-Path $here $f
        if (Test-Path $s) { Copy-Item $s -Destination $distDir -Force; Write-Host "  [bundled] $f" }
        else { Write-Host "  [skip] $f (없음)" }
    }
    Write-Host "`n빌드 완료: $exe" -ForegroundColor Green
}

if ($BuildOnly) { Write-Host "`n(-BuildOnly: 네트워크 배포는 생략)"; return }

Step "네트워크 마스터로 미러 복사 → $netMaster"
if (-not (Test-Path $exe)) { throw "배포할 빌드가 없음: $exe  (먼저 빌드하세요)" }
$netParent = Split-Path -Parent $netMaster
if (-not (Test-Path $netParent)) { throw "네트워크 공유에 접근 불가: $netParent  (Z: 매핑/네트워크 확인)" }
# robocopy: /MIR 미러(추가·변경·삭제 반영), /R:2 /W:2 재시도 짧게, /MT:8 멀티스레드.
& robocopy $distDir $netMaster /MIR /R:2 /W:2 /MT:8 /NFL /NDL /NJH /NJS /NP
$rc = $LASTEXITCODE
# robocopy: 0~7 = 성공(8 이상이 진짜 실패). 0=변경없음, 1=복사함, 3=복사+삭제 등.
if ($rc -ge 8) { throw "robocopy 실패. exit=$rc" }
Write-Host "`n배포 완료 (robocopy rc=$rc).  → $netMaster" -ForegroundColor Green
Write-Host "각 사무실 PC: 바탕화면 'HD사인 지시서(사무실)' 바로가기를 껐다가 다시 실행하면 새 버전으로 갱신됩니다." -ForegroundColor Yellow
