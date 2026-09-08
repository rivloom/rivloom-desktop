!include "${__FILEDIR__}\brand-icon.nsh"
!include "${__FILEDIR__}\notification-activation.nsh"

Var RivloomShellIcon
Var RivloomShortcutTarget
Var RivloomDesktopShortcut
Var RivloomStartMenuShortcut

; Stack argument: shortcut path. Only change an existing link to this installed
; executable. Loading/saving the link preserves arguments, working directory,
; AppUserModelID and other properties, unlike replacing the whole shortcut.
Function RivloomRefreshShortcutIcon
  Exch $R0
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  ${If} $RivloomShellIcon != ""
  ${AndIf} ${FileExists} "$RivloomShellIcon"
  ${AndIf} ${FileExists} "$R0"
    !insertmacro ComHlpr_CreateInProcInstance ${CLSID_ShellLink} ${IID_IShellLink} r0 ""
    ${If} $0 P<> 0
      ${IUnknown::QueryInterface} $0 '("${IID_IPersistFile}", .r1)'
      ${If} $1 P<> 0
        ${IPersistFile::Load} $1 '("$R0", ${STGM_READWRITE}) i.r3'
        ${If} $3 = 0
          ${IShellLink::GetPath} $0 '(w .r2, i ${NSIS_MAX_STRLEN}, p 0, i 4) i.r3'
          ${If} $3 = 0
          ${AndIf} $2 == $RivloomShortcutTarget
            ${IShellLink::GetIconLocation} $0 '(w .r2, i ${NSIS_MAX_STRLEN}, *i .r4) i.r3'
            ${If} $3 != 0
            ${OrIf} $2 != $RivloomShellIcon
            ${OrIf} $4 != 0
              ${IShellLink::SetIconLocation} $0 '(w "$RivloomShellIcon", i 0) i.r3'
              ${If} $3 = 0
                ${IPersistFile::Save} $1 '("$R0", 1) i.r3'
                ${If} $3 = 0
                  System::Call 'shell32::SHChangeNotify(i 0x2000, i 0x1005, w "$R0", p 0)'
                ${EndIf}
              ${EndIf}
            ${EndIf}
          ${EndIf}
        ${EndIf}
        ${IUnknown::Release} $1 ""
      ${EndIf}
      ${IUnknown::Release} $0 ""
    ${EndIf}
  ${EndIf}
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
  Pop $R0
FunctionEnd

Function RivloomRefreshShellShortcuts
  Push "$RivloomDesktopShortcut"
  Call RivloomRefreshShortcutIcon
  Push "$RivloomStartMenuShortcut"
  Call RivloomRefreshShortcutIcon
FunctionEnd

; In a GUI install, Tauri creates the optional desktop link on the finish page,
; after POSTINSTALL. Refresh it once that page has closed as well.
Function .onGUIEnd
  Call RivloomRefreshShellShortcuts
FunctionEnd

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro RivloomRegisterNotificationActivation
  StrCpy $RivloomShellIcon "$INSTDIR\${RIVLOOM_SHELL_ICON_RELATIVE}"
  StrCpy $RivloomShortcutTarget "$INSTDIR\${MAINBINARYNAME}.exe"
  StrCpy $RivloomDesktopShortcut "$DESKTOP\${PRODUCTNAME}.lnk"
  !if "${STARTMENUFOLDER}" != ""
    StrCpy $RivloomStartMenuShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
  !else
    StrCpy $RivloomStartMenuShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  !endif
  Call RivloomRefreshShellShortcuts
  ; SHCNE_UPDATEITEM = 0x2000, SHCNF_PATHW | SHCNF_FLUSH = 0x1005.
  System::Call 'shell32::SHChangeNotify(i 0x2000, i 0x1005, w "$INSTDIR\${MAINBINARYNAME}.exe", p 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro RivloomUnregisterNotificationActivation
!macroend
