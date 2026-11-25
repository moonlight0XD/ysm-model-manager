@echo off
chcp 65001 >nul
rem 打包成 dist\YSM模型管理器.exe（需要 Python 與：pip install pywebview pyinstaller）
cd /d "%~dp0"
rem 先用 py 啟動器（Windows 的 python 指令可能只是 Microsoft Store 的捷徑）
rem 用完整路徑執行（PATH 裡若有不成對的引號，cmd 會找不到後面的程式）
set PY=
for /f "delims=" %%i in ('where py 2^>nul') do if not defined PY set PY="%%i" -3
if not defined PY for /f "delims=" %%i in ('where python 2^>nul') do if not defined PY set PY="%%i"
if not defined PY (
  echo 找不到 Python，請先安裝 Python 3
  exit /b 1
)
%PY% -m PyInstaller --noconfirm --onefile --windowed --name "YSM模型管理器" ^
  --workpath "%TEMP%\ysm_manager_build" --specpath "%TEMP%\ysm_manager_build" ^
  --add-data "%~dp0index.html;." --add-data "%~dp0manager.html;." ^
  --add-data "%~dp0css;css" --add-data "%~dp0js;js" --add-data "%~dp0lib;lib" ^
  --add-data "%~dp0mods;mods" ^
  manager_app.py
if errorlevel 1 (
  echo.
  echo 打包失敗，請看上面的錯誤訊息
  exit /b 1
)
echo.
echo 完成：dist\YSM模型管理器.exe
