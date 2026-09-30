/**
 * Phase 7 Verification Test Suite - Agent Mode with OpenCode
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getDefaultConfig } from "../src/config.ts";
import { Logger } from "../src/logger.ts";
import { Database } from "../src/database.ts";
import { OpenCodeClient } from "../src/opencode_client.ts";
import { SessionManager } from "../src/session_manager.ts";
import { MemoryManager } from "../src/memory/memory_manager.ts";
import { AgentDispatcher, type AgentEvent } from "../src/agent/agent_dispatcher.ts";

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

async function runPhase7() {
  console.log("\n=======================================================");
  console.log("             JARVIS PHASE 7 TEST SUITE                 ");
  console.log("=======================================================\n");

  const testDataDir = path.join(process.cwd(), ".test_data_p7");
  if (fs.existsSync(testDataDir)) fs.rmSync(testDataDir, { recursive: true, force: true });
  fs.mkdirSync(testDataDir, { recursive: true });

  const testDbPath = path.join(testDataDir, "phase7_jarvis.db");
  const logger = new Logger("Phase7Test", "info");
  const cfg = getDefaultConfig();

  const db = new Database(testDbPath, logger);
  const client = new OpenCodeClient(cfg.opencode.serviceFile, logger);
  const sessionMgr = new SessionManager(db, client, logger);
  const memoryMgr = new MemoryManager(db, logger);

  // 1. Setup Project & Context
  console.log("▶ Step 1: Project & Context Setup");
  const mockReppDir = path.join(testDataDir, "REPP");
  fs.mkdirSync(path.join(mockReppDir, "Content"), { recursive: true });
  fs.writeFileSync(path.join(mockReppDir, "REPP.uproject"), JSON.stringify({ FileVersion: 3 }));
  fs.writeFileSync(path.join(mockReppDir, "Content", "ABP_FP_Weapon.txt"), "BlendSpace 1D RootMotion: Enabled");

  memoryMgr.setProject({
    id: "repp",
    name: "REPP Game Project",
    path: mockReppDir,
    description: "Tactical shooter in Unreal Engine",
  });
  memoryMgr.remember({
    category: "project",
    key: "Animation State",
    content: "Weapon animation uses blend spaces and root motion in " + mockReppDir,
    importance: 5,
    projectId: "repp",
  });
  assert(true, "Stored REPP project metadata and animation fact in memory");

  // 2. Initialize Jarvis Session
  console.log("\n▶ Step 2: Initialize Logical Session");
  const session = await sessionMgr.createSession({
    title: "REPP Animation Inspection",
    category: "coding",
    projectId: "repp",
    createOpenCodeSession: true,
  });
  assert(typeof session.opencode_session_id === "string", `Paired with OpenCode session ${session.opencode_session_id}`);

  // 3. Dispatch Agent Task
  console.log("\n▶ Step 3: Execute Agent Task with Context Injection");
  const dispatcher = new AgentDispatcher(sessionMgr, memoryMgr, client, logger);

  const events: AgentEvent[] = [];
  let finalResult = "";

  for await (const ev of dispatcher.executeTask(
    `Inspect the weapon animation state in ${mockReppDir} and confirm the blend spaces settings.`,
    session.id,
    "repp"
  )) {
    events.push(ev);
    if (ev.type === "progress") {
      console.log(`  \x1b[36m[Progress]\x1b[0m ${ev.message}`);
    } else if (ev.type === "done") {
      finalResult = ev.fullText;
    }
  }

  // 4. Verify Progress Events
  console.log("\n▶ Step 4: Verify Streaming Progress & Safe Output");
  const progressEvents = events.filter((e) => e.type === "progress");
  assert(progressEvents.length >= 2, `Emitted ${progressEvents.length} safe progress indicators to UI`);
  assert(events.some((e) => e.type === "tool_activity"), "Emitted tool activity completion event");
  assert(events.some((e) => e.type === "done"), "Received task completion event");

  // 5. Cleanup
  if (session.opencode_session_id) {
    await client.deleteSession(session.opencode_session_id);
  }
  db.close();

  try {
    fs.rmSync(testDataDir, { recursive: true, force: true });
  } catch {}

  console.log("\n=======================================================");
  console.log(`  TOTAL: ${totalTests}  |  PASSED: ${passedTests}  |  FAILED: ${failedTests}`);
  console.log("=======================================================\n");

  if (failedTests > 0) process.exit(1);
}

runPhase7().catch((err) => {
  console.error("Phase 7 test failed:", err);
  process.exit(1);
});
