// Relay hub: WebSocket bus + REST API + dashboard, backed by SQLite.
import type { ServerWebSocket } from "bun";
import { openDb } from "./db";
import {
  isTerminal, rid,
  type Control, type ControlAction, type HubToDashboard, type HubToWorker,
  type PermissionLevel, type ProjectCatalogEntry, type ScriptCatalogEntry, type Task, type TaskKind, type WorkerInfo, type WorkerToHub,
} from "../shared/protocol";

const TOKEN = process.env.RELAY_TOKEN ?? "";
const HOST = process.env.HUB_HOST ?? "127.0.0.1";
const PORT = Number(process.env.HUB_PORT ?? 7717);
const DB_PATH = process.env.HUB_DB ?? "relay.sqlite";
const DEFAULT_TARGET = process.env.RELAY_TARGET ?? "win";

if (!TOKEN) {
  console.error("RELAY_TOKEN is required (shared secret for all clients).");
  process.exit(1);
}

const db = openDb(DB_PATH);
const dashboardHtml = Bun.file(new URL("./dashboard.html", import.meta.url));

type SocketData = {
  role: "worker" | "dashboard"; name: string; active: Set<string>; connectedAt: number; caps?: string[];
  projects?: ProjectCatalogEntry[]; scripts?: ScriptCatalogEntry[]; // worker catalog, sent after hello
};
type Sock = ServerWebSocket<SocketData>;

const workers = new Map<string, Sock>();
const dashboards = new Set<Sock>();

const workerInfo = (): WorkerInfo[] =>
  [...workers.values()].map((w) => ({
    name: w.data.name, connected_at: w.data.connectedAt, active: [...w.data.active],
    projects: w.data.projects, scripts: w.data.scripts,
  }));

function toWorker(ws: Sock, msg: HubToWorker) { ws.send(JSON.stringify(msg)); }
function broadcast(msg: HubToDashboard) {
  const s = JSON.stringify(msg);
  for (const d of dashboards) d.send(s);
}
function taskChanged(task: Task | null) { if (task) broadcast({ t: "task", task }); }

function assign(task: Task) {
  const w = workers.get(task.target);
  if (!w) return;
  // An older worker build would ignore the project and run in its default folder.
  if (task.project && !w.data.caps?.includes("project")) {
    taskChanged(db.setStatus(task.id, "error", { result: `Worker "${task.target}" does not support projects; update it.` }));
    return;
  }
  toWorker(w, { t: "assign", task, last_seq: db.lastSeq(task.id) });
  w.data.active.add(task.id);
  if (task.status === "queued") taskChanged(db.setStatus(task.id, "assigned"));
}

function deliverControl(c: Control) {
  const task = db.getTask(c.task_id);
  const w = task && workers.get(task.target);
  if (w) toWorker(w, { t: "control", control: c });
}

function onWorkerHello(ws: Sock, name: string, active: string[], caps: string[]) {
  const prev = workers.get(name);
  if (prev && prev !== ws) prev.close(4000, "replaced by new connection");
  ws.data.name = name;
  ws.data.active = new Set(active);
  ws.data.caps = caps;
  workers.set(name, ws);
  toWorker(ws, { t: "welcome" });

  // Tasks the hub thinks are in flight but the worker no longer holds were lost (worker restart).
  for (const t of db.tasksFor(name, ["running", "waiting"])) {
    if (!ws.data.active.has(t.id)) taskChanged(db.setStatus(t.id, "error", { result: "Worker restarted; task was lost." }));
  }
  // (Re)send anything queued or assigned that the worker doesn't hold, unless it was cancelled meanwhile.
  const toAssign = db.tasksFor(name, ["queued", "assigned"]).filter((t) => !ws.data.active.has(t.id));
  const cancelled = new Set<string>();
  for (const c of db.undeliveredControls(toAssign.map((t) => t.id))) {
    if (c.action === "cancel") cancelled.add(c.task_id);
    db.markDelivered(c.id);
  }
  for (const t of toAssign) {
    if (cancelled.has(t.id)) taskChanged(db.setStatus(t.id, "cancelled", { result: "Cancelled before it started." }));
    else assign(t);
  }
  for (const c of db.undeliveredControls(active)) toWorker(ws, { t: "control", control: c });
  broadcast({ t: "workers", workers: workerInfo() });
  console.log(`worker "${name}" connected (${active.length} active)`);
}

function onWorkerMessage(ws: Sock, msg: WorkerToHub) {
  switch (msg.t) {
    case "event": {
      const stored = db.addEvent(msg.event);
      if (stored) broadcast({ t: "event", event: stored });
      toWorker(ws, { t: "ack", mid: msg.mid });
      break;
    }
    case "status": {
      const t = db.setStatus(msg.task_id, msg.status, { session_id: msg.session_id, result: msg.result });
      if (isTerminal(msg.status)) ws.data.active.delete(msg.task_id);
      taskChanged(t);
      toWorker(ws, { t: "ack", mid: msg.mid });
      break;
    }
    case "control_ack":
      db.markDelivered(msg.control_id);
      break;
    case "active":
      ws.data.active = new Set(msg.active);
      broadcast({ t: "workers", workers: workerInfo() });
      break;
    case "catalog":
      ws.data.projects = msg.projects;
      ws.data.scripts = msg.scripts;
      broadcast({ t: "workers", workers: workerInfo() });
      break;
  }
}

// ---------- REST ----------

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const bad = (msg: string, status = 400) => json({ error: msg }, status);

function authed(req: Request, url: URL) {
  const h = req.headers.get("authorization");
  const t = h?.startsWith("Bearer ") ? h.slice(7) : url.searchParams.get("token");
  return t === TOKEN;
}

const KINDS: TaskKind[] = ["agent", "exec"];
const LEVELS: PermissionLevel[] = ["ask", "edits", "auto"];
const ACTIONS: ControlAction[] = ["approve", "deny", "cancel", "continue", "message", "interrupt"];
const PROJECT_NAME = /^[A-Za-z0-9._-]{1,64}$/;

async function createTask(body: any): Promise<Response> {
  const kind = body.kind as TaskKind;
  if (!KINDS.includes(kind)) return bad("kind must be 'agent' or 'exec'");
  if (body.permission && !LEVELS.includes(body.permission)) return bad("permission must be ask | edits | auto");
  let target = String(body.target || DEFAULT_TARGET);
  // A project is a name from the worker's allowlist. The hub checks the shape only; the worker resolves it to a folder.
  if (body.project != null && (typeof body.project !== "string" || !PROJECT_NAME.test(body.project)))
    return bad("project must be a name of 1-64 letters, digits, '.', '_' or '-'");
  if (body.project != null && kind !== "agent") return bad("only agent tasks take a project");
  let project: string | null = body.project ?? null;
  let resume_session: string | null = null;

  if (kind === "agent") {
    if (!body.prompt) return bad("agent tasks need a prompt");
    if (body.resume_task_id) {
      const prev = db.getTask(String(body.resume_task_id));
      if (!prev?.session_id) return bad("resume_task_id has no session to resume");
      if (body.project != null && body.project !== (prev.project ?? null))
        return bad("resume uses the original task's project");
      if (body.target && String(body.target) !== prev.target) return bad("resume uses the original task's worker");
      project = prev.project ?? null; // resume always runs on the original worker, in the original folder
      target = prev.target;
      resume_session = prev.session_id;
    }
  } else if (!body.script) return bad("exec tasks need a script name");
  if (body.args && !(Array.isArray(body.args) && body.args.every((a: unknown) => typeof a === "string")))
    return bad("args must be an array of strings");

  const task = db.createTask({
    id: rid("t_"), target, kind, status: "queued",
    model: body.model ?? null, prompt: body.prompt ?? null, permission: body.permission ?? null,
    resume_session, project, script: body.script ?? null, args: body.args ?? null,
  });
  taskChanged(task);
  assign(task);
  return json(db.getTask(task.id), 201);
}

function control(taskId: string, body: any): Response {
  const task = db.getTask(taskId);
  if (!task) return bad("no such task", 404);
  const action = body.action as ControlAction;
  if (!ACTIONS.includes(action)) return bad("action must be approve | deny | cancel | continue | message | interrupt");
  if (isTerminal(task.status)) return bad(`task already ${task.status}`, 409);
  if (body.message != null && typeof body.message !== "string") return bad("message must be a string");
  if (action === "message" || action === "interrupt") {
    if (task.kind !== "agent") return bad(`${action} is for agent tasks`);
    if (task.status !== "running" && task.status !== "waiting") return bad(`task is ${task.status}; ${action} needs a running agent`, 409);
    if (action === "message" && !body.message?.trim()) return bad("message needs a message");
  } else if (action !== "cancel" && !body.request_id) return bad(`${action} needs a request_id`);

  // A task nobody has picked up can be cancelled right here.
  if (action === "cancel" && task.status === "queued") {
    taskChanged(db.setStatus(task.id, "cancelled", { result: "Cancelled before it started." }));
    return json({ ok: true, task: db.getTask(task.id) });
  }
  const c = db.addControl(task.id, action, body.request_id, body.message);
  deliverControl(c);
  return json({ ok: true, control: c, delivered_now: workers.has(task.target) });
}

async function api(req: Request, url: URL): Promise<Response> {
  if (!authed(req, url)) return bad("unauthorized", 401);
  const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
  const m = req.method;

  if (parts[1] === "workers" && m === "GET") return json(workerInfo());
  if (parts[1] === "tasks") {
    // Finished tasks only; anything queued, running or waiting stays.
    if (parts[2] === "clear" && parts.length === 3 && m === "POST") {
      const cleared = db.clearFinished();
      broadcast({ t: "snapshot", tasks: db.listTasks(50), workers: workerInfo() });
      return json({ ok: true, cleared });
    }
    if (parts.length === 2) {
      if (m === "GET") return json(db.listTasks(Number(url.searchParams.get("limit") ?? 30)));
      if (m === "POST") return createTask(await req.json().catch(() => ({})));
    }
    const id = parts[2]!;
    if (parts.length === 3 && m === "GET") {
      const task = db.getTask(id);
      if (!task) return bad("no such task", 404);
      return json({ task, pending: isTerminal(task.status) ? [] : db.pending(id), last_seq: db.lastSeq(id) });
    }
    if (parts[3] === "events" && m === "GET") {
      const tail = url.searchParams.get("tail");
      return json(db.events(id, {
        afterSeq: Number(url.searchParams.get("after_seq") ?? 0),
        tail: tail ? Number(tail) : undefined,
        limit: Number(url.searchParams.get("limit") ?? 1000),
      }));
    }
    if (parts[3] === "control" && m === "POST") return control(id, await req.json().catch(() => ({})));
  }
  return bad("not found", 404);
}

// ---------- server ----------

const server = Bun.serve<SocketData>({
  hostname: HOST,
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      if (!authed(req, url)) return bad("unauthorized", 401);
      const role = url.searchParams.get("role") === "worker" ? "worker" : "dashboard";
      const ok = srv.upgrade(req, { data: { role, name: "", active: new Set<string>(), connectedAt: Date.now() } });
      return ok ? undefined : bad("upgrade failed");
    }
    if (url.pathname.startsWith("/api/")) return api(req, url);
    if (url.pathname === "/" || url.pathname === "/index.html")
      return new Response(dashboardHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
    return new Response("not found", { status: 404 });
  },
  websocket: {
    idleTimeout: 120,
    sendPings: true,
    open(ws) {
      if (ws.data.role === "dashboard") {
        dashboards.add(ws);
        ws.send(JSON.stringify({ t: "snapshot", tasks: db.listTasks(50), workers: workerInfo() } satisfies HubToDashboard));
      }
    },
    message(ws, raw) {
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (ws.data.role !== "worker") return; // dashboards act through the REST API
      if (msg.t === "hello") onWorkerHello(ws, String(msg.name), msg.active ?? [], Array.isArray(msg.caps) ? msg.caps : []);
      else if (ws.data.name) onWorkerMessage(ws, msg as WorkerToHub);
    },
    close(ws) {
      if (ws.data.role === "dashboard") dashboards.delete(ws);
      else if (workers.get(ws.data.name) === ws) {
        workers.delete(ws.data.name);
        broadcast({ t: "workers", workers: workerInfo() });
        console.log(`worker "${ws.data.name}" disconnected`);
      }
    },
  },
});

console.log(`relay hub on http://${server.hostname}:${server.port}  (db: ${DB_PATH})`);
