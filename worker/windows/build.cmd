@echo off
rem Build the app. Extra args from the driver are passed on as build targets.
rem Replace with your project's build command (this one assumes a Ninja build in out\).
cd /d C:\src\my-app || exit /b 1
call ninja -C out %*
