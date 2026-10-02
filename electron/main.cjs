/**
 * Electron Main Process for JARVIS Desktop
 * 
 * Architecture:
 * Electron main process -> local JARVIS backend -> BrowserWindow -> http://127.0.0.1:<port>
 * 
 * Features:
 * - Managed backend lifecycle (zero orphan processes)
 * - Active readiness check via HTTP polling before window creation
 * - Secure BrowserWindow defaults (contextIsolation: true, nodeIntegration: false)
 * - Native desktop window controls (minimize, maximize, restore, close)
 */

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { waitForServerReady } = require("./readiness.cjs");

let mainWindow = null;
let backendProcess = null;
let isQuitting = false;

const DEFAULT_PORT = process.env.JARVIS_PORT ? parseInt(process.env.JARVIS_PORT, 10) : 31415;
const HOST = "127.0.0.1";
const SERVER_URL = `http://${HOST}:${DEFAULT_PORT}`;

function startBackend() {
  const rootDir = path.resolve(__dirname, "..");
  console.log(`[Electron] Starting JARVIS backend from ${rootDir}...`);

  backendProcess = spawn(
    process.execPath,
    ["--experimental-strip-types", "src/index.ts"],
    {
      cwd: rootDir,
      env: {
        ...process.env,
        PORT: String(DEFAULT_PORT),
        HOST: HOST,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  );

  backendProcess.stdout?.on("data", (data) => {
    const text = data.toString().trim();
    if (text) console.log(`[JARVIS Backend] ${text}`);
  });

  backendProcess.stderr?.on("data", (data) => {
    const text = data.toString().trim();
    if (text) console.error(`[JARVIS Backend Error] ${text}`);
  });

  backendProcess.on("exit", (code, signal) => {
    console.log(`[Electron] Backend process exited (code=${code}, signal=${signal})`);
    backendProcess = null;
    if (!isQuitting) {
      app.quit();
    }
  });
}

function stopBackend() {
  if (backendProcess && !backendProcess.killed) {
    console.log("[Electron] Stopping JARVIS backend process...");
    try {
      backendProcess.kill("SIGTERM");
      setTimeout(() => {
        if (backendProcess && !backendProcess.killed) {
          backendProcess.kill("SIGKILL");
        }
      }, 2000);
    } catch (e) {
      console.error("[Electron] Error terminating backend:", e);
    }
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 920,
    minHeight: 640,
    title: "JARVIS",
    backgroundColor: "#080a0f",
    frame: false,
    titleBarStyle: "hidden",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  });

  mainWindow.loadURL(SERVER_URL);

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// IPC Handlers for Native Window Controls
ipcMain.on("window-minimize", () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on("window-maximize", () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.on("window-close", () => {
  if (mainWindow) mainWindow.close();
});

ipcMain.handle("window-is-maximized", () => {
  return mainWindow ? mainWindow.isMaximized() : false;
});

// App Lifecycle
app.whenReady().then(async () => {
  startBackend();

  console.log(`[Electron] Polling server readiness at ${SERVER_URL}/api/status...`);
  try {
    await waitForServerReady(`${SERVER_URL}/api/status`, 20000, 250);
    console.log("[Electron] Server is ready! Launching application window.");
    createWindow();
  } catch (err) {
    console.error(`[Electron] Server failed to start: ${err.message}`);
    stopBackend();
    app.quit();
  }
});

app.on("before-quit", () => {
  isQuitting = true;
  stopBackend();
});

app.on("window-all-closed", () => {
  isQuitting = true;
  stopBackend();
  app.quit();
});
