export * from "./config.ts";
export * from "./logger.ts";
export * from "./database.ts";
export * from "./router.ts";
export * from "./personality.ts";
export * from "./opencode_client.ts";
export * from "./session_manager.ts";
export * from "./permissions.ts";
export * from "./tools/direct_tools.ts";
export * from "./search.ts";
export * from "./models/provider.ts";
export * from "./memory/memory_manager.ts";
export * from "./agent/agent_dispatcher.ts";
export * from "./voice/voice_service.ts";
export * from "./core.ts";
export * from "./ui/server.ts";

import { JarvisCore } from "./core.ts";
import { JarvisServer } from "./ui/server.ts";

const isMainModule = Boolean(
  process.argv[1] &&
  (process.argv[1].endsWith("index.ts") || process.argv[1].endsWith("index.js"))
);

if (isMainModule) {
  const core = new JarvisCore();
  core.initialize().then(async () => {
    const server = new JarvisServer(core, core.config.port, core.config.host);
    await server.start();
    console.log("\n===============================================================");
    console.log("            JARVIS Personal AI Assistant is ONLINE             ");
    console.log(`            Dashboard: http://${core.config.host}:${core.config.port}            `);
    console.log("===============================================================\n");
  }).catch((err) => {
    console.error("Failed to start Jarvis:", err);
    process.exit(1);
  });
}
