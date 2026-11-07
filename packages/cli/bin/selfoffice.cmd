@echo off
rem selfoffice launcher for the packaged Windows app: <install>\resources\cli\selfoffice.cmd
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\..\SelfOffice.exe" "%~dp0selfoffice.cjs" %*
endlocal
