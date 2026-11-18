Unicode True
RequestExecutionLevel user
!include LogicLib.nsh

!ifndef VERSION
  !error "VERSION is required"
!endif
!ifndef INPUT_EXE
  !error "INPUT_EXE is required"
!endif
!ifndef APP_ICON
  !error "APP_ICON is required"
!endif
!ifndef NODE_LICENSE
  !error "NODE_LICENSE is required"
!endif
!ifndef OUTPUT_EXE
  !error "OUTPUT_EXE is required"
!endif

Name "Antigravity Quota Injector"
OutFile "${OUTPUT_EXE}"
Icon "${APP_ICON}"
UninstallIcon "${APP_ICON}"
InstallDir "$LOCALAPPDATA\Programs\Antigravity Quota Injector"
InstallDirRegKey HKCU "Software\Antigravity Quota Injector" "InstallDir"
SetCompressor /SOLID lzma

Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Section "Install"
  SetShellVarContext current
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "/oname=Antigravity Quota Injector update.exe" "${INPUT_EXE}"
  ExecWait '"$PLUGINSDIR\Antigravity Quota Injector update.exe" --prepare-update' $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "无法安全关闭正在运行的 Antigravity Quota Injector，安装已取消。" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  SetOutPath "$INSTDIR"
  ClearErrors
  File "/oname=Antigravity Quota Injector.exe" "${INPUT_EXE}"
  ${If} ${Errors}
    MessageBox MB_ICONSTOP "主程序被占用或写入失败，安装已取消；当前正式版本未变更。" /SD IDOK
    SetErrorLevel 3
    Quit
  ${EndIf}
  File "/oname=AppIcon.ico" "${APP_ICON}"
  File "/oname=NODE_LICENSE.txt" "${NODE_LICENSE}"

  WriteRegStr HKCU "Software\Antigravity Quota Injector" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Antigravity Quota Injector" "DisplayName" "Antigravity Quota Injector"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Antigravity Quota Injector" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Antigravity Quota Injector" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Antigravity Quota Injector" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Antigravity Quota Injector" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Antigravity Quota Injector" "NoRepair" 1

  CreateDirectory "$SMPROGRAMS\Antigravity Quota Injector"
  CreateShortCut "$SMPROGRAMS\Antigravity Quota Injector\Antigravity Quota Injector.lnk" "$INSTDIR\Antigravity Quota Injector.exe" "" "$INSTDIR\AppIcon.ico"
  CreateShortCut "$DESKTOP\Antigravity Quota Injector.lnk" "$INSTDIR\Antigravity Quota Injector.exe" "" "$INSTDIR\AppIcon.ico"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  Delete "$DESKTOP\Antigravity Quota Injector.lnk"
  Delete "$SMPROGRAMS\Antigravity Quota Injector\Antigravity Quota Injector.lnk"
  RMDir "$SMPROGRAMS\Antigravity Quota Injector"
  Delete "$INSTDIR\Antigravity Quota Injector.exe"
  Delete "$INSTDIR\AppIcon.ico"
  Delete "$INSTDIR\NODE_LICENSE.txt"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "Software\Antigravity Quota Injector"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Antigravity Quota Injector"
SectionEnd
