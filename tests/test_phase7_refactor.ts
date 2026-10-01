/**
 * Phase 7 Verification Test Suite - 5-Layer Memory Architecture & Relevance Scoring
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Logger } from "../src/logger.ts";
import { Database } from "../src/database.ts";
import { MemoryManager } from "../src/memory/memory_manager.ts";

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

async function runPhase7RefactorTests() {
  console.log("\n=======================================================");
  console.log("       JARVIS PHASE 7 REFACTOR TEST SUITE              ");
  console.log("=======================================================\n");

  const testDir = path.join(process.cwd(), ".test_p7_refactor");
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  fs.mkdirSync(testDir, { recursive: true });

  let db: Database | undefined;
  let db2: Database | undefined;

  try {
    const logger = new Logger("Phase7Refactor", "error");
    const dbPath = path.join(testDir, "test_memory.db");
    db = new Database(dbPath, logger);
    const memoryMgr = new MemoryManager(db, logger);

    // -----------------------------------------------------------------
    // 1. Layer 1: Working Memory
    // -----------------------------------------------------------------
    console.log("▶ Group 1: Working Memory (Session Scratchpad)");
    const session1 = "ses_work_001";

    memoryMgr.setWorkingGoal(session1, "Debug character collision");
    memoryMgr.setWorkingVariable(session1, "current_file", "Character.cpp");
    memoryMgr.setWorkingVariable(session1, "breakpoint_line", 142);

    const wm = memoryMgr.getWorkingMemory(session1);
    assert(wm.activeGoal === "Debug character collision", "Stored active working goal in session scratchpad");
    assert(memoryMgr.getWorkingVariable(session1, "current_file") === "Character.cpp", "Stored working session variable");
    assert(memoryMgr.getWorkingVariable(session1, "breakpoint_line") === 142, "Stored numeric working session variable");

    memoryMgr.clearWorkingMemory(session1);
    const clearedWm = memoryMgr.getWorkingMemory(session1);
    assert(clearedWm.activeGoal === undefined && Object.keys(clearedWm.variables).length === 0, "Cleared working memory on demand");

    // -----------------------------------------------------------------
    // 2. Layer 3 & 4: Long-Term & Project Memory with Importance Scoring
    // -----------------------------------------------------------------
    console.log("\n▶ Group 2: Long-Term & Project Memory Persistence");

    memoryMgr.setProject({
      id: "repp",
      name: "REPP Game Project",
      path: "C:\\Projects\\REPP",
      description: "Tactical shooter in Unreal Engine",
    });

    const m1 = memoryMgr.remember({
      category: "project",
      key: "Engine Choice",
      content: "REPP project uses Unreal Engine 5.4 with Lumen",
      importance: 5,
      projectId: "repp",
    });

    const m2 = memoryMgr.remember({
      category: "personal",
      key: "Coding Preference",
      content: "User prefers concise responses with bullet points",
      importance: 4,
    });

    const m3 = memoryMgr.remember({
      category: "decision",
      key: "Database Choice",
      content: "We decided to use SQLite DatabaseSync for embedded storage",
      importance: 4,
    });

    assert(m1.importance === 5, "Recorded importance level 5 for project memory");
    assert(m2.importance === 4, "Recorded importance level 4 for personal preference");
    assert(m3.category === "decision", "Recorded decision memory category");

    // -----------------------------------------------------------------
    // 3. Relevance-Scored Memory Retrieval
    // -----------------------------------------------------------------
    console.log("\n▶ Group 3: Relevance-Scored Retrieval");

    // Exact / relevant query
    const unrealRecall = memoryMgr.recall("What engine does REPP use?", "repp");
    assert(unrealRecall.length > 0, "Recalled memories for query mentioning 'engine' and 'REPP'");
    assert(unrealRecall[0].key === "Engine Choice", "Top recalled memory matches 'Engine Choice'");

    const sqliteRecall = memoryMgr.recall("Which database did we decide on?");
    assert(sqliteRecall.length > 0, "Recalled memories for query mentioning 'database'");
    assert(sqliteRecall[0].key === "Database Choice", "Top recalled memory matches 'Database Choice'");

    // Irrelevant query -> returns EMPTY (does not pollute context)
    const unrelatedRecall = memoryMgr.recall("How do I bake chocolate chip cookies?");
    assert(unrelatedRecall.length === 0, "Irrelevant query returns 0 memories (avoids context pollution)");

    // -----------------------------------------------------------------
    // 4. Layer 5: Task Memory Lifecycle
    // -----------------------------------------------------------------
    console.log("\n▶ Group 4: Task Memory Lifecycle");

    const task = memoryMgr.createTask("Implement weapon reload animation", "repp", "Blend spaces setup");
    assert(task.status === "pending", "Created task in 'pending' status");

    const pendingList = memoryMgr.listTasks("pending", "repp");
    assert(pendingList.some((t) => t.id === task.id), "Listed active pending task in project");

    memoryMgr.updateTaskStatus(task.id, "completed");
    const completedList = memoryMgr.listTasks("completed", "repp");
    assert(completedList.some((t) => t.id === task.id), "Updated task status to 'completed'");

    // -----------------------------------------------------------------
    // 5. Intelligent Directive Extraction & Casual Sentence Filtering
    // -----------------------------------------------------------------
    console.log("\n▶ Group 5: Intelligent Directives & Casual Filtering");

    // Preference rule directive
    const d1 = memoryMgr.processDirectives("Always use TypeScript instead of plain JavaScript.");
    assert(d1.storedMemory?.importance === 5, "Extracted rule directive with importance 5");

    // Decision directive
    const d2 = memoryMgr.processDirectives("We decided that tests must be automated in CI.");
    assert(d2.storedMemory?.category === "decision", "Extracted decision directive");

    // Casual query -> ignored
    const d3 = memoryMgr.processDirectives("What time is it?");
    assert(!d3.storedMemory && !d3.createdTask, "Ignored casual time query");

    const d4 = memoryMgr.processDirectives("calculate 100 * 5");
    assert(!d4.storedMemory && !d4.createdTask, "Ignored casual calculator query");

    // -----------------------------------------------------------------
    // 6. Persistence across Reconnection
    // -----------------------------------------------------------------
    console.log("\n▶ Group 6: Persistence across Database Reconnection");
    db.close();
    db = undefined;

    db2 = new Database(dbPath, logger);
    const memoryMgr2 = new MemoryManager(db2, logger);

    const persistedRecall = memoryMgr2.recall("Unreal Lumen", "repp");
    assert(persistedRecall.length > 0 && persistedRecall[0].content.includes("Unreal Engine 5.4"), "Recalled project memory after database reconnection");

    db2.close();
    db2 = undefined;
  } finally {
    try {
      if (db) db.close();
    } catch {}
    try {
      if (db2) db2.close();
    } catch {}
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }

  // -----------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------
  console.log("\n=======================================================");
  console.log(`Phase 7 Tests Total: ${totalTests} | Passed: ${passedTests} | Failed: ${failedTests}`);
  console.log("=======================================================\n");

  if (failedTests > 0) {
    process.exit(1);
  }
}

runPhase7RefactorTests().catch((err) => {
  console.error("Test runner threw uncaught error:", err);
  process.exit(1);
});
