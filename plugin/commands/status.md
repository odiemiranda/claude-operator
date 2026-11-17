---
description: Show an operator task's status and recent output
argument-hint: "<task_id> [grep pattern]"
allowed-tools: mcp__operator__operator_status
---
Arguments: "$ARGUMENTS". The first word is the task id; anything after it is a `grep` pattern.
If no task id was given, call `operator_tasks` first and use the newest task.
Call `operator_status` with that `task_id` (and `grep` if given), then summarise the status, any pending decision, and the key output lines.
