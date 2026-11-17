// Run the hub or the worker in the background:
//   bun run hub:start | hub:stop | hub:status | hub:logs   (same for worker: and mcp:)
// mcp runs with --http (MCP_PORT, default 7718) so it can live outside a Claude Code session.
import { spawn, spawnSync } from "node:child_process";
import { openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SERVICES = { hub: "hub/index.ts", worker: "worker/index.ts", mcp: "mcp-remote/index.ts" } as const;
const name = process.argv[2] as keyof typeof SERVICES;
const action = process.argv[3];
if (!Object.hasOwn(SERVICES, name)) {
  console.error("usage: bun run scripts/service.ts hub|worker|mcp start|stop|status|logs");
  process.exit(2);
}

const root = fileURLToPath(new URL("..", import.meta.url));
const PID = `${root}.${name}.pid`;
const LOG = `${root}${name}.log`;
const IS_WIN = process.platform === "win32";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The pid in the pid file if that process is still alive. */
function running(): number | null {
  try {
    const pid = Number(readFileSync(PID, "utf8"));
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function tail(n: number): string {
  try { return readFileSync(LOG, "utf8").trimEnd().split(/\r?\n/).slice(-n).join("\n"); } catch { return "(no log yet)"; }
}

switch (action) {
  case "start": {
    const pid = running();
    if (pid) { console.log(`${name} already running (pid ${pid})`); break; }
    const out = openSync(LOG, "a");
    // cwd = repo root, so Bun loads .env from there. windowsHide: no console window on Windows.
    const child = spawn(process.execPath, ["run", root + SERVICES[name], ...(name === "mcp" ? ["--http"] : [])], {
      cwd: root, detached: true, windowsHide: true, stdio: ["ignore", out, out],
    });
    child.unref();
    writeFileSync(PID, String(child.pid));
    await sleep(1500);
    if (running()) console.log(`${name} started (pid ${child.pid}), log: ${LOG}\n${tail(2)}`);
    else { rmSync(PID, { force: true }); console.error(`${name} exited right away:\n${tail(10)}`); process.exit(1); }
    break;
  }
  case "stop": {
    const pid = running();
    if (!pid) { rmSync(PID, { force: true }); console.log(`${name} not running`); break; }
    // On Windows a kill does not reach child processes (agent sessions, scripts), so kill the whole tree.
    if (IS_WIN) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(pid, "SIGTERM");
    for (let i = 0; i < 30 && running(); i++) await sleep(100);
    if (running()) process.kill(pid, "SIGKILL");
    rmSync(PID, { force: true });
    console.log(`${name} stopped (pid ${pid})`);
    break;
  }
  case "status": {
    const pid = running();
    console.log(pid ? `${name} running (pid ${pid})\n${tail(2)}` : `${name} not running`);
    break;
  }
  case "logs":
    console.log(tail(Number(process.argv[4] ?? 40)));
    break;
  default:
    console.error(`usage: bun run ${name}:start | ${name}:stop | ${name}:status | ${name}:logs`);
    process.exit(2);
}
