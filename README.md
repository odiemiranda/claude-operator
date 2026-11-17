# claude-operator

Let Claude Code operate another machine: run allowlisted scripts there, or hand a task to a Claude agent that works in a folder on that machine. Windows, macOS and Linux all work, on either side. Everything goes through a small Bun + SQLite hub with a web dashboard.

```
Claude Code ⇄ MCP server ⇄ hub (HTTP + WS + SQLite + dashboard) ⇄ worker ⇄ Claude Agent SDK / scripts
```

- **exec tasks** run a named script from `worker/scripts.json` (build, launch, git-sync…). No tokens spent.
- **agent tasks** run a Claude Agent SDK session in a named project folder on the worker (default model `claude-haiku-5-5`).
- Every event is stored in SQLite. The worker keeps unacknowledged messages and resends them, so a hub restart or a sleeping laptop loses no output.
- The worker can run inside your desktop session, so apps it launches open on the desktop you see over remote desktop.
- The dashboard lists tasks, streams output, and lets you allow/deny commands and continue after a manual step (works from a phone over Tailscale).

Claude Code sees it as the `operator` MCP server, with `operator_*` tools and optional `/operator:*` slash commands. The hub and worker internals still say relay (`RELAY_TOKEN`, `RELAY_TARGET`).

## The three parts

| part | runs on | what it does |
|---|---|---|
| **MCP server** (`mcp-remote/`) | the machine with Claude Code | gives Claude Code the `operator_*` tools; talks to the hub over HTTP |
| **hub** (`hub/`) | any machine both sides can reach, usually the Claude Code one | stores tasks and events in SQLite, routes them to workers, serves the dashboard |
| **worker** (`worker/`) | the machine being operated | connects out to the hub, runs scripts and agent sessions, streams output back |

Each part runs on Windows, macOS or Linux. A typical setup: hub and MCP server on your laptop, one worker on a build box. Several workers can share one hub; each has a `WORKER_NAME`, and tools take a `target` (default `RELAY_TARGET`).

## Requirements

- Every machine: [Bun](https://bun.sh) and a clone of this repo.
- Worker machine: Claude Code installed and signed in with `claude login` (agent tasks use that login). On Windows also Git for Windows, since Claude Code uses Git Bash for its shell tool.
- A private network between the machines, e.g. [Tailscale](https://tailscale.com), or the same LAN.

## Install

On every machine:

```sh
git clone <this repo> ~/claude-operator     # Windows: C:\claude-operator
cd ~/claude-operator
bun install
cp .env.example .env
```

Every part reads `.env` from the repo root. All of them need the same `RELAY_TOKEN` (make one with `openssl rand -hex 32`).

Each part has the same four background commands, `<part>:start`, `<part>:stop`, `<part>:status` and `<part>:logs` (output in `<part>.log`), for example `bun run hub:start`. They don't survive a reboot; see [Start at login](#start-at-login) for that.

## 1. Hub

In `.env`: `RELAY_TOKEN`, `HUB_HOST` (the address to bind, e.g. your Tailscale IP), optionally `HUB_PORT` (7717) and `HUB_DB` (`relay.sqlite`).

```sh
bun run hub          # foreground; or bun run hub:start
```

Open `http://<HUB_HOST>:7717` for the dashboard and sign in with the token.

## 2. MCP server

Runs on the machine with Claude Code. It needs `HUB_URL` (`http://<HUB_HOST>:7717`, the exact address the hub binds), `RELAY_TOKEN`, and `RELAY_TARGET` (the default worker name).

**Per session (stdio, default):** Claude Code starts and stops it. Register it once, at user scope so every project sees it:

```sh
claude mcp add operator -s user \
  -e HUB_URL=http://100.x.y.z:7717 -e RELAY_TOKEN=<token> -e RELAY_TARGET=win \
  -- bun run /full/path/to/claude-operator/mcp-remote/index.ts
```

Use the full path to `index.ts` (on Windows `C:\\claude-operator\\mcp-remote\\index.ts`). If `~` reaches Claude Code unexpanded, the server fails to start ("Connection closed").

**In the background (HTTP):** `bun run mcp:start` serves it on `127.0.0.1:7718` (`MCP_HOST`, `MCP_PORT`), reading the settings from `.env`. Register that instead:

```sh
claude mcp add operator -s user --transport http http://127.0.0.1:7718/mcp \
  --header "Authorization: Bearer <RELAY_TOKEN>"
```

It must be running whenever Claude Code needs the operator tools.

Check with `claude mcp get operator`; it should say Connected.

## 3. Worker

Runs on the machine being operated. In `.env`: `RELAY_TOKEN`, `HUB_URL`, `WORKER_NAME` (what `RELAY_TARGET` refers to), and the `WORKER_*` settings described in `.env.example`.

```sh
cp worker/scripts.example.json worker/scripts.json     # edit commands and paths, see scripts.json below
cp worker/projects.example.json worker/projects.json   # folders agents may work in
bun run worker                                         # foreground first; later bun run worker:start
```

The dashboard should now show the worker as connected. `worker:stop` also ends running agent sessions and scripts.

Run the worker inside your logged-in desktop session if the apps it launches should be visible on screen. The login options below do that.

The first agent task logs a line like `· session … (auth oauth, claude-haiku-5-5)`. If it says `ANTHROPIC_API_KEY`, a key is reaching the session and billing the API instead of your plan. Set `WORKER_USE_API_KEY=1` if that is what you want.

## Start at login

The same recipe works for any part: swap `worker` for `hub` or `mcp` (the background HTTP MCP server).

**Windows** (scheduled task in your desktop session, no password stored, runs only while you're logged in):

```nu
^schtasks /create /tn OperatorWorker /tr 'C:\claude-operator\worker\windows\start-worker.cmd' /sc onlogon /it /f
^schtasks /run /tn OperatorWorker
```

`start-worker.cmd` runs the worker; copy it and change the last line for the hub.

**macOS** (launchd agent). Save as `~/Library/LaunchAgents/com.claude-operator.worker.plist`, with the paths from `which bun` and your clone:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.claude-operator.worker</string>
  <key>ProgramArguments</key>
  <array><string>/Users/you/.bun/bin/bun</string><string>run</string><string>worker/index.ts</string></array>
  <key>WorkingDirectory</key><string>/Users/you/claude-operator</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/you/claude-operator/worker.log</string>
  <key>StandardErrorPath</key><string>/Users/you/claude-operator/worker.log</string>
</dict>
</plist>
```

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude-operator.worker.plist
```

**Linux** (systemd user service). Save as `~/.config/systemd/user/claude-operator-worker.service`:

```ini
[Unit]
Description=claude-operator worker

[Service]
WorkingDirectory=%h/claude-operator
ExecStart=%h/.bun/bin/bun run worker/index.ts
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user enable --now claude-operator-worker
journalctl --user -u claude-operator-worker -f     # logs
```

For apps that need the desktop, use `WantedBy=graphical-session.target` and make sure the user manager has `DISPLAY`/`WAYLAND_DISPLAY` (most desktops import them; otherwise `systemctl --user import-environment DISPLAY WAYLAND_DISPLAY`). To keep a headless worker running after logout, `loginctl enable-linger $USER`.

## scripts.json

Only scripts listed here can be run by exec tasks. Edit it any time; it's re-read for each task. `cmd` is the program and its fixed arguments, run without a shell.

Windows:

```json
"build": { "cmd": ["cmd", "/c", "C:\\claude-operator\\worker\\windows\\build.cmd"], "allowArgs": true, "timeoutMin": 360 }
```

macOS / Linux:

```json
"build": { "cmd": ["/bin/sh", "/home/you/scripts/build.sh"], "allowArgs": true, "timeoutMin": 360 },
"kill-app": { "cmd": ["pkill", "-x", "my-app"], "timeoutMin": 1 }
```

- `allowArgs` lets the driver append arguments; leave it off unless the script expects them.
- Every argument must fully match the script's `argPattern` (a regex), or the task is refused. Without one, the default allows plain names only: letters, digits and `_ . / + -`, not starting with `-`, `/` or `.`, and without `..`. That keeps spaces, shell characters, options (`-f`), response files (`@x`) and paths out. Set a pattern per script when it needs something else, as `build` and `git-sync` do in the example.
- Cancelling a task stops the whole process tree on Windows, but only the script's own process on macOS and Linux. In a shell script, start the long-running command with `exec` so the stop reaches it.
- Scripts and agent sessions start with `RELAY_TOKEN` removed from their environment; that stops accidental leaks, not a script that reads `.env` itself.

`worker/windows/` has example `.cmd` files: `build.cmd`, `git-sync.cmd`, and `launch.cmd`, which starts the app detached with `--remote-debugging-port=9222` so `cdp-status` can see what it is showing (Chromium, Electron and CEF apps; debug builds only). To keep a machine's scripts in their own folder or repo, point `WORKER_SCRIPTS` at that `scripts.json`.

## projects.json

Agent tasks run in a folder chosen by name. The allowlist maps each name to a folder; the driver sends only the name, never a path. Like `scripts.json`, it is re-read for each task (`WORKER_PROJECTS` picks another file).

```json
"my-app": { "path": "C:\\src\\my-app", "description": "The app's checkout" },
"docs": { "path": "/home/you/src/docs", "description": "Docs site" }
```

- `operator_agent` with `project: "my-app"` runs in that folder. Without `project` it runs in `WORKER_CWD`, which must be a folder outside this checkout.
- An unknown name, or a path that is missing or not a directory, fails the task with the reason.
- A resumed task (`resume_task_id`) always runs in the original task's project.
- **One agent task per project at a time.** A second one waits in the queue. Tasks without a project share `WORKER_CWD`, so they also run one at a time. Exec tasks are not limited this way. `WORKER_MAX_CONCURRENT` caps the total.
- The worker sends the driver the names and descriptions of its projects and scripts (never paths or commands). `operator_projects` and `operator_scripts` list them.

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

**This is not a sandbox.** A shell command you approve, or any command at `auto`, can reach every file the worker's OS user can. For real isolation, run the worker as a separate user.

Requests show up in the dashboard and in `operator_status`. Unanswered requests are denied after `WORKER_PERMISSION_TIMEOUT_MIN`.

The agent has a `wait_for_user` tool. When it needs you to do something on the desktop (log in, click through a dialog), it pauses until you press Continue in the dashboard or the driver calls `operator_control continue`. To change what a running agent is doing, use `operator_control` `interrupt` with a `message`.

## MCP tools

| tool | use |
|---|---|
| `operator_exec` | run an allowlisted script, wait up to `wait_s`, return recent output |
| `operator_agent` | start an agent task; `project`, `model`, `permission`, `resume_task_id` to continue a session |
| `operator_status` | status, pending decisions, output; `grep`, `tail`, `after_seq`, `wait_s` |
| `operator_control` | `approve`, `deny`, `continue` a pending request; `message` queues an instruction for after the current turn; `interrupt` stops the current turn and runs `message` next (alone, it ends the task as cancelled, still resumable); `cancel` kills the task |
| `operator_projects`, `operator_scripts` | names and descriptions the worker offers |
| `operator_tasks`, `operator_workers` | overview |

## Slash commands (optional)

The repo is also a Claude Code plugin marketplace with `/operator:projects`, `/operator:scripts`, `/operator:workers`, `/operator:tasks`, `/operator:status <task>`, `/operator:agent <project> <prompt>` and `/operator:exec <script> [args]`. Each calls the matching MCP tool, so register the `operator` MCP server first.

```sh
claude plugin marketplace add /full/path/to/claude-operator
claude plugin install operator@claude-operator
```

## Example CLAUDE.md for your project

```md
## Build machine (operator)
- The build machine is reachable through the operator MCP tools (worker "win").
- operator_projects lists the folders an agent can work in; operator_scripts lists the scripts.
- Builds, launching the app and git sync: operator_exec with build, launch, kill-app, cdp-status, git-sync.
  Push commits first; the worker checks them out with git-sync <ref>.
- After a failed build: operator_status with grep "error" to get the first errors, fix them here, push, rebuild.
- Use operator_agent only for work that needs judgment on that machine (platform-only errors, debugging the running app).
  Write self-contained instructions; the remote agent can't see this conversation.
- When the app needs a manual step (login, dialog), tell me and wait.
```

## Security

The hub can make the worker machine run commands.

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
plugin/               /operator:* slash commands
scripts/service.ts    the <part>:start/stop/status/logs commands
```
