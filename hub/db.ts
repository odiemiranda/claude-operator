import { Database } from "bun:sqlite";
import type { Control, ControlAction, PendingRequest, Task, TaskEvent, TaskStatus } from "../shared/protocol";

export function openDb(path: string) {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      target TEXT NOT NULL,
      kind TEXT NOT NULL,
      model TEXT, prompt TEXT, permission TEXT, resume_session TEXT,
      project TEXT,
      script TEXT, args TEXT,
      session_id TEXT,
      status TEXT NOT NULL,
      result TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tasks_target_status ON tasks(target, status);`);

  // Databases created before the project column existed: add it in place.
  const taskCols = db.query("PRAGMA table_info(tasks)").all() as { name: string }[];
  if (!taskCols.some((c) => c.name === "project")) db.exec("ALTER TABLE tasks ADD COLUMN project TEXT");
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload TEXT,
      ts INTEGER NOT NULL,
      UNIQUE(task_id, seq)
    );
    CREATE TABLE IF NOT EXISTS controls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      action TEXT NOT NULL,
      request_id TEXT,
      message TEXT,
      delivered INTEGER NOT NULL DEFAULT 0,
      ts INTEGER NOT NULL
    );
  `);

  const rowToTask = (r: any): Task => ({ ...r, args: r.args ? JSON.parse(r.args) : null });
  const rowToEvent = (r: any): TaskEvent => ({ ...r, payload: r.payload ? JSON.parse(r.payload) : null });

  const q = {
    insertTask: db.prepare(`INSERT INTO tasks (id,target,kind,model,prompt,permission,resume_session,project,script,args,status,created_at,updated_at)
      VALUES ($id,$target,$kind,$model,$prompt,$permission,$resume_session,$project,$script,$args,$status,$now,$now)`),
    getTask: db.prepare("SELECT * FROM tasks WHERE id = ?"),
    listTasks: db.prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?"),
    byTargetStatus: db.prepare("SELECT * FROM tasks WHERE target = ? AND status IN (SELECT value FROM json_each(?)) ORDER BY created_at"),
    setStatus: db.prepare(`UPDATE tasks SET status = $status, updated_at = $now,
      session_id = COALESCE($session_id, session_id), result = COALESCE($result, result) WHERE id = $id`),
    insertEvent: db.prepare("INSERT OR IGNORE INTO events (task_id,seq,type,payload,ts) VALUES (?,?,?,?,?) RETURNING id"),
    eventsAfter: db.prepare("SELECT * FROM events WHERE task_id = ? AND seq > ? ORDER BY seq LIMIT ?"),
    eventsTail: db.prepare("SELECT * FROM (SELECT * FROM events WHERE task_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq"),
    lastSeq: db.prepare("SELECT COALESCE(MAX(seq),0) AS s FROM events WHERE task_id = ?"),
    pendingRaw: db.prepare(`SELECT * FROM events WHERE task_id = ? AND type IN
      ('permission_request','permission_resolved','waiting','resumed') ORDER BY seq`),
    insertControl: db.prepare("INSERT INTO controls (task_id,action,request_id,message,ts) VALUES (?,?,?,?,?) RETURNING *"),
    undeliveredFor: db.prepare("SELECT * FROM controls WHERE delivered = 0 AND task_id IN (SELECT value FROM json_each(?)) ORDER BY id"),
    markDelivered: db.prepare("UPDATE controls SET delivered = 1 WHERE id = ?"),
    clearEvents: db.prepare("DELETE FROM events WHERE task_id IN (SELECT id FROM tasks WHERE status IN ('done','error','cancelled'))"),
    clearControls: db.prepare("DELETE FROM controls WHERE task_id IN (SELECT id FROM tasks WHERE status IN ('done','error','cancelled'))"),
    clearTasks: db.prepare("DELETE FROM tasks WHERE status IN ('done','error','cancelled')"),
  };

  return {
    createTask(t: Omit<Task, "created_at" | "updated_at" | "session_id" | "result">): Task {
      q.insertTask.run({
        $id: t.id, $target: t.target, $kind: t.kind, $model: t.model ?? null, $prompt: t.prompt ?? null,
        $permission: t.permission ?? null, $resume_session: t.resume_session ?? null, $project: t.project ?? null,
        $script: t.script ?? null, $args: t.args ? JSON.stringify(t.args) : null,
        $status: t.status, $now: Date.now(),
      });
      return this.getTask(t.id)!;
    },
    getTask(id: string): Task | null {
      const r = q.getTask.get(id);
      return r ? rowToTask(r) : null;
    },
    listTasks(limit = 50): Task[] {
      return q.listTasks.all(limit).map(rowToTask);
    },
    tasksFor(target: string, statuses: TaskStatus[]): Task[] {
      return q.byTargetStatus.all(target, JSON.stringify(statuses)).map(rowToTask);
    },
    setStatus(id: string, status: TaskStatus, extra: { session_id?: string; result?: string } = {}): Task | null {
      q.setStatus.run({ $id: id, $status: status, $now: Date.now(), $session_id: extra.session_id ?? null, $result: extra.result ?? null });
      return this.getTask(id);
    },
    /** Returns the stored event with its global id, or null if it was a duplicate. */
    addEvent(e: TaskEvent): TaskEvent | null {
      const r = q.insertEvent.get(e.task_id, e.seq, e.type, JSON.stringify(e.payload ?? null), e.ts) as { id: number } | null;
      return r ? { ...e, id: r.id } : null;
    },
    events(taskId: string, opts: { afterSeq?: number; tail?: number; limit?: number }): TaskEvent[] {
      const rows = opts.tail
        ? q.eventsTail.all(taskId, opts.tail)
        : q.eventsAfter.all(taskId, opts.afterSeq ?? 0, opts.limit ?? 1000);
      return rows.map(rowToEvent);
    },
    lastSeq(taskId: string): number {
      return (q.lastSeq.get(taskId) as { s: number }).s;
    },
    pending(taskId: string): PendingRequest[] {
      const open = new Map<string, PendingRequest>();
      for (const r of q.pendingRaw.all(taskId).map(rowToEvent)) {
        const p = r.payload ?? {};
        if (r.type === "permission_request")
          open.set(p.request_id, { request_id: p.request_id, kind: "permission", tool: p.tool, input: p.input, seq: r.seq });
        else if (r.type === "waiting")
          open.set(p.request_id, { request_id: p.request_id, kind: "waiting", reason: p.reason, seq: r.seq });
        else open.delete(p.request_id);
      }
      return [...open.values()];
    },
    addControl(taskId: string, action: ControlAction, requestId?: string, message?: string): Control {
      return q.insertControl.get(taskId, action, requestId ?? null, message ?? null, Date.now()) as Control;
    },
    undeliveredControls(taskIds: string[]): Control[] {
      return q.undeliveredFor.all(JSON.stringify(taskIds)) as Control[];
    },
    markDelivered(id: number) {
      q.markDelivered.run(id);
    },
    /** Deletes finished tasks with their events and controls. Returns how many tasks went. */
    clearFinished: db.transaction((): number => {
      q.clearEvents.run();
      q.clearControls.run();
      return q.clearTasks.run().changes;
    }),
  };
}

export type Db = ReturnType<typeof openDb>;
