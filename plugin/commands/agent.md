---
description: Run a prompt with the Claude agent in a project on the operator worker
argument-hint: "<project> <prompt>"
allowed-tools: mcp__operator__operator_agent, mcp__operator__operator_status, mcp__operator__operator_projects
---
Arguments: "$ARGUMENTS". The first word is the project name; the rest is the prompt for the remote agent.
If the project is missing or unknown, call `operator_projects` and ask which one to use.
Call `operator_agent` with that `project` and the prompt, `wait_s` 55. The remote agent cannot see this conversation, so pass the prompt as written.
While the task is not finished and has no pending decision, call `operator_status` with `wait_s` 55 again. Stop and show any pending permission request or wait instead of answering it yourself.
When it finishes, report the result.
