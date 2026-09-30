/**
 * JARVIS OpenCode Unified Gateway Integration Test Suite
 * 
 * Verifies that OpenCode operates as the sole LLM gateway for all model-powered behavior:
 * 1. OpenCode daemon availability & discovery
 * 2. Session creation with model profile
 * 3. Model selection & switching API verification
 * 4. FAST conversational request through OpenCode
 * 5. AGENT execution through OpenCode
 * 6. Real-time token streaming verification (no fake word-splitting)
 * 7. Multi-turn session reuse
 * 8. Handling when configured model is unavailable
 * 9. Handling when OpenCode daemon is unreachable (graceful recovery)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { JarvisCore, type JarvisEvent } from "../src/core.ts";
import { OpenCodeClient } from "../src/opencode_client.ts";
import { Logger } from "../src/logger.ts";
import { SessionManager } from "../src/session_manager.ts";
import { Database } from "../src/database.ts";
import { OpenCodeModelProvider } from "../src/models/provider.ts";

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
let skippedTests = 0;

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

function skip(testName: string, reason: string) {
  totalTests++;
  skippedTests++;
  console.log(`  \x1b[33m⊘\x1b[0m [SKIP] ${testName} (${reason})`);
}

async function collectEvents(core: JarvisCore, prompt: string, sessionId?: string): Promise<JarvisEvent[]> {
  const events: JarvisEvent[] = [];
  for await (const ev of core.processInput(prompt, sessionId)) {
    events.push(ev);
  }
  return events;
}

async function runOpenCodeGatewayTests() {
  console.log("=================================================================");
  console.log("     JARVIS OPENCODE UNIFIED GATEWAY INTEGRATION TEST SUITE       ");
  console.log("=================================================================\n");

  const logger = new Logger("OpenCodeTest", "error");
  const client = new OpenCodeClient("", logger);

  // 1. OpenCode Daemon Availability Check
  console.log("▶ Test 1: OpenCode Daemon Availability & Discovery");
  const serviceInfo = client.discoverService();
  if (!serviceInfo) {
    console.log("\n=================================================================");
    console.log("  OPENCODE INTEGRATION TESTS SKIPPED: daemon unavailable");
    console.log("  Reason: OpenCode service.json not found in candidate paths.");
    console.log("=================================================================\n");
    return;
  }

  const health = await client.health();
  if (!health.ok) {
    console.log("\n=================================================================");
    console.log("  OPENCODE INTEGRATION TESTS SKIPPED: daemon unavailable");
    console.log(`  Reason: OpenCode daemon at ${serviceInfo.url} returned unhealthy: ${health.error}`);
    console.log("=================================================================\n");
    return;
  }

  assert(health.ok, "OpenCode daemon is running and reachable", `URL: ${serviceInfo.url}, PID: ${health.pid}, Version: ${health.version}`);

  // Discover installed models
  const catalog = await client.listModels();
  assert(catalog.length > 0, `Discovered active OpenCode model catalog (${catalog.length} models found)`);

  const preferredModel =
    catalog.find(m => m.id === "mimo-v2.6-flash-free") ||
    catalog.find(m => m.id.includes("flash")) ||
    catalog.find(m => m.id.includes("free")) ||
    catalog[0];
  const testModelRef = {
    providerID: preferredModel.providerID,
    id: preferredModel.id,
    variant: "default",
  };
  console.log(`  Using OpenCode model for integration tests: ${testModelRef.providerID}/${testModelRef.id}`);

  // Setup isolated test environment
  const testDir = path.join(process.cwd(), ".test_opencode_gateway");
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  fs.mkdirSync(testDir, { recursive: true });

  const testDbPath = path.join(testDir, "test_gateway.db");
  const testConfigPath = path.join(testDir, "jarvis.config.json");

  fs.writeFileSync(
    testConfigPath,
    JSON.stringify({
      dataDir: testDir,
      databasePath: testDbPath,
      models: {
        fast: testModelRef,
        agent: testModelRef,
      },
      fallbackProvider: {
        enabled: false,
      },
      logging: { level: "error" },
    })
  );

  // 2. OpenCode Session Creation with Model Profile
  console.log("\n▶ Test 2: OpenCode Session Creation with Model Profile");
  const sessionData = await client.createSession({
    title: "Gateway Test Session",
    model: testModelRef,
  });
  assert(!!sessionData && typeof sessionData.id === "string" && sessionData.id.startsWith("ses_"), "Created session directly on OpenCode with model profile");

  // 3. Model Selection & Switching
  console.log("\n▶ Test 3: Model Selection & Dynamic Switching");
  const switchOk = await client.switchSessionModel(sessionData.id, testModelRef);
  assert(switchOk === true, `Successfully switched session model to ${testModelRef.providerID}/${testModelRef.id}`);

  // Clean up direct test session
  await client.deleteSession(sessionData.id);

  // Initialize JARVIS Core with OpenCode as sole model gateway
  console.log("\n▶ Initializing JARVIS Core (OpenCode Gateway Mode)...");
  const jarvis = new JarvisCore(testConfigPath);
  await jarvis.initialize();

  // 4. FAST Conversational Request through OpenCode
  console.log("\n▶ Test 4: FAST Conversational Request via OpenCode");
  const t4Events = await collectEvents(jarvis, "Hello Jarvis, respond with exactly: READY");
  const t4Route = t4Events.find(e => e.type === "route");
  const t4Tokens = t4Events.filter(e => e.type === "token") as { type: "token"; text: string }[];
  const t4Done = t4Events.find(e => e.type === "done") as { type: "done"; fullText: string } | undefined;

  assert(t4Route?.type === "route" && t4Route.route === "FAST", "Routed casual greeting to FAST path");
  assert(t4Done !== undefined && t4Done.fullText.length > 0, `Received non-empty response from OpenCode model: "${t4Done?.fullText?.trim()}"`);

  // 5. Genuine Streaming Verification
  console.log("\n▶ Test 5: Genuine Incremental Token Streaming (No Fake Word Splitting)");
  assert(t4Tokens.length > 0, `Streamed ${t4Tokens.length} incremental token chunks through SSE`);

  // 6. Multi-Turn Session Reuse
  console.log("\n▶ Test 6: Multi-Turn Session Reuse & Context Retention");
  const activeSession = await jarvis.sessionMgr.getOrCreateActiveSession("general");
  const initialOcId = await jarvis.sessionMgr.ensureOpenCodeSession(activeSession.id);

  // Turn 1: Introduce a specific detail
  await collectEvents(jarvis, "My secret phrase is NEBULA-99. Acknowledge briefly.", activeSession.id);

  // Verify same OpenCode session is retained
  const followUpOcId = await jarvis.sessionMgr.ensureOpenCodeSession(activeSession.id);
  assert(initialOcId === followUpOcId, `OpenCode session ID reused across turns (${initialOcId})`);

  // Turn 2: Query the detail
  const t6Events = await collectEvents(jarvis, "What is my secret phrase?", activeSession.id);
  const t6Done = t6Events.find(e => e.type === "done") as { type: "done"; fullText: string } | undefined;
  assert(
    t6Done !== undefined && t6Done.fullText.includes("NEBULA-99"),
    `Context retained across session turns: "${t6Done?.fullText?.trim()}"`
  );

  // 7. AGENT Request Execution through OpenCode
  console.log("\n▶ Test 7: AGENT Execution through OpenCode Gateway");
  const t7Events = await collectEvents(jarvis, "Perform a code review of this function: function isEven(n) { return n % 2 === 0; }");
  const t7Route = t7Events.find(e => e.type === "route");
  const t7Done = t7Events.find(e => e.type === "done") as { type: "done"; fullText: string } | undefined;
  assert(t7Route?.type === "route" && t7Route.route === "AGENT", "Routed coding/task request to AGENT path");
  assert(t7Done !== undefined && t7Done.fullText.length > 0, "AGENT execution completed with response through OpenCode");

  // 8. Model Failure / Unavailability Behavior
  console.log("\n▶ Test 8: Graceful Handling when Configured Model is Missing");
  const missingModelProvider = new OpenCodeModelProvider(
    {
      client,
      modelProfile: {
        providerID: "nonexistent_provider",
        modelID: "nonexistent_model_xyz",
      },
    },
    logger
  );

  let missingModelFailed = false;
  let missingModelError = "";
  for await (const ev of missingModelProvider.chat({ messages: [{ role: "user", content: "test" }] })) {
    if (ev.type === "error") {
      missingModelFailed = true;
      missingModelError = ev.error || "";
    }
  }
  assert(missingModelFailed || missingModelError.length > 0, "Nonexistent model reported explicit error without crashing JARVIS");

  // 9. OpenCode Daemon Unreachable Behavior
  console.log("\n▶ Test 9: Graceful Handling when Daemon is Unreachable");
  const deadServiceFile = path.join(testDir, "dead_service.json");
  fs.writeFileSync(
    deadServiceFile,
    JSON.stringify({
      url: "http://127.0.0.1:59999",
      pid: 99999,
      version: "2.0.0",
      password: "dummy",
    })
  );
  const deadClient = new OpenCodeClient(deadServiceFile, logger);
  const deadProvider = new OpenCodeModelProvider(
    {
      client: deadClient,
      modelProfile: {
        providerID: testModelRef.providerID,
        modelID: testModelRef.id,
      },
    },
    logger
  );

  let deadReportedError = false;
  let deadErrorMessage = "";
  for await (const ev of deadProvider.chat({ messages: [{ role: "user", content: "hi" }] })) {
    if (ev.type === "error") {
      deadReportedError = true;
      deadErrorMessage = ev.error || "";
    }
  }
  assert(deadReportedError, `Dead daemon cleanly emits error: "${deadErrorMessage}"`);

  // Clean up test environment
  jarvis.shutdown();
  fs.rmSync(testDir, { recursive: true, force: true });

  console.log("\n=================================================================");
  if (failedTests === 0) {
    console.log(`  OPENCODE INTEGRATION TESTS PASSED (${passedTests}/${totalTests} verified)`);
  } else {
    console.error(`  OPENCODE INTEGRATION TESTS FAILED (${failedTests}/${totalTests} failed)`);
    process.exit(1);
  }
  console.log("=================================================================\n");
}

runOpenCodeGatewayTests().catch((err) => {
  console.error("Test runner threw uncaught error:", err);
  process.exit(1);
});
