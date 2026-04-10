@echo off
REM Build a standalone Windows .exe of the Kromer notifier using PyInstaller.
REM Requires: Python 3.10+ and PyInstaller (pip install pyinstaller).

cd /d "%~dp0"

echo Installing / verifying dependencies...
python -m pip install -r requirements.txt || goto :fail
python -m pip install pyinstaller || goto :fail

echo.
echo Building executable...
python -m PyInstaller ^
  --onefile ^
  --name kromer-notifier ^
  --icon shitty-logo.ico ^
  --add-data "shitty-logo.png;." ^
  --collect-all winotify ^
  --noconfirm ^
  main.py
if errorlevel 1 goto :fail

echo.
echo Copying runtime files next to the exe...
if not exist dist\config.json copy config.template.json dist\config.json >nul
copy shitty-logo.png dist\shitty-logo.png >nul

echo.
echo ============================================================
echo Build complete: dist\kromer-notifier.exe
echo Make sure dist\config.json is filled in before running.
echo ============================================================
pause
exit /b 0

:fail
echo.
echo Build failed.
pause
exit /b 1
