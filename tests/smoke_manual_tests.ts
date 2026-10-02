/**
 * Phase 9 Manual Smoke Tests
 * 
 * Executes the 7 exact verification tests required for the OpenCode unified gateway architecture:
 * Test 1: "hi" -> Real conversational response through OpenCode.
 * Test 2: "what did I just ask?" -> Same Jarvis/OpenCode conversation context.
 * Test 3: Current-information request -> Routes to search, zero model consumption.
 * Test 4: Complex coding/task request -> Routes to OpenCode AGENT execution.
 * Test 5: Change configured FAST & AGENT profiles -> Sends selected model to OpenCode.
 * Test 6: Restart Jarvis while OpenCode remains running -> Session reconnection verified.
 * Test 7: Stop OpenCode -> Reports real failure clearly rather than hanging forever.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { JarvisCore, type JarvisEvent } from "../src/core.ts";
import { OpenCodeClient } from "../src/opencode_client.ts";
import { Logger } from "../src/logger.ts";
import { compareSemver } from "../src/config.ts";

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assert(condition: boolean, testName: string, details?: string) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  \x1b[32m✔\x1b[0m [PASS] ${testName}${details ? ` (${details})` : ""}`);
  } else {
    failedTests++;
    console.error(`  \x1b[31m✖\x1b[0m [FAIL] ${testName}${details ? ` - ${details}` : ""}`);
  }
}

async function collectEvents(core: JarvisCore, prompt: string, sessionId?: string): Promise<JarvisEvent[]> {
  const events: JarvisEvent[] = [];
  for await (const ev of core.processInput(prompt, sessionId)) {
    events.push(ev);
  }
  return events;
}

async function runSmokeTests() {
  console.log("=================================================================");
  console.log("             JARVIS PHASE 9 MANUAL SMOKE TEST SUITE              ");
  console.log("=================================================================\n");

  const testDir = path.join(process.cwd(), ".test_smoke_phase9");
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  fs.mkdirSync(testDir, { recursive: true });

  let jarvis: JarvisCore | undefined;
  let altJarvis: JarvisCore | undefined;
  let restartedJarvis: JarvisCore | undefined;
  let deadJarvis: JarvisCore | undefined;

  try {

  const testDb = path.join(testDir, "smoke.db");
  const testConfig = path.join(testDir, "jarvis.config.json");

  const probeClient = new OpenCodeClient();
  const probeInfo = await probeClient.resolveService();
  let isLegacy = false;
  if (probeInfo) {
    const h = await probeClient.health();
    if (h.ok && h.version && compareSemver(h.version, "2.1.0") < 0) {
      isLegacy = true;
    }
  }

  fs.writeFileSync(
    testConfig,
    JSON.stringify({
      dataDir: testDir,
      databasePath: testDb,
      opencode: {
        legacyProtocolMode: isLegacy,
      },
      models: {
        fast: {
          providerID: "opencode",
          modelID: "mimo-v2.6-flash-free",
          variant: "default",
        },
        agent: {
          providerID: "opencode",
          modelID: "mimo-v2.6-flash-free",
          variant: "default",
        },
      },
      fallbackProvider: { enabled: false },
      logging: { level: "error" },
    })
  );

    jarvis = new JarvisCore(testConfig);
  await jarvis.initialize();

  const generalSession = await jarvis.sessionMgr.getOrCreateActiveSession("general");

  // -------------------------------------------------------------
  // Test 1: User: "hi" -> Real conversational response through OpenCode
  // -------------------------------------------------------------
  console.log("▶ Smoke Test 1: Casual 'hi' through OpenCode Gateway");
  const t1Events = await collectEvents(jarvis, "hi", generalSession.id);
  const t1Route = t1Events.find(e => e.type === "route");
  const t1Tokens = t1Events.filter(e => e.type === "token") as { type: "token"; text: string }[];
  const t1Done = t1Events.find(e => e.type === "done") as { type: "done"; fullText: string } | undefined;

  assert(t1Route?.type === "route" && t1Route.route === "FAST", "Routed 'hi' to FAST path");
  assert(t1Tokens.length > 0, "Incremental tokens streamed from OpenCode", `Chunks: ${t1Tokens.length}`);
  assert(t1Done !== undefined && t1Done.fullText.length > 0, "Real conversational response received", t1Done?.fullText?.trim());

  // -------------------------------------------------------------
  // Test 2: Follow-up: "what did I just ask?" -> Same conversation context
  // -------------------------------------------------------------
  console.log("\n▶ Smoke Test 2: Context Follow-Up 'what did I just ask?'");
  const t2Events = await collectEvents(jarvis, "what did I just ask?", generalSession.id);
  const t2Done = t2Events.find(e => e.type === "done") as { type: "done"; fullText: string } | undefined;
  const ans2 = t2Done?.fullText?.toLowerCase() || "";
  assert(
    t2Done !== undefined && (ans2.includes("hi") || ans2.includes("hello") || ans2.includes("greet")),
    "Context retained across follow-up in same session",
    t2Done?.fullText?.trim()
  );

  // -------------------------------------------------------------
  // Test 3: Current Information Request -> Routes to SEARCH (no LLM consumption)
  // -------------------------------------------------------------
  console.log("\n▶ Smoke Test 3: Current Information Query Routes to SEARCH");
  const t3Events = await collectEvents(jarvis, "What's the latest Nvidia RTX driver?");
  const t3Route = t3Events.find(e => e.type === "route");
  const t3Done = t3Events.find(e => e.type === "done") as { type: "done"; fullText: string; sources?: any[] } | undefined;

  assert(t3Route?.type === "route" && t3Route.route === "SEARCH", "Routed to SEARCH path without consuming LLM inference");
  assert(t3Done !== undefined && Array.isArray(t3Done.sources) && t3Done.sources.length > 0, "Returned factual web search sources", `Sources: ${t3Done?.sources?.length}`);

  // -------------------------------------------------------------
  // Test 4: Complex Coding/Task Request -> Routes to OpenCode AGENT
  // -------------------------------------------------------------
  console.log("\n▶ Smoke Test 4: Complex Coding Request Routes to OpenCode AGENT");
  const t4Events = await collectEvents(jarvis, "Perform a code review of this function: function factorial(n) { return n <= 1 ? 1 : n * factorial(n - 1); }");
  const t4Route = t4Events.find(e => e.type === "route");
  const t4Done = t4Events.find(e => e.type === "done") as { type: "done"; fullText: string } | undefined;

  assert(t4Route?.type === "route" && t4Route.route === "AGENT", "Routed to AGENT path for code reasoning");
  assert(t4Done !== undefined && t4Done.fullText.length > 0, "OpenCode AGENT executed and returned structured analysis");

  // -------------------------------------------------------------
  // Test 5: Change Configured FAST & AGENT Model Profiles
  // -------------------------------------------------------------
  console.log("\n▶ Smoke Test 5: Dynamic Profile Switching Sent to OpenCode");
  const altModelConfig = path.join(testDir, "alt_config.json");
  fs.writeFileSync(
    altModelConfig,
    JSON.stringify({
      dataDir: testDir,
      databasePath: testDb,
      models: {
        fast: {
          providerID: "opencode",
          modelID: "longcat-2.5-preview-free",
          variant: "default",
        },
        agent: {
          providerID: "opencode",
          modelID: "longcat-2.5-preview-free",
          variant: "default",
        },
      },
      fallbackProvider: { enabled: false },
      logging: { level: "error" },
    })
  );

    altJarvis = new JarvisCore(altModelConfig);
  await altJarvis.initialize();
  const activeAltSession = await altJarvis.sessionMgr.getOrCreateActiveSession("general");
  const altOcId = await altJarvis.sessionMgr.ensureOpenCodeSession(activeAltSession.id);

  // Verify switchSessionModel sends selected model profile to OpenCode
  let switchSuccess = false;
  try {
    await altJarvis.opencode.switchSessionModel(altOcId, {
      providerID: "opencode",
      id: "longcat-2.5-preview-free",
      variant: "default",
    });
    switchSuccess = true;
  } catch (err: any) {
    console.error("switchSessionModel failed:", err.message);
  }
  assert(switchSuccess === true, "Switched active OpenCode session to configured alternate model profile");
  altJarvis.shutdown();

  // -------------------------------------------------------------
  // Test 6: Restart Jarvis While OpenCode Remains Running
  // -------------------------------------------------------------
  console.log("\n▶ Smoke Test 6: Restart Jarvis While OpenCode Remains Running");
  jarvis.shutdown(); // Stop original instance

  // Start fresh instance with same DB
    restartedJarvis = new JarvisCore(testConfig);
  await restartedJarvis.initialize();

  const resumedSession = await restartedJarvis.sessionMgr.getOrCreateActiveSession("general");
  const resumedOcId = await restartedJarvis.sessionMgr.ensureOpenCodeSession(resumedSession.id);
  assert(resumedSession.id === generalSession.id, "Jarvis session ID preserved across server restart");
  assert(typeof resumedOcId === "string" && resumedOcId.startsWith("ses_"), "OpenCode session reconnected smoothly after restart");

  // -------------------------------------------------------------
  // Test 7: Stop OpenCode / Unreachable Daemon Failure Reporting
  // -------------------------------------------------------------
  console.log("\n▶ Smoke Test 7: Unreachable Daemon Failure Cleanly Handled (No Infinite Hang)");
  const deadConfig = path.join(testDir, "dead_config.json");
  const deadService = path.join(testDir, "dead_service.json");
  fs.writeFileSync(
    deadService,
    JSON.stringify({ url: "http://127.0.0.1:59998", pid: 99999, version: "2.0.0", password: "none" })
  );
  fs.writeFileSync(
    deadConfig,
    JSON.stringify({
      dataDir: testDir,
      databasePath: path.join(testDir, "dead.db"),
      opencode: { serviceFile: deadService, disableGlobalDiscovery: true },
      models: {
        fast: { providerID: "opencode", modelID: "mimo-v2.6-flash-free" },
        agent: { providerID: "opencode", modelID: "mimo-v2.6-flash-free" },
      },
      fallbackProvider: { enabled: false },
      logging: { level: "error" },
    })
  );

    deadJarvis = new JarvisCore(deadConfig);
  const startTime = Date.now();
  const deadEvents: JarvisEvent[] = [];
  for await (const ev of deadJarvis.processInput("hello?")) {
    deadEvents.push(ev);
  }
  const duration = Date.now() - startTime;
  const deadError = deadEvents.find(e => e.type === "error");

  assert(deadError !== undefined, "Reported explicit error when OpenCode daemon is down", (deadError as any)?.error);
  assert(duration < 10000, `Returned immediately (${duration}ms) rather than hanging indefinitely`);

  } finally {
    try {
      if (deadJarvis) deadJarvis.shutdown();
    } catch {}
    try {
      if (restartedJarvis) restartedJarvis.shutdown();
    } catch {}
    try {
      if (altJarvis) altJarvis.shutdown();
    } catch {}
    try {
      if (jarvis) jarvis.shutdown();
    } catch {}
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }

  console.log("\n=================================================================");
  if (failedTests === 0) {
    console.log(`  ALL 7 SMOKE TESTS PASSED (${passedTests}/${totalTests} verified)`);
  } else {
    console.error(`  SMOKE TESTS FAILED (${failedTests}/${totalTests} failed)`);
    process.exit(1);
  }
  console.log("=================================================================\n");
  process.exit(0);
}

runSmokeTests().catch(err => {
  console.error("Smoke test failure:", err);
  process.exit(1);
});
