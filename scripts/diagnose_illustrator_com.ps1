$ErrorActionPreference = "Continue"

Write-Host "=== HD Sign Illustrator COM diagnosis ==="
Write-Host ""

$roots = @(
    "Registry::HKEY_CLASSES_ROOT",
    "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Classes",
    "Registry::HKEY_CURRENT_USER\SOFTWARE\Classes",
    "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Classes"
)

$allProgIds = New-Object System.Collections.Generic.List[string]

foreach ($root in $roots) {
    Write-Host "Checking $root"
    try {
        $items = Get-ChildItem -Path $root -ErrorAction Stop |
            Where-Object { $_.PSChildName -like "Illustrator.Application*" } |
            Select-Object -ExpandProperty PSChildName

        if ($items) {
            foreach ($item in $items) {
                Write-Host "  FOUND: $item"
                if (-not $allProgIds.Contains($item)) {
                    $allProgIds.Add($item)
                }
            }
        } else {
            Write-Host "  none"
        }
    } catch {
        Write-Host "  error: $($_.Exception.Message)"
    }
    Write-Host ""
}

if ($allProgIds.Count -eq 0) {
    Write-Host "RESULT: No Illustrator.Application ProgID is registered."
    Write-Host ""
    Write-Host "Fix:"
    Write-Host "  1. Close Illustrator and the watcher."
    Write-Host "  2. Open Adobe Creative Cloud."
    Write-Host "  3. Repair or reinstall Adobe Illustrator."
    Write-Host "  4. Start Illustrator once, then start hdsign_worksheet.exe again."
    Write-Host ""
    Write-Host "If repair is not available, uninstall Illustrator, reboot, then install it again."
    Read-Host "Press Enter to close"
    exit 1
}

Write-Host "Testing COM activation with registered ProgIDs..."
foreach ($progid in $allProgIds) {
    try {
        $app = [Runtime.InteropServices.Marshal]::GetActiveObject($progid)
        Write-Host "  OK active object: $progid"
        Read-Host "Press Enter to close"
        exit 0
    } catch {
        Write-Host "  active object failed: $progid -> $($_.Exception.Message)"
    }
}

Write-Host ""
Write-Host "RESULT: ProgID exists, but no running Illustrator COM object was reachable."
Write-Host ""
Write-Host "Fix:"
Write-Host "  1. Start Illustrator first."
Write-Host "  2. Run the watcher and Illustrator with the same privilege level."
Write-Host "  3. If it still fails, repair or reinstall Illustrator."
Read-Host "Press Enter to close"
