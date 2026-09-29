/**
 * Phase 6 Verification Test Suite - Persistent Memory System
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Database } from "../src/database.ts";
import { MemoryManager } from "../src/memory/memory_manager.ts";
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

async function runPhase6() {
  console.log("\n=======================================================");
  console.log("             JARVIS PHASE 6 TEST SUITE                 ");
  console.log("=======================================================\n");

  const testDataDir = path.join(process.cwd(), ".test_data_p6");
  if (fs.existsSync(testDataDir)) fs.rmSync(testDataDir, { recursive: true, force: true });
  fs.mkdirSync(testDataDir, { recursive: true });

  const testDbPath = path.join(testDataDir, "phase6_jarvis.db");
  const logger = new Logger("Phase6Test", "error");
  let db = new Database(testDbPath, logger);
  let memoryMgr = new MemoryManager(db, logger);

  // 1. Projects
  console.log("▶ Step 1: Project Registration & Context");
  const proj = memoryMgr.setProject({
    id: "repp",
    name: "REPP Game Project",
    path: "C:\\Projects\\REPP",
    description: "Multiplayer tactical shooter in Unreal Engine",
  });
  assert(proj.id === "repp", "Project registered successfully");
  const fetchedProj = memoryMgr.getProject("repp");
  assert(fetchedProj?.name === "REPP Game Project", "Retrieved project metadata");

  // 2. Intelligent Directive Processing
  console.log("\n▶ Step 2: Intelligent Directives & Importance Scoring");
  // Explicit memory
  const res1 = memoryMgr.processDirectives("Remember that my REPP project uses Unreal Engine.", "repp");
  assert(res1.storedMemory !== undefined, "Extracted persistent memory from directive");
  assert(res1.storedMemory?.importance === 4, "Assigned importance level 4");

  // Ephemeral calculation -> NO memory
  const res2 = memoryMgr.processDirectives("What's 23 * 8?", "repp");
  assert(!res2.storedMemory && !res2.createdTask, "Ignored ephemeral math query without polluting memory");

  // Task directive
  const res3 = memoryMgr.processDirectives("Today I am debugging the weapon animation system.", "repp");
  assert(res3.createdTask !== undefined, "Extracted active task state");
  assert(res3.createdTask?.title.includes("debugging the weapon animation system"), "Recorded task details accurately");

  // 3. Task Lifecycle
  console.log("\n▶ Step 3: Task Management Lifecycle");
  const pendingTasks = memoryMgr.listTasks("pending", "repp");
  assert(pendingTasks.length === 1, "Listed active pending task");

  memoryMgr.updateTaskStatus(pendingTasks[0].id, "completed");
  const completedTasks = memoryMgr.listTasks("completed", "repp");
  assert(completedTasks.length === 1, "Marked task as completed");

  // 4. Persistence Across Reconnect
  console.log("\n▶ Step 4: Verification Across Database Reconnect");
  db.close();

  // Re-open SQLite database
  db = new Database(testDbPath, logger);
  memoryMgr = new MemoryManager(db, logger);

  const recalled = memoryMgr.recall("Unreal", "repp");
  assert(recalled.length > 0 && recalled[0].content.includes("Unreal Engine"), "Recalled persistent memory after database restart");
  const persistedTasks = memoryMgr.listTasks("completed", "repp");
  assert(persistedTasks.length === 1, "Task history persisted across database restart");

  db.close();
  try {
    fs.rmSync(testDataDir, { recursive: true, force: true });
  } catch {}

  console.log("\n=======================================================");
  console.log(`  TOTAL: ${totalTests}  |  PASSED: ${passedTests}  |  FAILED: ${failedTests}`);
  console.log("=======================================================\n");

  if (failedTests > 0) process.exit(1);
}

runPhase6().catch((err) => {
  console.error("Phase 6 test failed:", err);
  process.exit(1);
});
