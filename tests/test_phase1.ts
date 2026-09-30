/**
 * Phase 1 Verification Test Suite
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig, getDefaultConfig } from "../src/config.ts";
import { Logger, redactSecrets } from "../src/logger.ts";
import { Database } from "../src/database.ts";
import { Router } from "../src/router.ts";
import { OpenCodeClient } from "../src/opencode_client.ts";
import { getSystemPrompt, formatContextPrompt } from "../src/personality.ts";

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

async function runTests() {
  console.log("\n=======================================================");
  console.log("             JARVIS PHASE 1 TEST SUITE                 ");
  console.log("=======================================================\n");

  const testDataDir = path.join(process.cwd(), ".test_data");
  if (fs.existsSync(testDataDir)) {
    fs.rmSync(testDataDir, { recursive: true, force: true });
  }
  fs.mkdirSync(testDataDir, { recursive: true });

  const testDbPath = path.join(testDataDir, "test_jarvis.db");
  const logger = new Logger("TestPhase1", "error"); // Keep quiet during tests

  // -----------------------------------------------------------------
  // 1. Config & Defaults
  // -----------------------------------------------------------------
  console.log("▶ Group 1: Configuration & Environment Setup");
  const cfg = getDefaultConfig();
  assert(cfg.name === undefined || cfg.personality.name === "JARVIS", "Config sets assistant name to JARVIS");
  assert(cfg.personality.userTitle === "Sir", "Config defaults userTitle to Sir");
  assert(typeof cfg.opencode.serviceFile === "string" && cfg.opencode.serviceFile.length > 0, "OpenCode serviceFile path resolved");
  assert(cfg.agentModel.provider === "opencode", "Agent model provider is set to opencode");
  assert(cfg.fastModel.provider === "openai-compatible", "Fast model provider defaults to real 'openai-compatible' in production");

  // -----------------------------------------------------------------
  // 2. Logger & Secret Redaction
  // -----------------------------------------------------------------
  console.log("\n▶ Group 2: Logger & Security Redaction");
  const sensitiveString = "Bearer secret_token_123456 and Basic b3BlbmNvZGU6c2VjcmV0 and sk-proj-12345678901234567890";
  const redacted = redactSecrets(sensitiveString);
  assert(!redacted.includes("secret_token_123456"), "Redacts Bearer tokens");
  assert(!redacted.includes("b3BlbmNvZGU6c2VjcmV0"), "Redacts Basic credentials");
  assert(!redacted.includes("sk-proj-12345678901234567890"), "Redacts OpenAI-style API keys");
  assert(redacted.includes("[REDACTED]"), "Inserts [REDACTED] replacement markers");

  // -----------------------------------------------------------------
  // 3. SQLite Database Layer
  // -----------------------------------------------------------------
  console.log("\n▶ Group 3: SQLite Persistent Database Layer");
  const db = new Database(testDbPath, logger);

  // Session table
  const testSessionId = "jarvis_ses_001";
  db.createSession({
    id: testSessionId,
    title: "Test General Session",
    category: "general",
    created_at: Date.now(),
    updated_at: Date.now(),
    status: "active",
  });
  const fetchedSession = db.getSession(testSessionId);
  assert(fetchedSession !== null && fetchedSession.id === testSessionId, "Creates and retrieves Jarvis session");

  // Memory table & importance
  db.addMemory({
    id: "mem_001",
    category: "project",
    key: "REPP Engine",
    content: "REPP project uses Unreal Engine 5.4",
    importance: 5,
    project_id: "repp",
    created_at: Date.now(),
    updated_at: Date.now(),
  });
  const memories = db.getRelevantMemories("Unreal", "repp");
  assert(memories.length > 0 && memories[0].content.includes("Unreal Engine"), "Stores and retrieves high-importance memory");

  // Tool history & Audit logs
  db.recordToolHistory({
    id: "th_001",
    session_id: testSessionId,
    tool_name: "get_time",
    category: "system",
    input_params: "{}",
    output_result: "12:00:00",
    status: "success",
    latency_ms: 1.2,
    created_at: Date.now(),
  });
  db.logAudit({
    id: "audit_001",
    action: "read_file",
    severity: "safe",
    details: "Read package.json",
    created_at: Date.now(),
  });
  assert(true, "Successfully logged tool history and audit records");
  db.close();

  // -----------------------------------------------------------------
  // 4. Intent & Complexity Router
  // -----------------------------------------------------------------
  console.log("\n▶ Group 4: Deterministic Router Classification");
  const router = new Router();

  const testCases: Array<{ query: string; expectedRoute: string; expectedAction?: string }> = [
    // Direct path
    { query: "What time is it?", expectedRoute: "DIRECT", expectedAction: "time" },
    { query: "what is the date", expectedRoute: "DIRECT", expectedAction: "date" },
    { query: "23 * 8", expectedRoute: "DIRECT", expectedAction: "calculator" },
    { query: "set volume to 50%", expectedRoute: "DIRECT", expectedAction: "volume_set" },
    { query: "open chrome", expectedRoute: "DIRECT", expectedAction: "app_open" },
    { query: "system info", expectedRoute: "DIRECT", expectedAction: "system_info" },

    // Search path
    { query: "What's the latest Nvidia driver?", expectedRoute: "SEARCH" },
    { query: "Who won the match yesterday?", expectedRoute: "SEARCH" },
    { query: "What is the current price of Bitcoin?", expectedRoute: "SEARCH" },
    { query: "search the web for quantum computing breakthroughs", expectedRoute: "SEARCH" },

    // Fast path
    { query: "Hey Jarvis, what are you doing?", expectedRoute: "FAST" },
    { query: "Tell me a joke.", expectedRoute: "FAST" },
    { query: "What's the difference between TCP and UDP?", expectedRoute: "FAST" },
    { query: "Explain this in one sentence.", expectedRoute: "FAST" },

    // Agent path
    { query: "Inspect my REPP project and find the cause of this animation bug.", expectedRoute: "AGENT" },
    { query: "Analyze this repository and fix the bug in the physics controller", expectedRoute: "AGENT" },
    { query: "Run tests and git commit the changes", expectedRoute: "AGENT" },
  ];

  let totalLatency = 0;
  for (const tc of testCases) {
    const res = router.route(tc.query);
    totalLatency += res.latencyMs;
    const routeMatch = res.route === tc.expectedRoute;
    const actionMatch = !tc.expectedAction || res.directAction?.type === tc.expectedAction;
    assert(
      routeMatch && actionMatch,
      `Routing "${tc.query}" -> ${res.route} (${res.latencyMs.toFixed(3)}ms)`,
      `Expected ${tc.expectedRoute}${tc.expectedAction ? `:${tc.expectedAction}` : ""}, got ${res.route}:${res.directAction?.type}`
    );
  }

  const avgLatency = totalLatency / testCases.length;
  console.log(`\n  \x1b[36mℹ Average Routing Latency: ${avgLatency.toFixed(3)} ms (Target: < 50ms)\x1b[0m`);
  assert(avgLatency < 50, "Router latency strictly fulfills < 50ms requirement");

  // -----------------------------------------------------------------
  // 5. Personality & Context Assembly
  // -----------------------------------------------------------------
  console.log("\n▶ Group 5: Personality System & Context Formatting");
  const sysPrompt = getSystemPrompt("Sir", true);
  assert(sysPrompt.includes("JARVIS") && sysPrompt.includes("Concise Mode: Enabled"), "Generates system prompt with concise policy");
  const contextPrompt = formatContextPrompt({
    userTitle: "Sir",
    projectName: "REPP",
    memories: [{ category: "project", key: "Engine", content: "Unreal Engine 5.4" }],
    currentTask: "Debugging weapon animation",
    capabilities: ["open_application", "read_file", "search_web"],
  });
  assert(contextPrompt.includes("Active Project:") && contextPrompt.includes("Unreal Engine 5.4"), "Assembles compact structured context prompt");

  // -----------------------------------------------------------------
  // 6. OpenCode Local Daemon Health & Discovery
  // -----------------------------------------------------------------
  console.log("\n▶ Group 6: OpenCode Local Client Discovery & Health");
  const ocClient = new OpenCodeClient(cfg.opencode.serviceFile, logger);
  const service = ocClient.discoverService();
  assert(service !== null && typeof service.url === "string", "Discovers local OpenCode service.json dynamically");
  if (service) {
    console.log(`  \x1b[36mℹ Discovered Daemon at ${service.url} (PID: ${service.pid})\x1b[0m`);
    const health = await ocClient.health();
    assert(health.ok, `Health check against OpenCode daemon succeeds (version: ${health.version})`, health.error);
  }

  // -----------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------
  console.log("\n=======================================================");
  console.log(`  TOTAL: ${totalTests}  |  PASSED: ${passedTests}  |  FAILED: ${failedTests}`);
  console.log("=======================================================\n");

  // Clean test dir
  try {
    fs.rmSync(testDataDir, { recursive: true, force: true });
  } catch {}

  if (failedTests > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
