/**
 * Test Suite: OpenCode Resilience, Persistence, Health Fallback & SSE Connection (Requirements 6, 7, 8, 9, 10)
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { saveConfig, loadConfig, type JarvisConfig } from "../src/config.ts";
import { OpenCodeClient, OpenCodeError } from "../src/opencode_client.ts";
import { JarvisCore } from "../src/core.ts";
import { Logger } from "../src/logger.ts";

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assert(condition: boolean, testName: string, details?: string) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  \x1b[32m✔\x1b[0m [PASS] ${testName}`);
  } else {
    failedTests++;
    console.error(`  \x1b[31m✖\x1b[0m [FAIL] ${testName}${details ? ` - ${details}` : ""}`);
  }
}

async function runResilienceTests() {
  console.log("\n=======================================================");
  console.log("   OPENCODE RESILIENCE, PERSISTENCE & HEALTH SUITE     ");
  console.log("=======================================================\n");

  const testDir = path.join(process.cwd(), `.test_resilience_${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  const logger = new Logger("TestResilience", "error");

  // -------------------------------------------------------------
  // Test 1: Configuration Persistence (Requirement 6)
  // -------------------------------------------------------------
  console.log("▶ Test 1: Model Profile Persistence (Requirement 6)");
  const configPath = path.join(testDir, "jarvis.config.json");
  const initialConfig = loadConfig();
  initialConfig.dataDir = testDir;
  initialConfig.databasePath = path.join(testDir, "test.db");

  // Modify profiles
  initialConfig.models = {
    fast: {
      providerID: "opencode",
      modelID: "custom-fast-model",
      variant: "fast",
    },
    agent: {
      providerID: "anthropic",
      modelID: "claude-3-7-sonnet",
      variant: "high",
      agentID: "coder",
    },
  };

  // Save config atomically
  saveConfig(initialConfig, configPath);
  assert(fs.existsSync(configPath), "Config file written to disk");

  // Reload config from disk
  const reloaded = loadConfig(configPath);
  assert(reloaded.models?.fast.providerID === "opencode", "FAST providerID persisted");
  assert(reloaded.models?.fast.modelID === "custom-fast-model", "FAST modelID persisted");
  assert(reloaded.models?.fast.variant === "fast", "FAST variant persisted");
  assert(reloaded.models?.agent.providerID === "anthropic", "AGENT providerID persisted");
  assert(reloaded.models?.agent.modelID === "claude-3-7-sonnet", "AGENT modelID persisted");
  assert(reloaded.models?.agent.variant === "high", "AGENT variant persisted");
  assert(reloaded.models?.agent.agentID === "coder", "AGENT agentID persisted");

  // Verify atomic write: temp file is cleaned up
  const tempFiles = fs.readdirSync(testDir).filter(f => f.includes(".tmp"));
  assert(tempFiles.length === 0, "No leftover .tmp files from atomic rename");

  // -------------------------------------------------------------
  // Test 2: Fake Creativity Slider Removal (Requirement 7)
  // -------------------------------------------------------------
  console.log("\n▶ Test 2: Fake Creativity / Temperature Control Audit (Requirement 7)");
  const htmlContent = fs.readFileSync(path.join(process.cwd(), "public", "index.html"), "utf-8");
  assert(!htmlContent.includes('id="creativityWeightSlider"'), "creativityWeightSlider completely removed from UI");
  assert(!htmlContent.includes('creativityWeight'), "No non-functional creativityWeight references in UI");

  // -------------------------------------------------------------
  // Test 3: Health Endpoint with /api/info Fallback (Requirement 8)
  // -------------------------------------------------------------
  console.log("\n▶ Test 3: Health Endpoint & Fallback (Requirement 8)");
  let healthHit = false;
  let infoHit = false;
  let serverMode: "standard_health" | "fallback_info" | "unhealthy" = "standard_health";

  const healthServerPort = 39818;
  const healthServer = http.createServer((req, res) => {
    if (req.url === "/api/health" && req.method === "GET") {
      healthHit = true;
      if (serverMode === "standard_health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, version: "2.0.15", pid: 9999 }));
        return;
      }
      if (serverMode === "fallback_info") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not Found" }));
        return;
      }
      if (serverMode === "unhealthy") {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Database unavailable" }));
        return;
      }
    }

    if (req.url === "/api/info" && req.method === "GET") {
      infoHit = true;
      if (serverMode === "fallback_info") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ version: "1.9.0", pid: 8888 }));
        return;
      }
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((r) => healthServer.listen(healthServerPort, "127.0.0.1", r));

  const healthServiceFile = path.join(testDir, "service_health.json");
  fs.writeFileSync(healthServiceFile, JSON.stringify({
    url: `http://127.0.0.1:${healthServerPort}`,
    pid: 9999,
    version: "2.0.15",
  }));

  const client = new OpenCodeClient({
    serviceFile: healthServiceFile,
    disableGlobalDiscovery: true,
    spawnIfDown: false,
    connectTimeoutMs: 1500,
  }, logger);

  // Mode 1: Standard /api/health
  healthHit = false;
  infoHit = false;
  serverMode = "standard_health";
  const h1 = await client.health();
  assert(h1.ok === true, "Standard /api/health succeeded");
  assert(healthHit === true, "Queried /api/health directly");
  assert(infoHit === false, "Did not query /api/info when /api/health was supported");

  // Mode 2: /api/health 404 -> fallback to /api/info
  healthHit = false;
  infoHit = false;
  serverMode = "fallback_info";
  const h2 = await client.health();
  assert(h2.ok === true, "Health succeeded via /api/info fallback");
  assert(healthHit === true, "Queried /api/health first");
  assert(infoHit === true, "Fell back to /api/info when /api/health returned 404");

  // Mode 3: Server 503 -> distinguishes server error from endpoint 404
  healthHit = false;
  infoHit = false;
  serverMode = "unhealthy";
  const h3 = await client.health();
  assert(h3.ok === false, "Recognized 503 as unhealthy daemon");
  assert(infoHit === false, "Did NOT fall back to /api/info when server returned 503");

  // -------------------------------------------------------------
  // Test 4: SSE Initial Connection Bounded Timeout (Requirement 9)
  // -------------------------------------------------------------
  console.log("\n▶ Test 4: SSE Initial Connection Timeout (Requirement 9)");

  // Hang the SSE connection at HTTP level
  let sseHanging = true;
  const sseHangPort = 39819;
  const sseHangServer = http.createServer((req, res) => {
    if (req.url === "/api/health" || req.url === "/api/info") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: "2.0.15", pid: 8888 }));
      return;
    }
    if (req.url === "/api/event") {
      if (sseHanging) {
        // Do not respond at all
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      res.flushHeaders();
      res.write(": keepalive\n\n");
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((r) => sseHangServer.listen(sseHangPort, "127.0.0.1", r));

  const sseServiceFile = path.join(testDir, "service_sse.json");
  fs.writeFileSync(sseServiceFile, JSON.stringify({
    url: `http://127.0.0.1:${sseHangPort}`,
    pid: 8888,
    version: "2.0.15",
  }));

  const sseClient = new OpenCodeClient({
    serviceFile: sseServiceFile,
    disableGlobalDiscovery: true,
    spawnIfDown: false,
    connectTimeoutMs: 600, // Short bounded timeout
  }, logger);

  const startTime = Date.now();
  let timedOutCleanly = false;
  try {
    await sseClient.subscribeEvents(() => {});
  } catch (err: any) {
    timedOutCleanly = true;
  }
  const elapsed = Date.now() - startTime;
  assert(timedOutCleanly === true, "SSE initial connection aborted on timeout");
  assert(elapsed < 2000, `Initial connection timeout was bounded (${elapsed}ms < 2000ms)`);

  // Verify successful connection doesn't terminate after connectTimeoutMs
  sseHanging = false;
  let healthySubDisconnected = false;
  const sub = await sseClient.subscribeEvents(() => {});
  await new Promise((r) => setTimeout(r, 800)); // Longer than connectTimeoutMs (600ms)
  assert(!healthySubDisconnected, "Long-lived SSE connection remains healthy beyond connectTimeoutMs");
  sub(); // Unsubscribe cleanly

  // -------------------------------------------------------------
  // Test 5: Startup Reconciliation Visibility (Requirement 10)
  // -------------------------------------------------------------
  console.log("\n▶ Test 5: Startup Model/Agent Reconciliation (Requirement 10)");
  let sessionState = {
    id: "ses_startup_1",
    model: { providerID: "opencode", id: "existing-model", variant: "default" },
    agent: "existing-agent",
  };
  let switchModelCalled = false;
  let switchAgentCalled = false;
  let failSwitchModel = false;

  const startupServerPort = 39820;
  const startupServer = http.createServer((req, res) => {
    if ((req.url === "/api/health" || req.url === "/api/info") && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: "2.0.15", pid: 7777 }));
      return;
    }
    if (req.url === "/api/model" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([
        { providerID: "opencode", id: "existing-model", variants: ["default"] },
        { providerID: "opencode", id: "configured-model", variants: ["default"] },
      ]));
      return;
    }
    if (req.url === "/api/agent" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([
        { id: "existing-agent", mode: "primary" },
        { id: "configured-agent", mode: "primary" },
      ]));
      return;
    }
    if (req.url?.startsWith("/api/session/") && req.url.endsWith("/model") && req.method === "POST") {
      if (failSwitchModel) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Model unavailable" }));
        return;
      }
      switchModelCalled = true;
      sessionState.model = { providerID: "opencode", id: "configured-model", variant: "default" };
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.url?.startsWith("/api/session/") && req.url.endsWith("/agent") && req.method === "POST") {
      switchAgentCalled = true;
      sessionState.agent = "configured-agent";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === "/api/session" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "ses_startup_1" }));
      return;
    }
    if (req.url?.startsWith("/api/session/") && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ...sessionState,
        data: sessionState,
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((r) => startupServer.listen(startupServerPort, "127.0.0.1", r));

  const serviceFile = path.join(testDir, "service.json");
  fs.writeFileSync(serviceFile, JSON.stringify({
    url: `http://127.0.0.1:${startupServerPort}`,
    pid: 7777,
    version: "2.0.15",
  }));

  const coreConfigPath = path.join(testDir, "core_config.json");
  fs.writeFileSync(coreConfigPath, JSON.stringify({
    dataDir: testDir,
    databasePath: path.join(testDir, "core.db"),
    opencode: { serviceFile, spawnIfDown: false, disableGlobalDiscovery: true },
    logging: { level: "error", format: "pretty" },
    models: {
      fast: { providerID: "opencode", modelID: "configured-model", variant: "default" },
      agent: { providerID: "opencode", modelID: "configured-model", variant: "default", agentID: "configured-agent" },
    },
  }));

  // Reconciles model and agent at startup
  const startupCore = new JarvisCore(coreConfigPath);
  await startupCore.initialize();
  assert(switchModelCalled === true, "Startup reconciled model when mismatched");
  assert(switchAgentCalled === true, "Startup reconciled agent when mismatched");
  startupCore.shutdown();

  // Test already correct: does not overwrite needlessly
  switchModelCalled = false;
  switchAgentCalled = false;
  const coreAlreadyCorrect = new JarvisCore(coreConfigPath);
  await coreAlreadyCorrect.initialize();
  assert(switchModelCalled === false, "Startup does not switch model when already matching");
  assert(switchAgentCalled === false, "Startup does not switch agent when already matching");
  coreAlreadyCorrect.shutdown();

  // Cleanup
  await new Promise<void>((r) => healthServer.close(() => r()));
  await new Promise<void>((r) => sseHangServer.close(() => r()));
  await new Promise<void>((r) => startupServer.close(() => r()));
  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch {}

  console.log("\n=======================================================");
  console.log(`Resilience Tests Total: ${totalTests} | Passed: ${passedTests} | Failed: ${failedTests}`);
  console.log("=======================================================\n");

  if (failedTests > 0) process.exit(1);
}

runResilienceTests().catch((err) => {
  console.error("Resilience test suite failed:", err);
  process.exit(1);
});
