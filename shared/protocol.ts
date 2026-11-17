// Message and record types shared by hub, worker, MCP server and dashboard.

export type TaskKind = "agent" | "exec";
export type TaskStatus =
  | "queued"    // stored, worker not connected yet
  | "assigned"  // sent to worker, waiting in its local queue
  | "running"
  | "waiting"   // blocked on a permission request or wait_for_user
  | "done"
  | "error"
  | "cancelled";

export const TERMINAL: readonly TaskStatus[] = ["done", "error", "cancelled"];
export const isTerminal = (s: TaskStatus) => TERMINAL.includes(s);

/** ask: only read-only tools run freely. edits: file edits too. auto: everything. */
export type PermissionLevel = "ask" | "edits" | "auto";

export interface Task {
  id: string;
  target: string;          // worker name, e.g. "win"
  kind: TaskKind;
  model?: string | null;   // agent tasks
  prompt?: string | null;  // agent tasks
  permission?: PermissionLevel | null;
  resume_session?: string | null; // agent: continue this Claude session
  project?: string | null; // agent: name in worker's projects.json (never a path)
  script?: string | null;  // exec tasks: key in worker's scripts.json
  args?: string[] | null;
  session_id?: string | null;     // filled in by the worker
  status: TaskStatus;
  result?: string | null;
  created_at: number;
  updated_at: number;
}

export type EventType =
  | "log"                 // exec output: { stream, lines[] }
  | "info"                // { message, ... }
  | "text"                // agent text: { text }
  | "tool_call"           // { id, name, input }
  | "tool_result"         // { tool_use_id, is_error, content }
  | "permission_request"  // { request_id, tool, input, title? }
  | "permission_resolved" // { request_id, decision, message? }
  | "waiting"             // { request_id, reason }
  | "resumed"             // { request_id, message? }
  | "result";             // { ok, summary, ... }

export interface TaskEvent {
  id?: number;   // global id assigned by the hub
  task_id: string;
  seq: number;   // per-task, assigned by the worker (dedupe key)
  type: EventType;
  payload: any;
  ts: number;
}

/** message: queue a user message for after the agent's current turn. interrupt: stop the current turn now
 * (then run the message, if one is given, else end the task as cancelled). Both are for running agent tasks. */
export type ControlAction = "approve" | "deny" | "cancel" | "continue" | "message" | "interrupt";

export interface Control {
  id: number;
  task_id: string;
  action: ControlAction;
  request_id?: string | null;
  message?: string | null;
  ts: number;
}

/** What a worker offers: names and descriptions only, never paths or commands. */
export interface ProjectCatalogEntry {
  name: string;
  description?: string;
}

export interface ScriptCatalogEntry {
  name: string;
  description?: string;
  allowArgs: boolean;
  argPattern?: string; // regex each extra arg must match; absent = the worker default
  timeoutMin?: number;
}

export interface WorkerInfo {
  name: string;
  connected_at: number;
  active: string[];
  projects?: ProjectCatalogEntry[];  // absent until the worker sends its catalog
  scripts?: ScriptCatalogEntry[];
}

export interface PendingRequest {
  request_id: string;
  kind: "permission" | "waiting";
  tool?: string;
  input?: string;
  reason?: string;
  seq: number;
}

// ---- WebSocket messages ----

export type WorkerToHub =
  | { t: "hello"; role: "worker"; name: string; active: string[]; caps?: string[] } // caps: features this worker build supports
  | { t: "event"; mid: number; event: TaskEvent }
  | { t: "status"; mid: number; task_id: string; status: TaskStatus; session_id?: string; result?: string }
  | { t: "control_ack"; control_id: number }
  | { t: "active"; active: string[] }
  | { t: "catalog"; projects: ProjectCatalogEntry[]; scripts: ScriptCatalogEntry[] };

export type HubToWorker =
  | { t: "welcome" }
  | { t: "assign"; task: Task; last_seq?: number } // last_seq: highest event seq the hub already stored for this task
  | { t: "control"; control: Control }
  | { t: "ack"; mid: number };

export type HubToDashboard =
  | { t: "snapshot"; tasks: Task[]; workers: WorkerInfo[] }
  | { t: "task"; task: Task }
  | { t: "event"; event: TaskEvent }
  | { t: "workers"; workers: WorkerInfo[] };

// ---- helpers ----

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n… [${s.length - max} more chars]`;
}

export function rid(prefix = ""): string {
  return prefix + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}
