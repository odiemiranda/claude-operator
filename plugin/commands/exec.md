---
description: Run an allowlisted script on the operator worker
argument-hint: "<script> [args...]"
allowed-tools: mcp__operator__operator_exec, mcp__operator__operator_status, mcp__operator__operator_scripts
---
Arguments: "$ARGUMENTS". The first word is the script name; any further words are its `args`.
If the script is missing or unknown, call `operator_scripts` and show the list.
Call `operator_exec` with that `script` (and `args` if any), `wait_s` 55. If it is still running, call `operator_status` with `wait_s` 55 until it finishes, then report the exit status and the key output lines (use `grep` "error|fail" for long build logs).
