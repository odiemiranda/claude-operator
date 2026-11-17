# claude-operator

Let Claude Code on your Mac operate a Windows machine: run allowlisted scripts there, or hand a task to a Claude agent that works in a folder on Windows. Everything goes through a small Bun + SQLite hub with a web dashboard.

```
Claude Code (Mac) ⇄ mcp-remote (Mac, stdio) ⇄ hub (Mac: HTTP + WS + SQLite + dashboard) ⇄ worker (Windows) ⇄ Claude Agent SDK / scripts
```

- **exec tasks** run a named script from `worker/scripts.json` (build, launch, git-sync…). No tokens spent.
- **agent tasks** run a Claude Agent SDK session in a named project folder on Windows (default model `claude-haiku-5-5`).
- Every event is stored in SQLite. The worker keeps unacknowledged messages and resends them, so a hub restart or Mac sleep loses no output.
- The worker runs inside your desktop session, so apps it launches open on the desktop you see over remote desktop.
- The dashboard lists tasks, streams output, and lets you allow/deny commands and continue after a manual step (works from a phone over Tailscale).

Inside the code and tools the system is called **relay**: the MCP server, its `relay_*` tools, `RELAY_TOKEN` and the `/relay:*` slash commands.

## Requirements

- Mac: [Bun](https://bun.sh), Claude Code.
- Windows: Bun, Git for Windows (Claude Code uses Git Bash for its shell tool), Claude Code installed and signed in with `claude login`.
- A private network between the two, e.g. [Tailscale](https://tailscale.com), or the same LAN.

## Mac: hub and MCP server

```sh
git clone <this repo> ~/claude-operator && cd ~/claude-operator
bun install
cp .env.example .env        # set RELAY_TOKEN (openssl rand -hex 32), HUB_HOST (Tailscale IP), HUB_URL
bun run hub                 # open http://<HUB_HOST>:7717 for the dashboard
```

Run it in the background instead with `bun run hub:start`; `hub:stop`, `hub:status` and `hub:logs` do the rest (output goes to `hub.log`). It does not restart after a reboot; for that, wrap `bun run hub` in a launchd agent.

Register the MCP server with Claude Code (user scope, so every project sees it):

```sh
claude mcp add relay -s user \
  -e HUB_URL=http://100.x.y.z:7717 -e RELAY_TOKEN=<token> -e RELAY_TARGET=win \
  -- bun run /Users/<you>/claude-operator/mcp-remote/index.ts
```

Use the full path to `index.ts`. If `~` reaches Claude Code unexpanded, the server fails to start ("Connection closed"). `HUB_URL` must be the address the hub binds (`HUB_HOST`).

Or run the MCP server in the background: `bun run mcp:start` serves it over HTTP on `127.0.0.1:7718` (`MCP_PORT`, `MCP_HOST` in `.env`); `mcp:stop`, `mcp:status`, `mcp:logs` as for the hub. Register that one instead:

```sh
claude mcp add relay -s user --transport http http://127.0.0.1:7718/mcp \
  --header "Authorization: Bearer <RELAY_TOKEN>"
```

It must be running whenever Claude Code needs the relay tools.

## Windows: worker

```nu
git clone <this repo> C:\claude-operator
cd C:\claude-operator
bun install
cp .env.example .env                                     # same RELAY_TOKEN and HUB_URL; set WORKER_* values
cp worker\scripts.example.json worker\scripts.json       # then edit paths and commands
cp worker\projects.example.json worker\projects.json     # folders agents may work in
bun run worker                                           # try it in the foreground first
```

The dashboard should now show the worker as connected.

To run it in the background, use `bun run worker:start`; `worker:stop` (which also ends running agent sessions and scripts), `worker:status` and `worker:logs` do the rest, with output in `worker.log`. It does not come back after a reboot or logoff.

Or start it at logon, inside your desktop session (no password stored, runs only while you're logged in):

```nu
^schtasks /create /tn RelayWorker /tr 'C:\claude-operator\worker\windows\start-worker.cmd' /sc onlogon /it /f
^schtasks /run /tn RelayWorker
```

The first agent task logs a line like `· session … (auth oauth, claude-haiku-5-5)`. If it says `ANTHROPIC_API_KEY`, a key is reaching the session and billing the API instead of your plan. Set `WORKER_USE_API_KEY=1` if that is what you want.

## scripts.json

Only scripts listed here can be run by exec tasks. Edit it any time; it's re-read for each task.

```json
"build": { "cmd": ["cmd", "/c", "C:\\claude-operator\\worker\\windows\\build.cmd"], "allowArgs": true, "timeoutMin": 360 }
```

`allowArgs` lets the driver append arguments; leave it off unless the script expects them. Every argument must fully match the script's `argPattern` (a regex), or the task is refused. Without `argPattern` the default allows plain names only: letters, digits and `_ . / + -`, not starting with `-`, `/` or `.`, and without `..`. That keeps spaces, shell characters (`& | < > ^ % "`), options (`-f`), response files (`@x`) and Windows or network paths away from `cmd /c`. Set a pattern per script when it needs something else, as `build` and `git-sync` do in the example.

Scripts and agent sessions start with `RELAY_TOKEN` emptied in their environment; that stops accidental leaks, not a script that reads `.env` itself.

Example `.cmd` files are in `worker/windows/`: `build.cmd`, `git-sync.cmd`, and `launch.cmd`, which starts the app detached with `--remote-debugging-port=9222` so `cdp-status` can tell what it is showing (Chromium, Electron and CEF apps; keep that flag to debug builds). To keep a machine's scripts in their own folder or repo, point `WORKER_SCRIPTS` at that `scripts.json`.

## projects.json

Agent tasks run in a folder chosen by name. The allowlist maps each name to a folder; the driver sends only the name, never a path. Like `scripts.json`, it is re-read for each task (`WORKER_PROJECTS` picks another file).

```json
"my-app": { "path": "C:\\src\\my-app", "description": "The app's checkout" }
```

- `relay_agent` with `project: "my-app"` runs in that folder. Without `project` it runs in `WORKER_CWD`, which must be a folder outside this checkout.
- An unknown name, or a path that is missing or not a directory, fails the task with the reason.
- A resumed task (`resume_task_id`) always runs in the original task's project.
- **One agent task per project at a time.** A second one waits in the queue. Tasks without a project share `WORKER_CWD`, so they also run one at a time. Exec tasks are not limited this way. `WORKER_MAX_CONCURRENT` caps the total.
- The worker sends the driver the names and descriptions of its projects and scripts (never paths or commands). `relay_projects` and `relay_scripts` list them.

Only list folders you trust: each folder's own `.claude/settings.json` (allow rules, hooks) applies to agents that run there. Don't list the `WORKER_CWD` folder under a second name; the one-agent-per-project lock goes by name.

## Permissions for agent tasks

| level | runs without asking | asks first |
|---|---|---|
| `ask` | reads and searches in the task's folder, todo | edits, Bash, everything else |
| `edits` (default) | the above plus Edit/Write | Bash, everything else |
| `auto` | everything | nothing |

- Levels apply inside the task's folder. A read or edit outside it asks first at `ask` and `edits`.
- Files in this checkout are refused at every level, and a task whose folder overlaps the checkout fails.
- `WORKER_MAX_PERMISSION` caps what a driver may request: with `edits`, a task sent with `auto` runs at `edits`.
- Edits to files that configure tools later (`.claude/`, `.git/`, `.vscode/`, `.husky/`, `.mcp.json`, `CLAUDE.md` and similar) always ask below `auto`. Network and other unusual path spellings always ask.
- `WORKER_SETTINGS` picks which Claude settings files agent sessions load (`user,project,local` by default). Allow rules and hooks in a loaded file apply before this check, so they skip approval and the ceiling. Set it to `project`, or empty, to keep your personal rules away from operator agents.

**This is not a sandbox.** A shell command you approve, or any command at `auto`, can reach every file your Windows user can. For real isolation, run the worker as a separate Windows user.

Requests show up in the dashboard and in `relay_status`. Unanswered requests are denied after `WORKER_PERMISSION_TIMEOUT_MIN`.

The agent has a `wait_for_user` tool. When it needs you to do something on the desktop (log in, click through a dialog), it pauses until you press Continue in the dashboard or the driver calls `relay_control continue`. To change what a running agent is doing, use `relay_control` `interrupt` with a `message`.

## MCP tools

| tool | use |
|---|---|
| `relay_exec` | run an allowlisted script, wait up to `wait_s`, return recent output |
| `relay_agent` | start an agent task; `project`, `model`, `permission`, `resume_task_id` to continue a session |
| `relay_status` | status, pending decisions, output; `grep`, `tail`, `after_seq`, `wait_s` |
| `relay_control` | `approve`, `deny`, `continue` a pending request; `message` queues an instruction for after the current turn; `interrupt` stops the current turn and runs `message` next (alone, it ends the task as cancelled, still resumable); `cancel` kills the task |
| `relay_projects`, `relay_scripts` | names and descriptions the worker offers |
| `relay_tasks`, `relay_workers` | overview |

## Slash commands (optional)

The repo is also a Claude Code plugin marketplace with `/relay:projects`, `/relay:scripts`, `/relay:workers`, `/relay:tasks`, `/relay:status <task>`, `/relay:agent <project> <prompt>` and `/relay:exec <script> [args]`. Each calls the matching MCP tool, so register the `relay` MCP server first.

```sh
claude plugin marketplace add ~/claude-operator
claude plugin install relay@claude-operator
```

## Example CLAUDE.md for your Mac project

```md
## Windows (relay)
- The Windows machine is reachable through the relay MCP tools (worker "win").
- relay_projects lists the folders an agent can work in; relay_scripts lists the scripts.
- Builds, launching the app and git sync: relay_exec with build, launch, kill-app, cdp-status, git-sync.
  Push commits first; the worker checks them out with git-sync <ref>.
- After a failed build: relay_status with grep "error" to get the first errors, fix them here, push, rebuild.
- Use relay_agent only for work that needs judgment on Windows (Windows-only errors, debugging the running app).
  Write self-contained instructions; the remote agent can't see this conversation.
- When the app needs a manual step (login, dialog), tell me and wait.
```

## Security

The hub can make the Windows machine run commands.

- Bind `HUB_HOST` to a Tailscale or loopback address, never `0.0.0.0` on an open network.
- Use a long random `RELAY_TOKEN`.
- Keep `scripts.json` to commands you'd be happy to run unattended.

## Layout

```
shared/protocol.ts    message and record types
hub/                  index.ts (HTTP, WS, routing), db.ts (SQLite), dashboard.html
mcp-remote/index.ts   MCP server for Claude Code
worker/               index.ts (connection, outbox, queue), exec.ts, agent.ts, config.ts
worker/windows/       example .cmd scripts and the logon launcher
plugin/               /relay:* slash commands
```
