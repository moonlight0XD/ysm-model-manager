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
rem exe 的版本資訊（右鍵內容 → 詳細資料），版本號取自 manager_app.py 的 APP_VERSION
if not exist "%TEMP%\ysm_manager_build" mkdir "%TEMP%\ysm_manager_build"
%PY% "%~dp0make_version.py" "%TEMP%\ysm_manager_build\version_info.txt"
if errorlevel 1 exit /b 1
set /p VER=<"%TEMP%\ysm_manager_build\version.txt"
rem Windows 版只用 Edge WebView2：排除電腦上剛好裝了、但用不到的套件（PyQt 等），縮小 exe
rem 管理器只連本機 http，也排除 OpenSSL（約 6 MB，hashlib 會改用內建的 sha1/sha256）和其他用不到的標準函式庫
%PY% -m PyInstaller --noconfirm --onefile --windowed --name "YSM模型管理器" ^
  --workpath "%TEMP%\ysm_manager_build" --specpath "%TEMP%\ysm_manager_build" ^
  --version-file "%TEMP%\ysm_manager_build\version_info.txt" ^
  --icon "%~dp0assets\icon.ico" ^
  --add-data "%~dp0index.html;." --add-data "%~dp0manager.html;." ^
  --add-data "%~dp0css;css" --add-data "%~dp0js;js" --add-data "%~dp0lib;lib" ^
  --add-data "%~dp0mods;mods" ^
  --exclude-module PyQt5 --exclude-module PyQt6 --exclude-module PySide2 --exclude-module PySide6 ^
  --exclude-module qtpy --exclude-module gi --exclude-module cefpython3 --exclude-module tkinter ^
  --exclude-module setuptools --exclude-module pkg_resources --exclude-module _distutils_hack ^
  --exclude-module unittest --exclude-module pydoc --exclude-module xmlrpc --exclude-module numpy ^
  --exclude-module ssl --exclude-module _ssl --exclude-module _hashlib ^
  --exclude-module decimal --exclude-module _decimal --exclude-module lzma --exclude-module _lzma ^
  --exclude-module bz2 --exclude-module _bz2 --exclude-module asyncio --exclude-module multiprocessing ^
  --exclude-module xml --exclude-module pyexpat ^
  manager_app.py
if errorlevel 1 (
  echo.
  echo 打包失敗，請看上面的錯誤訊息
  exit /b 1
)
rem 檔名加上版本號，例如 dist\YSM模型管理器-v1.1.0.exe
move /y "dist\YSM模型管理器.exe" "dist\YSM模型管理器-v%VER%.exe" >nul
if errorlevel 1 exit /b 1
echo.
echo 完成：dist\YSM模型管理器-v%VER%.exe