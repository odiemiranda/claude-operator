import { readFile } from "node:fs/promises";
import type { PermissionLevel } from "../shared/protocol";

export interface ScriptSpec {
  /** Command and fixed arguments, e.g. ["cmd", "/c", "C:\\src\\my-app\\build.cmd"] */
  cmd: string[];
  cwd?: string;
  /** Allow the driver to append extra args. Off by default. */
  allowArgs?: boolean;
  /** Regex every extra arg must match in full. Default: DEFAULT_ARG_PATTERN (no spaces or shell characters). */
  argPattern?: string;
  timeoutMin?: number;
  description?: string;
}

/** One allowlisted folder. Drivers name it; only the worker ever sees the path. */
export interface ProjectSpec {
  path: string;
  description?: string;
}

const env = process.env;

export const config = {
  hubUrl: (env.HUB_URL ?? "http://127.0.0.1:7717").replace(/\/$/, ""),
  token: env.RELAY_TOKEN ?? "",
  name: env.WORKER_NAME ?? "win",
  cwd: env.WORKER_CWD ?? process.cwd(),
  scriptsPath: env.WORKER_SCRIPTS ?? new URL("./scripts.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
  projectsPath: env.WORKER_PROJECTS ?? new URL("./projects.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
  defaultModel: env.WORKER_MODEL ?? "claude-haiku-5-5",
  defaultPermission: (env.WORKER_PERMISSION ?? "edits") as PermissionLevel,
  /** Ceiling for what a driver may request; a higher request is lowered to this. */
  maxPermission: (env.WORKER_MAX_PERMISSION ?? "auto") as PermissionLevel,
  maxConcurrent: Number(env.WORKER_MAX_CONCURRENT ?? 2),
  permissionTimeoutMin: Number(env.WORKER_PERMISSION_TIMEOUT_MIN ?? 30),
  /**
   * Which Claude settings files agent sessions load: any of user, project, local. Allow rules and hooks in a loaded
   * file apply before the relay's own permission check. Empty = none.
   */
  settingSources: (env.WORKER_SETTINGS ?? "user,project,local").split(",").map((s) => s.trim())
    .filter((s): s is "user" | "project" | "local" => s === "user" || s === "project" || s === "local"),
  /** Keep ANTHROPIC_API_KEY so usage bills to the API instead of your subscription. */
  useApiKey: env.WORKER_USE_API_KEY === "1",
};

/**
 * Extra args often pass through `cmd /c` into %1 / %*. The default allows plain names only: no spaces or shell
 * characters, no leading - / @ (option and response-file injection), no \ or : (UNC, drive and stream paths),
 * no = or , (cmd splits arguments on them).
 */
export const DEFAULT_ARG_PATTERN = "(?!.*\\.\\.)[A-Za-z0-9_][A-Za-z0-9_./+-]{0,199}"; // and no ".." path steps

/** Environment for anything the worker starts: the hub token stays with the worker. */
export function childEnv(): Record<string, string | undefined> {
  const e: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(e)) if (k.toUpperCase() === "RELAY_TOKEN") delete e[k]; // Windows names ignore case
  // Empty, not unset: a child `bun` started next to this checkout's .env would otherwise load the token again.
  e.RELAY_TOKEN = "";
  return e;
}

const warned = new Set<string>();
function warnOnce(msg: string) {
  if (warned.has(msg)) return;
  warned.add(msg);
  console.warn(msg);
}

/** Both allowlist files are a JSON object of name -> spec; anything else is refused. */
async function loadMap<T>(path: string, label: string, missing: string): Promise<Record<string, T>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    warnOnce(`no ${label} file at ${path}; ${missing}`);
    return {};
  }
  let v: unknown;
  try {
    v = JSON.parse(text.replace(/^﻿/, "")); // Windows editors often save a BOM
  } catch (e) {
    throw new Error(`${label} file is not valid JSON (${path}): ${(e as Error).message}`);
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${label} file must be a JSON object of name -> entry (${path})`);
  return v as Record<string, T>;
}

export const loadScripts = () => loadMap<ScriptSpec>(config.scriptsPath, "scripts", "exec tasks will fail");

/** Re-read for every task, like loadScripts. A missing file means no projects. */
export const loadProjects = () => loadMap<ProjectSpec>(config.projectsPath, "projects", "agent tasks with a project will fail");
