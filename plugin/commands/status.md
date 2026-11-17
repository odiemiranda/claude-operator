---
description: Show a relay task's status and recent output
argument-hint: "<task_id> [grep pattern]"
allowed-tools: mcp__relay__relay_status
---
Arguments: "$ARGUMENTS". The first word is the task id; anything after it is a `grep` pattern.
If no task id was given, call `relay_tasks` first and use the newest task.
Call `relay_status` with that `task_id` (and `grep` if given), then summarise the status, any pending decision, and the key output lines.
