// Runs an allowlisted script from scripts.json and streams its output. No LLM involved.
import { childEnv, config, DEFAULT_ARG_PATTERN, loadScripts } from "./config";
import type { TaskContext } from "./context";

const IS_WIN = process.platform === "win32";

// Stop the script and everything it started. On Windows taskkill /T walks the tree. Elsewhere the script runs
// detached (its own process group, pgid = pid), so signalling -pid reaches its children too; SIGKILL follows
// after a grace period for anything that ignores SIGTERM (its open pipes would otherwise keep the task running).
export function killTree(pid: number) {
  if (IS_WIN) {
    Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"]);
    return;
  }
  const signal = (sig: NodeJS.Signals) => {
    try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch {} } // no group: older Bun ignored detached
  };
  signal("SIGTERM");
  setTimeout(() => signal("SIGKILL"), 5_000).unref();
}

export async function runExec(ctx: TaskContext): Promise<void> {
  const { task } = ctx;
  const scripts = await loadScripts();
  const spec = scripts[task.script ?? ""];
  if (!spec) {
    const known = Object.keys(scripts).join(", ") || "(none)";
    ctx.setStatus("error", { result: `Unknown script "${task.script}". Known: ${known}` });
    return;
  }
  const extra = task.args ?? [];
  if (extra.length && !spec.allowArgs) {
    ctx.setStatus("error", { result: `Script "${task.script}" does not accept extra args.` });
    return;
  }

  if (extra.length) {
    let re: RegExp;
    try {
      const pattern = spec.argPattern ?? DEFAULT_ARG_PATTERN;
      if (typeof pattern !== "string" || !pattern) throw new Error("argPattern must be a non-empty string");
      new RegExp(pattern); // must compile on its own, so it cannot close the anchoring group below
      re = new RegExp(`^(?:${pattern})$`);
    } catch {
      ctx.setStatus("error", { result: `Script "${task.script}" has an invalid argPattern in scripts.json.` });
      return;
    }
    const badArg = extra.find((a) => typeof a !== "string" || !re.test(a));
    if (badArg !== undefined) {
      ctx.setStatus("error", { result: `Argument ${JSON.stringify(badArg)} is not allowed for script "${task.script}" (must match ${re.source}).` });
      return;
    }
  }

  const cmd = [...spec.cmd, ...extra];
  ctx.setStatus("running");
  ctx.emit("info", { message: `exec ${cmd.join(" ")}`, cwd: spec.cwd ?? config.cwd });

  const proc = Bun.spawn(cmd, {
    cwd: spec.cwd ?? config.cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: childEnv(),
    // Own process group outside Windows, so killTree can stop the script's children. Missing from bun-types.
    ...(IS_WIN ? {} : { detached: true }),
  });

  // Batch output into one event per ~300ms per stream so the log stays readable and SQLite stays calm.
  const buffers: Record<"stdout" | "stderr", string[]> = { stdout: [], stderr: [] };
  const flush = () => {
    for (const stream of ["stdout", "stderr"] as const) {
      if (buffers[stream].length) {
        ctx.emit("log", { stream, lines: buffers[stream] });
        buffers[stream] = [];
      }
    }
  };
  const timer = setInterval(flush, 300);

  async function pump(stream: ReadableStream<Uint8Array>, name: "stdout" | "stderr") {
    const decoder = new TextDecoder();
    let partial = "";
    const reader = stream.getReader();
    for (;;) {
      const { value: chunk, done } = await reader.read();
      if (done) break;
      const text = partial + decoder.decode(chunk, { stream: true });
      const lines = text.split(/\r?\n/);
      partial = lines.pop() ?? "";
      buffers[name].push(...lines);
      if (buffers[name].length > 200) flush();
    }
    if (partial) buffers[name].push(partial);
  }

  let timedOut = false;
  const timeout = spec.timeoutMin
    ? setTimeout(() => { timedOut = true; killTree(proc.pid); }, spec.timeoutMin * 60_000)
    : null;
  const onAbort = () => killTree(proc.pid);
  ctx.signal.addEventListener("abort", onAbort);

  try {
    await Promise.all([pump(proc.stdout, "stdout"), pump(proc.stderr, "stderr")]);
    const code = await proc.exited;
    flush();
    if (ctx.signal.aborted) ctx.setStatus("cancelled", { result: "Cancelled; process killed." });
    else if (timedOut) ctx.setStatus("error", { result: `Timed out after ${spec.timeoutMin} min.` });
    else if (code === 0) ctx.setStatus("done", { result: "exit code 0" });
    else ctx.setStatus("error", { result: `exit code ${code}` });
  } finally {
    clearInterval(timer);
    if (timeout) clearTimeout(timeout);
    ctx.signal.removeEventListener("abort", onAbort);
  }
}
