@echo off
cd /d "%~dp0"
echo Checking dependencies...
call npm ls --silent >nul 2>&1
if errorlevel 1 (
    echo Installing missing dependencies...
    call npm install
    if errorlevel 1 (
        echo npm install failed.
        pause
        exit /b 1
    )
)
node index.js
pause
