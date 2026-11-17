// MCP server that lets Claude Code drive remote workers through the relay hub.
// Default: stdio (Claude Code starts it per session; stdout is the MCP channel, so log to stderr only).
// With --http: Streamable HTTP on MCP_HOST:MCP_PORT/mcp (default 127.0.0.1:7718), for running in the background
// (bun run mcp:start). A flag, not an env var, so a .env setting can never switch a Claude Code stdio session.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { isTerminal, type PendingRequest, type Task, type TaskEvent, type WorkerInfo } from "../shared/protocol";

const HUB = (process.env.HUB_URL ?? "http://127.0.0.1:7717").replace(/\/$/, "");
const TOKEN = process.env.RELAY_TOKEN ?? "";
const TARGET = process.env.RELAY_TARGET ?? "win";

async function hub<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(HUB + path, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as any).error ?? `hub returned ${res.status}`);
  return body as T;
}

type TaskView = { task: Task; pending: PendingRequest[]; last_seq: number };
const getTask = (id: string) => hub<TaskView>(`/api/tasks/${id}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until the task finishes, needs a decision, or the timeout passes. */
async function waitFor(id: string, seconds: number): Promise<TaskView> {
  const until = Date.now() + seconds * 1000;
  let v = await getTask(id);
  while (Date.now() < until && !isTerminal(v.task.status) && v.pending.length === 0) {
    await sleep(1000);
    v = await getTask(id);
  }
  return v;
}

function renderEvent(e: TaskEvent): string[] {
  const p = e.payload ?? {};
  switch (e.type) {
    case "log": return (p.lines as string[]).map((l) => (p.stream === "stderr" ? "! " : "") + l);
    case "info": return [`· ${p.message}${p.auth ? ` (auth: ${p.auth}, model: ${p.model})` : ""}`];
    case "text": return [`assistant: ${p.text}`];
    case "tool_call": return [`→ ${p.name}: ${p.input}`];
    case "tool_result":
      return p.is_error ? [`✗ ${String(p.content).slice(0, 800)}`] : [`  ✓ ${String(p.content).split("\n")[0]!.slice(0, 160)}`];
    case "permission_request": return [`⏸ permission ${p.request_id}: ${p.tool}: ${p.input}`];
    case "permission_resolved": return [`▶ ${p.request_id} ${p.decision}${p.message ? `: ${p.message}` : ""}`];
    case "waiting": return [`⏸ waiting ${p.request_id}: ${p.reason}`];
    case "resumed": return [`▶ ${p.request_id} continued${p.message ? `: ${p.message}` : ""}`];
    case "result": return [`■ ${p.ok ? "done" : "failed"} (${p.turns ?? "?"} turns): ${p.summary}`];
    default: return [JSON.stringify(e)];
  }
}

async function report(id: string, opts: { tail?: number; grep?: string; after_seq?: number; wait_s?: number } = {}) {
  const v = opts.wait_s ? await waitFor(id, opts.wait_s) : await getTask(id);
  const t = v.task;
  const qs = opts.after_seq ? `after_seq=${opts.after_seq}&limit=5000` : `tail=${opts.grep ? 2000 : 300}`;
  const events = await hub<TaskEvent[]>(`/api/tasks/${id}/events?${qs}`);
  let lines = events.flatMap(renderEvent);
  if (opts.grep) {
    const re = new RegExp(opts.grep, "i");
    lines = lines.filter((l) => re.test(l));
  }
  const tail = opts.tail ?? 40;
  const shown = lines.slice(-tail);

  const out = [
    `task ${t.id} [${t.kind} ${t.kind === "exec" ? t.script : t.model ?? "default model"}${t.project ? `, project ${t.project}` : ""}] on ${t.target}: ${t.status}`,
  ];
  if (t.result) out.push(`result: ${t.result}`);
  if (t.session_id) out.push(`session: ${t.session_id} (continue with operator_agent resume_task_id="${t.id}")`);
  if (v.pending.length) {
    out.push("needs a decision:");
    for (const p of v.pending)
      out.push(p.kind === "permission"
        ? `  - ${p.request_id}: allow ${p.tool}? ${p.input}  → operator_control approve|deny`
        : `  - ${p.request_id}: waiting for the user: ${p.reason}  → operator_control continue`);
  }
  out.push(`last_seq: ${v.last_seq}`);
  out.push(`--- ${shown.length} of ${lines.length} lines${opts.grep ? ` matching /${opts.grep}/` : ""} ---`);
  out.push(...shown);
  return { content: [{ type: "text" as const, text: out.join("\n") }] };
}

const fail = (err: unknown) => ({ content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true });
const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });

/** The named worker as the hub sees it, or undefined when it is not connected. */
async function workerNamed(name: string): Promise<WorkerInfo | undefined> {
  return (await hub<WorkerInfo[]>("/api/workers")).find((w) => w.name === name);
}

/** One server with every relay tool. HTTP mode builds one per request (stateless). */
function makeServer(): McpServer {
  const server = new McpServer({ name: "operator", version: "1.0.0" });

  server.registerTool("operator_workers", {
    description: "List connected remote workers and the tasks each one holds.",
    inputSchema: {},
  }, async () => {
    try {
      const w = await hub<any[]>("/api/workers");
      const text = w.length ? w.map((x) => `${x.name}: ${x.active.length} active ${x.active.join(", ")}`).join("\n") : "No workers connected.";
      return { content: [{ type: "text", text }] };
    } catch (e) { return fail(e); }
  });

  server.registerTool("operator_projects", {
    description:
      "List the project folders a worker offers for operator_agent's project parameter (names and descriptions only, no paths). " +
      "The list is refreshed when the worker connects and when a task starts, not continuously.",
    inputSchema: { target: z.string().optional().describe(`Worker name (default ${TARGET})`) },
  }, async ({ target }) => {
    try {
      const name = target ?? TARGET;
      const w = await workerNamed(name);
      if (!w) return reply(`worker ${name} is not connected`);
      if (!w.projects) return reply(`worker ${name} has not sent its project list yet; try again shortly`);
      return reply(w.projects.map((p) => `${p.name}${p.description ? ` — ${p.description}` : ""}`).join("\n") || `worker ${name} has no projects`);
    } catch (e) { return fail(e); }
  });

  server.registerTool("operator_scripts", {
    description:
      "List the scripts a worker offers for operator_exec (names and descriptions only). " +
      "The list is refreshed when the worker connects and when a task starts, not continuously.",
    inputSchema: { target: z.string().optional().describe(`Worker name (default ${TARGET})`) },
  }, async ({ target }) => {
    try {
      const name = target ?? TARGET;
      const w = await workerNamed(name);
      if (!w) return reply(`worker ${name} is not connected`);
      if (!w.scripts) return reply(`worker ${name} has not sent its script list yet; try again shortly`);
      return reply(
        w.scripts.map((s) => `${s.name}${s.allowArgs ? ` (accepts args${s.argPattern ? ` matching /${s.argPattern}/` : ", no spaces or shell characters"})` : ""}${s.timeoutMin ? ` [time limit ${s.timeoutMin >= 60 ? `${+(s.timeoutMin / 60).toFixed(1)} h` : `${s.timeoutMin} min`}]` : " [no time limit]"}${s.description ? ` — ${s.description}` : ""}`).join("\n") ||
        `worker ${name} has no scripts`,
      );
    } catch (e) { return fail(e); }
  });

  server.registerTool("operator_exec", {
    description:
      "Run an allowlisted script on a remote worker (no LLM, no tokens). Use for build, launch, git-sync, cdp-status and similar. " +
      "Returns the task with recent output. Prefer this over operator_agent whenever no judgment is needed.",
    inputSchema: {
      script: z.string().describe("Script name from the worker's scripts.json, e.g. build"),
      args: z.array(z.string()).optional().describe("Extra args, only if the script allows them"),
      target: z.string().optional().describe(`Worker name (default ${TARGET})`),
      wait_s: z.number().min(0).max(55).optional().describe("Wait up to this many seconds for completion (default 20)"),
      tail: z.number().optional().describe("Output lines to return (default 40)"),
    },
  }, async ({ script, args, target, wait_s, tail }) => {
    try {
      const t = await hub<Task>("/api/tasks", { method: "POST", body: JSON.stringify({ kind: "exec", script, args, target: target ?? TARGET }) });
      return report(t.id, { wait_s: wait_s ?? 20, tail });
    } catch (e) { return fail(e); }
  });

  server.registerTool("operator_agent", {
    description:
      "Give a task to the Claude agent on a remote worker. Write precise, self-contained instructions (paths, commits, what to report). " +
      "The remote agent cannot see this conversation. Use resume_task_id to continue a previous agent task's session.",
    inputSchema: {
      prompt: z.string(),
      model: z.string().optional().describe("e.g. claude-haiku-5-5 (worker default) or claude-sonnet-5-5 for harder fixes"),
      permission: z.enum(["ask", "edits", "auto"]).optional()
        .describe("ask: read-only tools run freely; edits: file edits too; auto: everything incl. shell. Worker default applies if omitted."),
      resume_task_id: z.string().optional().describe("Continue the session from this earlier agent task; it runs in the same project"),
      project: z.string().optional().describe("Project name from operator_projects. Omit only if the worker has a default folder (WORKER_CWD) outside the relay checkout; otherwise the task fails"),
      target: z.string().optional(),
      wait_s: z.number().min(0).max(55).optional().describe("Wait up to this many seconds (default 20)"),
    },
  }, async ({ prompt, model, permission, resume_task_id, project, target, wait_s }) => {
    try {
      const t = await hub<Task>("/api/tasks", {
        method: "POST",
        body: JSON.stringify({ kind: "agent", prompt, model, permission, resume_task_id, project, target: target ?? TARGET }),
      });
      return report(t.id, { wait_s: wait_s ?? 20 });
    } catch (e) { return fail(e); }
  });

  server.registerTool("operator_status", {
    description:
      "Check a task: status, result, pending decisions, and recent output. Use wait_s to block until it finishes or needs you. " +
      "Use grep to pull errors out of long build logs, after_seq to get only new lines.",
    inputSchema: {
      task_id: z.string(),
      wait_s: z.number().min(0).max(55).optional(),
      tail: z.number().optional().describe("Lines to return (default 40)"),
      grep: z.string().optional().describe("Case-insensitive regex filter, e.g. 'error|fatal'"),
      after_seq: z.number().optional().describe("Only events after this seq (from a previous last_seq)"),
    },
  }, async ({ task_id, ...opts }) => {
    try { return await report(task_id, opts); } catch (e) { return fail(e); }
  });

  server.registerTool("operator_control", {
    description:
      "Answer a pending request, steer a running agent, or stop a task. approve/deny a permission request; continue a " +
      "wait_for_user pause (message is passed to the agent); message: queue a new instruction the agent runs when its " +
      "current turn ends; interrupt: stop the agent's current turn now and run message next (without a message the task " +
      "ends as cancelled, resumable); cancel: kill the task. A deny reason is not an instruction the agent follows; use " +
      "interrupt with a message to redirect it.",
    inputSchema: {
      task_id: z.string(),
      action: z.enum(["approve", "deny", "continue", "cancel", "message", "interrupt"]),
      request_id: z.string().optional().describe("Required for approve, deny and continue"),
      message: z.string().optional().describe("Reason for a deny, note for continue, or the instruction for message/interrupt"),
      wait_s: z.number().min(0).max(55).optional().describe("Then wait up to this many seconds (default 10)"),
    },
  }, async ({ task_id, action, request_id, message, wait_s }) => {
    try {
      await hub(`/api/tasks/${task_id}/control`, { method: "POST", body: JSON.stringify({ action, request_id, message }) });
      await sleep(500);
      return report(task_id, { wait_s: wait_s ?? 10 });
    } catch (e) { return fail(e); }
  });

  server.registerTool("operator_tasks", {
    description: "List recent tasks across workers.",
    inputSchema: { limit: z.number().optional() },
  }, async ({ limit }) => {
    try {
      const tasks = await hub<Task[]>(`/api/tasks?limit=${limit ?? 15}`);
      const text = tasks.map((t) =>
        `${t.id}  ${t.status.padEnd(9)} ${t.target}  ${t.kind === "exec" ? `exec ${t.script}` : `agent${t.project ? ` [${t.project}]` : ""}: ${(t.prompt ?? "").slice(0, 70)}`}`,
      ).join("\n") || "No tasks yet.";
      return { content: [{ type: "text", text }] };
    } catch (e) { return fail(e); }
  });
  return server;
}

if (!TOKEN) console.error("operator MCP: RELAY_TOKEN is not set; hub calls will fail.");

if (process.argv.includes("--http")) {
  const MCP_PORT = Number(process.env.MCP_PORT || 7718);
  const host = process.env.MCP_HOST ?? "127.0.0.1";
  Bun.serve({
    hostname: host,
    port: MCP_PORT,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/mcp") return new Response("not found", { status: 404 });
      // Same shared secret as the hub, sent by Claude Code as a header from the registration.
      if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });
      const server = makeServer();
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      return transport.handleRequest(req);
    },
  });
  console.error(`operator MCP on http://${host}:${MCP_PORT}/mcp, hub ${HUB} (default target ${TARGET})`);
} else {
  await makeServer().connect(new StdioServerTransport());
  console.error(`operator MCP connected to ${HUB} (default target ${TARGET})`);
}
