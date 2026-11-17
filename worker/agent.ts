// Runs a Claude Agent SDK session for an agent task, streaming progress to the hub.
import { lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createSdkMcpServer, query, tool, type CanUseTool, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { rid, truncate, type PermissionLevel } from "../shared/protocol";
import { childEnv, config, loadProjects } from "./config";
import type { TaskContext } from "./context";

const READ_ONLY = new Set(["Read", "Glob", "Grep", "LS", "TodoWrite", "NotebookRead", "BashOutput", "ToolSearch"]);
const EDITS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

const SYSTEM_APPEND = `
You are running as a remote worker on this machine, driven by an orchestrator agent on another computer.
Nobody is watching this terminal. Work autonomously and keep tool output focused (grep/tail long logs instead of printing them whole).
When you need the human to do something on this machine's desktop (for example log in to the app you launched), call the
wait_for_user tool with a short instruction, then continue once it returns.
End with a concise report: what you did, the outcome, and any errors with file:line and the key lines of the message.`;

function brief(input: unknown, max = 600): string {
  if (input && typeof input === "object" && "command" in input) return String((input as any).command).slice(0, max);
  return truncate(JSON.stringify(input), max);
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: any) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
  return JSON.stringify(content);
}

const LEVELS: PermissionLevel[] = ["ask", "edits", "auto"];
/** The lower of the requested level and the worker's ceiling. */
function capLevel(requested: PermissionLevel): PermissionLevel {
  const r = LEVELS.indexOf(requested), m = LEVELS.indexOf(config.maxPermission);
  return LEVELS[Math.min(r < 0 ? 0 : r, m < 0 ? 0 : m)]!;
}

/** This relay's own checkout: it holds .env (the hub token) and the allowlist files. */
export const RELAY_DIR = fileURLToPath(new URL("..", import.meta.url));

/** The path as the CLI will read it: trimmed, ~ expanded, and on Windows /c/x -> C:\\x and no \\\\?\\ prefix. */
function normalize(raw: string): string {
  let p = raw.trim();
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) p = homedir() + p.slice(1);
  if (process.platform === "win32") {
    p = p.replace(/^\\\\\?\\(?=[A-Za-z]:)/, "").replace(/^\/([A-Za-z])(?=[\\/]|$)/, "$1:");
  }
  return p;
}

const UNRESOLVED = "\0unresolved";

/** Real location of a path, following links. For a path that does not exist yet, its deepest existing parent decides. */
function real(p: string): string {
  let rest = "";
  for (let cur = p; ; ) {
    try { return join(realpathSync.native(cur), rest); } catch {}
    // Something is there but does not resolve (a dangling link): where a write would land is unknown.
    try { lstatSync(cur); return UNRESOLVED; } catch {}
    const up = dirname(cur);
    if (up === cur) return p;
    rest = join(basename(cur), rest);
    cur = up;
  }
}
function inside(root: string, p: string): boolean {
  const rp = real(p);
  if (rp === UNRESOLVED) return false;
  let rel = relative(real(root), rp);
  if (process.platform === "win32") rel = rel.toLowerCase();
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
/** One folder is, holds, or sits in the other. */
export const overlaps = (a: string, b: string) => inside(a, b) || inside(b, a);

/** Files that configure Claude itself: allow rules, hooks, MCP servers. Writing one could grant the next task anything. */
function isClaudeConfig(root: string, p: string): boolean {
  const parts = relative(real(root), real(p)).split(/[\\/]/).map((s) => s.toLowerCase());
  return parts.some((s) => GUARDED_DIRS.has(s)) || GUARDED_FILES.has(parts.at(-1) ?? "");
}
/** Folders and files whose content runs or configures tools later (git hooks, editor tasks, Claude settings). */
const GUARDED_DIRS = new Set([".claude", ".git", ".husky", ".githooks", ".vscode", ".idea", ".devcontainer"]);
const GUARDED_FILES = new Set([".mcp.json", ".claude.json", ".gitmodules", "bunfig.toml", ".pre-commit-config.yaml", "lefthook.yml", "claude.md"]);

/**
 * Spellings the gate cannot judge reliably: UNC and device paths, alternate data streams, 8.3 short names,
 * trailing dots or spaces. These always ask, at every level.
 */
function suspicious(raw: string): boolean {
  const p = raw.trim();
  if (/^[\\/]{2}/.test(p) || /^[\\/]\?\?[\\/]/.test(p)) return !/^\\\\\?\\[A-Za-z]:[\\/]/.test(p);
  return p.replace(/^[A-Za-z]:/, "").split(/[\\/]/).some((seg) => seg.includes(":") || /~\d/.test(seg) || /[. ]$/.test(seg) && seg !== "." && seg !== "..");
}

const PATH_KEYS = ["file_path", "path", "notebook_path", "out_dir", "scriptPath"];
/** The raw path strings a tool call carries, whatever the tool. */
function rawPaths(input: unknown): string[] {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out: string[] = [];
  for (const k of PATH_KEYS) if (typeof i[k] === "string" && (i[k] as string).trim()) out.push(i[k] as string);
  if (Array.isArray(i.file_paths)) for (const v of i.file_paths) if (typeof v === "string" && v.trim()) out.push(v);
  return out;
}

/** Every path a tool call names, resolved against the task's folder. */
function pathsOf(toolName: string, input: unknown, cwd: string): string[] {
  const out = rawPaths(input).map((r) => resolve(cwd, normalize(r)));
  // A glob pattern can itself point elsewhere ("C:/other/**", "../x/**", "~/x"): judge its fixed leading part.
  const pattern = (input as Record<string, unknown> | null)?.pattern;
  if (toolName === "Glob" && typeof pattern === "string") {
    const fixed = normalize(pattern).split(/[*?[{]/)[0]!;
    if (isAbsolute(fixed) || pattern.includes("..")) out.push(resolve(cwd, pattern.includes("..") ? ".." : fixed));
  }
  return out;
}

/**
 * allow / ask / deny for one tool call.
 * - Anything in the relay checkout (.env with the hub token, the allowlists, this code) is refused, as is a search
 *   whose root holds that checkout. Task folders never overlap it (see resolveCwd).
 * - Read-only and edit tools run freely only inside the task's folder; a path outside it asks first.
 * - Edits to files that run or configure tools later (.claude/, .git/, .vscode/, .mcp.json, ...) ask below auto.
 * - Path spellings the gate cannot judge (UNC, device paths, streams, short names) ask at every level.
 * - Not a sandbox: an approved or auto-level shell command can still reach any file this Windows user can.
 */
function decide(level: PermissionLevel, toolName: string, input: unknown, cwd: string): "allow" | "ask" | "deny" {
  if (toolName === "mcp__relay__wait_for_user") return "allow";
  if (toolName === "EnterWorktree") return "deny"; // would move the session out of the folder paths are judged against
  const fileTool = READ_ONLY.has(toolName) || EDITS.has(toolName);
  // Paths are checked on every tool that carries one, so a tool outside the two sets cannot reach the relay either.
  const paths = pathsOf(toolName, input, cwd);
  if (paths.some((p) => overlaps(RELAY_DIR, p))) return "deny";
  if (rawPaths(input).some(suspicious)) return "ask";
  if (level === "auto") return "allow";
  if (fileTool && !paths.every((p) => inside(cwd, p))) return "ask";
  if (READ_ONLY.has(toolName)) return "allow";
  if (level === "edits" && EDITS.has(toolName)) return paths.some((p) => isClaudeConfig(cwd, p)) ? "ask" : "allow";
  return "ask";
}

/** Project name -> folder from projects.json. Sets the error status and returns null if it cannot be used. */
async function resolveCwd(ctx: TaskContext): Promise<string | null> {
  const name = ctx.task.project;
  if (name == null) return config.cwd;
  if (typeof name !== "string") {
    ctx.setStatus("error", { result: "Task project must be a name." });
    return null;
  }
  const projects = await loadProjects();
  const spec = Object.hasOwn(projects, name) ? projects[name] : undefined;
  if (spec === undefined) {
    const known = Object.keys(projects).join(", ") || "(none)";
    ctx.setStatus("error", { result: `Unknown project "${name}". Known: ${known}` });
    return null;
  }
  if (typeof spec?.path !== "string") {
    ctx.setStatus("error", { result: `Project "${name}" has no path in projects.json.` });
    return null;
  }
  try {
    if (statSync(spec.path).isDirectory()) return spec.path;
  } catch {}
  ctx.setStatus("error", { result: `Project "${name}" folder is missing or is not a directory.` });
  return null;
}

export const __test = { decide, suspicious };

export async function runAgent(ctx: TaskContext): Promise<void> {
  const { task } = ctx;
  const cwd = await resolveCwd(ctx);
  if (cwd === null) return;
  if (overlaps(RELAY_DIR, cwd)) {
    ctx.setStatus("error", {
      result: task.project
        ? `Project "${task.project}" is, holds, or sits in the relay's own checkout; agents cannot work there.`
        : "The default folder is, holds, or sits in the relay's own checkout; set WORKER_CWD elsewhere or name a project.",
    });
    return;
  }
  // A cancel that arrived during the lookup above fired before any listener existed.
  if (ctx.signal.aborted) {
    ctx.setStatus("cancelled", { result: "Cancelled." });
    return;
  }
  const requested = (task.permission ?? config.defaultPermission) as PermissionLevel;
  const level = capLevel(requested);
  if (level !== requested) ctx.emit("info", { message: `permission ${requested} lowered to ${level} (WORKER_MAX_PERMISSION)` });
  const abort = new AbortController();
  ctx.signal.addEventListener("abort", () => abort.abort());

  // Blocks the agent until the human (via dashboard or driver) sends "continue".
  const relayTools = createSdkMcpServer({
    name: "relay",
    version: "1.0.0",
    tools: [
      tool(
        "wait_for_user",
        "Pause until the human confirms they finished a manual step on this machine's desktop (e.g. logging in). Returns their reply.",
        { reason: z.string().describe("What the human should do, in one or two sentences") },
        async ({ reason }) => {
          const request_id = rid("w_");
          ctx.emit("waiting", { request_id, reason });
          ctx.setStatus("waiting");
          const c = await ctx.waitForControl(request_id, ["continue"]);
          ctx.emit("resumed", { request_id, message: c?.message ?? null });
          ctx.setStatus("running");
          const text = !c ? "The wait was cancelled." : c.message ? `The user continued and said: ${c.message}` : "The user continued.";
          return { content: [{ type: "text", text }] };
        },
      ),
    ],
  });

  const canUseTool: CanUseTool = async (toolName, input, opts) => {
    const verdict = decide(level, toolName, input, cwd);
    if (verdict === "allow") return { behavior: "allow", updatedInput: input };
    if (verdict === "deny") return { behavior: "deny", message: "The relay's own files are off limits to agent tasks." };
    const request_id = rid("p_");
    ctx.emit("permission_request", {
      request_id, tool: toolName, input: brief(input, 2000), title: (opts as any).title ?? null,
    });
    ctx.setStatus("waiting");
    const c = await ctx.waitForControl(request_id, ["approve", "deny"], config.permissionTimeoutMin * 60_000);
    const approved = c?.action === "approve";
    ctx.emit("permission_resolved", {
      request_id, decision: approved ? "approved" : c ? "denied" : interrupted ? "interrupted" : "timed out", message: c?.message ?? null,
    });
    ctx.setStatus("running");
    return approved
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: c?.message || (c ? "Denied by the orchestrator." : interrupted ? "Interrupted by the orchestrator." : "No approval arrived in time.") };
  };

  // Streaming input keeps the session (and the in-process MCP server) alive until the last result.
  // Driver messages (relay_control message/interrupt) are queued in inbox and sent one per turn, only after the
  // current turn's result, so every turn ends in exactly one result.
  const userMsg = (text: string) =>
    ({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null }) as SDKUserMessage;
  const inbox: string[] = [];
  let done = false, between = false, interrupted = false;
  let wake: (() => void) | null = null;
  const kick = () => { const w = wake; wake = null; w?.(); };
  const finish = () => { done = true; kick(); };
  async function* input(): AsyncIterable<SDKUserMessage> {
    yield userMsg(task.prompt ?? "");
    for (;;) {
      while (!done && !(between && inbox.length)) await new Promise<void>((r) => (wake = r));
      if (done) return;
      between = false;
      const text = inbox.shift()!;
      ctx.emit("info", { message: `next turn, from the driver: ${truncate(text, 300)}` });
      ctx.setStatus("running");
      yield userMsg(text);
    }
  }
  let q: ReturnType<typeof query> | null = null;
  ctx.onMessage((c) => {
    if (done) return;
    const text = c.message?.trim() ?? "";
    if (text) inbox.push(text);
    if (c.action === "interrupt") {
      interrupted = true;
      ctx.emit("info", { message: `interrupt from the driver${text ? "; next: " + truncate(text, 300) : ""}` });
      q?.interrupt().catch((e) => ctx.emit("info", { message: `interrupt failed: ${(e as Error).message}` }));
    } else {
      ctx.emit("info", { message: `message queued for after the current turn: ${truncate(text, 300)}` });
    }
  });

  const env = childEnv();
  if (!config.useApiKey) delete env.ANTHROPIC_API_KEY;

  ctx.setStatus("running");
  let sawResult = false;
  try {
    q = query({
      prompt: input(),
      options: {
        model: task.model || config.defaultModel,
        cwd,
        resume: task.resume_session ?? undefined,
        abortController: abort,
        permissionMode: "default",
        canUseTool,
        mcpServers: { relay: relayTools },
        settingSources: config.settingSources,
        systemPrompt: { type: "preset", preset: "claude_code", append: SYSTEM_APPEND },
        env,
      },
    });

    for await (const msg of q) {
      if (msg.type === "system" && msg.subtype === "init") {
        ctx.setStatus("running", { session_id: msg.session_id });
        ctx.emit("info", {
          message: `session ${msg.session_id}`, model: msg.model, cwd: msg.cwd, project: task.project ?? null,
          auth: msg.apiKeySource, claude_code: msg.claude_code_version,
        });
      } else if (msg.type === "assistant") {
        for (const block of msg.message.content as any[]) {
          if (block.type === "text" && block.text.trim()) ctx.emit("text", { text: block.text });
          else if (block.type === "tool_use") ctx.emit("tool_call", { id: block.id, name: block.name, input: brief(block.input) });
        }
      } else if (msg.type === "user") {
        const content = (msg.message as any).content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_result")
              ctx.emit("tool_result", {
                tool_use_id: block.tool_use_id, is_error: !!block.is_error,
                content: truncate(toolResultText(block.content), 1500),
              });
          }
        }
      } else if (msg.type === "result") {
        sawResult = true;
        const r = msg as any;
        const ok = r.subtype === "success" && !r.is_error;
        const summary: string = r.result ?? (r.errors ?? []).join("\n") ?? r.subtype;
        ctx.emit("result", {
          ok, subtype: r.subtype, summary, turns: r.num_turns, duration_ms: r.duration_ms, cost_usd: r.total_cost_usd,
        });
        const wasInterrupted = interrupted;
        interrupted = false;
        if (inbox.length) {
          // More driver messages: keep the session and send the next one as a new turn.
          ctx.setStatus("running", { session_id: r.session_id });
          between = true;
          kick();
        } else {
          ctx.setStatus(wasInterrupted ? "cancelled" : ok ? "done" : "error", {
            session_id: r.session_id,
            result: wasInterrupted ? "Interrupted by the driver." : summary || r.subtype,
          });
          finish();
        }
      }
    }
    if (!sawResult) {
      ctx.setStatus(ctx.signal.aborted ? "cancelled" : "error", { result: ctx.signal.aborted ? "Cancelled." : "Session ended without a result." });
    }
  } catch (err) {
    if (ctx.signal.aborted) ctx.setStatus("cancelled", { result: "Cancelled." });
    else ctx.setStatus("error", { result: `Agent failed: ${(err as Error).message}` });
  } finally {
    finish();
  }
}
