/**
 * Electron Main Process for JARVIS Desktop
 * 
 * Architecture:
 * Electron Main
 *     ↓
 * utilityProcess.fork("backend-entry.cjs")
 *     ↓
 * JARVIS Node backend
 *     ↓
 * local HTTP server (127.0.0.1:<port>)
 *     ↓
 * BrowserWindow
 * 
 * Features:
 * - UtilityProcess managed backend child (zero process.execPath abuse)
 * - Active readiness check via HTTP polling before window creation
 * - Backend lifecycle monitoring with crash recovery ("Restart Backend")
 * - Native Desktop System Tray integration
 * - Native Global Shortcut (Ctrl/Cmd + Space)
 * - Native desktop notifications
 * - Secure BrowserWindow defaults (contextIsolation: true, nodeIntegration: false)
 * - Native window controls (minimize, maximize, restore, close)
 */

const {
  app,
  BrowserWindow,
  ipcMain,
  utilityProcess,
  Tray,
  Menu,
  globalShortcut,
  Notification,
  dialog,
  nativeImage,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { waitForServerReady } = require("./readiness.cjs");

let mainWindow = null;
let backendChild = null;
let tray = null;
let isQuitting = false;
let backendRestarting = false;

const DEFAULT_PORT = process.env.JARVIS_PORT ? parseInt(process.env.JARVIS_PORT, 10) : 31415;
const HOST = process.env.JARVIS_HOST || "127.0.0.1";
const SERVER_URL = `http://${HOST}:${DEFAULT_PORT}`;

function startBackend() {
  if (backendChild) {
    console.log("[Electron] Backend process already running.");
    return;
  }

  const backendScript = path.join(__dirname, "backend-entry.cjs");
  console.log(`[Electron] Forking JARVIS backend utilityProcess: ${backendScript}...`);

  try {
    backendChild = utilityProcess.fork(backendScript, [], {
      execArgv: ["--experimental-strip-types"],
      env: {
        ...process.env,
        JARVIS_PORT: String(DEFAULT_PORT),
        JARVIS_HOST: HOST,
      },
      stdio: "pipe",
    });

    backendChild.stdout?.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) console.log(`[JARVIS Backend] ${text}`);
    });

    backendChild.stderr?.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) console.error(`[JARVIS Backend Error] ${text}`);
    });

    backendChild.on("spawn", () => {
      console.log(`[Electron] Backend utilityProcess spawned (pid=${backendChild.pid})`);
    });

    backendChild.on("exit", (code) => {
      console.log(`[Electron] Backend utilityProcess exited (code=${code})`);
      backendChild = null;

      if (!isQuitting && !backendRestarting) {
        handleBackendCrash(code);
      }
      backendRestarting = false;
    });
  } catch (err) {
    console.error("[Electron] Failed to fork backend utilityProcess:", err);
    handleBackendCrash(-1, err.message);
  }
}

function stopBackend() {
  if (backendChild) {
    console.log("[Electron] Stopping JARVIS backend utilityProcess...");
    try {
      backendChild.postMessage({ type: "shutdown" });
      setTimeout(() => {
        if (backendChild) {
          backendChild.kill();
          backendChild = null;
        }
      }, 1500);
    } catch (e) {
      console.error("[Electron] Error signaling backend stop:", e);
      backendChild.kill();
      backendChild = null;
    }
  }
}

async function restartBackend() {
  backendRestarting = true;
  stopBackend();
  await new Promise((r) => setTimeout(r, 600));

  startBackend();
  try {
    await waitForServerReady(`${SERVER_URL}/api/health`, 12000, 250);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(SERVER_URL);
    }
  } catch (err) {
    handleBackendCrash(-1, "Backend restart timed out.");
  }
}

function handleBackendCrash(code, details = "") {
  console.error(`[Electron] Backend unexpected termination (code=${code}): ${details}`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("desktop:backend-error", {
      code,
      message: details || `Backend terminated unexpectedly (exit code: ${code}).`,
    });
  } else {
    dialog.showMessageBox({
      type: "error",
      title: "JARVIS Backend Error",
      message: "The JARVIS Core background service encountered an error.",
      detail: details || `Exit code: ${code}. You can restart the backend service.`,
      buttons: ["Restart Backend", "Quit Application"],
    }).then(({ response }) => {
      if (response === 0) {
        restartBackend();
      } else {
        app.quit();
      }
    });
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 960,
    minHeight: 640,
    title: "JARVIS",
    backgroundColor: "#07090e",
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

function createTray() {
  try {
    // Generate minimal clean tray icon
    const iconPath = path.join(__dirname, "../public/favicon.ico");
    const trayIcon = fs.existsSync(iconPath)
      ? nativeImage.createFromPath(iconPath)
      : nativeImage.createEmpty();

    tray = new Tray(trayIcon);
    tray.setToolTip("JARVIS Desktop Assistant");

    const contextMenu = Menu.buildFromTemplate([
      {
        label: "Open JARVIS",
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          }
        },
      },
      { type: "separator" },
      {
        label: "Start Voice Session",
        click: () => mainWindow?.webContents.send("desktop:tray-action", "start-voice"),
      },
      {
        label: "Stop Voice Session",
        click: () => mainWindow?.webContents.send("desktop:tray-action", "stop-voice"),
      },
      {
        label: "Mute Speech",
        click: () => mainWindow?.webContents.send("desktop:tray-action", "mute-speech"),
      },
      {
        label: "New Session",
        click: () => mainWindow?.webContents.send("desktop:tray-action", "new-session"),
      },
      { type: "separator" },
      {
        label: "Restart Backend",
        click: () => restartBackend(),
      },
      {
        label: "Quit",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]);

    tray.setContextMenu(contextMenu);
    tray.on("double-click", () => {
      if (mainWindow) {
        if (mainWindow.isVisible()) {
          mainWindow.focus();
        } else {
          mainWindow.show();
        }
      }
    });
  } catch (err) {
    console.warn("[Electron] Tray creation note:", err.message);
  }
}

function registerShortcuts() {
  try {
    // Register global shortcut Ctrl+Space (or Cmd+Space on macOS)
    const shortcut = process.platform === "darwin" ? "Command+Shift+Space" : "CommandOrControl+Space";
    globalShortcut.register(shortcut, () => {
      if (!mainWindow) return;
      if (!mainWindow.isVisible() || mainWindow.isMinimized()) {
        mainWindow.show();
        mainWindow.restore();
        mainWindow.focus();
      } else {
        mainWindow.focus();
      }
      mainWindow.webContents.send("desktop:global-shortcut", "toggle");
    });
  } catch (err) {
    console.warn("[Electron] Failed to register global shortcut:", err.message);
  }
}

// IPC Handlers
ipcMain.on("window-minimize", () => mainWindow?.minimize());
ipcMain.on("window-maximize", () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
});
ipcMain.on("window-close", () => mainWindow?.close());
ipcMain.handle("window-is-maximized", () => mainWindow?.isMaximized() || false);

ipcMain.on("desktop:restart-backend", () => {
  restartBackend();
});

ipcMain.on("desktop:notify", (_, { title, body }) => {
  if (Notification.isSupported()) {
    new Notification({
      title: title || "JARVIS",
      body: body || "",
      silent: false,
    }).show();
  }
});

// App Lifecycle
app.whenReady().then(async () => {
  startBackend();

  console.log(`[Electron] Waiting for JARVIS backend readiness at ${SERVER_URL}...`);
  try {
    await waitForServerReady(`${SERVER_URL}/api/health`, 20000, 250);
    console.log("[Electron] Backend health check PASSED. Launching window...");
  } catch (err) {
    console.error("[Electron] Backend readiness check timed out:", err.message);
  }

  createWindow();
  createTray();
  registerShortcuts();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("before-quit", () => {
  isQuitting = true;
  globalShortcut.unregisterAll();
  stopBackend();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    isQuitting = true;
    stopBackend();
    app.quit();
  }
});
