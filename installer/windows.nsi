; Per-user installer for Home Library (no admin rights needed). Built by scripts/build-windows.sh.
; Expects /DVERSION=, /DSTAGE= (folder with node.exe, app\, HomeLibrary.vbs, AppIcon.ico) and /DOUTFILE=.
Unicode true
!include "MUI2.nsh"

Name "Home Library"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\HomeLibrary"
RequestExecutionLevel user
SetCompressor /SOLID lzma

!define MUI_ICON "${STAGE}/AppIcon.ico"
!define MUI_UNICON "${STAGE}/AppIcon.ico"
!define MUI_FINISHPAGE_RUN "$WINDIR\System32\wscript.exe"
!define MUI_FINISHPAGE_RUN_PARAMETERS '"$INSTDIR\HomeLibrary.vbs"'
!define MUI_FINISHPAGE_RUN_TEXT "Open Home Library now"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "Install"
  SetOutPath "$INSTDIR"
  File /r "${STAGE}/*.*"
  CreateShortcut "$SMPROGRAMS\Home Library.lnk" "$WINDIR\System32\wscript.exe" '"$INSTDIR\HomeLibrary.vbs"' "$INSTDIR\AppIcon.ico"
  CreateShortcut "$DESKTOP\Home Library.lnk" "$WINDIR\System32\wscript.exe" '"$INSTDIR\HomeLibrary.vbs"' "$INSTDIR\AppIcon.ico"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\HomeLibrary" "DisplayName" "Home Library"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\HomeLibrary" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\HomeLibrary" "DisplayIcon" "$INSTDIR\AppIcon.ico"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\HomeLibrary" "UninstallString" '"$INSTDIR\Uninstall.exe"'
SectionEnd

; The library itself lives in %APPDATA%\HomeLibrary and is deliberately left alone.
Section "Uninstall"
  Delete "$SMPROGRAMS\Home Library.lnk"
  Delete "$DESKTOP\Home Library.lnk"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\HomeLibrary"
  RMDir /r "$INSTDIR"
SectionEnd
