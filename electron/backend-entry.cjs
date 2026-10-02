/**
 * JARVIS Electron Backend UtilityProcess Entrypoint
 * 
 * Runs the JARVIS Core backend inside an isolated Electron utilityProcess child.
 * Receives lifecycle signals (stop, restart) via IPC or process signals.
 */

const path = require("node:path");

const port = process.env.JARVIS_PORT ? parseInt(process.env.JARVIS_PORT, 10) : 31415;
const host = process.env.JARVIS_HOST || "127.0.0.1";

let coreInstance = null;
let serverInstance = null;

async function startServer() {
  console.log(`[Backend-Entry] Initializing JARVIS Core backend on ${host}:${port}...`);
  try {
    // Dynamically load the TypeScript core module using Node's native strip-types support
    const { JarvisCore } = await import(path.resolve(__dirname, "../src/core.ts"));
    const { JarvisServer } = await import(path.resolve(__dirname, "../src/ui/server.ts"));

    coreInstance = new JarvisCore();
    await coreInstance.initialize();

    serverInstance = new JarvisServer(coreInstance, port, host);
    await serverInstance.start();

    console.log(`[Backend-Entry] JARVIS backend successfully online at http://${host}:${port}`);
    if (process.parentPort) {
      process.parentPort.postMessage({ type: "ready", port, host });
    }
  } catch (err) {
    console.error("[Backend-Entry] Fatal error starting JARVIS backend:", err);
    if (process.parentPort) {
      process.parentPort.postMessage({ type: "error", error: err.message, stack: err.stack });
    }
    process.exit(1);
  }
}

async function shutdown() {
  console.log("[Backend-Entry] Shutting down JARVIS backend...");
  try {
    if (serverInstance) {
      await serverInstance.stop();
    }
    if (coreInstance) {
      coreInstance.shutdown();
    }
  } catch (e) {
    console.error("[Backend-Entry] Error during shutdown:", e);
  } finally {
    process.exit(0);
  }
}

// IPC from Electron Main via utilityProcess
if (process.parentPort) {
  process.parentPort.on("message", async (event) => {
    if (event.data?.type === "shutdown") {
      await shutdown();
    }
  });
}

// Process signals
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

startServer();
