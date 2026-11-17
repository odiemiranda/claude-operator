import type { Control, ControlAction, EventType, Task, TaskStatus } from "../shared/protocol";

export interface TaskContext {
  task: Task;
  signal: AbortSignal;
  emit(type: EventType, payload: unknown): void;
  setStatus(status: TaskStatus, extra?: { session_id?: string; result?: string }): void;
  /** Resolves with the matching control, or null on timeout/cancel. */
  waitForControl(requestId: string, actions: ControlAction[], timeoutMs?: number): Promise<Control | null>;
  /** Receives message and interrupt controls for this task (agent tasks). */
  onMessage(handler: (c: Control) => void): void;
}
