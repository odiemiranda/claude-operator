---
description: Run an allowlisted script on the relay worker
argument-hint: "<script> [args...]"
allowed-tools: mcp__relay__relay_exec, mcp__relay__relay_status, mcp__relay__relay_scripts
---
Arguments: "$ARGUMENTS". The first word is the script name; any further words are its `args`.
If the script is missing or unknown, call `relay_scripts` and show the list.
Call `relay_exec` with that `script` (and `args` if any), `wait_s` 55. If it is still running, call `relay_status` with `wait_s` 55 until it finishes, then report the exit status and the key output lines (use `grep` "error|fail" for long build logs).
