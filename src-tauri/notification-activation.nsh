; The persistent registration belongs to the installed app, not to previews.
!define RIVLOOM_NOTIFICATION_APP_ID "com.rivloom.desktop"
!define RIVLOOM_NOTIFICATION_CLSID "{64D03DBD-AEC3-4D61-97B8-E0AC5B9D0734}"

!macro RivloomRegisterNotificationActivation
  !if "${BUNDLEID}" == "${RIVLOOM_NOTIFICATION_APP_ID}"
    SetRegView 64
    WriteRegStr HKCU "Software\Classes\CLSID\${RIVLOOM_NOTIFICATION_CLSID}\LocalServer32" "" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" -ToastActivated'
    WriteRegStr HKCU "Software\Classes\AppUserModelId\${RIVLOOM_NOTIFICATION_APP_ID}" "CustomActivator" "${RIVLOOM_NOTIFICATION_CLSID}"
    WriteRegStr HKCU "Software\Classes\AppUserModelId\${RIVLOOM_NOTIFICATION_APP_ID}" "DisplayName" "${PRODUCTNAME}"
    WriteRegStr HKCU "Software\Classes\AppUserModelId\${RIVLOOM_NOTIFICATION_APP_ID}" "IconUri" "$INSTDIR\${RIVLOOM_SHELL_ICON_RELATIVE}"
    SetRegView lastused
  !endif
!macroend

!macro RivloomUnregisterNotificationActivation
  !if "${BUNDLEID}" == "${RIVLOOM_NOTIFICATION_APP_ID}"
    SetRegView 64
    Push $0
    ReadRegStr $0 HKCU "Software\Classes\CLSID\${RIVLOOM_NOTIFICATION_CLSID}\LocalServer32" ""
    ; An old uninstaller must not remove a registration owned by a newer path.
    ${If} $0 == '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" -ToastActivated'
      DeleteRegKey HKCU "Software\Classes\CLSID\${RIVLOOM_NOTIFICATION_CLSID}"
      ReadRegStr $0 HKCU "Software\Classes\AppUserModelId\${RIVLOOM_NOTIFICATION_APP_ID}" "CustomActivator"
      ${If} $0 == "${RIVLOOM_NOTIFICATION_CLSID}"
        DeleteRegValue HKCU "Software\Classes\AppUserModelId\${RIVLOOM_NOTIFICATION_APP_ID}" "CustomActivator"
        ReadRegStr $0 HKCU "Software\Classes\AppUserModelId\${RIVLOOM_NOTIFICATION_APP_ID}" "DisplayName"
        ${If} $0 == "${PRODUCTNAME}"
          DeleteRegValue HKCU "Software\Classes\AppUserModelId\${RIVLOOM_NOTIFICATION_APP_ID}" "DisplayName"
        ${EndIf}
        ReadRegStr $0 HKCU "Software\Classes\AppUserModelId\${RIVLOOM_NOTIFICATION_APP_ID}" "IconUri"
        ${If} $0 == "$INSTDIR\${RIVLOOM_SHELL_ICON_RELATIVE}"
          DeleteRegValue HKCU "Software\Classes\AppUserModelId\${RIVLOOM_NOTIFICATION_APP_ID}" "IconUri"
        ${EndIf}
        DeleteRegKey /ifempty HKCU "Software\Classes\AppUserModelId\${RIVLOOM_NOTIFICATION_APP_ID}"
      ${EndIf}
    ${EndIf}
    Pop $0
    SetRegView lastused
  !endif
!macroend
