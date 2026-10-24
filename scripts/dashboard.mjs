#!/usr/bin/env node
/**
 * Fixed-command control for the Understand-Anything dashboard dev server,
 * so starting/stopping it does not require dispatching an agent or skill.
 *
 * Usage:
 *   node scripts/dashboard.mjs start  [projectDir]   # default projectDir: cwd
 *   node scripts/dashboard.mjs stop   [projectDir]
 *   node scripts/dashboard.mjs status [projectDir]
 *   node scripts/dashboard.mjs restart[projectDir]
 *
 * `start` resolves the project data directory (.ua/ or legacy
 * .understand-anything/ — same rule as vite.config.ts), picks a free port,
 * starts the Vite dev server in the background, and prints the tokenized
 * dashboard URL. State lives in os.tmpdir() keyed by the project dir, so
 * `stop` needs no agent and no port guessing.
 *
 * Background strategy per platform:
 * - POSIX: vite is spawned detached (own session), writing to the log file.
 * - Windows: IDE terminals reap their whole process tree (Job Object
 *   kill-on-close) when a command completes, which silently kills detached
 *   children. The server is therefore created via WMI Win32_Process.Create
 *   (parented by WmiPrvSE, outside the caller's job) running a small `__run`
 *   supervisor that owns vite's log handles and survives the terminal.
 */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const DASHBOARD_DIR = path.join(
  REPO_ROOT,
  "understand-anything-plugin",
  "packages",
  "dashboard",
);
// Legacy directory first — mirrors vite.config.ts / bin/viewer.mjs.
const UA_DIR_CANDIDATES = [".understand-anything", ".ua"];
const FIRST_PORT = 5173;
const LAST_PORT = 5193;

// ── Helpers ───────────────────────────────────────────────────────────────

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function stateFile(projectDir) {
  const key = crypto
    .createHash("sha1")
    .update(path.resolve(projectDir).toLowerCase())
    .digest("hex")
    .slice(0, 12);
  return path.join(os.tmpdir(), `ua-dashboard-${key}.json`);
}

function readState(projectDir) {
  const file = stateFile(projectDir);
  try {
    const state = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (typeof state.pid !== "number") return null;
    return { ...state, file };
  } catch {
    return null;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is owned by another user.
    return err?.code === "EPERM";
  }
}

async function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

async function findFreePort() {
  for (let port = FIRST_PORT; port <= LAST_PORT; port++) {
    if (await isPortFree(port)) return port;
  }
  return null;
}

function resolveProject(projectArg) {
  const projectDir = path.resolve(projectArg ?? process.cwd());
  const dataDir = UA_DIR_CANDIDATES.map((dir) => path.join(projectDir, dir)).find(
    (dir) => fs.existsSync(path.join(dir, "knowledge-graph.json")),
  );
  if (!dataDir) {
    fail(
      `no knowledge graph under ${projectDir}. ` +
        "Run /understand in that project first (expected .ua/ or legacy .understand-anything/).",
    );
  }
  return { projectDir, dataDir };
}

function resolveViteEntry() {
  const viteJs = path.join(DASHBOARD_DIR, "node_modules", "vite", "bin", "vite.js");
  if (!fs.existsSync(viteJs)) {
    fail(
      "dashboard dependencies are not installed. Run `pnpm install` at the repo root first.",
    );
  }
  return viteJs;
}

function viteArgs(port) {
  return ["--host", "127.0.0.1", "--port", String(port), "--strictPort"];
}

// ── Background launchers ──────────────────────────────────────────────────

function startDetachedPosix({ projectDir, port, token, logPath, viteJs }) {
  const out = fs.openSync(logPath, "w");
  const child = spawn(process.execPath, [viteJs, ...viteArgs(port)], {
    cwd: DASHBOARD_DIR,
    // UNDERSTAND_ACCESS_TOKEN pins the one-time token (see vite.config.ts),
    // so we can print the full URL without scraping the log.
    env: { ...process.env, GRAPH_DIR: projectDir, UNDERSTAND_ACCESS_TOKEN: token },
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  // Do NOT close `out` — keep the fd alive for the lifetime of this
  // short-lived CLI so the child's writes stay valid.
  child.on("error", (err) => {
    try {
      fs.appendFileSync(logPath, `\n[dashboard.mjs] spawn error: ${err}\n`);
    } catch { /* best effort */ }
  });
  return child.pid;
}

function startViaWmi({ projectDir, port, token, logPath, viteJs }) {
  // `__run` supervisor: stays alive, owns vite + its log file handles, and —
  // crucially — is created by WMI, so it escapes the caller's Job Object.
  const cmdline =
    `"${process.execPath}" "${SCRIPT_PATH}" __run ` +
    `"${projectDir}" ${port} ${token} "${logPath}" "${viteJs}"`;
  const escaped = cmdline.replace(/'/g, "''");
  const psScript =
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create ` +
    `-Arguments @{ CommandLine = '${escaped}' }; ` +
    `if ($r.ReturnValue -ne 0) { Write-Output "ERR:$($r.ReturnValue)"; exit 1 }; ` +
    `Write-Output $r.ProcessId`;
  const encoded = Buffer.from(psScript, "utf16le").toString("base64");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    { encoding: "utf8", timeout: 30_000, windowsHide: true },
  );
  const out = (result.stdout ?? "").trim().split("\n").pop()?.trim() ?? "";
  if (out.startsWith("ERR:")) {
    fail(`WMI process creation failed with code ${out.slice(4)}`);
  }
  const pid = Number.parseInt(out, 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    fail(`could not determine supervisor pid. stderr: ${result.stderr ?? ""}`);
  }
  return pid;
}

/** Windows supervisor mode: run vite as our own child and babysit it. */
function runSupervisor(projectDir, portStr, token, logPath, viteJs) {
  const out = fs.openSync(logPath, "w");
  const port = Number.parseInt(portStr, 10);
  const child = spawn(process.execPath, [viteJs, ...viteArgs(port)], {
    cwd: DASHBOARD_DIR,
    env: { ...process.env, GRAPH_DIR: projectDir, UNDERSTAND_ACCESS_TOKEN: token },
    stdio: ["ignore", out, out],
  });
  child.on("exit", (code) => {
    try {
      fs.appendFileSync(logPath, `\n[dashboard.mjs] vite exited code=${code}\n`);
    } catch { /* best effort */ }
    try {
      fs.rmSync(stateFile(projectDir), { force: true });
    } catch { /* best effort */ }
    process.exit(code ?? 1);
  });
  child.on("error", (err) => {
    try {
      fs.appendFileSync(logPath, `\n[dashboard.mjs] spawn error: ${err}\n`);
    } catch { /* best effort */ }
    process.exit(1);
  });
}

// ── Commands ──────────────────────────────────────────────────────────────

async function start(projectArg) {
  const { projectDir, dataDir } = resolveProject(projectArg);
  const existing = readState(projectDir);
  if (existing && isAlive(existing.pid)) {
    console.log(`  Dashboard already running for ${projectDir}`);
    console.log(`  🔑  URL: http://127.0.0.1:${existing.port}/?token=${existing.token}`);
    return;
  }
  // Stale state file from a crashed/rebooted server — drop it.
  if (existing) fs.rmSync(existing.file, { force: true });

  const port = await findFreePort();
  if (port === null) fail(`no free port in range ${FIRST_PORT}-${LAST_PORT}`);

  const viteJs = resolveViteEntry();
  const token = crypto.randomBytes(16).toString("hex");
  const key = path.basename(stateFile(projectDir), ".json");
  const logPath = path.join(os.tmpdir(), `${key}.log`);

  const launch = { projectDir, port, token, logPath, viteJs };
  const pid = process.platform === "win32" ? startViaWmi(launch) : startDetachedPosix(launch);

  // Give Vite a moment to boot so obvious failures surface immediately.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  if (!isAlive(pid)) {
    const tail = fs.readFileSync(logPath, "utf-8").split("\n").slice(-15).join("\n");
    fail(`dashboard exited immediately. Log tail:\n${tail}`);
  }

  fs.writeFileSync(
    stateFile(projectDir),
    JSON.stringify({ pid, port, token, projectDir, logPath }, null, 2),
  );

  console.log(`  Serving graph from ${dataDir}`);
  console.log(`  🔑  Dashboard URL: http://127.0.0.1:${port}/?token=${token}`);
  console.log(`  Log: ${logPath}`);
  console.log(`  Stop: pnpm ua:stop -- ${projectDir}`);
}

function stop(projectArg) {
  const projectDir = path.resolve(projectArg ?? process.cwd());
  const state = readState(projectDir);
  if (!state) {
    console.log(`  No background dashboard recorded for ${projectDir}`);
    return;
  }
  if (isAlive(state.pid)) {
    if (process.platform === "win32") {
      // /T kills the whole tree (supervisor + vite).
      const result = spawnSync("taskkill", ["/pid", String(state.pid), "/T", "/F"], {
        stdio: "ignore",
      });
      if (result.status !== 0) fail(`taskkill failed for pid ${state.pid}`);
    } else {
      // POSIX vite is spawned detached, so it leads its own process group.
      try {
        process.kill(-state.pid, "SIGTERM");
      } catch {
        try {
          process.kill(state.pid, "SIGTERM");
        } catch {
          /* already gone */
        }
      }
    }
    // Wait briefly so the command only returns once the port is actually free.
    const deadline = Date.now() + 5000;
    while (isAlive(state.pid) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
    if (isAlive(state.pid)) fail(`dashboard pid ${state.pid} did not exit`);
  }
  fs.rmSync(state.file, { force: true });
  console.log(`  Dashboard stopped (pid ${state.pid})`);
}

function status(projectArg) {
  const projectDir = path.resolve(projectArg ?? process.cwd());
  const state = readState(projectDir);
  if (!state || !isAlive(state.pid)) {
    console.log(`  Not running for ${projectDir}`);
    return;
  }
  console.log(`  Running (pid ${state.pid}) for ${state.projectDir ?? projectDir}`);
  console.log(`  🔑  URL: http://127.0.0.1:${state.port}/?token=${state.token}`);
}

// ── CLI ───────────────────────────────────────────────────────────────────

const [command, projectArg] = process.argv.slice(2);
switch (command) {
  case "__run":
    // Internal: Windows supervisor started via WMI. Never call by hand.
    runSupervisor(...process.argv.slice(3));
    break;
  case "start":
    await start(projectArg);
    break;
  case "stop":
    stop(projectArg);
    break;
  case "status":
    status(projectArg);
    break;
  case "restart":
    stop(projectArg);
    await start(projectArg);
    break;
  default:
    console.log(
      "Usage: node scripts/dashboard.mjs <start|stop|status|restart> [projectDir]\n" +
        "Shortcuts: pnpm ua:start [dir] / pnpm ua:stop [dir] / pnpm ua:status [dir]",
    );
    if (command !== undefined) process.exitCode = 1;
}
