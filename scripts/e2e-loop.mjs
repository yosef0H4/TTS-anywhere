#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MAX_LOOPS = Number(process.env.E2E_MAX_LOOPS || 30);
const CLEAN_TARGET = Number(process.env.E2E_CLEAN_TARGET || 3);
const USE_EDGE_TTS = process.env.E2E_USE_EDGE_TTS === "1";
const ROOT = process.cwd();
const ARTIFACT_ROOT = path.join(ROOT, "test-artifacts", "loop");

fs.mkdirSync(ARTIFACT_ROOT, { recursive: true });

function runCommand(cmd, args, env, logFile) {
  return new Promise((resolve) => {
    const out = fs.createWriteStream(logFile, { flags: "w" });
    const child = spawn(cmd, args, {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    child.stdout.pipe(out);
    child.stderr.pipe(out);
    child.on("close", (code) => {
      out.end();
      resolve(code === 0);
    });
  });
}

async function maybeStartEdgeTts(env, runDir) {
  if (!USE_EDGE_TTS) return null;
  const logPath = path.join(runDir, "edge-tts.log");
  const out = fs.createWriteStream(logPath, { flags: "w" });
  const child = spawn("uv", ["run", "tts-edge", "serve", "--host", "127.0.0.1", "--port", "8012"], {
    cwd: path.join(ROOT, "services", "tts", "edge"),
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  await new Promise((r) => setTimeout(r, 2500));
  return child;
}

let cleanStreak = 0;
for (let i = 1; i <= MAX_LOOPS; i += 1) {
  const runDir = path.join(ARTIFACT_ROOT, `run-${String(i).padStart(2, "0")}`);
  fs.mkdirSync(runDir, { recursive: true });
  console.log(`\n[loop] run ${i} started`);

  const env = {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: ".cache/ms-playwright",
    CI: "1"
  };
  if (USE_EDGE_TTS) {
    env.E2E_USE_EDGE_TTS = "1";
  }

  const edgeProc = await maybeStartEdgeTts(env, runDir);

  const webOk = await runCommand("npm", ["run", "test:e2e"], env, path.join(runDir, "web.log"));
  const electronOk = await runCommand("npm", ["run", "test:e2e:electron"], env, path.join(runDir, "electron.log"));

  if (edgeProc) {
    edgeProc.kill("SIGTERM");
  }

  const runOk = webOk && electronOk;
  if (runOk) {
    cleanStreak += 1;
    console.log(`[loop] run ${i} passed (clean streak: ${cleanStreak}/${CLEAN_TARGET})`);
  } else {
    cleanStreak = 0;
    console.log(`[loop] run ${i} failed (streak reset)`);
  }

  fs.writeFileSync(
    path.join(runDir, "summary.json"),
    JSON.stringify(
      {
        run: i,
        webOk,
        electronOk,
        runOk,
        cleanStreak,
        useEdgeTts: USE_EDGE_TTS
      },
      null,
      2
    ),
    "utf8"
  );

  if (cleanStreak >= CLEAN_TARGET) {
    console.log(`\n[loop] success: achieved ${CLEAN_TARGET} consecutive clean runs.`);
    process.exit(0);
  }
}

console.error(`\n[loop] failed: did not reach ${CLEAN_TARGET} clean runs within ${MAX_LOOPS} attempts.`);
process.exit(1);
