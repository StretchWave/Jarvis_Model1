/**
 * Electron Preload Script for JARVIS Desktop
 * 
 * Secure bridge exposing only explicitly required desktop controls:
 * - Window minimize, maximize, close
 * - Backend lifecycle monitoring & restart
 * - Native desktop notifications
 * - Desktop platform detection flag
 * Context isolation: true, nodeIntegration: false
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopAPI", {
  isDesktop: true,
  minimize: () => ipcRenderer.send("window-minimize"),
  maximize: () => ipcRenderer.send("window-maximize"),
  close: () => ipcRenderer.send("window-close"),
  isMaximized: () => ipcRenderer.invoke("window-is-maximized"),
  restartBackend: () => ipcRenderer.send("desktop:restart-backend"),
  notify: (opts) => ipcRenderer.send("desktop:notify", opts),
  onBackendError: (cb) => ipcRenderer.on("desktop:backend-error", (_, data) => cb(data)),
  onTrayAction: (cb) => ipcRenderer.on("desktop:tray-action", (_, action) => cb(action)),
  onGlobalShortcut: (cb) => ipcRenderer.on("desktop:global-shortcut", (_, action) => cb(action)),
});
