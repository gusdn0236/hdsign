' HD Sign Field Worksheet - Integrated Launcher
' 1. Start hdsign_field_agent.exe if not already running (background)
' 2. Open the sidebar (/field) in --app mode using a Chromium browser
'    (Chrome / Edge / Brave / Vivaldi — whichever is installed)
' 3. Wait for that window to close, then stop the agent
'    (closing the sidebar = closing the whole thing).
'
' If no Chromium browser is found, falls back to the default browser
' (no dedicated window / no auto-stop in that case — install Chrome or Edge for the full flow).
'
' Place this on the network share. Each field PC just needs a shortcut
' (.lnk) on its desktop pointing to this .vbs.

Option Explicit

Dim shell, fso, scriptDir, agentExeNet, agentExe, binDir, sidebarUrl, profileDir
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
' 네트워크 마스터 .exe — 배포 스크립트가 여기에 새 빌드를 떨군다.
agentExeNet = scriptDir & "\hdsign_field_agent.exe"
sidebarUrl = "https://hdsigncraft.com/field"
' 전용 프로필 — 브라우저 메인 프로필의 "마지막 창 상태" 를 안 건드리려고 분리.
profileDir = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\HDSignFieldViewer"
' 실제로 실행하는 .exe 는 항상 이 로컬 복사본 — 네트워크 마스터를 직접 실행하면 그 파일이
' 잠겨서, 다음 배포 때 "프로그램 먼저 꺼 달라" 고 일일이 부탁해야 했다(워처와 동일한 구조로
' 통일: 네트워크는 마스터만, 실행은 로컬 복사본). 이 .vbs 가 띄울 때마다 네트워크 → 로컬로
' (에이전트가 안 떠 있을 때만) 덮어써서 다음 실행에 새 버전이 자동 반영된다.
binDir = profileDir & "\bin"
agentExe = binDir & "\hdsign_field_agent.exe"

' --- 0a. Self-heal the desktop shortcut icon ----------------------------
' The shipped .lnk files point IconLocation at the UNC .ico
' (\\Main\현대공유\field-agent\hdsign_field.ico). Explorer is flaky about
' fetching icons over UNC — especially with a non-ASCII share name — so the
' shortcuts often render as a blank page. Fix: copy the .ico to a local path
' once, then re-point any desktop shortcut that launches this program at the
' local copy. Best-effort — never let this block startup.
On Error Resume Next
Dim icoSrc, icoLocal, wantIcon, deskDir, deskFolder, f, lnk, isOurs
icoSrc = scriptDir & "\..\hdsign_field.ico"
icoLocal = profileDir & "\hdsign_field.ico"
If fso.FileExists(icoSrc) Then
    If Not fso.FolderExists(profileDir) Then fso.CreateFolder(profileDir)
    fso.CopyFile icoSrc, icoLocal, True       ' overwrite so logo updates propagate
End If
If fso.FileExists(icoLocal) Then
    wantIcon = icoLocal & ",0"
    deskDir = shell.SpecialFolders("Desktop")
    If fso.FolderExists(deskDir) Then
        Set deskFolder = fso.GetFolder(deskDir)
        For Each f In deskFolder.Files
            If LCase(fso.GetExtensionName(f.Name)) = "lnk" Then
                Set lnk = shell.CreateShortcut(f.Path)
                isOurs = ((InStr(LCase(lnk.Arguments), "field-agent") > 0) And (InStr(LCase(lnk.Arguments), "launcher.vbs") > 0)) _
                      Or (InStr(LCase(lnk.TargetPath), "hdsign_field_agent") > 0)
                If isOurs And (lnk.IconLocation <> wantIcon) Then
                    lnk.IconLocation = wantIcon
                    lnk.Save
                End If
            End If
        Next
    End If
End If
Err.Clear
On Error Goto 0

' --- 0. Already-open guard ----------------------------------------------
' 사이드바(우리 --user-data-dir 의 브라우저) 가 이미 떠 있으면 새로 안 띄우고
' 에이전트도 안 건드리고 그냥 종료. (두 번 실행해도 안전.)
Dim wmi, procs, proc
On Error Resume Next
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
If Err.Number = 0 Then
    Set procs = wmi.ExecQuery("SELECT CommandLine FROM Win32_Process WHERE Name='chrome.exe' OR Name='msedge.exe' OR Name='brave.exe' OR Name='vivaldi.exe'")
    For Each proc In procs
        If Not IsNull(proc.CommandLine) Then
            If InStr(proc.CommandLine, "HDSignFieldViewer") > 0 And InStr(proc.CommandLine, "--app=") > 0 Then
                WScript.Quit 0
            End If
        End If
    Next
End If
Err.Clear
On Error Goto 0

' --- 1. Health check the local agent (port 17345) -----------------------
Dim isAlive, http
isAlive = False
On Error Resume Next
Set http = CreateObject("MSXML2.XMLHTTP")
http.Open "GET", "http://127.0.0.1:17345/health", False
http.Send
If Err.Number = 0 And http.Status = 200 Then isAlive = True
Err.Clear
On Error Goto 0

If Not isAlive Then
    ' 에이전트가 안 떠 있는 지금만 네트워크 마스터 → 로컬 복사본으로 갱신(떠 있으면 로컬
    ' .exe 가 잠겨서 복사 실패하므로 시도 안 함 — 그 경우 어차피 이미 실행 중이라 이 블록을
    ' 안 탄다). 네트워크 접근 불가/복사 실패면 직전 로컬 복사본 그대로 실행(워처와 동일).
    On Error Resume Next
    If Not fso.FolderExists(profileDir) Then fso.CreateFolder(profileDir)
    If Not fso.FolderExists(binDir) Then fso.CreateFolder(binDir)
    If fso.FileExists(agentExeNet) Then fso.CopyFile agentExeNet, agentExe, True
    ' 디버그 .exe 도 같이 로컬로 — 디버그 바로가기가 로컬 복사본을 가리키는 경우 대비(있으면).
    If fso.FileExists(scriptDir & "\hdsign_field_agent_debug.exe") Then _
        fso.CopyFile scriptDir & "\hdsign_field_agent_debug.exe", binDir & "\hdsign_field_agent_debug.exe", True
    Err.Clear
    On Error Goto 0

    If Not fso.FileExists(agentExe) Then
        If fso.FileExists(agentExeNet) Then
            ' 로컬 복사가 실패했지만 네트워크엔 있다 — 마지막 수단으로 네트워크에서 직접 실행
            ' (이 경우만 네트워크 .exe 가 잠긴다. 다음 배포 전에 사이드바를 닫아야 함.)
            agentExe = agentExeNet
        Else
            MsgBox "hdsign_field_agent.exe not found:" & vbCrLf & agentExeNet, 16, "HD Sign"
            WScript.Quit 1
        End If
    End If
    shell.Run """" & agentExe & """", 0, False   ' hidden, no wait — agent is --noconsole
    WScript.Sleep 1500                            ' let the bootloader bind the port
End If

' --- 2. Locate a Chromium browser --------------------------------------
Dim pf, pfx86, lad
pf   = shell.ExpandEnvironmentStrings("%ProgramFiles%")
pfx86 = shell.ExpandEnvironmentStrings("%ProgramFiles(x86)%")
lad  = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%")

Dim browserPaths, browserExe, p
browserPaths = Array( _
    pf    & "\Google\Chrome\Application\chrome.exe", _
    pfx86 & "\Google\Chrome\Application\chrome.exe", _
    lad   & "\Google\Chrome\Application\chrome.exe", _
    pfx86 & "\Microsoft\Edge\Application\msedge.exe", _
    pf    & "\Microsoft\Edge\Application\msedge.exe", _
    pf    & "\BraveSoftware\Brave-Browser\Application\brave.exe", _
    pfx86 & "\BraveSoftware\Brave-Browser\Application\brave.exe", _
    lad   & "\BraveSoftware\Brave-Browser\Application\brave.exe", _
    pf    & "\Vivaldi\Application\vivaldi.exe", _
    lad   & "\Vivaldi\Application\vivaldi.exe" _
)
browserExe = ""
For Each p In browserPaths
    If fso.FileExists(p) Then
        browserExe = p
        Exit For
    End If
Next

' --- 3a. No Chromium browser → open in the default browser, no auto-stop ---
' (창 닫힘 감지가 불가능 → 에이전트가 백그라운드로 남음. Chrome/Edge 설치 권장.)
If browserExe = "" Then
    shell.Run "cmd /c start """" """ & sidebarUrl & """", 0, False
    WScript.Quit 0
End If

' --- 3b. Open the sidebar and WAIT for it to close ----------------------
' --user-data-dir 가 새 프로필이라 여기서 띄운 브라우저 프로세스가 메인 → 창 닫을
' 때까지 살아 있음 → shell.Run(..., True) 가 그때까지 블록.
' Adjust --window-size / --window-position per monitor if needed.
Dim browserArgs
browserArgs = "--app=" & sidebarUrl _
    & " --user-data-dir=""" & profileDir & """" _
    & " --window-size=420,1080 --window-position=1500,0"
shell.Run """" & browserExe & """ " & browserArgs, 1, True

' --- 4. Sidebar closed → stop the agent ---------------------------------
shell.Run "taskkill /F /T /IM hdsign_field_agent.exe", 0, True
shell.Run "taskkill /F /T /IM hdsign_field_agent_debug.exe", 0, True
