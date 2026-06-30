@echo off

:: Start Ollama silently if not running
tasklist /FI "IMAGENAME eq ollama.exe" 2>NUL | find /I "ollama.exe" >NUL
if %errorlevel% neq 0 (
    start "" /b ollama serve >nul 2>nul
)

:: Start dev server (ComfyUI auto-starts via Vite plugin)
start "" /b cmd /c "cd /d "%~dp0" && npm run dev >nul 2>nul"

:: Wait for server, then open browser
timeout /t 3 /nobreak >nul
start "" http://localhost:5173

exit
