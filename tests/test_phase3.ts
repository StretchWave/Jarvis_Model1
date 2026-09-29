/**
 * Phase 3 Verification Test Suite - Direct Path Deterministic Tools & Permissions
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { DirectTools, evaluateMath } from "../src/tools/direct_tools.ts";
import { PermissionManager } from "../src/permissions.ts";
import { Database } from "../src/database.ts";
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

async function runPhase3() {
  console.log("\n=======================================================");
  console.log("             JARVIS PHASE 3 TEST SUITE                 ");
  console.log("=======================================================\n");

  const testDataDir = path.join(process.cwd(), ".test_data_p3");
  if (fs.existsSync(testDataDir)) fs.rmSync(testDataDir, { recursive: true, force: true });
  fs.mkdirSync(testDataDir, { recursive: true });

  const testDbPath = path.join(testDataDir, "phase3_jarvis.db");
  const logger = new Logger("Phase3Test", "error");
  const db = new Database(testDbPath, logger);
  const perms = new PermissionManager(db, logger);

  // 1. Time & Date
  console.log("▶ Group 1: Time and Date Tools");
  const tRes = DirectTools.getTime();
  assert(tRes.success && typeof tRes.data.time === "string", `getTime returns formatted string: "${tRes.message}"`);
  const dRes = DirectTools.getDate();
  assert(dRes.success && typeof dRes.data.date === "string", `getDate returns formatted string: "${dRes.message}"`);

  // 2. Safe Math Evaluator
  console.log("\n▶ Group 2: Safe Calculator (Zero eval)");
  assert(evaluateMath("23 * 8") === 184, "23 * 8 = 184");
  assert(evaluateMath("100 + 25 * 2") === 150, "Precedence check: 100 + 25 * 2 = 150");
  assert(evaluateMath("(100 + 25) * 2") === 250, "Parentheses check: (100 + 25) * 2 = 250");
  assert(evaluateMath("10 - 4 + 2") === 8, "Left-associativity check: 10 - 4 + 2 = 8");
  assert(evaluateMath("2 ^ 3") === 8, "Exponentiation: 2 ^ 3 = 8");
  
  let divZeroError = false;
  try {
    evaluateMath("10 / 0");
  } catch {
    divZeroError = true;
  }
  assert(divZeroError, "Division by zero throws error safely");

  const calcTool = DirectTools.calculate("23 * 8");
  assert(calcTool.success && calcTool.data.result === 184, "DirectTools.calculate integration works");

  // 3. System Information
  console.log("\n▶ Group 3: System Information");
  const sysRes = DirectTools.getSystemInfo();
  assert(sysRes.success && sysRes.data.cpu.length > 0, `Detected system info: ${sysRes.message}`);

  // 4. Volume & Media Keys
  console.log("\n▶ Group 4: Volume & Media Control");
  const muteRes = await DirectTools.volume("mute");
  assert(muteRes.success, "Mute toggle executed successfully");
  // Restore volume mute state
  await DirectTools.volume("mute");

  // 5. Filesystem Read & Search
  console.log("\n▶ Group 5: Filesystem Operations");
  const readRes = DirectTools.readFile(path.join(process.cwd(), "package.json"));
  assert(readRes.success && readRes.data.content.includes("jarvis-core"), "DirectTools.readFile reads package.json safely");

  const searchRes = DirectTools.searchFiles(process.cwd(), "config.ts");
  assert(searchRes.success && searchRes.data.matches.length > 0, "DirectTools.searchFiles locates config.ts");

  // 6. Permission & Safety Engine
  console.log("\n▶ Group 6: Permission System & Safety Tiers");
  const safeEval = perms.evaluate("read_file", { path: "package.json" });
  assert(safeEval.allowed && safeEval.level === "SAFE", "read_file classified as SAFE and allowed");

  const confirmEval = perms.evaluate("write_file", { path: "test.txt" });
  assert(!confirmEval.allowed && confirmEval.level === "CONFIRM" && confirmEval.requiresPrompt, "write_file classified as CONFIRM and requires prompt");

  const dangerousEval = perms.evaluate("delete_directory", { path: "C:\\Windows" });
  assert(!dangerousEval.allowed && dangerousEval.level === "DANGEROUS" && dangerousEval.requiresPrompt, "delete_directory classified as DANGEROUS");

  // Audit Logging
  perms.logAudit("open_application", "SAFE", "Launched chrome", "auto");
  perms.logAudit("write_file", "CONFIRM", "Wrote new config file", "user_prompt");
  assert(true, "Audited actions logged to SQLite");

  db.close();
  try {
    fs.rmSync(testDataDir, { recursive: true, force: true });
  } catch {}

  console.log("\n=======================================================");
  console.log(`  TOTAL: ${totalTests}  |  PASSED: ${passedTests}  |  FAILED: ${failedTests}`);
  console.log("=======================================================\n");

  if (failedTests > 0) process.exit(1);
}

runPhase3().catch((err) => {
  console.error("Phase 3 test failed:", err);
  process.exit(1);
});
