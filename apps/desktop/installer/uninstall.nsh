; Custom uninstall steps for the FocusLock NSIS uninstaller. Runs after the
; app files are removed (Control Panel uninstall path). Guarantees nothing is
; left behind that can break the machine's network:
;   1. stop and remove the background enforcement service
;   2. restore the OS DNS from the backup FocusLock wrote before routing
;      the resolver through the local filter
;   3. remove the application data directory (contains rules + the backup)

!macro customUnInstall
  DetailPrint "Stopping focuslock background service..."
  nsExec::ExecToLog '"$SYSDIR\sc.exe" stop FocusLockService'
  nsExec::ExecToLog '"$SYSDIR\sc.exe" delete FocusLockService'

  DetailPrint "Restoring the original system DNS settings..."
  SetOutPath "$PLUGINSDIR"
  File "/oname=restore-dns.ps1" "${PROJECT_DIR}\installer\restore-dns.ps1"
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\restore-dns.ps1"'
  RMDir /r "$PLUGINSDIR"

  DetailPrint "Removing focuslock application data..."
  RMDir /r /REBOOTOK "$APPDATA\FocusLock"
!macroend