!include LogicLib.nsh
!include nsDialogs.nsh

!define EXTENDOWN_FILES "${__FILEDIR__}\..\target\optional-components"
!include "${EXTENDOWN_FILES}\component-files.nsh"
!define EXTENDOWN_INSTALL_CHOICES "Software\ExtenDown\InstallerChoices"

Var componentsInitialized

!macro ExtendownDeclare group
  Var pick_${group}
  Var check_${group}
!macroend
!insertmacro ExtendownDeclare html
!insertmacro ExtendownDeclare math
!insertmacro ExtendownDeclare mermaid
!insertmacro ExtendownDeclare focus
!insertmacro ExtendownDeclare pdf
!insertmacro ExtendownDeclare images
!insertmacro ExtendownDeclare languages
!insertmacro ExtendownDeclare theme

!macro ExtendownLoadChoice group
  ClearErrors
  ReadRegDWORD $pick_${group} SHCTX "${EXTENDOWN_INSTALL_CHOICES}" "${group}"
  ${If} ${Errors}
    StrCpy $pick_${group} 1
  ${EndIf}
!macroend

Function ExtendownLoadChoices
  ${If} $componentsInitialized == ""
    !insertmacro ExtendownLoadChoice html
    !insertmacro ExtendownLoadChoice math
    !insertmacro ExtendownLoadChoice mermaid
    !insertmacro ExtendownLoadChoice focus
    !insertmacro ExtendownLoadChoice pdf
    !insertmacro ExtendownLoadChoice images
    !insertmacro ExtendownLoadChoice languages
    !insertmacro ExtendownLoadChoice theme
    StrCpy $componentsInitialized 1
  ${EndIf}
FunctionEnd

!macro ExtendownCheckbox group label offset
  ${NSD_CreateCheckbox} 0 ${offset} 100% 11u "${label}"
  Pop $check_${group}
  ${If} $pick_${group} = 1
    ${NSD_Check} $check_${group}
  ${EndIf}
!macroend

Page custom ExtendownComponentsPage ExtendownComponentsLeave

Function ExtendownComponentsPage
  ${GetOptions} $CMDLINE "/P" $0
  ${IfNot} ${Errors}
    Abort
  ${EndIf}
  ${GetOptions} $CMDLINE "/UPDATE" $0
  ${IfNot} ${Errors}
    Abort
  ${EndIf}
  Call ExtendownLoadChoices
  !insertmacro MUI_HEADER_TEXT "Optional components" "Choose the extensions to install with ExtenDown."
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == "error"
    Abort
  ${EndIf}
  !insertmacro ExtendownCheckbox html "HTML export" 3u
  !insertmacro ExtendownCheckbox math "Mathematical formulas" 18u
  !insertmacro ExtendownCheckbox mermaid "Mermaid diagrams" 33u
  !insertmacro ExtendownCheckbox focus "Focus view" 48u
  !insertmacro ExtendownCheckbox pdf "PDF export" 63u
  !insertmacro ExtendownCheckbox images "PNG and JPEG export" 78u
  !insertmacro ExtendownCheckbox languages "Additional code highlighting languages" 93u
  !insertmacro ExtendownCheckbox theme "Midnight theme" 108u
  nsDialogs::Show
FunctionEnd

!macro ExtendownReadCheckbox group
  ${NSD_GetState} $check_${group} $pick_${group}
!macroend

Function ExtendownComponentsLeave
  !insertmacro ExtendownReadCheckbox html
  !insertmacro ExtendownReadCheckbox math
  !insertmacro ExtendownReadCheckbox mermaid
  !insertmacro ExtendownReadCheckbox focus
  !insertmacro ExtendownReadCheckbox pdf
  !insertmacro ExtendownReadCheckbox images
  !insertmacro ExtendownReadCheckbox languages
  !insertmacro ExtendownReadCheckbox theme
FunctionEnd

!macro ExtendownSaveChoice group
  WriteINIStr "$INSTDIR\extendown-components\selection.ini" "components" "${group}" "$pick_${group}"
  WriteRegDWORD SHCTX "${EXTENDOWN_INSTALL_CHOICES}" "${group}" $pick_${group}
!macroend

!macro ExtendownInstallComponents
  Call ExtendownLoadChoices
  !insertmacro ExtendownRemoveComponents
  CreateDirectory "$INSTDIR\extendown-components"
  !insertmacro EXTENDOWN_COMPONENT_FILES
  !insertmacro ExtendownSaveChoice html
  !insertmacro ExtendownSaveChoice math
  !insertmacro ExtendownSaveChoice mermaid
  !insertmacro ExtendownSaveChoice focus
  !insertmacro ExtendownSaveChoice pdf
  !insertmacro ExtendownSaveChoice images
  !insertmacro ExtendownSaveChoice languages
  !insertmacro ExtendownSaveChoice theme
  SetOutPath "$INSTDIR"
!macroend

!macro ExtendownRemoveComponents
  Delete "$INSTDIR\extendown-components\selection.ini"
  Delete "$INSTDIR\extendown-components\assets\*.js"
  Delete "$INSTDIR\extendown-components\assets\*.css"
  Delete "$INSTDIR\extendown-components\assets\*.woff"
  Delete "$INSTDIR\extendown-components\assets\*.woff2"
  Delete "$INSTDIR\extendown-components\assets\*.png"
  Delete "$INSTDIR\extendown-components\assets\*.svg"
  RMDir "$INSTDIR\extendown-components\assets"
  RMDir "$INSTDIR\extendown-components"
!macroend
