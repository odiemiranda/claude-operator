@echo off
rem Launched at logon by the RelayWorker scheduled task. Bun reads .env from the repo root.
cd /d "%~dp0..\.."
title relay worker
bun run worker\index.ts
