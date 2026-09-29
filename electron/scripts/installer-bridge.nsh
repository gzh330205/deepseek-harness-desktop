; Bridge installer hooks for migrating users from the Tauri shell.
;
; The Tauri updater (tauri-plugin-updater 2.10.1, `src/updater.rs:799,855`) runs the
; downloaded installer as
;
;   DSH.Desktop_<version>_x64-setup.exe /P /R /UPDATE /ARGS "<current exe>"
;
; and then exits its own process immediately. electron-builder's installer only
; understands /S, --updated, /allusers and /currentuser, so without this file a
; migrated user would be walked through the full install wizard.
;
; `FileFunc.nsh` (and therefore ${GetOptions}) is already included through
; `multiUser.nsh`, which installer.nsi pulls in before customInit runs.
;
; Deliberately *not* done here: uninstalling the leftover Tauri build. Running another
; installer's uninstaller with ExecWait has no timeout and would hang the install if it
; ever showed UI. The shell does that on first run instead, where it has a timeout, a
; log, and a way to report failure (see src/legacy-cleanup.ts).

!macro customInit
  ${GetParameters} $R0
  ${GetOptions} $R0 "/UPDATE" $R1
  ${IfNot} ${Errors}
    ; Tauri's update signal: install without any user interaction.
    SetSilent silent
  ${EndIf}
!macroend

; The Tauri updater exits its own process before the installer runs, so something must
; bring the app back. electron-builder only does that for
; `${isForceRun} ${andIf} ${Silent}` (installSection.nsh:106), and Tauri passes neither
; --force-run nor --updated — so a silent bridge install would otherwise end with the
; user staring at a closed app. Verified on a real install:
; docs/electron-p3-verification.md.
;
; By the time customInstall runs, installApplicationFiles, registryAddInstallInfo and
; the shortcuts are all done (installSection.nsh:66-69), so launching here is safe.
!macro customInstall
  ${GetParameters} $R0
  ${GetOptions} $R0 "/UPDATE" $R1
  ${IfNot} ${Errors}
    ExecShell "open" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  ${EndIf}
!macroend

; ─── Make sure the app is not running before files are copied ───────────────────
;
; The updater starts this installer from *inside* the running app, which is still shutting
; down when the installer begins. A running image cannot be overwritten, so without this an
; install can fail partway through copying files.
;
; electron-builder would otherwise insert its own check, which prompts and then leaves the
; process alone; defining `customCheckAppRunning` replaces it entirely (see
; allowOnlyOneInstallerInstance.nsh:37).
;
; Scoped by PID on purpose. An earlier version matched the image name, which also matched
; the *other* installation of this product that happened to be running (same executable
; name, different directory) and killed it — a check meant to protect an install took down
; an app it was never asked to touch. So:
;
;   * `/DSHPID=<pid>` (our updater passes its own PID): wait for that process, then
;     terminate that process and nothing else.
;   * no `/DSHPID` (started by hand, or by the Tauri migration bridge): never terminate by
;     name. Ask first, and act only on a yes; a silent run is left alone entirely.
;
; Named variables rather than `$0`-`$R9`: the generated installer uses every register, and
; this macro runs inside its install section. Strings are English on purpose — this file has
; no BOM, so non-ASCII would be compiled as mojibake by makensis.

Var DshCommandResult
Var DshTaskOutput
Var DshTargetPid
Var DshPidRunning
Var DshNameRunning
Var DshWaitTicks

; Sets `_result` to 1 while the process `$DshTargetPid` is alive, 0 when it is gone.
; `findstr` decides it by exit code (0 found, 1 not found), so nothing depends on the
; localised text `tasklist` prints, and no string matching or extra plugin is involved.
!macro DSH_PID_RUNNING _result
  nsExec::ExecToStack '"$SYSDIR\cmd.exe" /C ""$SYSDIR\tasklist.exe" /NH /FI "PID eq $DshTargetPid" | "$SYSDIR\findstr.exe" /C:"$DshTargetPid" >NUL"'
  Pop $DshCommandResult
  Pop $DshTaskOutput
  StrCpy ${_result} 0
  ${If} $DshCommandResult == 0
    StrCpy ${_result} 1
  ${EndIf}
!macroend

; Sets `_result` to 1 while any process with this product's image name is running.
; Only ever used to ask the user, never to terminate on its own.
!macro DSH_NAME_RUNNING _result
  nsExec::ExecToStack '"$SYSDIR\cmd.exe" /C ""$SYSDIR\tasklist.exe" /NH /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" | "$SYSDIR\findstr.exe" /C:"${APP_EXECUTABLE_FILENAME}" >NUL"'
  Pop $DshCommandResult
  Pop $DshTaskOutput
  StrCpy ${_result} 0
  ${If} $DshCommandResult == 0
    StrCpy ${_result} 1
  ${EndIf}
!macroend

!macro customCheckAppRunning
  ${GetParameters} $R0
  ${GetOptions} $R0 "/DSHPID=" $DshTargetPid
  ${If} ${Errors}
    StrCpy $DshTargetPid ""
  ${EndIf}

  ${If} $DshTargetPid != ""
    StrCpy $DshWaitTicks 0
    ${Do}
      !insertmacro DSH_PID_RUNNING $DshPidRunning
      ${If} $DshPidRunning == 0
        DetailPrint "Process $DshTargetPid has exited; continuing."
        ${ExitDo}
      ${EndIf}
      IntOp $DshWaitTicks $DshWaitTicks + 1
      ${If} $DshWaitTicks > 20
        DetailPrint "Process $DshTargetPid is still running after 10s; terminating that PID."
        nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /PID $DshTargetPid /T /F'
        Pop $DshCommandResult
        Sleep 1500
        ${ExitDo}
      ${EndIf}
      Sleep 500
    ${Loop}
  ${Else}
    !insertmacro DSH_NAME_RUNNING $DshNameRunning
    ${If} $DshNameRunning == 0
      DetailPrint "No running instance found; continuing."
    ${ElseIf} ${Silent}
      ; No PID to target and nobody to ask: leave other applications alone.
      DetailPrint "An instance is running but no target PID was given; not touching it."
    ${Else}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "DSH Desktop appears to be running and must be closed before installing.$\r$\n$\r$\nClick OK to close it and continue, or Cancel to stop the installation." IDOK +2
        Abort
      nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /IM "${APP_EXECUTABLE_FILENAME}" /T /F'
      Pop $DshCommandResult
      Sleep 1500
    ${EndIf}
  ${EndIf}
!macroend
