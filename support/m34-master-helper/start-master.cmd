@echo off
setlocal
set "M34_RUNTIME=%LOCALAPPDATA%\Rivloom\runtime"
if not exist "%M34_RUNTIME%\node.exe" (
  echo Rivloom runtime not found. Install Rivloom 0.1.3 first.
  pause
  exit /b 1
)
"%M34_RUNTIME%\node.exe" "%~dp0scripts\m34-physical-master.ts"
pause
