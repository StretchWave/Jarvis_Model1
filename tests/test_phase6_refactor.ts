/**
 * Phase 6 Verification Test Suite - Task Run Inspector & Disconnection Recovery
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { Logger } from "../src/logger.ts";
import { Database } from "../src/database.ts";
import { RunInspector } from "../src/inspector/run_inspector.ts";
import { OpenCodeClient } from "../src/opencode_client.ts";
import { JarvisCore } from "../src/core.ts";

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

async function runPhase6RefactorTests() {
  console.log("\n=======================================================");
  console.log("       JARVIS PHASE 6 REFACTOR TEST SUITE              ");
  console.log("=======================================================\n");

  const testDir = path.join(process.cwd(), ".test_p6_refactor");
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  fs.mkdirSync(testDir, { recursive: true });

  let db: Database | undefined;
  let reconnectedDb: Database | undefined;
  let recoveryDb: Database | undefined;
  let mockServer: http.Server | undefined;
  let core: JarvisCore | undefined;

  try {
    const logger = new Logger("Phase6Refactor", "error");
    const dbPath = path.join(testDir, "test_inspector.db");
    db = new Database(dbPath, logger);
    const inspector = new RunInspector(db, logger);

  // -----------------------------------------------------------------
  // 1. Task Run Lifecycle Management
  // -----------------------------------------------------------------
  console.log("▶ Group 1: Task Run Lifecycle Management");
  const sessionId = "ses_inspector_01";

  // Start run
  const run1 = inspector.startRun({
    sessionId,
    route: "AGENT",
    modelProvider: "OpenCode",
    initialOperation: "Analyzing repository",
  });

  assert(run1.status === "running", "Task run created in 'running' status");
  assert(run1.route === "AGENT", "Task run has correct route");
  assert(run1.modelProvider === "OpenCode", "Task run records model provider");
  assert(run1.currentOperation === "Analyzing repository", "Initial operation recorded");

  // Update operation
  inspector.updateOperation(run1.runId, "Running Blueprint validation");
  const updatedRun = inspector.getRun(run1.runId);
  assert(updatedRun?.currentOperation === "Running Blueprint validation", "Updated current operation in real time");

  // Record tool events
  inspector.recordToolEvent(run1.runId, "read_file", "started", "path=Character.uasset");
  inspector.recordToolEvent(run1.runId, "read_file", "completed", "Loaded 124KB");
  const runWithTools = inspector.getRun(run1.runId);
  assert(runWithTools?.toolEvents.length === 2, "Recorded 2 tool lifecycle events");
  assert(runWithTools?.toolEvents[1].status === "completed", "Tool event status recorded as completed");

  // Complete run
  inspector.completeRun(run1.runId, "Animation state machines verified successfully.");
  const completedRun = inspector.getRun(run1.runId);
  assert(completedRun?.status === "completed", "Task run status updated to 'completed'");
  assert(typeof completedRun?.endTime === "number", "Recorded completion endTime");
  assert(completedRun!.elapsedMs >= 0, "Computed non-negative elapsed execution time");
  assert(completedRun?.result?.includes("Animation state machines"), "Stored final task result");

  // -----------------------------------------------------------------
  // 2. Failure Handling
  // -----------------------------------------------------------------
  console.log("\n▶ Group 2: Run Failure Recording");
  const failRun = inspector.startRun({
    sessionId,
    route: "FAST",
    modelProvider: "gpt-4o",
  });
  inspector.failRun(failRun.runId, "Connection timeout to model endpoint");
  const failed = inspector.getRun(failRun.runId);
  assert(failed?.status === "failed", "Task run status marked as 'failed'");
  assert(failed?.error === "Connection timeout to model endpoint", "Recorded error details accurately");

  // -----------------------------------------------------------------
  // 3. UI Inspector Tree Formatting
  // -----------------------------------------------------------------
  console.log("\n▶ Group 3: Task Inspector Tree Formatting");
  const summary = inspector.formatInspectorSummary(run1.runId);
  assert(summary.includes("Task:"), "Formatted tree has Task header");
  assert(summary.includes("├── route: AGENT"), "Formatted tree displays route");
  assert(summary.includes("├── status: COMPLETED"), "Formatted tree displays status");
  assert(summary.includes("├── tool events: 2 recorded"), "Formatted tree displays tool count");
  assert(summary.includes("└── final result:"), "Formatted tree displays final result");

  // -----------------------------------------------------------------
  // 4. Persistence across Database Reconnection
  // -----------------------------------------------------------------
  console.log("\n▶ Group 4: Persistence across Database Reconnection");
  db.close();

  reconnectedDb = new Database(dbPath, logger);
  const reconnectedInspector = new RunInspector(reconnectedDb, logger);

  const persistedRun = reconnectedInspector.getRun(run1.runId);
  assert(persistedRun !== null, "Recalled run from database after restart");
  assert(persistedRun?.status === "completed", "Persisted run retains 'completed' status");
  assert(persistedRun?.toolEvents.length === 2, "Persisted run retains all tool events");
  reconnectedDb.close();

  // -----------------------------------------------------------------
  // 5. Task Disconnection & Recovery without Replaying Request
  // -----------------------------------------------------------------
  console.log("\n▶ Group 5: Task Recovery without Replaying Request");

  recoveryDb = new Database(path.join(testDir, "recovery_test.db"), logger);
  const targetSession = "ses_recover_100";
  const ocTargetSession = "oc_ses_target_999";

  // Create session and paired running task
  recoveryDb.createSession({
    id: targetSession,
    title: "Recovery Test Session",
    category: "coding",
    opencode_session_id: ocTargetSession,
    created_at: Date.now(),
    updated_at: Date.now(),
    status: "active",
  });

  const recoveryInspector = new RunInspector(recoveryDb, logger);
  const detachedRun = recoveryInspector.startRun({
    sessionId: targetSession,
    route: "AGENT",
    modelProvider: "OpenCode",
    initialOperation: "Processing background task",
  });
  assert(recoveryInspector.getActiveRun(targetSession)?.runId === detachedRun.runId, "Found active running task prior to recovery");

  // Setup mock OpenCode server returning completed message for ocTargetSession
  let promptCallCount = 0;
  mockServer = http.createServer((req, res) => {
    if (req.url === "/api/info" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: "2.0.15", pid: 8888 }));
    } else if (req.url === `/api/session/${ocTargetSession}` && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: ocTargetSession, title: "Background Session" }));
    } else if (req.url === `/api/session/${ocTargetSession}/message` && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([
        { role: "user", content: "Original task prompt" },
        { role: "assistant", content: [{ type: "text", text: "Task finished while UI was away, Sir." }] },
      ]));
    } else if (req.url?.includes("/prompt") && req.method === "POST") {
      promptCallCount++;
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          if (!parsed.prompt || !parsed.prompt.text) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing prompt.text" }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400);
          res.end();
        }
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  const mockPort = 39899;
  await new Promise<void>((resolve) => mockServer.listen(mockPort, "127.0.0.1", resolve));

  const serviceFile = path.join(testDir, "recovery_service.json");
  fs.writeFileSync(serviceFile, JSON.stringify({
    url: `http://127.0.0.1:${mockPort}`,
    pid: 8888,
    version: "2.0.15",
  }));

  const recoveryClient = new OpenCodeClient(serviceFile, logger);

  // Perform recovery
  const recoveryResult = await recoveryInspector.recoverSession(targetSession, recoveryClient);

  assert(recoveryResult.recovered === true, "Task recovery reported success");
  assert(recoveryResult.run?.status === "completed", "Recovered task is marked as 'completed'");
  assert(recoveryResult.run?.result?.includes("Task finished while UI was away"), "Recovered final assistant response: " + recoveryResult.run?.result);
  assert(promptCallCount === 0, "Did NOT replay the prompt to OpenCode unnecessarily");

  await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  recoveryDb.close();

  // -----------------------------------------------------------------
  // 6. End-to-End Core Task Run Auditing
  // -----------------------------------------------------------------
  console.log("\n▶ Group 6: End-to-End JarvisCore Automatic Run Auditing");

    process.env.JARVIS_FAST_PROVIDER = "mock";
    core = new JarvisCore();
    await core.initialize();

    // Execute a command
    for await (const ev of core.processInput("calculate 10 + 20")) {}

    const runs = core.inspector.listRuns();
    assert(runs.length >= 1, "JarvisCore automatically tracked task run in inspector");
    assert(runs[0].route === "DIRECT", "Tracked run has DIRECT route");
    assert(runs[0].status === "completed", "Tracked run marked as completed");
    assert(runs[0].toolEvents.length > 0, "Tracked run recorded tool event");
  } finally {
    try {
      if (db) db.close();
    } catch {}
    try {
      if (reconnectedDb) reconnectedDb.close();
    } catch {}
    try {
      if (recoveryDb) recoveryDb.close();
    } catch {}
    if (mockServer) {
      await new Promise<void>((r) => mockServer!.close(() => r()));
    }
    try {
      if (core) core.shutdown();
    } catch {}
    delete process.env.JARVIS_FAST_PROVIDER;
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }

  // -----------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------
  console.log("\n=======================================================");
  console.log(`Phase 6 Tests Total: ${totalTests} | Passed: ${passedTests} | Failed: ${failedTests}`);
  console.log("=======================================================\n");

  if (failedTests > 0) {
    process.exit(1);
  }
}

runPhase6RefactorTests().catch((err) => {
  console.error("Test runner threw uncaught error:", err);
  process.exit(1);
});
