@echo off
rem Launched at logon by the OperatorWorker scheduled task. Bun reads .env from the repo root.
cd /d "%~dp0..\.."
title claude-operator worker
bun run worker\index.ts
