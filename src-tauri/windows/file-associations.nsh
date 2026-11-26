!include "${__FILEDIR__}\components.nsh"

!define EXTENDOWN_PROG_ID "ExtenDown.Markdown"
!define EXTENDOWN_CAPABILITIES "Software\ExtenDown\Capabilities"

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro ExtendownInstallComponents
  WriteRegStr SHCTX "Software\Classes\${EXTENDOWN_PROG_ID}" "" "ExtenDown Markdown document"
  WriteRegStr SHCTX "Software\Classes\${EXTENDOWN_PROG_ID}\DefaultIcon" "" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0'
  WriteRegStr SHCTX "Software\Classes\${EXTENDOWN_PROG_ID}\shell\open\command" "" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\"'
  WriteRegStr SHCTX "Software\Classes\.md\OpenWithProgids" "${EXTENDOWN_PROG_ID}" ""
  WriteRegStr SHCTX "Software\Classes\.markdown\OpenWithProgids" "${EXTENDOWN_PROG_ID}" ""
  WriteRegStr SHCTX "${EXTENDOWN_CAPABILITIES}" "ApplicationName" "ExtenDown"
  WriteRegStr SHCTX "${EXTENDOWN_CAPABILITIES}" "ApplicationDescription" "Edit and preview Markdown documents"
  WriteRegStr SHCTX "${EXTENDOWN_CAPABILITIES}\FileAssociations" ".md" "${EXTENDOWN_PROG_ID}"
  WriteRegStr SHCTX "${EXTENDOWN_CAPABILITIES}\FileAssociations" ".markdown" "${EXTENDOWN_PROG_ID}"
  WriteRegStr SHCTX "Software\RegisteredApplications" "ExtenDown" "${EXTENDOWN_CAPABILITIES}"
  System::Call "shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro ExtendownRemoveComponents
  DeleteRegValue SHCTX "Software\RegisteredApplications" "ExtenDown"
  DeleteRegKey SHCTX "${EXTENDOWN_CAPABILITIES}"
  DeleteRegKey /ifempty SHCTX "Software\ExtenDown"
  DeleteRegValue SHCTX "Software\Classes\.md\OpenWithProgids" "${EXTENDOWN_PROG_ID}"
  DeleteRegValue SHCTX "Software\Classes\.markdown\OpenWithProgids" "${EXTENDOWN_PROG_ID}"
  DeleteRegKey SHCTX "Software\Classes\${EXTENDOWN_PROG_ID}"
  System::Call "shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)"
!macroend
