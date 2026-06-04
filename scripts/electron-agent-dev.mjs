#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const CACHE_DIR = path.join(ROOT, ".cache");
const LOG_PATH = path.join(CACHE_DIR, "electron-agent-dev.log");
const STATE_PATH = path.join(CACHE_DIR, "electron-agent-dev.json");
const VITE_PORT = 5173;
const DEFAULT_CDP_PORT = 9333;

function log(line) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const text = `[${new Date().toISOString()}] ${line}`;
  fs.appendFileSync(LOG_PATH, `${text}\n`);
  console.log(text);
}

function run(command, args, options = {}) {
  log(`run ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: cleanElectronEnv(process.env),
    shell: process.platform === "win32",
    stdio: options.stdio ?? "inherit"
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
}

function cleanElectronEnv(env) {
  const next = { ...env };
  delete next.ELECTRON_RUN_AS_NODE;
  return next;
}

function spawnLogged(name, command, args, extraEnv = {}) {
  log(`spawn ${name}: ${command} ${args.join(" ")}`);
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...cleanElectronEnv(process.env), ...extraEnv },
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout?.on("data", (chunk) => appendChildLog(name, chunk));
  child.stderr?.on("data", (chunk) => appendChildLog(name, chunk));
  child.on("exit", (code, signal) => log(`${name} exited code=${code ?? "null"} signal=${signal ?? "null"}`));
  return child;
}

function appendChildLog(name, chunk) {
  for (const line of String(chunk).split(/\r?\n/u)) {
    if (line.trim()) log(`${name}: ${line}`);
  }
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(1000);
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(false));
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: 2000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error(`Invalid JSON from ${url}: ${body.slice(0, 120)}`));
        }
      });
    });
    request.on("timeout", () => {
      request.destroy(new Error(`Timeout fetching ${url}`));
    });
    request.on("error", reject);
  });
}

async function waitFor(check, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await check();
      if (value) return value;
    } catch {
      // Keep polling until timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function writeState(state) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return null;
  }
}

async function findFreePort(preferredPort) {
  if (await canBindPort(preferredPort)) return preferredPort;
  for (let port = 9400; port < 9500; port += 1) {
    if (await canBindPort(port)) return port;
  }
  throw new Error("No free CDP port found in 9400-9499");
}

function canBindPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

function stopRepoDevProcesses() {
  if (process.platform !== "win32") return;
  const script = `
$self = ${process.pid}
$patterns = @(
  'scripts/electron-agent-dev.mjs',
  'dev:electron:debug',
  'dev:electron:main',
  'dev:electron:launch',
  'vite/bin/vite.js',
  'tsconfig.electron.json --watch',
  'remote-debugging-port'
)
Get-CimInstance Win32_Process | Where-Object {
  $cmd = $_.CommandLine
  if ($_.ProcessId -eq $self -or -not $cmd) { return $false }
  $repoMatch = $cmd -like '*tts-electron*' -or $cmd -like '*TTS Anywhere*'
  if (-not $repoMatch) { return $false }
  foreach ($pattern in $patterns) {
    if ($cmd -like "*$pattern*") { return $true }
  }
  return $false
} | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
`;
  spawnSync("powershell.exe", ["-NoProfile", "-Command", script], { stdio: "ignore" });
}

async function doctor() {
  const state = readState();
  const cdpPort = Number(state?.cdpPort ?? DEFAULT_CDP_PORT);
  const cdpUrl = `http://127.0.0.1:${cdpPort}/json/version`;
  const cdpPortOpen = await isPortOpen(cdpPort);
  const vitePortOpen = await isPortOpen(VITE_PORT);
  let cdp = null;
  let cdpError = null;
  try {
    cdp = await getJson(cdpUrl);
  } catch (error) {
    cdpError = error instanceof Error ? error.message : String(error);
  }
  const tail = fs.existsSync(LOG_PATH)
    ? fs.readFileSync(LOG_PATH, "utf8").split(/\r?\n/u).filter(Boolean).slice(-60)
    : [];
  const report = {
    ok: Boolean(cdp?.webSocketDebuggerUrl),
    env: {
      ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE ?? null
    },
    ports: {
      vite5173: vitePortOpen,
      [`cdp${cdpPort}`]: cdpPortOpen
    },
    statePath: STATE_PATH,
    state,
    cdp,
    cdpError,
    logPath: LOG_PATH,
    logTail: tail
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

async function start() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(LOG_PATH, "");
  stopRepoDevProcesses();
  const cdpPort = await findFreePort(DEFAULT_CDP_PORT);
  const cdpUrl = `http://127.0.0.1:${cdpPort}/json/version`;
  writeState({ cdpPort, cdpEndpoint: `http://127.0.0.1:${cdpPort}`, vitePort: VITE_PORT, startedAt: new Date().toISOString() });
  run("npm", ["run", "build:electron:main:dev"]);

  const renderer = spawnLogged("renderer", "npx", ["vite", "--host", "127.0.0.1", "--port", String(VITE_PORT), "--strictPort"]);
  const mainWatch = spawnLogged("main-watch", "npx", ["tsc", "-p", "tsconfig.electron.json", "--watch"]);

  await waitFor(() => isPortOpen(VITE_PORT), 30000, `Vite port ${VITE_PORT}`);
  await waitFor(() => fs.existsSync(path.join(ROOT, "dist-electron", "main.js")), 30000, "dist-electron/main.js");

  const electron = spawnLogged("electron", "npx", [
    "electron",
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${cdpPort}`,
    "."
  ], {
    VITE_DEV_SERVER_URL: `http://localhost:${VITE_PORT}`
  });

  await waitFor(async () => {
    const version = await getJson(cdpUrl);
    return version.webSocketDebuggerUrl ? version : null;
  }, 30000, "Electron CDP endpoint");

  log(`ready ${cdpUrl}`);
  process.on("SIGINT", () => {
    renderer.kill();
    mainWatch.kill();
    electron.kill();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    renderer.kill();
    mainWatch.kill();
    electron.kill();
    process.exit(0);
  });
  await new Promise(() => {});
}

const command = process.argv[2] ?? "doctor";
try {
  if (command === "doctor") {
    await doctor();
  } else if (command === "start") {
    await start();
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  log(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
}
