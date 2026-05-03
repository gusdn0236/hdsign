$ErrorActionPreference = "Stop"

$outDir = Join-Path $PSScriptRoot "illustrator_com_registry_export"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

Write-Host "=== Export Illustrator COM registry keys ==="
Write-Host "Output: $outDir"
Write-Host ""

$progIds = Get-ChildItem -Path "Registry::HKEY_CLASSES_ROOT" |
    Where-Object { $_.PSChildName -like "Illustrator.Application*" } |
    Select-Object -ExpandProperty PSChildName

if (-not $progIds) {
    Write-Host "No Illustrator.Application ProgID was found on this PC."
    Read-Host "Press Enter to close"
    exit 1
}

$exported = New-Object System.Collections.Generic.HashSet[string]

function Export-Key {
    param(
        [Parameter(Mandatory = $true)][string]$RegPath,
        [Parameter(Mandatory = $true)][string]$FileName
    )

    if ($exported.Contains($RegPath)) {
        return
    }

    $filePath = Join-Path $outDir $FileName
    Write-Host "Exporting $RegPath"
    & reg.exe export $RegPath $filePath /y | Out-Null
    $exported.Add($RegPath) | Out-Null
}

foreach ($progId in $progIds) {
    Export-Key "HKEY_CLASSES_ROOT\$progId" "$($progId -replace '[\\/:*?""<>|{}]', '_').reg"

    $clsidKey = "Registry::HKEY_CLASSES_ROOT\$progId\CLSID"
    if (-not (Test-Path $clsidKey)) {
        continue
    }

    $clsid = (Get-Item $clsidKey).GetValue("")
    if (-not $clsid) {
        continue
    }

    $safeClsid = $clsid -replace '[\\/:*?""<>|{}]', '_'
    Export-Key "HKEY_CLASSES_ROOT\CLSID\$clsid" "CLSID_$safeClsid.reg"

    $typeLibKey = "Registry::HKEY_CLASSES_ROOT\CLSID\$clsid\TypeLib"
    if (Test-Path $typeLibKey) {
        $typeLib = (Get-Item $typeLibKey).GetValue("")
        if ($typeLib) {
            $safeTypeLib = $typeLib -replace '[\\/:*?""<>|{}]', '_'
            Export-Key "HKEY_CLASSES_ROOT\TypeLib\$typeLib" "TypeLib_$safeTypeLib.reg"
        }
    }
}

$importScript = @'
$ErrorActionPreference = "Stop"

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "Run this script as Administrator."
    Read-Host "Press Enter to close"
    exit 1
}

Write-Host "=== Import Illustrator COM registry keys ==="
Write-Host "Folder: $PSScriptRoot"
Write-Host ""

$files = Get-ChildItem -Path $PSScriptRoot -Filter "*.reg" | Sort-Object Name
if (-not $files) {
    Write-Host "No .reg files found."
    Read-Host "Press Enter to close"
    exit 1
}

foreach ($file in $files) {
    Write-Host "Importing $($file.Name)"
    & reg.exe import $file.FullName
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to import $($file.FullName)"
    }
}

Write-Host ""
Write-Host "Import complete."
Write-Host "Close Illustrator, start Illustrator once, then start hdsign_worksheet.exe."
Read-Host "Press Enter to close"
'@

Set-Content -Path (Join-Path $outDir "import_illustrator_com_registry.ps1") -Value $importScript -Encoding UTF8

Write-Host ""
Write-Host "Export complete."
Write-Host "Copy this whole folder to the problem PC:"
Write-Host "  $outDir"
Write-Host ""
Write-Host "Then run import_illustrator_com_registry.ps1 as Administrator on the problem PC."
Read-Host "Press Enter to close"
