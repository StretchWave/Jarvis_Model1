/**
 * Phase 9 Refactor Verification Test Suite
 * Tests ArtifactManager and ProactivePulse (disabled by default)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Database } from "../src/database.ts";
import { Logger } from "../src/logger.ts";
import { ArtifactManager } from "../src/artifacts/artifact_manager.ts";
import { ProactivePulse, type PulseNotification } from "../src/proactive/pulse.ts";
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

async function runPhase9Tests() {
  console.log("=================================================================");
  console.log("          PHASE 9 REFACTOR: ARTIFACTS & PROACTIVE PULSE          ");
  console.log("=================================================================\n");

  const testDir = path.join(process.cwd(), ".test_phase9");
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  fs.mkdirSync(testDir, { recursive: true });

  let db: Database | undefined;
  let jarvis: JarvisCore | undefined;

  try {
    const testDbPath = path.join(testDir, "test_phase9.db");
    const testArtifactsDir = path.join(testDir, "artifacts");
    const logger = new Logger("Phase9Test", "error", "pretty");
    db = new Database(testDbPath, logger);
    const opencode = new OpenCodeClient("nonexistent_service.json", logger);

  // -------------------------------------------------------------
  // Test 1: ArtifactManager Creation and Storage
  // -------------------------------------------------------------
  console.log("▶ Test 1: ArtifactManager Creation and File Storage");
  const artMgr = new ArtifactManager(db, logger, testArtifactsDir);
  assert(fs.existsSync(testArtifactsDir), "Artifact storage directory created automatically");

  const art1 = artMgr.createArtifact({
    runId: "run_001",
    sessionId: "ses_001",
    type: "report",
    description: "System Architecture Analysis",
    content: "# Architecture Report\nDetails about Jarvis components.",
  });

  assert(art1.id.startsWith("art_"), `Artifact ID assigned: ${art1.id}`);
  assert(art1.type === "report", "Artifact type stored correctly");
  assert(!!art1.path && fs.existsSync(art1.path), `Artifact file written to disk at ${art1.path}`);
  assert(art1.path!.endsWith(".md"), "Markdown extension assigned for report type");
  assert(fs.readFileSync(art1.path!, "utf-8").includes("# Architecture Report"), "File content matches input");

  // -------------------------------------------------------------
  // Test 2: Artifact Retrieval & DB Persistence
  // -------------------------------------------------------------
  console.log("\n▶ Test 2: Artifact Retrieval & DB Persistence");
  const fetched = artMgr.getArtifact(art1.id);
  assert(fetched !== null, "Artifact retrieved by ID");
  assert(fetched?.description === "System Architecture Analysis", "Retrieved description matches");
  assert(fetched?.run_id === "run_001", "Retrieved runId matches");

  // -------------------------------------------------------------
  // Test 3: Artifact Listing & Filtering
  // -------------------------------------------------------------
  console.log("\n▶ Test 3: Artifact Listing & Filtering");
  const art2 = artMgr.createArtifact({
    runId: "run_001",
    sessionId: "ses_001",
    type: "code_patch",
    description: "Fix router regex",
    content: "diff --git a/router.ts b/router.ts\n+ fixed",
  });
  assert(art2.path!.endsWith(".patch"), "Patch extension assigned for code_patch");

  const art3 = artMgr.createArtifact({
    runId: "run_002",
    sessionId: "ses_002",
    type: "research_note",
    description: "Quantum computing notes",
    content: "Notes on qubits",
  });

  const allArts = artMgr.listArtifacts();
  assert(allArts.length === 3, `All 3 artifacts listed (found ${allArts.length})`);

  const ses1Arts = artMgr.listArtifacts({ sessionId: "ses_001" });
  assert(ses1Arts.length === 2, `Session 1 filtered artifacts (found ${ses1Arts.length})`);

  const patchArts = artMgr.listArtifacts({ type: "code_patch" });
  assert(patchArts.length === 1 && patchArts[0].id === art2.id, "Type filter for code_patch matched exactly");

  // -------------------------------------------------------------
  // Test 4: Artifact Summary Formatting
  // -------------------------------------------------------------
  console.log("\n▶ Test 4: Artifact Summary Formatting");
  const summary = artMgr.formatArtifactSummary([art1, art2]);
  assert(summary.includes("Generated Artifacts (2)"), "Summary contains header with count");
  assert(summary.includes("[REPORT]"), "Summary contains formatted type [REPORT]");
  assert(summary.includes("[CODE_PATCH]"), "Summary contains formatted type [CODE_PATCH]");
  assert(summary.includes(art1.id), "Summary contains artifact ID");

  const emptySummary = artMgr.formatArtifactSummary([]);
  assert(emptySummary === "No artifacts recorded.", "Empty summary handled gracefully");

  // -------------------------------------------------------------
  // Test 5: Artifact Export
  // -------------------------------------------------------------
  console.log("\n▶ Test 5: Artifact Export to Destination");
  const exportDest = path.join(testDir, "exported", "report_export.md");
  const exportSuccess = artMgr.exportArtifact(art1.id, exportDest);
  assert(exportSuccess, "exportArtifact returned true");
  assert(fs.existsSync(exportDest), `Exported file exists at ${exportDest}`);
  assert(fs.readFileSync(exportDest, "utf-8").includes("# Architecture Report"), "Exported file content matches");

  // -------------------------------------------------------------
  // Test 6: ProactivePulse Default State (Must be disabled by default)
  // -------------------------------------------------------------
  console.log("\n▶ Test 6: ProactivePulse Default State");
  const pulseDefault = new ProactivePulse(db, opencode, logger);
  assert(pulseDefault.isEnabled() === false, "Proactive pulse is strictly disabled by default");

  // Enable and disable lifecycle
  pulseDefault.enable();
  assert(pulseDefault.isEnabled() === true, "Pulse enabled successfully");
  pulseDefault.disable();
  assert(pulseDefault.isEnabled() === false, "Pulse disabled successfully");

  // -------------------------------------------------------------
  // Test 7: Scheduled Reminders Management
  // -------------------------------------------------------------
  console.log("\n▶ Test 7: Scheduled Reminders Management");
  const pulse = new ProactivePulse(db, opencode, logger, { enabled: false });

  const now = Date.now();
  const rem1 = pulse.addReminder({
    title: "Check project build status",
    triggerAt: now + 1000,
    sessionId: "ses_001",
  });

  const rem2 = pulse.addReminder({
    title: "Call user about deployment",
    triggerAt: now + 50000,
  });

  assert(rem1.id.startsWith("rem_"), `Reminder registered: ${rem1.id}`);
  const pending = pulse.getPendingReminders();
  assert(pending.length === 2, `2 pending reminders found in DB (got ${pending.length})`);

  pulse.cancelReminder(rem2.id);
  const pendingAfterCancel = pulse.getPendingReminders();
  assert(pendingAfterCancel.length === 1 && pendingAfterCancel[0].id === rem1.id, "Cancelled reminder excluded from pending");

  // -------------------------------------------------------------
  // Test 8: Pulse Tick & Notification Emission
  // -------------------------------------------------------------
  console.log("\n▶ Test 8: Pulse Tick & Notification Emission");
  const receivedNotifs: PulseNotification[] = [];
  const unsubscribe = pulse.onNotification((notif) => {
    receivedNotifs.push(notif);
  });

  // Tick before trigger time -> no notification
  const notifsBefore = await pulse.tick(now);
  assert(notifsBefore.length === 0, "No notification fired before triggerAt");

  // Tick at or after trigger time -> reminder fired
  const notifsAfter = await pulse.tick(now + 2000);
  assert(notifsAfter.length === 1, `Due reminder fired on tick (count: ${notifsAfter.length})`);
  assert(notifsAfter[0].type === "reminder", "Notification type is 'reminder'");
  assert(notifsAfter[0].message === "Check project build status", "Notification message matches reminder title");
  assert(receivedNotifs.length === 1, "Listener received pulse notification callback");

  // Verify reminder status in DB updated to 'fired'
  const pendingAfterTick = pulse.getPendingReminders();
  assert(pendingAfterTick.length === 0, "Fired reminder no longer in pending list");

  unsubscribe();

  // -------------------------------------------------------------
  // Test 9: Task Completion & Failure Notifications
  // -------------------------------------------------------------
  console.log("\n▶ Test 9: Task Completion & Failure Notifications");
  const taskNotifs: PulseNotification[] = [];
  pulse.onNotification((n) => taskNotifs.push(n));

  pulse.notifyTaskCompleted({
    id: "run_test_01",
    session_id: "ses_001",
    route: "AGENT",
    status: "completed",
    start_time: now,
    end_time: now + 200,
    tool_events: "[]",
    result: "All tasks completed successfully",
  });

  assert(taskNotifs.length === 1, "notifyTaskCompleted triggered pulse notification");
  assert(taskNotifs[0].type === "task_complete", "Type is task_complete");

  pulse.notifyTaskFailed({
    id: "run_test_02",
    session_id: "ses_001",
    route: "AGENT",
    status: "failed",
    start_time: now,
    tool_events: "[]",
  }, "Compilation error");

  assert(taskNotifs.length === 2, "notifyTaskFailed triggered pulse notification");
  assert(taskNotifs[1].type === "task_failed", "Type is task_failed");
  assert(taskNotifs[1].message.includes("Compilation error"), "Notification includes error detail");

  // -------------------------------------------------------------
  // Test 10: Health Check
  // -------------------------------------------------------------
  console.log("\n▶ Test 10: Health Check Diagnostics");
  const health = await pulse.checkHealth();
  assert(typeof health.ok === "boolean", "Health status contains ok boolean");
  assert(health.database === true, "Database diagnosed as healthy");
  assert(typeof health.pendingReminders === "number", "Health reports pendingReminders count");
  assert(typeof health.activeRuns === "number", "Health reports activeRuns count");

  // -------------------------------------------------------------
  // Test 11: JarvisCore Integration
  // -------------------------------------------------------------
  console.log("\n▶ Test 11: JarvisCore Integration");
  const coreConfigPath = path.join(testDir, "core_config.json");
  fs.writeFileSync(
    coreConfigPath,
    JSON.stringify({
      dataDir: testDir,
      databasePath: path.join(testDir, "core.db"),
      fastModel: { provider: "mock", model: "mock-fast" },
      proactivePulse: { enabled: false },
      artifacts: { storageDir: path.join(testDir, "core_artifacts") },
      logging: { level: "error", format: "pretty" },
    })
  );

    jarvis = new JarvisCore(coreConfigPath);
    assert(jarvis.artifacts instanceof ArtifactManager, "jarvis.artifacts is instance of ArtifactManager");
    assert(jarvis.pulse instanceof ProactivePulse, "jarvis.pulse is instance of ProactivePulse");
    assert(jarvis.pulse.isEnabled() === false, "jarvis.pulse is disabled by default in JarvisCore");

    // Create an artifact via core
    const coreArt = jarvis.artifacts.createArtifact({
      runId: "core_run_1",
      sessionId: "core_ses_1",
      type: "document",
      description: "Core test document",
      content: "Jarvis Core Artifact Content",
    });
    assert(coreArt.id.startsWith("art_"), "Core artifact created successfully");
  } finally {
    try {
      if (jarvis) jarvis.shutdown();
    } catch {}
    try {
      if (db) db.close();
    } catch {}
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }

  // -------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------
  console.log("\n=================================================================");
  console.log(`Phase 9 Verification: ${passedTests}/${totalTests} Passed (${failedTests} Failed)`);
  console.log("=================================================================\n");

  if (failedTests > 0) {
    process.exit(1);
  }
}

runPhase9Tests().catch((err) => {
  console.error("Unhandled error in Phase 9 test:", err);
  process.exit(1);
});
