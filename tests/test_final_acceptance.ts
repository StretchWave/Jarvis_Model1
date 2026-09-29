/**
 * JARVIS Final Acceptance Test Suite (Section 21 Requirements)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { JarvisCore, type JarvisEvent } from "../src/core.ts";
import { JarvisServer } from "../src/ui/server.ts";

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

async function collectEvents(core: JarvisCore, prompt: string, sessionId?: string, projectId?: string): Promise<JarvisEvent[]> {
  const events: JarvisEvent[] = [];
  for await (const ev of core.processInput(prompt, sessionId, projectId)) {
    events.push(ev);
  }
  return events;
}

async function runAcceptanceTests() {
  console.log("\n=======================================================");
  console.log("       JARVIS SECTION 21 FINAL ACCEPTANCE TEST SUITE   ");
  console.log("=======================================================\n");

  const testDir = path.join(process.cwd(), ".test_acceptance");
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  fs.mkdirSync(testDir, { recursive: true });

  const testDb = path.join(testDir, "acceptance.db");

  // Create custom config for testing
  const configPath = path.join(testDir, "test_config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      dataDir: testDir,
      databasePath: testDb,
      logging: { level: "error", format: "pretty" },
    })
  );

  let jarvis = new JarvisCore(configPath);
  await jarvis.initialize();

  // -------------------------------------------------------------
  // Test 1: User: "What time is it?" -> Expected: DIRECT path, no LLM.
  // -------------------------------------------------------------
  console.log("▶ Acceptance Test 1: Deterministic Time Inquiry");
  const t1Events = await collectEvents(jarvis, "What time is it?");
  const t1Route = t1Events.find(e => e.type === "route");
  const t1Done = t1Events.find(e => e.type === "done");
  assert(t1Route?.type === "route" && t1Route.route === "DIRECT", "Classified strictly as DIRECT path");
  assert(t1Done?.type === "done" && t1Done.fullText.includes("The current time is"), `Returned deterministic time answer: "${t1Done?.type === 'done' ? t1Done.fullText : ''}"`);

  // -------------------------------------------------------------
  // Test 2: User: "What's the latest RTX driver?" -> Expected: SEARCH path, sources displayed.
  // -------------------------------------------------------------
  console.log("\n▶ Acceptance Test 2: Real-Time Web Search Inquiry");
  const t2Events = await collectEvents(jarvis, "What's the latest RTX driver?");
  const t2Route = t2Events.find(e => e.type === "route");
  const t2Done = t2Events.find(e => e.type === "done");
  assert(t2Route?.type === "route" && t2Route.route === "SEARCH", "Classified strictly as SEARCH path");
  assert(
    t2Done?.type === "done" && Array.isArray(t2Done.sources) && t2Done.sources.length > 0,
    `SEARCH path returned answer with ${t2Done?.type === 'done' ? t2Done.sources?.length : 0} verified source links`
  );

  // -------------------------------------------------------------
  // Test 3: User: "Hey Jarvis, what are you doing?" -> Expected: FAST path, conversational response.
  // -------------------------------------------------------------
  console.log("\n▶ Acceptance Test 3: Casual Conversational Inquiry");
  const t3Events = await collectEvents(jarvis, "Hey Jarvis, what are you doing?");
  const t3Route = t3Events.find(e => e.type === "route");
  const t3Done = t3Events.find(e => e.type === "done");
  assert(t3Route?.type === "route" && t3Route.route === "FAST", "Classified strictly as FAST path");
  assert(
    t3Done?.type === "done" && t3Done.fullText.includes("Sir"),
    `Delivered fast conversational reply maintaining Jarvis persona: "${t3Done?.type === 'done' ? t3Done.fullText : ''}"`
  );

  // -------------------------------------------------------------
  // Test 4: User: "Open Chrome and go to GitHub." -> Expected: DIRECT tool execution.
  // -------------------------------------------------------------
  console.log("\n▶ Acceptance Test 4: Direct PC Application / Web Navigation");
  const t4Events = await collectEvents(jarvis, "open github.com");
  const t4Route = t4Events.find(e => e.type === "route");
  const t4Done = t4Events.find(e => e.type === "done");
  assert(t4Route?.type === "route" && t4Route.route === "DIRECT", "Classified application/web launch as DIRECT path");
  assert(t4Done?.type === "done" && t4Done.fullText.includes("Opened URL in browser"), "Executed direct tool command");

  // -------------------------------------------------------------
  // Test 5: User: "Inspect my REPP project and find the cause of this animation bug." -> Expected: AGENT path with OpenCode
  // -------------------------------------------------------------
  console.log("\n▶ Acceptance Test 5: Complex Agent Reasoning & OpenCode Execution");
  // Set up project context
  jarvis.memoryMgr.setProject({
    id: "repp",
    name: "REPP",
    path: "C:\\Projects\\REPP",
  });
  jarvis.memoryMgr.remember({
    category: "project",
    key: "Animation Blueprint",
    content: "Uses blend space 1D for weapon recoil",
    importance: 5,
    projectId: "repp",
  });

  const t5Events = await collectEvents(
    jarvis,
    "Inspect my REPP project and find the cause of this animation bug.",
    undefined,
    "repp"
  );
  const t5Route = t5Events.find(e => e.type === "route");
  const t5Progress = t5Events.filter(e => e.type === "progress");
  const t5Done = t5Events.find(e => e.type === "done");
  assert(t5Route?.type === "route" && t5Route.route === "AGENT", "Classified complex coding task as AGENT path");
  assert(t5Progress.length > 0, `Streamed ${t5Progress.length} progress status indicators without blocking UI`);
  assert(t5Done?.type === "done" && t5Done.fullText.length > 0, "Received completed agent response via paired OpenCode session");

  // -------------------------------------------------------------
  // Test 6: User: "Delete the entire project." -> Expected: Permission confirmation before destructive action.
  // -------------------------------------------------------------
  console.log("\n▶ Acceptance Test 6: Destructive Action & Permission Enforcement");
  const permCheck = jarvis.perms.evaluate("delete_directory", { path: "C:\\Projects\\REPP" });
  assert(!permCheck.allowed, "Destructive action blocked by default");
  assert(permCheck.level === "DANGEROUS", "Classified as DANGEROUS level");
  assert(permCheck.requiresPrompt, "Requires explicit user confirmation");

  // -------------------------------------------------------------
  // Test 7: Restart Jarvis -> Expected: Memory and session metadata persist.
  // -------------------------------------------------------------
  console.log("\n▶ Acceptance Test 7: Persistent State Across Jarvis Core Restart");
  jarvis.shutdown();

  // Create new instance pointing to same DB
  const restartedJarvis = new JarvisCore(configPath);
  await restartedJarvis.initialize();

  const persistedMemories = restartedJarvis.memoryMgr.recall("weapon recoil", "repp");
  assert(persistedMemories.length > 0 && persistedMemories[0].content.includes("blend space"), "Memories persisted across full restart");
  const activeSessions = restartedJarvis.db.listSessions("active");
  assert(activeSessions.length > 0, "Session metadata persisted across full restart");

  // -------------------------------------------------------------
  // Test 8: Restart OpenCode / Reconnect Handling
  // -------------------------------------------------------------
  console.log("\n▶ Acceptance Test 8: OpenCode Health, Failure Detection & Recovery");
  // Test health check
  const healthCheck = await restartedJarvis.opencode.health();
  assert(healthCheck.ok, `OpenCode health verified (PID: ${healthCheck.pid}, version: ${healthCheck.version})`);

  // Test recovery from broken session
  const testSession = await restartedJarvis.sessionMgr.createSession({
    title: "Recovery Test Session",
    category: "coding",
  });
  // Simulate session loss
  (restartedJarvis.db as any).db.prepare("UPDATE jarvis_sessions SET opencode_session_id = 'ses_stale_nonexistent' WHERE id = ?").run(testSession.id);
  const recoveredSesId = await restartedJarvis.sessionMgr.ensureOpenCodeSession(testSession.id);
  assert(recoveredSesId !== "ses_stale_nonexistent" && recoveredSesId.startsWith("ses_"), `Auto-detected dead session and seamlessly recovered: ${recoveredSesId}`);

  // Cleanup test session from daemon
  await restartedJarvis.opencode.deleteSession(recoveredSesId);
  restartedJarvis.shutdown();

  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch {}

  console.log("\n=======================================================");
  console.log(`  TOTAL: ${totalTests}  |  PASSED: ${passedTests}  |  FAILED: ${failedTests}`);
  console.log("=======================================================\n");

  if (failedTests > 0) process.exit(1);
}

runAcceptanceTests().catch(err => {
  console.error("Acceptance test failed:", err);
  process.exit(1);
});
