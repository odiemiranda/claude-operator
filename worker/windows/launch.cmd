@echo off
rem Starts the app detached so this script returns immediately.
rem The DevTools port (Chromium/Electron/CEF apps, debug builds only) lets cdp-status see app state.
start "" "C:\src\my-app\out\my-app.exe" --remote-debugging-port=9222
