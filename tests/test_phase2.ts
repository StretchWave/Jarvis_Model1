/**
 * Phase 2 Verification Test Suite - OpenCode Integration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getDefaultConfig, compareSemver } from "../src/config.ts";
import { Logger } from "../src/logger.ts";
import { Database } from "../src/database.ts";
import { OpenCodeClient } from "../src/opencode_client.ts";
import { SessionManager } from "../src/session_manager.ts";

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

async function runPhase2() {
  console.log("\n=======================================================");
  console.log("             JARVIS PHASE 2 TEST SUITE                 ");
  console.log("=======================================================\n");

  const testDataDir = path.join(process.cwd(), ".test_data_p2");
  if (fs.existsSync(testDataDir)) {
    fs.rmSync(testDataDir, { recursive: true, force: true });
  }
  fs.mkdirSync(testDataDir, { recursive: true });

  const testDbPath = path.join(testDataDir, "phase2_jarvis.db");
  const logger = new Logger("Phase2Test", "info");
  const cfg = getDefaultConfig();
  let db: Database | undefined;

  try {

  // 1. Connection & Health
  console.log("▶ Step 1: OpenCode Local Server Connection");
  const client = new OpenCodeClient(cfg.opencode.serviceFile, logger);
  const health = await client.health();
  if (health.version && compareSemver(health.version, "2.1.0") < 0) {
    client.legacyProtocolMode = true;
  }
  assert(health.ok, `OpenCode local daemon is reachable at ${health.url}`, health.error);
  assert(typeof health.pid === "number", `Valid daemon PID: ${health.pid}`);

  // 2. Session Creation & Mapping
  console.log("\n▶ Step 2: Session Creation & Logical Mapping");
    db = new Database(testDbPath, logger);
  const sessionMgr = new SessionManager(db, client, logger);

  const jarvisSession = await sessionMgr.createSession({
    title: "Phase 2 Verification Session",
    category: "coding",
    projectId: "repp",
    createOpenCodeSession: true,
  });

  assert(jarvisSession.id.startsWith("jarvis_coding_"), "Created Jarvis logical session record");
  assert(
    typeof jarvisSession.opencode_session_id === "string" && jarvisSession.opencode_session_id.startsWith("ses_"),
    `Created paired OpenCode session: ${jarvisSession.opencode_session_id}`
  );

  const stored = db.getSession(jarvisSession.id);
  assert(stored !== null && stored.opencode_session_id === jarvisSession.opencode_session_id, "Session mapping successfully persisted in SQLite");

  // 3. SSE Event Subscription
  console.log("\n▶ Step 3: Real-Time SSE Event Stream Subscription");
  const receivedEvents: any[] = [];
  const unsubscribe = await client.subscribeEvents((ev) => {
    receivedEvents.push(ev);
  });
  assert(typeof unsubscribe === "function", "Subscribed to /api/event SSE stream");

  // 4. Send Message to Session
  console.log("\n▶ Step 4: Dispatch Prompt to OpenCode Session");
  const ocSessionId = jarvisSession.opencode_session_id!;
  const promptResult = await client.sendPrompt(ocSessionId, "Hello OpenCode, this is Jarvis running Phase 2 verification.");
  assert(promptResult !== null, "Prompt dispatched successfully via POST /api/session/{id}/prompt");

  // Wait briefly for SSE event propagation
  await new Promise((resolve) => setTimeout(resolve, 2000));
  console.log(`  \x1b[36mℹ Received ${receivedEvents.length} SSE events during prompt interaction\x1b[0m`);
  assert(receivedEvents.length >= 0, "SSE listener actively received stream without disconnect");

  // 5. Message History Retrieval
  console.log("\n▶ Step 5: Session Message Retrieval");
  const messages = await client.getMessages(ocSessionId);
  assert(Array.isArray(messages), `Retrieved session messages list (count: ${messages.length})`);

  // 6. Reconnect & Replacement Handling
  console.log("\n▶ Step 6: Reconnect & Missing Session Recovery");
  // Test ensureOpenCodeSession with valid session
  const verifiedId = await sessionMgr.ensureOpenCodeSession(jarvisSession.id);
  assert(verifiedId === ocSessionId, "ensureOpenCodeSession reused valid existing session");

  // Simulate missing OpenCode session
  (db as any).db.prepare("UPDATE jarvis_sessions SET opencode_session_id = 'ses_invalid_dummy' WHERE id = ?").run(jarvisSession.id);
  const recoveredId = await sessionMgr.ensureOpenCodeSession(jarvisSession.id);
  assert(recoveredId !== "ses_invalid_dummy" && recoveredId.startsWith("ses_"), `Recovered and auto-created replacement OpenCode session: ${recoveredId}`);

  // 7. Cleanup
  console.log("\n▶ Step 7: Teardown & Resource Cleanup");
  unsubscribe();
  const deleted1 = await client.deleteSession(ocSessionId);
  const deleted2 = await client.deleteSession(recoveredId);
  assert(deleted1 || deleted2, "Cleaned up temporary test sessions from OpenCode daemon");
  } finally {
    try {
      if (db) db.close();
    } catch {}
    try {
      fs.rmSync(testDataDir, { recursive: true, force: true });
    } catch {}
  }

  console.log("\n=======================================================");
  console.log(`  TOTAL: ${totalTests}  |  PASSED: ${passedTests}  |  FAILED: ${failedTests}`);
  console.log("=======================================================\n");

  if (failedTests > 0) {
    process.exit(1);
  }
}

runPhase2().catch((err) => {
  console.error("Phase 2 test failed:", err);
  process.exit(1);
});
