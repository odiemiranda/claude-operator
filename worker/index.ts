// Relay worker: connects out to the hub, runs assigned tasks, streams events back.
// Start it at logon so it (and anything it launches) lives in your desktop session.
import {
  isTerminal, type Control, type ControlAction, type HubToWorker, type ProjectCatalogEntry, type ScriptCatalogEntry,
  type Task, type TaskEvent, type TaskStatus, type WorkerToHub,
} from "../shared/protocol";
import { overlaps, RELAY_DIR, runAgent } from "./agent";
import { config, loadProjects, loadScripts } from "./config";
import type { TaskContext } from "./context";
import { runExec } from "./exec";

if (!config.token) {
  console.error("RELAY_TOKEN is required.");
  process.exit(1);
}
if (overlaps(RELAY_DIR, config.cwd)) {
  console.warn(`WORKER_CWD (${config.cwd}) overlaps the relay checkout: agent tasks sent without a project will fail. Set WORKER_CWD elsewhere or always name a project.`);
}
if (!config.useApiKey && process.env.ANTHROPIC_API_KEY) {
  console.log("ANTHROPIC_API_KEY is set but ignored; agent tasks use your Claude login (set WORKER_USE_API_KEY=1 to bill the API).");
}

// ---------- connection + durable outbox ----------

let ws: WebSocket | null = null;
let connected = false;
let mid = 0;
const outbox = new Map<number, WorkerToHub>(); // kept until the hub acks, resent on reconnect

function sendRaw(msg: WorkerToHub) {
  if (connected && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
function sendDurable(msg: WorkerToHub & { mid: number }) {
  outbox.set(msg.mid, msg);
  sendRaw(msg);
}

function connect(attempt = 0) {
  const url = config.hubUrl.replace(/^http/, "ws") + `/ws?role=worker&token=${encodeURIComponent(config.token)}`;
  ws = new WebSocket(url);
  ws.onopen = () => {
    attempt = 0;
    ws!.send(JSON.stringify({ t: "hello", role: "worker", name: config.name, active: [...tasks.keys()], caps: ["project"] } satisfies WorkerToHub));
  };
  ws.onmessage = (e) => onHubMessage(JSON.parse(String(e.data)) as HubToWorker);
  ws.onclose = (e) => {
    connected = false;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
    console.log(`hub connection closed (${e.code}${e.reason ? " " + e.reason : ""}); retrying in ${delay / 1000}s`);
    setTimeout(() => connect(attempt + 1), delay);
  };
  ws.onerror = () => {}; // onclose handles retry
}

function onHubMessage(msg: HubToWorker) {
  switch (msg.t) {
    case "welcome":
      connected = true;
      console.log(`connected to ${config.hubUrl} as "${config.name}"`);
      // A new socket means the hub holds nothing for us, so the catalog always goes out.
      sendCatalog(true);
      for (const m of [...outbox.keys()].sort((a, b) => a - b)) sendRaw(outbox.get(m)!);
      break;
    case "ack":
      outbox.delete(msg.mid);
      break;
    case "assign":
      if (!tasks.has(msg.task.id)) enqueue(msg.task, msg.last_seq ?? 0);
      break;
    case "control":
      sendRaw({ t: "control_ack", control_id: msg.control.id });
      onControl(msg.control);
      break;
  }
}

// ---------- catalog: what this worker offers (names and descriptions only) ----------

let lastCatalog = "";
let catalogChain: Promise<void> = Promise.resolve();

/** Serialized, so two reloads can never reach the hub out of order. */
function sendCatalog(force: boolean): Promise<void> {
  catalogChain = catalogChain.then(() => doSendCatalog(force)).catch(catalogError);
  return catalogChain;
}

async function doSendCatalog(force: boolean) {
  // One unreadable file must not hide the other list.
  const [projects, scripts] = await Promise.all([
    loadProjects().catch((e) => (catalogError(e), {} as Awaited<ReturnType<typeof loadProjects>>)),
    loadScripts().catch((e) => (catalogError(e), {} as Awaited<ReturnType<typeof loadScripts>>)),
  ]);
  const cat = {
    projects: Object.keys(projects)
      .filter((name) => typeof projects[name]?.path === "string")
      .map((name): ProjectCatalogEntry => ({ name, description: projects[name]!.description })),
    scripts: Object.keys(scripts).map((name): ScriptCatalogEntry => {
      const s = scripts[name]!;
      return { name, description: s.description, allowArgs: !!s.allowArgs, argPattern: s.allowArgs ? s.argPattern : undefined, timeoutMin: s.timeoutMin };
    }),
  };
  const json = JSON.stringify(cat);
  if (!force && json === lastCatalog) return;
  if (!connected) return; // the next welcome sends it
  lastCatalog = json;
  sendRaw({ t: "catalog", ...cat });
}

function catalogError(err: unknown) { console.error(`catalog: ${(err as Error).message}`); }

// ---------- task execution ----------

interface Running {
  task: Task;
  seq: number;
  abort: AbortController;
  started: boolean;
  holdNoted: boolean; // the "waiting for project" info event has gone out
  waiters: Map<string, { actions: ControlAction[]; resolve: (c: Control | null) => void }>;
  onMessage?: (c: Control) => void;
  seenMessages: Set<number>; // message/interrupt control ids already handled (a resend must not repeat one)
}
const tasks = new Map<string, Running>();
const queue: string[] = [];
let runningCount = 0;
/** Agent tasks run one at a time per project key ("" = the default folder). Exec tasks take no key. */
const busyProjects = new Map<string, string>(); // project key -> id of the task holding it
const projectKey = (task: Task): string | null => (task.kind === "agent" ? task.project ?? "" : null);

function reportActive() { sendRaw({ t: "active", active: [...tasks.keys()] }); }

function makeContext(r: Running): TaskContext {
  return {
    task: r.task,
    signal: r.abort.signal,
    emit(type, payload) {
      const event: TaskEvent = { task_id: r.task.id, seq: ++r.seq, type, payload, ts: Date.now() };
      sendDurable({ t: "event", mid: ++mid, event });
    },
    setStatus(status: TaskStatus, extra = {}) {
      r.task.status = status;
      sendDurable({ t: "status", mid: ++mid, task_id: r.task.id, status, ...extra });
    },
    onMessage(handler) {
      r.onMessage = handler;
    },
    waitForControl(requestId, actions, timeoutMs) {
      return new Promise((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const done = (c: Control | null) => {
          if (timer) clearTimeout(timer);
          r.waiters.delete(requestId);
          resolve(c);
        };
        r.waiters.set(requestId, { actions, resolve: done });
        if (timeoutMs) timer = setTimeout(() => done(null), timeoutMs);
      });
    },
  };
}

function enqueue(task: Task, lastSeq: number) {
  // A re-assigned task continues after the events the hub already stored, so none collide on (task_id, seq).
  tasks.set(task.id, { task, seq: lastSeq, abort: new AbortController(), started: false, holdNoted: false, waiters: new Map(), seenMessages: new Set() });
  queue.push(task.id);
  console.log(`queued ${task.id} (${task.kind}${task.script ? " " + task.script : ""})`);
  reportActive();
  pump();
}

/** Index of the first queued task that may start now, or -1. Order among same-project tasks stays FIFO. */
function nextRunnable(): number {
  for (let i = 0; i < queue.length; i++) {
    const r = tasks.get(queue[i]!);
    if (!r) return i; // stale id; the caller drops it
    const key = projectKey(r.task);
    if (key === null || !busyProjects.has(key)) return i;
    if (!r.holdNoted) {
      r.holdNoted = true;
      makeContext(r).emit("info", { message: `waiting: agent task ${busyProjects.get(key)} is running in project ${key || "(default folder)"}` });
    }
  }
  return -1;
}

function pump() {
  while (runningCount < config.maxConcurrent) {
    const i = nextRunnable();
    if (i < 0) break;
    // Take the slot and the project key synchronously, before any await.
    const r = tasks.get(queue.splice(i, 1)[0]!);
    if (!r) continue;
    r.started = true;
    runningCount++;
    const key = projectKey(r.task);
    if (key !== null) busyProjects.set(key, r.task.id);
    sendCatalog(false); // a changed allowlist reaches the hub as the next task starts
    const ctx = makeContext(r);
    const run = r.task.kind === "exec" ? runExec(ctx) : runAgent(ctx);
    run
      .catch((err) => ctx.setStatus("error", { result: `Worker error: ${(err as Error).message}` }))
      .finally(() => {
        // Release the slot and the project first, so nothing below can leak them.
        if (key !== null) busyProjects.delete(key);
        runningCount--;
        if (!isTerminal(r.task.status)) ctx.setStatus("error", { result: "Task ended without a final status." });
        tasks.delete(r.task.id);
        console.log(`finished ${r.task.id}: ${r.task.status}`);
        reportActive();
        pump();
      });
  }
}

function onControl(c: Control) {
  const r = tasks.get(c.task_id);
  if (!r) return;
  if (c.action === "cancel") {
    if (!r.started) {
      queue.splice(queue.indexOf(c.task_id), 1);
      tasks.delete(c.task_id);
      makeContext(r).setStatus("cancelled", { result: "Cancelled before it started." });
      reportActive();
      return;
    }
    for (const w of [...r.waiters.values()]) w.resolve(null);
    r.abort.abort();
    return;
  }
  if (c.action === "message" || c.action === "interrupt") {
    if (r.seenMessages.has(c.id)) return;
    r.seenMessages.add(c.id);
    if (!r.onMessage) {
      makeContext(r).emit("info", { message: `${c.action} ignored: the task is not running an agent session` });
      return;
    }
    // An interrupt ends the turn, so nothing may stay blocked on a pending approval or wait.
    if (c.action === "interrupt") for (const w of [...r.waiters.values()]) w.resolve(null);
    r.onMessage(c);
    return;
  }
  const w = c.request_id ? r.waiters.get(c.request_id) : undefined;
  if (w && w.actions.includes(c.action)) w.resolve(c);
}

connect();
