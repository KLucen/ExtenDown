!include LogicLib.nsh
!include nsDialogs.nsh

!define EXTENDOWN_COMPONENT_FILES "${__FILEDIR__}\\..\\target\\optional-components"
!include "${EXTENDOWN_COMPONENT_FILES}\\component-catalog.nsh"

Var componentsSelectionCreated
Var UpgradeMode
!macro ExtendownDeclare group
  Var pick_${group}
  Var check_${group}
!macroend
!insertmacro EXTENDOWN_COMPONENT_DECLARE

Function ExtendownSkipComponentPage
  ${GetOptions} $CMDLINE "/UPDATE" $0
  ${IfNot} ${Errors}
    Abort
  ${EndIf}
  ${GetOptions} $CMDLINE "/P" $0
  ${IfNot} ${Errors}
    Abort
  ${EndIf}
  ${If} $UpgradeMode = 1
    Abort
  ${EndIf}
  ${If} ${Silent}
    Abort
  ${EndIf}
FunctionEnd

!macro ExtendownCategory label left offset
  ${NSD_CreateLabel} ${left} ${offset} 48% 11u "${label}"
  Pop $0
!macroend

!macro ExtendownCheckbox group label left offset
  ${NSD_CreateCheckbox} ${left} ${offset} 48% 12u "${label}"
  Pop $check_${group}
  ${If} $pick_${group} = 1
    ${NSD_Check} $check_${group}
  ${EndIf}
!macroend

!macro ExtendownLoadInitialChoice group
  ClearErrors
  ReadINIStr $pick_${group} "$PLUGINSDIR\\selection.ini" "components" "${group}"
  ${If} ${Errors}
    ClearErrors
    ReadINIStr $pick_${group} "$INSTDIR\\extendown-components\\selection.ini" "components" "${group}"
    ${If} ${Errors}
      StrCpy $pick_${group} 0
    ${EndIf}
  ${EndIf}
!macroend

Function ExtendownComponentsPage
  Call ExtendownSkipComponentPage
  InitPluginsDir
  !insertmacro EXTENDOWN_COMPONENT_LOAD
  !insertmacro MUI_HEADER_TEXT "可选组件" "选择要从 GitHub 下载并安装的组件。"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == "error"
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 14u "首次启动后也可在「设置 → 插件」中再安装。"
  Pop $0
  !insertmacro EXTENDOWN_COMPONENT_CHECKS
  nsDialogs::Show
FunctionEnd

!macro ExtendownReadChoice group
  ${NSD_GetState} $check_${group} $pick_${group}
  ${If} $pick_${group} = ${BST_CHECKED}
    StrCpy $pick_${group} 1
    StrCpy $componentsSelectionCreated 1
  ${Else}
    StrCpy $pick_${group} 0
  ${EndIf}
  WriteINIStr "$PLUGINSDIR\\selection.ini" "components" "${group}" "$pick_${group}"
!macroend

Function ExtendownComponentsLeave
  StrCpy $componentsSelectionCreated 0
  InitPluginsDir
  Delete "$PLUGINSDIR\\selection.ini"
  !insertmacro EXTENDOWN_COMPONENT_READ
  ${If} $componentsSelectionCreated = 1
    WriteINIStr "$PLUGINSDIR\\selection.ini" "installer" "download-selected" "1"
  ${EndIf}
FunctionEnd

Function ExtendownBackupComponentChoices
  ${If} ${FileExists} "$INSTDIR\\extendown-components\\selection.ini"
    InitPluginsDir
    CopyFiles /SILENT "$INSTDIR\\extendown-components\\selection.ini" "$PLUGINSDIR"
  ${EndIf}
FunctionEnd

!macro ExtendownRemoveLegacyComponentCache
  Delete "$INSTDIR\\extendown-components\\available\\*.gz"
  RMDir "$INSTDIR\\extendown-components\\available"
!macroend

!macro ExtendownMigrateComponents
  !insertmacro ExtendownRemoveLegacyComponentCache
  ${If} $PLUGINSDIR != ""
  ${AndIf} ${FileExists} "$PLUGINSDIR\\selection.ini"
    CreateDirectory "$INSTDIR\\extendown-components"
    CopyFiles /SILENT "$PLUGINSDIR\\selection.ini" "$INSTDIR\\extendown-components"
  ${EndIf}
!macroend

!macro ExtendownRemoveComponents
  Delete "$INSTDIR\\extendown-components\\selection.ini"
  Delete "$INSTDIR\\extendown-components\\assets\\*.js"
  Delete "$INSTDIR\\extendown-components\\assets\\*.css"
  Delete "$INSTDIR\\extendown-components\\assets\\*.woff"
  Delete "$INSTDIR\\extendown-components\\assets\\*.woff2"
  Delete "$INSTDIR\\extendown-components\\assets\\*.png"
  Delete "$INSTDIR\\extendown-components\\assets\\*.svg"
  !insertmacro ExtendownRemoveLegacyComponentCache
  RMDir "$INSTDIR\\extendown-components\\assets"
  RMDir "$INSTDIR\\extendown-components"
!macroend
