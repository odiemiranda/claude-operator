# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

relay lets Claude Code on a Mac drive a Windows machine: allowlisted scripts (`exec` tasks) and Claude Agent SDK sessions (`agent` tasks). Bun + TypeScript, SQLite via `bun:sqlite`, no build step.

```
Claude Code (Mac) ⇄ mcp-remote (stdio MCP) ⇄ hub (HTTP + WS + SQLite + dashboard) ⇄ worker (Windows) ⇄ Agent SDK / scripts
```

## Commands

```sh
bun install
bun run typecheck   # tsc --noEmit — the only check; there are no tests or linter
bun run hub:start   # background hub (scripts/service.ts): also hub:stop, hub:status, hub:logs; log in hub.log
bun run worker:start  # background worker, same four commands; log in worker.log
bun run hub         # foreground hub; needs RELAY_TOKEN; HUB_HOST, HUB_PORT (7717), HUB_DB (relay.sqlite), RELAY_TARGET
bun run worker      # needs RELAY_TOKEN, HUB_URL; WORKER_* settings in worker/config.ts
bun run mcp         # stdio MCP server; HUB_URL, RELAY_TOKEN, RELAY_TARGET
bun run mcp:start   # same tools over HTTP on MCP_HOST:MCP_PORT/mcp (default 127.0.0.1:7718), bearer RELAY_TOKEN
```

Bun loads `.env` automatically. `.env.example` lists every setting. Running the worker under Node (`npx tsx worker/index.ts`) is untested; exec tasks use `Bun.spawn`.

## Architecture

- **`shared/protocol.ts`** is the single source of types: `Task`, `TaskEvent`, `Control`, and the WS message unions (`WorkerToHub`, `HubToWorker`, `HubToDashboard`). `hub/dashboard.html` is plain inline JS and does not import these types. A protocol change must be mirrored there by hand, and in `mcp-remote/index.ts` `renderEvent` when an event type is added.
- **The hub** (`hub/index.ts`) is the only process that owns state. Workers connect *out* to it over `/ws?role=worker`. Dashboards connect over `/ws` and receive broadcasts only: they act through the REST API (`/api/tasks`, `/api/tasks/:id/{events,control}`, `/api/workers`), the same API mcp-remote uses. Auth is one shared `RELAY_TOKEN`, sent as a Bearer header or `?token=`.
- **Delivery guarantees:**
  - Worker → hub `event` and `status` messages carry a `mid`. They stay in the worker's in-memory `outbox` until the hub replies `ack`, and they are resent after a reconnect.
  - Events are deduped in SQLite by `UNIQUE(task_id, seq)` (`INSERT OR IGNORE`). `seq` is assigned per task by the worker.
  - Controls (approve/deny/continue/cancel) are stored in the hub and marked delivered on the worker's `control_ack`.
- **Reconnect reconciliation** (`onWorkerHello`):
  - The worker reports its `active` task ids.
  - Tasks the hub has as `running`/`waiting` but the worker lacks are marked `error` ("Worker restarted").
  - `queued`/`assigned` tasks are re-assigned, unless an undelivered cancel exists for them.
  - Undelivered controls for active tasks are resent.
- **Task status flow:** `queued` (no worker) → `assigned` (in the worker's queue, limited by `WORKER_MAX_CONCURRENT`) → `running` ⇄ `waiting` → `done` | `error` | `cancelled`. The worker sets every status after `assigned`.
- **Blocking on a human:** `TaskContext.waitForControl(request_id, actions, timeout)` (`worker/context.ts`) is the single mechanism. Agent permission prompts (`canUseTool` in `worker/agent.ts`) and the in-process `wait_for_user` MCP tool both emit an event, set `waiting`, and await a matching control. Cancel resolves every waiter with `null` and aborts. `message`/`interrupt` controls go to the agent's `onMessage` handler instead: driver messages queue in an inbox and are sent one per turn, only after the current turn's `result`, so each turn ends in exactly one result; `interrupt` resolves pending waiters, calls `query.interrupt()`, and without a message ends the task `cancelled` (resumable).
- **Agent tasks** (`worker/agent.ts`):
  - Uses the SDK `query()` with a streaming-input generator that stays open until the `result` message. This keeps the in-process `relay` MCP server alive.
  - Permission level `ask`/`edits`/`auto` is applied by `decide()`, after `capLevel()` lowers it to `WORKER_MAX_PERMISSION`. File tools run freely only inside the task's folder; a path outside it asks; paths in the relay's own checkout (`RELAY_DIR`) are denied, and a task whose folder overlaps it fails. `mcp__relay__*` is always allowed. Not a sandbox: Bash is judged by level only, and allow rules in the settings files named by `WORKER_SETTINGS` apply before `canUseTool`.
  - `ANTHROPIC_API_KEY` is removed from the session env unless `WORKER_USE_API_KEY=1`, so usage bills to the Claude login, not the API.
  - `resume_task_id` resumes the earlier task's stored `session_id`, in the same project.
  - `project` is a name from `worker/projects.json` (re-read per task), resolved to a folder in `runAgent`. The hub checks the name's shape only; the driver never sends a path and the catalog carries none (the resolved `cwd` does appear in the task's `info` event). No project means `config.cwd`.
  - `pump()` runs at most one agent task per project key (`task.project ?? ""`) at a time. The key is taken synchronously in `pump()` and released in its `.finally`. Exec tasks take no key.
- **Exec tasks** (`worker/exec.ts`) run only scripts listed in `worker/scripts.json`, which is re-read for every task. Extra args are accepted only when the script has `allowArgs`, and each must fully match its `argPattern` (default `DEFAULT_ARG_PATTERN` in `worker/config.ts`: no spaces or shell characters). `childEnv()` removes `RELAY_TOKEN` from the environment of exec scripts and agent sessions. `worker/scripts.example.json` and `worker/windows/*.cmd` are the templates.
- **Catalog:** the worker sends `{ t: "catalog" }` (project and script names and descriptions, no paths or commands) after every `welcome`, and again when a task starts if the contents changed. The hub keeps it on the worker's socket and returns it from `GET /api/workers`.
- **mcp-remote** runs over stdio by default, or Streamable HTTP with `--http` (`mcp:start`; port from `MCP_PORT`) (stateless: a new `McpServer` per request, from `makeServer()`). It polls the REST API: `wait_s` loops `GET /api/tasks/:id` once a second until the task is terminal or has a pending request. stdout is the MCP channel, so log only to stderr there.

## Constraints

- The hub can make the Windows machine run commands. Bind `HUB_HOST` to a Tailscale or loopback address, never `0.0.0.0`. Keep `scripts.json` to commands that are safe to run unattended.
- The worker must run inside the logged-in desktop session (`schtasks /it`, see README) so the apps it launches are visible.
