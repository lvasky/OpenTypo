!define LEGACY_NOMO_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Nomo"

LangString legacyNomoUninstallPrompt 1033 "Nomo is installed on this computer. Uninstall Nomo before installing OpenTypo?"
LangString legacyNomoUninstallPrompt 2052 "检测到已安装 Nomo。是否在安装 OpenTypo 前卸载 Nomo？"
LangString legacyNomoUninstallIncomplete 1033 "Nomo was not completely uninstalled."
LangString legacyNomoUninstallIncomplete 2052 "Nomo 未完成卸载。"
LangString legacyNomoInstallPathConflict 1033 "To keep Nomo, choose a different installation folder for OpenTypo."
LangString legacyNomoInstallPathConflict 2052 "如果要保留 Nomo，请为 OpenTypo 选择其他安装目录。"

!macro ReadLegacyNomoInstallLocation ROOT
  ReadRegStr $R0 ${ROOT} "${LEGACY_NOMO_UNINSTALL_KEY}" "InstallLocation"
  ReadRegStr $R1 ${ROOT} "${LEGACY_NOMO_UNINSTALL_KEY}" "UninstallString"
  StrCpy $R2 $R0 1
  ${If} $R2 == '$\"'
    StrCpy $R0 $R0 -1 1
  ${EndIf}
  ; Only invoke the registered NSIS uninstaller in the Nomo installation folder.
  ${If} $R0 == ""
  ${OrIf} $R1 != '$\"$R0\uninstall.exe$\"'
  ${OrIfNot} ${FileExists} "$R0\uninstall.exe"
  ${OrIfNot} ${FileExists} "$R0\nomo.exe"
    StrCpy $R0 ""
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  IfSilent opentypo_legacy_done
  Push $R0
  Push $R1
  Push $R2

  !insertmacro ReadLegacyNomoInstallLocation HKCU
  ${If} $R0 == ""
    !insertmacro ReadLegacyNomoInstallLocation HKLM
  ${EndIf}
  ${If} $R0 == ""
    Goto opentypo_legacy_restore
  ${EndIf}
  MessageBox MB_ICONQUESTION|MB_YESNO|MB_DEFBUTTON2 "$(legacyNomoUninstallPrompt)" IDYES opentypo_remove_legacy
  Goto opentypo_keep_legacy

opentypo_remove_legacy:

  ; Let the uninstaller show its own options and wait for it to finish.
  ClearErrors
  ExecWait '$\"$R0\uninstall.exe$\" _?=$R0' $R2
  ${If} ${Errors}
  ${OrIf} $R2 != 0
  ${OrIf} ${FileExists} "$R0\nomo.exe"
    MessageBox MB_ICONINFORMATION|MB_OK "$(legacyNomoUninstallIncomplete)"
    Goto opentypo_keep_legacy
  ${EndIf}
  ; _?= runs the uninstaller in place, so clean up the now unused executable.
  Delete "$R0\uninstall.exe"
  RMDir "$R0"
  SetOutPath "$INSTDIR"
  Goto opentypo_legacy_restore

opentypo_keep_legacy:
  GetFullPathName $R1 "$INSTDIR"
  GetFullPathName $R2 "$R0"
  ${If} $R1 == $R2
    MessageBox MB_ICONEXCLAMATION|MB_OK "$(legacyNomoInstallPathConflict)"
    Pop $R2
    Pop $R1
    Pop $R0
    Abort
  ${EndIf}

opentypo_legacy_restore:
  Pop $R2
  Pop $R1
  Pop $R0
opentypo_legacy_done:
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; 注册到 Windows“打开方式”候选列表，但不改写任何文档类型的默认程序。
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe" "FriendlyAppName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".md" ""
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".markdown" ""
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".txt" ""
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".json" ""
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open" "" "Open with ${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""

  WriteRegStr SHCTX "Software\Classes\Nomo.Markdown" "" "Markdown Document"
  WriteRegStr SHCTX "Software\Classes\Nomo.Markdown\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr SHCTX "Software\Classes\Nomo.Markdown\shell\open" "" "Open with ${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Classes\Nomo.Markdown\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""

  WriteRegStr SHCTX "Software\Classes\Nomo.Text" "" "Text Document"
  WriteRegStr SHCTX "Software\Classes\Nomo.Text\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr SHCTX "Software\Classes\Nomo.Text\shell\open" "" "Open with ${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Classes\Nomo.Text\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""

  WriteRegStr SHCTX "Software\Classes\Nomo.Json" "" "JSON Document"
  WriteRegStr SHCTX "Software\Classes\Nomo.Json\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr SHCTX "Software\Classes\Nomo.Json\shell\open" "" "Open with ${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Classes\Nomo.Json\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""

  WriteRegStr SHCTX "Software\Classes\.md\OpenWithList\${MAINBINARYNAME}.exe" "" ""
  WriteRegStr SHCTX "Software\Classes\.md\OpenWithProgids" "Nomo.Markdown" ""
  WriteRegStr SHCTX "Software\Classes\.markdown\OpenWithList\${MAINBINARYNAME}.exe" "" ""
  WriteRegStr SHCTX "Software\Classes\.markdown\OpenWithProgids" "Nomo.Markdown" ""
  WriteRegStr SHCTX "Software\Classes\.txt\OpenWithList\${MAINBINARYNAME}.exe" "" ""
  WriteRegStr SHCTX "Software\Classes\.txt\OpenWithProgids" "Nomo.Text" ""
  WriteRegStr SHCTX "Software\Classes\.json\OpenWithList\${MAINBINARYNAME}.exe" "" ""
  WriteRegStr SHCTX "Software\Classes\.json\OpenWithProgids" "Nomo.Json" ""

  System::Call "shell32::SHChangeNotify(i,i,i,i) (0x08000000, 0x1000, 0, 0)"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; 卸载时只移除 Nomo 自己注册的打开方式入口，保留用户选择的其他默认程序。
  DeleteRegKey SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe"
  DeleteRegKey SHCTX "Software\Classes\Nomo.Markdown"
  DeleteRegKey SHCTX "Software\Classes\Nomo.Text"
  DeleteRegKey SHCTX "Software\Classes\Nomo.Json"
  DeleteRegKey SHCTX "Software\Classes\.md\OpenWithList\${MAINBINARYNAME}.exe"
  DeleteRegValue SHCTX "Software\Classes\.md\OpenWithProgids" "Nomo.Markdown"
  DeleteRegKey SHCTX "Software\Classes\.markdown\OpenWithList\${MAINBINARYNAME}.exe"
  DeleteRegValue SHCTX "Software\Classes\.markdown\OpenWithProgids" "Nomo.Markdown"
  DeleteRegKey SHCTX "Software\Classes\.txt\OpenWithList\${MAINBINARYNAME}.exe"
  DeleteRegValue SHCTX "Software\Classes\.txt\OpenWithProgids" "Nomo.Text"
  DeleteRegKey SHCTX "Software\Classes\.json\OpenWithList\${MAINBINARYNAME}.exe"
  DeleteRegValue SHCTX "Software\Classes\.json\OpenWithProgids" "Nomo.Json"

  System::Call "shell32::SHChangeNotify(i,i,i,i) (0x08000000, 0x1000, 0, 0)"
!macroend
