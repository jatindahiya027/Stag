!ifdef APP_ARM64
  !ifndef APP_64
    !ifndef APP_32
      # Load x64.nsh here, before electron-builder defines its extraction
      # macros. The later include is skipped by x64.nsh's include guard.
      !include x64.nsh

      !macro _StagIsNativeARM64 _a _b _t _f
        ReadRegStr $_LOGICLIB_TEMP HKLM \
          "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" \
          "PROCESSOR_ARCHITECTURE"
        StrCmp $_LOGICLIB_TEMP "ARM64" `${_t}` `${_f}`
      !macroend

      !undef IsNativeARM64
      !define IsNativeARM64 `"" StagIsNativeARM64 ""`
    !endif
  !endif
!endif

!macro customInit
  !ifndef BUILD_UNINSTALLER
    !ifdef APP_ARM64
      !ifndef APP_64
        !ifndef APP_32
          ${IfNot} ${IsNativeARM64}
            MessageBox MB_ICONSTOP|MB_TOPMOST|MB_SETFOREGROUND \
              "This installer requires Windows on ARM64. Use the Stag x64 installer on this computer."
            Abort
          ${EndIf}
        !endif
      !endif
    !endif
  !endif
!macroend
