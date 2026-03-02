import { app, BrowserWindow, globalShortcut, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let isPinned = true;

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 860,
    minHeight: 560,
    frame: false,
    titleBarStyle: "hidden",
    backgroundColor: "#fff0f5",
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.setAlwaysOnTop(true, "floating");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  win.once("ready-to-show", () => {
    win.show();
  });

  return win;
}

app.whenReady().then(() => {
  mainWindow = createMainWindow();

  globalShortcut.register("Control+Shift+Alt+S", () => {
    mainWindow?.webContents.send("capture-requested");
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    }
  });
});

ipcMain.on("window:minimize", () => {
  mainWindow?.minimize();
});

ipcMain.handle("window:toggle-maximize", () => {
  if (!mainWindow) {
    return false;
  }
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
    return false;
  }
  mainWindow.maximize();
  return true;
});

ipcMain.on("window:close", () => {
  mainWindow?.close();
});

ipcMain.handle("window:toggle-pin", () => {
  if (!mainWindow) {
    return isPinned;
  }
  isPinned = !isPinned;
  mainWindow.setAlwaysOnTop(isPinned, "floating");
  return isPinned;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

ipcMain.handle("ping", () => "pong");
