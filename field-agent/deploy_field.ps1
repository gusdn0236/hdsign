# ─────────────────────────────────────────────────────────────────────────────
#  HD사인 지시서(현장용) 에이전트 — 빌드 + 네트워크 배포 한 방 스크립트
# ─────────────────────────────────────────────────────────────────────────────
#  하는 일:
#    1) 이 PC 에서 PyInstaller --onefile 로 빌드:
#         dist\hdsign_field_agent.exe        (--noconsole, 정식)
#         dist\hdsign_field_agent_debug.exe  (--console,   디버그)   ← -NoDebug 로 생략 가능
#    2) 산출물을 현장 네트워크 배포 폴더로 복사:
#         \\Main\현대공유\field-agent\dist\   (= Z:\field-agent\dist\)
#           ├ hdsign_field_agent.exe
#           ├ hdsign_field_agent_debug.exe
#           └ launcher.vbs                  (repo 의 최신본으로 갱신)
#         \\Main\현대공유\field-agent\hdsign_field.ico  (dist 의 한 칸 위 — launcher.vbs 의
#                                                        ..\hdsign_field.ico 아이콘 자가복구용)
#       ⚠ config.json 과 *.lnk(HD사인 지시서 (현장)/(디버그)) 는 건드리지 않음
#         — config.json 은 모든 현장 PC 공유 설정, .lnk 는 수동 관리.
#  배포 후:
#    각 현장/사무실 PC 는 바탕화면 "HD사인 지시서 (현장).lnk" 를 다시 실행하면 됨.
#    그 .lnk 는 wscript 로 launcher.vbs(네트워크) 를 실행 → 에이전트(.exe, 네트워크 dist\
#    에서 직접 실행)를 띄우고 사이드바(--app https://hdsigncraft.com/field) 를 연다.
#    창 닫으면 에이전트도 종료. ⚠ 그 PC 에서 사이드바가 떠 있으면(=에이전트 실행 중) 그
#    .exe 파일이 잠겨 복사가 실패할 수 있음 — 사이드바 먼저 닫고 배포.
#
#  사용:  powershell -NoProfile -ExecutionPolicy Bypass -File deploy_field.ps1
#         빌드만:  -BuildOnly   /   배포만(이미 빌드됨):  -DeployOnly   /   정식만:  -NoDebug
# ─────────────────────────────────────────────────────────────────────────────
param(
    [switch]$BuildOnly,
    [switch]$DeployOnly,
    [switch]$NoDebug
)
$ErrorActionPreference = 'Stop'
$here    = Split-Path -Parent $MyInvocation.MyCommand.Path
$distDir = Join-Path $here 'dist'
$exe     = Join-Path $distDir 'hdsign_field_agent.exe'
$exeDbg  = Join-Path $distDir 'hdsign_field_agent_debug.exe'
$icoRepo = Join-Path $here 'hdsign_field.ico'
$vbsRepo = Join-Path $here 'launcher.vbs'
# 현장 배포 폴더 — 한글 share명이라 매핑드라이브(Z:)가 있으면 그쪽 우선.
$netRoot = 'Z:\field-agent'
if (-not (Test-Path 'Z:\field-agent')) { $netRoot = '\\Main\현대공유\field-agent' }
$netDist = Join-Path $netRoot 'dist'

function Step($m) { Write-Host "`n==== $m ====" -ForegroundColor Cyan }

# py 런처로 PyInstaller 호출 — field-agent\build.bat / build_debug.bat 와 동일(py -3 = 최신 3.x).
function Invoke-PiBuild([string]$name, [string]$mode) {
    # $mode: '--noconsole' 또는 '--console'
    Push-Location $here
    try {
        & py -3 -m PyInstaller --noconfirm --onefile $mode --name $name --icon $icoRepo (Join-Path $here 'field_agent.py')
    } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw "PyInstaller 빌드 실패 ($name). exit=$LASTEXITCODE" }
}

if (-not $DeployOnly) {
    & py -3 --version *> $null
    if ($LASTEXITCODE -ne 0) { throw "Python 런처(py) 없음 — Python 3.10+ 설치 필요" }

    Step '실행 중인 에이전트 종료 (있으면 — dist exe 잠금 해제)'
    foreach ($n in 'hdsign_field_agent','hdsign_field_agent_debug') {
        Get-Process $n -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    }

    Step 'PyInstaller + certifi 최신화 (pip)'
    & py -3 -m pip install --disable-pip-version-check --upgrade pyinstaller certifi
    if ($LASTEXITCODE -ne 0) { throw "pip install pyinstaller/certifi 실패 (인터넷 확인). exit=$LASTEXITCODE" }

    Step '정식 빌드 (--onefile --noconsole)'
    Invoke-PiBuild 'hdsign_field_agent' '--noconsole'
    if (-not (Test-Path $exe)) { throw "빌드 후 exe 없음: $exe" }

    if (-not $NoDebug) {
        Step '디버그 빌드 (--onefile --console)'
        Invoke-PiBuild 'hdsign_field_agent_debug' '--console'
        if (-not (Test-Path $exeDbg)) { throw "빌드 후 debug exe 없음: $exeDbg" }
    } else {
        Write-Host '(-NoDebug: 디버그 빌드 생략)'
    }
    Write-Host "`n빌드 완료: $exe$(if (-not $NoDebug) { " (+ debug)" })" -ForegroundColor Green
}

if ($BuildOnly) { Write-Host "`n(-BuildOnly: 네트워크 배포는 생략)"; return }

Step "현장 네트워크 배포 폴더로 복사 → $netDist"
if (-not (Test-Path $exe)) { throw "배포할 정식 빌드가 없음: $exe  (먼저 빌드하세요)" }
if (-not (Test-Path $netRoot)) { throw "네트워크 공유에 접근 불가: $netRoot  (Z: 매핑/네트워크 확인)" }
if (-not (Test-Path $netDist)) { New-Item -ItemType Directory -Path $netDist -Force | Out-Null }

# 잠금(다른 PC 가 사이드바 열어 .exe 사용 중) 대비 — 짧게 몇 번 재시도.
function Copy-Retry([string]$src, [string]$dst, [int]$tries = 4) {
    if (-not (Test-Path $src)) { return }
    for ($i = 1; $i -le $tries; $i++) {
        try { Copy-Item -LiteralPath $src -Destination $dst -Force; Write-Host "  [copied] $(Split-Path $src -Leaf) → $dst"; return }
        catch {
            if ($i -eq $tries) { throw "복사 실패: $src → $dst  ($($_.Exception.Message))  ← 그 파일을 쓰는 현장 PC 의 사이드바를 닫고 다시 시도하세요." }
            Write-Host "  [잠김?] $(Split-Path $src -Leaf) 복사 재시도 $i/$tries ..." -ForegroundColor Yellow
            Start-Sleep -Seconds 2
        }
    }
}

Copy-Retry $exe    $netDist
if (-not $NoDebug) { Copy-Retry $exeDbg $netDist }   # -NoDebug 면 네트워크의 기존 디버그 .exe 그대로 둠
Copy-Retry $vbsRepo $netDist                          # launcher.vbs 최신본
Copy-Retry $icoRepo $netRoot                          # ..\hdsign_field.ico (dist 한 칸 위)

Write-Host "`n배포 완료.  → $netDist" -ForegroundColor Green
Write-Host "config.json / *.lnk 은 건드리지 않았습니다(공유 설정 + 수동 관리)." -ForegroundColor DarkGray
Write-Host "각 현장/사무실 PC: 바탕화면 'HD사인 지시서 (현장)' 바로가기를 다시 실행하면 새 버전으로 갱신됩니다." -ForegroundColor Yellow
Write-Host "  (.exe 직접 더블클릭 X — 반드시 .lnk(=wscript launcher.vbs). 사이드바가 떠 있으면 닫았다 다시 열어야 새 .exe 적용)" -ForegroundColor DarkGray
