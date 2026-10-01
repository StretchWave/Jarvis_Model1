/**
 * Phase 3 Verification Test Suite - Rolling Conversational Context, Entity Tracking & Pronoun Resolution
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Logger } from "../src/logger.ts";
import { Database } from "../src/database.ts";
import { ConversationContextManager } from "../src/context/conversation_context.ts";
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

async function runPhase3RefactorTests() {
  console.log("\n=======================================================");
  console.log("       JARVIS PHASE 3 REFACTOR TEST SUITE              ");
  console.log("=======================================================\n");

  const testDir = path.join(process.cwd(), ".test_p3_refactor");
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  fs.mkdirSync(testDir, { recursive: true });

  let db: Database | undefined;
  let core: JarvisCore | undefined;

  try {
    const dbPath = path.join(testDir, "test_context.db");
    const logger = new Logger("Phase3Refactor", "error");
    db = new Database(dbPath, logger);
    const contextMgr = new ConversationContextManager(db, logger);

  // -----------------------------------------------------------------
  // 1. Entity and Topic Extraction
  // -----------------------------------------------------------------
  console.log("▶ Group 1: Entity and Topic Extraction");
  const sessionId = "ses_test_context_001";

  contextMgr.addTurn(sessionId, "user", "I'm thinking about using MiMo for Jarvis.", "FAST");
  const state1 = contextMgr.getState(sessionId);

  assert(state1.activeEntities.includes("MiMo"), "Extracts 'MiMo' entity from user prompt");
  assert(state1.activeEntities.includes("Jarvis"), "Extracts 'Jarvis' entity from user prompt");
  assert(!!state1.currentTopic && state1.currentTopic.toLowerCase().includes("mimo"), "Extracts relevant current topic: " + state1.currentTopic);

  // -----------------------------------------------------------------
  // 2. Pronoun & Reference Resolution
  // -----------------------------------------------------------------
  console.log("\n▶ Group 2: Pronoun & Anaphoric Reference Resolution");

  const resolution = contextMgr.resolvePronoun("Is it good enough?", sessionId);
  assert(resolution.hasPronoun === true, "Detects pronoun in follow-up query");
  assert(resolution.pronoun === "it", "Identifies 'it' as the pronoun");
  assert(resolution.referent === "MiMo", "Resolves referent of 'it' to 'MiMo'");

  // -----------------------------------------------------------------
  // 3. Compact Contextual Prompt Building
  // -----------------------------------------------------------------
  console.log("\n▶ Group 3: Compact Contextual Prompt Construction");

  contextMgr.addTurn(sessionId, "assistant", "MiMo is a capable lightweight model, Sir.", "FAST");

  const promptMessages = contextMgr.buildPromptMessages("Is it good enough?", sessionId, {
    systemPrompt: "You are Jarvis, personal AI.",
    maxTurns: 4,
  });

  assert(promptMessages.length >= 3, "Constructs multi-turn prompt array (system + history + current)");
  assert(promptMessages[0].role === "system", "First message is system prompt with context annotation");
  assert(promptMessages[0].content.includes("Topic:"), "System prompt includes active context topic annotation");
  assert(promptMessages[promptMessages.length - 1].role === "user", "Last message is current user query");
  assert(promptMessages[promptMessages.length - 1].content.includes("MiMo"), "Pronoun is clarified with referent 'MiMo' in user query");

  // -----------------------------------------------------------------
  // 4. Bounded Rolling Turns (No Token Explosion)
  // -----------------------------------------------------------------
  console.log("\n▶ Group 4: Bounded Rolling Window");

  for (let i = 1; i <= 10; i++) {
    contextMgr.addTurn(sessionId, "user", `Turn query ${i}`, "FAST");
    contextMgr.addTurn(sessionId, "assistant", `Turn answer ${i}`, "FAST");
  }

  const boundedMessages = contextMgr.buildPromptMessages("Final query", sessionId, {
    systemPrompt: "System",
    maxTurns: 4,
  });

  // System (1) + maxTurns (4) + User (1) = 6 total messages
  assert(boundedMessages.length === 6, `Limits historical turns to exactly maxTurns (${boundedMessages.length} messages)`);

  // -----------------------------------------------------------------
  // 5. Session Context Isolation
  // -----------------------------------------------------------------
  console.log("\n▶ Group 5: Session Context Isolation");
  const sessionA = "ses_alpha";
  const sessionB = "ses_beta";

  contextMgr.addTurn(sessionA, "user", "We are working on the REPP Unreal project.", "FAST");
  contextMgr.addTurn(sessionB, "user", "I want to research RTX 4050 mobile drivers.", "FAST");

  const stateA = contextMgr.getState(sessionA);
  const stateB = contextMgr.getState(sessionB);

  assert(stateA.activeEntities.includes("REPP"), "Session A has 'REPP' in active entities");
  assert(!stateA.activeEntities.includes("RTX"), "Session A does NOT leak entities from Session B");
  assert(stateB.activeEntities.includes("RTX"), "Session B has 'RTX' in active entities");

  // -----------------------------------------------------------------
  // 6. End-to-End Core Conversational Multi-Turn Flow
  // -----------------------------------------------------------------
  console.log("\n▶ Group 6: End-to-End JarvisCore Multi-Turn Context Retention");

    process.env.JARVIS_FAST_PROVIDER = "mock";
    core = new JarvisCore();
    await core.initialize();

    const coreSession = await core.sessionMgr.createSession({
      title: "MiMo Evaluation",
      category: "general",
    });

    // Turn 1: Introduce topic
    let turn1Reply = "";
    for await (const ev of core.processInput("I'm thinking about using MiMo for Jarvis.", coreSession.id)) {
      if (ev.type === "token") turn1Reply += ev.text;
    }
    assert(turn1Reply.length > 0, "Turn 1 returns response from FAST path");

    // Turn 2: Follow-up with pronoun "it"
    let turn2Reply = "";
    for await (const ev of core.processInput("Is it good enough?", coreSession.id)) {
      if (ev.type === "token") turn2Reply += ev.text;
    }
    assert(turn2Reply.toLowerCase().includes("mimo"), `Turn 2 understands context and references MiMo: "${turn2Reply}"`);
  } finally {
    try {
      if (db) db.close();
    } catch {}
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
  console.log(`Phase 3 Tests Total: ${totalTests} | Passed: ${passedTests} | Failed: ${failedTests}`);
  console.log("=======================================================\n");

  if (failedTests > 0) {
    process.exit(1);
  }
}

runPhase3RefactorTests().catch((err) => {
  console.error("Test runner threw uncaught error:", err);
  process.exit(1);
});
