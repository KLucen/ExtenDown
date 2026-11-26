!include LogicLib.nsh
!include nsDialogs.nsh

!define EXTENDOWN_FILES "${__FILEDIR__}\..\target\optional-components"
!include "${EXTENDOWN_FILES}\component-files.nsh"
!include "${EXTENDOWN_FILES}\component-catalog.nsh"
!define EXTENDOWN_INSTALL_CHOICES "Software\ExtenDown\InstallerChoices"

Var componentsInitialized

!macro ExtendownDeclare group
  Var pick_${group}
  Var check_${group}
!macroend
!insertmacro EXTENDOWN_COMPONENT_DECLARE

!macro ExtendownLoadChoice group
  ClearErrors
  ReadRegDWORD $pick_${group} SHCTX "${EXTENDOWN_INSTALL_CHOICES}" "${group}"
  ${If} ${Errors}
    StrCpy $pick_${group} 1
  ${EndIf}
!macroend

Function ExtendownLoadChoices
  ${If} $componentsInitialized == ""
    !insertmacro EXTENDOWN_COMPONENT_LOAD
    StrCpy $componentsInitialized 1
  ${EndIf}
FunctionEnd

!macro ExtendownCheckbox group label left offset
  ${NSD_CreateCheckbox} ${left} ${offset} 48% 12u "${label}"
  Pop $check_${group}
  ${If} $pick_${group} = 1
    ${NSD_Check} $check_${group}
  ${EndIf}
!macroend

!macro ExtendownCategory label left offset
  ${NSD_CreateLabel} ${left} ${offset} 48% 11u "${label}"
  Pop $0
!macroend

!macro ExtendownSetCheck group enabled
  ${NSD_SetState} $check_${group} ${enabled}
!macroend

Function ExtendownMinimal
  Pop $0
  !insertmacro EXTENDOWN_COMPONENT_MINIMAL
FunctionEnd

Function ExtendownRecommended
  Pop $0
  !insertmacro EXTENDOWN_COMPONENT_RECOMMENDED
FunctionEnd

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
  !insertmacro MUI_HEADER_TEXT "可选组件" "选择要随 ExtenDown 安装的扩展。"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == "error"
    Abort
  ${EndIf}
  ${NSD_CreateButton} 0 0 52u 14u "精简"
  Pop $0
  ${NSD_OnClick} $0 ExtendownMinimal
  ${NSD_CreateButton} 57u 0 52u 14u "推荐"
  Pop $0
  ${NSD_OnClick} $0 ExtendownRecommended
  ${NSD_CreateLabel} 0 17u 100% 12u "自定义可直接勾选下方组件。"
  Pop $0
  !insertmacro EXTENDOWN_COMPONENT_CHECKS
  nsDialogs::Show
FunctionEnd

!macro ExtendownReadCheckbox group
  ${NSD_GetState} $check_${group} $pick_${group}
!macroend

Function ExtendownComponentsLeave
  !insertmacro EXTENDOWN_COMPONENT_READ
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
  !insertmacro EXTENDOWN_COMPONENT_SAVE
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
