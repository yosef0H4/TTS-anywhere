import { app, BrowserWindow, ipcMain } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let pythonProcess: ChildProcessWithoutNullStreams | null = null;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  return win;
}

function pythonWorkdir(): string {
  return path.resolve(__dirname, "../python-server");
}

function startPythonServer(): { ok: boolean; message: string } {
  if (pythonProcess) {
    return { ok: true, message: "Python server already running." };
  }

  const workdir = pythonWorkdir();
  const child = spawn("uv", ["run", "preproc-server", "serve", "--host", "127.0.0.1", "--port", "8091"], {
    cwd: workdir,
    stdio: "pipe"
  });

  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[python] ${chunk.toString()}`);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[python] ${chunk.toString()}`);
  });

  child.on("exit", () => {
    pythonProcess = null;
  });

  pythonProcess = child;
  return { ok: true, message: "Python server starting on http://127.0.0.1:8091" };
}

function stopPythonServer(): { ok: boolean; message: string } {
  if (!pythonProcess) {
    return { ok: true, message: "Python server is not running." };
  }
  pythonProcess.kill();
  pythonProcess = null;
  return { ok: true, message: "Python server stopped." };
}

app.whenReady().then(() => {
  mainWindow = createWindow();

  ipcMain.handle("python:start", () => startPythonServer());
  ipcMain.handle("python:stop", () => stopPythonServer());
  ipcMain.handle("python:state", () => ({ running: !!pythonProcess, pid: pythonProcess?.pid ?? null }));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  stopPythonServer();
  if (process.platform !== "darwin") {
    app.quit();
  }
});
