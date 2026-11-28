!include LogicLib.nsh

Function ExtendownBackupComponentChoices
  ${If} ${FileExists} "$INSTDIR\extendown-components\selection.ini"
    InitPluginsDir
    CopyFiles /SILENT "$INSTDIR\extendown-components\selection.ini" "$PLUGINSDIR"
  ${EndIf}
FunctionEnd

!macro ExtendownRemoveLegacyComponentCache
  Delete "$INSTDIR\extendown-components\available\*.gz"
  RMDir "$INSTDIR\extendown-components\available"
!macroend

!macro ExtendownMigrateComponents
  !insertmacro ExtendownRemoveLegacyComponentCache
  ${If} $PLUGINSDIR != ""
  ${AndIf} ${FileExists} "$PLUGINSDIR\selection.ini"
  ${AndIfNot} ${FileExists} "$INSTDIR\extendown-components\selection.ini"
    CreateDirectory "$INSTDIR\extendown-components"
    CopyFiles /SILENT "$PLUGINSDIR\selection.ini" "$INSTDIR\extendown-components"
  ${EndIf}
!macroend

!macro ExtendownRemoveComponents
  Delete "$INSTDIR\extendown-components\selection.ini"
  Delete "$INSTDIR\extendown-components\assets\*.js"
  Delete "$INSTDIR\extendown-components\assets\*.css"
  Delete "$INSTDIR\extendown-components\assets\*.woff"
  Delete "$INSTDIR\extendown-components\assets\*.woff2"
  Delete "$INSTDIR\extendown-components\assets\*.png"
  Delete "$INSTDIR\extendown-components\assets\*.svg"
  !insertmacro ExtendownRemoveLegacyComponentCache
  RMDir "$INSTDIR\extendown-components\assets"
  RMDir "$INSTDIR\extendown-components"
!macroend
