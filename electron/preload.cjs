/**
 * Electron Preload Script for JARVIS Desktop
 * 
 * Secure bridge exposing only explicitly required desktop controls:
 * - Window minimize, maximize, close
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
});
