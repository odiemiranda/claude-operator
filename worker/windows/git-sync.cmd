@echo off
rem Usage: git-sync <ref>
if "%~1"=="" (echo usage: git-sync ^<ref^> & exit /b 2)
cd /d C:\src\my-app || exit /b 1
git fetch --all --prune || exit /b 1
rem The trailing -- makes git read %1 as a ref, never as a file path to restore.
git checkout %1 -- || exit /b 1
git log -1 --oneline
