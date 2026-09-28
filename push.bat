@echo off
rem ============================================================================
rem  Push this repository to GitHub.
rem
rem  Keeps the window open so you can read any error, and authenticates through
rem  git's own credential prompt. GitHub no longer accepts an account password
rem  over HTTPS: when prompted for a password, paste a Personal Access Token
rem  (classic, scope "repo"). Create one at:
rem    https://github.com/settings/tokens
rem
rem  NOTE: pure ASCII on purpose -- cmd.exe splits multi-byte UTF-8 characters in
rem  .bat files into bogus commands.
rem ============================================================================
setlocal
cd /d "%~dp0"

set "PROXY=http://127.0.0.1:7890"
set "REPO=https://github.com/pucj0/deepseek-harness-desktop.git"

rem Read the version from package.json instead of hardcoding a tag.
rem This line used to say "v1.0.0" long after that release, so step [2/2] always failed.
for /f "usebackq delims=" %%v in (`node -p "require('./package.json').version"`) do set "TAG=v%%v"

rem A failed read used to be invisible: step [2/2] would "succeed" while pushing an
rem empty ref, and the banner still said DONE. Refuse to continue instead.
if not defined TAG (
  echo [push] ERROR: could not read the version from package.json.
  echo [push] Run this file from the repository root, with node on PATH.
  pause
  exit /b 1
)

echo ============================================================
echo  Pushing to %REPO%
echo  Proxy: %PROXY%
echo.
echo  If asked for a password, paste a Personal Access Token
echo  (classic, scope "repo"): https://github.com/settings/tokens
echo ============================================================
echo.

echo [1/2] Pushing branch master ...
git -c http.proxy=%PROXY% -c https.proxy=%PROXY% push -u origin master
if errorlevel 1 goto :failed

echo.
echo [2/2] Pushing tag %TAG% ...
git -c http.proxy=%PROXY% -c https.proxy=%PROXY% push origin %TAG%
if errorlevel 1 goto :failed

echo.
echo ============================================================
echo  DONE. Pushing the %TAG% tag starts the release workflow:
echo    https://github.com/pucj0/deepseek-harness-desktop/actions
echo ============================================================
pause
exit /b 0

:failed
echo.
echo ============================================================
echo  PUSH FAILED (see the error above).
echo.
echo  Common causes:
rem The arrows below MUST be escaped as ^> . A bare ">" makes cmd.exe treat the
rem rest of the line as a redirection, so instead of printing these hints it
rem silently creates files named after the next word -- this file really did
rem leave "Clash", "check" and "recreate" in the repo root on a failed push.
echo    * Wrong or expired token ^-^> recreate it at the URL above
echo    * Proxy not running       ^-^> Clash Verge must listen on 7890
echo    * No network to GitHub    ^-^> check the proxy is actually on
echo ============================================================
pause
exit /b 1
