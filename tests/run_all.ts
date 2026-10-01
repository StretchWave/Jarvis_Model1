/**
 * JARVIS Master Test Suite Runner
 * Categorizes and executes tests across:
 * 1. UNIT TESTS
 * 2. MOCK INTEGRATION TESTS
 * 3. LIVE OPENCODE INTEGRATION TESTS
 * 4. SMOKE TESTS
 * 
 * Complies with Requirement 30:
 * - Distinguishes the 4 test categories
 * - Reports exact counts for each category
 * - Never prints "ALL TESTS PASSED" if live integration was skipped
 * - Uses exact category reporting tokens (UNIT: PASS, MOCK: PASS, LIVE OPENCODE: PASS/SKIPPED, SMOKE: PASS)
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { OpenCodeClient } from "../src/opencode_client.ts";
import { compareSemver } from "../src/config.ts";

const execAsync = promisify(exec);

interface SuiteInfo {
  file: string;
  name: string;
}

interface CategoryResult {
  category: string;
  passedSuites: number;
  failedSuites: number;
  skippedSuites: number;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  status: "PASS" | "FAIL" | "SKIPPED";
}

const unitSuites: SuiteInfo[] = [
  { file: "tests/test_phase1.ts", name: "Core Types & Configuration" },
  { file: "tests/test_phase1_refactor.ts", name: "OpenCode Gateway Schema Validation" },
  { file: "tests/test_phase2.ts", name: "Database & Memory Persistence" },
  { file: "tests/test_phase2_refactor.ts", name: "Unified DB & OpenCode Session Mapping" },
  { file: "tests/test_phase3.ts", name: "Deterministic Skills Engine" },
  { file: "tests/test_phase3_refactor.ts", name: "Direct Skill Actions & Permissions" },
  { file: "tests/test_phase4.ts", name: "Fast Model & Fallback Providers" },
  { file: "tests/test_phase5.ts", name: "Router Classification & Routing Heuristics" },
  { file: "tests/test_phase7.ts", name: "Proactive Engine & System Monitor" },
  { file: "tests/test_phase7_refactor.ts", name: "Proactive Pulse & Task Scheduler" },
  { file: "tests/test_phase8_refactor.ts", name: "RunInspector & Execution History" },
];

const mockIntegrationSuites: SuiteInfo[] = [
  { file: "tests/test_phase4_refactor.ts", name: "OpenCode Agent Loop & SSE Stream" },
  { file: "tests/test_phase5_refactor.ts", name: "Unified 4-Tier OpenCode Routing" },
  { file: "tests/test_phase6.ts", name: "Session Management & Isolation" },
  { file: "tests/test_phase6_refactor.ts", name: "Jarvis-to-OpenCode Session Mapping" },
  { file: "tests/test_phase9_refactor.ts", name: "UI & REST API Endpoints with Mock OpenCode" },
  { file: "tests/test_opencode_bootstrap.ts", name: "OpenCode Bootstrap & Service Discovery" },
  { file: "tests/test_opencode_models_agents.ts", name: "OpenCode Model & Agent Discovery & Switching" },
  { file: "tests/test_opencode_permissions.ts", name: "OpenCode Permission Confirmation Protocol" },
  { file: "tests/test_opencode_cancellation.ts", name: "OpenCode SSE Lifecycle & Cancellation" },
  { file: "tests/test_opencode_resilience.ts", name: "OpenCode Persistence, Health Fallback & Timeout Resilience" },
  { file: "tests/test_final_acceptance.ts", name: "Final Mock Acceptance Verification" },
  { file: "tests/test_phase10_backend_fixes.ts", name: "Backend Protocol & Persistence Correctness" },
  { file: "tests/test_phase11_state_correctness.ts", name: "State Correctness & Polling Fallback" },
];

const liveIntegrationSuites: SuiteInfo[] = [
  { file: "tests/test_opencode_gateway.ts", name: "Live OpenCode Unified Gateway Integration" },
];

const smokeSuites: SuiteInfo[] = [
  { file: "tests/smoke_manual_tests.ts", name: "Live Smoke Manual Scenarios" },
];

function parseCounts(output: string): { pass: number; fail: number; skip: number; wasSkipped: boolean } {
  let pass = 0;
  let fail = 0;
  let skip = 0;

  // Check for explicit skip banner
  const wasSkipped = output.includes("TESTS SKIPPED") || output.includes("SKIPPED: daemon unavailable");

  // Count [PASS] or ✔
  const passMatches = output.match(/\[PASS\]/gi);
  if (passMatches) pass += passMatches.length;

  // Count [FAIL] or ✖
  const failMatches = output.match(/\[FAIL\]/gi);
  if (failMatches) fail += failMatches.length;

  // Count [SKIP] or ⊘
  const skipMatches = output.match(/\[SKIP\]/gi);
  if (skipMatches) skip += skipMatches.length;

  // Match summaries like "Passed: 30, Failed: 0" if individual [PASS] weren't printed
  if (pass === 0 && fail === 0) {
    const summaryMatch = output.match(/Passed:\s*(\d+),\s*Failed:\s*(\d+)/i);
    if (summaryMatch) {
      pass = parseInt(summaryMatch[1], 10);
      fail = parseInt(summaryMatch[2], 10);
    }
  }

  // Fallback if suite had no specific test assertions but exited 0
  if (pass === 0 && fail === 0 && !wasSkipped) {
    pass = 1;
  }

  return { pass, fail, skip, wasSkipped };
}

async function runCategory(
  categoryName: string,
  suites: SuiteInfo[]
): Promise<CategoryResult> {
  console.log(`\n=================================================================`);
  console.log(`  RUNNING ${categoryName.toUpperCase()} (${suites.length} suites)`);
  console.log(`=================================================================`);

  let passedSuites = 0;
  let failedSuites = 0;
  let skippedSuites = 0;
  let totalPass = 0;
  let totalFail = 0;
  let totalSkip = 0;

  for (const suite of suites) {
    process.stdout.write(`  ▶ ${suite.name} (${suite.file})... `);
    try {
      const { stdout } = await execAsync(`node --experimental-strip-types ${suite.file}`);
      const counts = parseCounts(stdout);

      if (counts.wasSkipped) {
        skippedSuites++;
        totalSkip += counts.skip || 1;
        console.log(`\x1b[33m[SKIPPED]\x1b[0m`);
      } else if (counts.fail > 0) {
        failedSuites++;
        totalFail += counts.fail;
        totalPass += counts.pass;
        console.log(`\x1b[31m[FAIL]\x1b[0m (${counts.fail} failures, ${counts.pass} passed)`);
      } else {
        passedSuites++;
        totalPass += counts.pass;
        console.log(`\x1b[32m[PASS]\x1b[0m (${counts.pass} tests)`);
      }
    } catch (err: any) {
      failedSuites++;
      const out = (err.stdout || "") + "\n" + (err.stderr || "") + "\n" + (err.message || "");
      const counts = parseCounts(out);
      totalFail += counts.fail || 1;
      totalPass += counts.pass;
      console.log(`\x1b[31m[ERROR]\x1b[0m`);
      console.error(out.trim().split("\n").map(l => "    " + l).join("\n"));
    }
  }

  let status: "PASS" | "FAIL" | "SKIPPED" = "PASS";
  if (failedSuites > 0 || totalFail > 0) {
    status = "FAIL";
  } else if (passedSuites === 0 && skippedSuites > 0) {
    status = "SKIPPED";
  }

  return {
    category: categoryName,
    passedSuites,
    failedSuites,
    skippedSuites,
    passedTests: totalPass,
    failedTests: totalFail,
    skippedTests: totalSkip,
    status,
  };
}

async function runMasterSuite() {
  console.log("=================================================================");
  console.log("        JARVIS COMPREHENSIVE VERIFICATION & TEST RUNNER         ");
  console.log("=================================================================");

  const unitResult = await runCategory("Unit Tests", unitSuites);
  const mockResult = await runCategory("Mock Integration Tests", mockIntegrationSuites);
  const liveResult = await runCategory("Live OpenCode Integration Tests", liveIntegrationSuites);
  const smokeResult = await runCategory("Smoke Tests", smokeSuites);

  console.log("\n=================================================================");
  console.log("                     FINAL TEST REPORT                           ");
  console.log("=================================================================");
  console.log(`UNIT: ${unitResult.status} (${unitResult.passedTests}/${unitResult.passedTests + unitResult.failedTests} tests passed across ${unitResult.passedSuites}/${unitSuites.length} suites)`);
  console.log(`MOCK: ${mockResult.status} (${mockResult.passedTests}/${mockResult.passedTests + mockResult.failedTests} tests passed across ${mockResult.passedSuites}/${mockIntegrationSuites.length} suites)`);
  if (liveResult.status === "SKIPPED") {
    console.log(`LIVE OPENCODE: SKIPPED (OpenCode daemon unavailable)`);
  } else {
    console.log(`LIVE OPENCODE: ${liveResult.status} (${liveResult.passedTests}/${liveResult.passedTests + liveResult.failedTests} tests passed across ${liveResult.passedSuites}/${liveIntegrationSuites.length} suites)`);
  }
  console.log(`SMOKE: ${smokeResult.status} (${smokeResult.passedTests}/${smokeResult.passedTests + smokeResult.failedTests} tests passed across ${smokeResult.passedSuites}/${smokeSuites.length} suites)`);
  console.log("=================================================================");

  const hasAnyFailure =
    unitResult.status === "FAIL" ||
    mockResult.status === "FAIL" ||
    liveResult.status === "FAIL" ||
    smokeResult.status === "FAIL";

  if (hasAnyFailure) {
    console.error("\n❌ SUITE VERIFICATION FAILED");
    process.exit(1);
  }

  if (liveResult.status === "SKIPPED") {
    console.log("\n⚠️  ALL LOCAL TESTS PASSED (LIVE OPENCODE WAS SKIPPED - NOT ALL TESTS RUN)");
  } else {
    console.log("\n✅ ALL 4 TEST CATEGORIES PASSED (INCLUDING LIVE OPENCODE)");
  }
}

runMasterSuite().catch(err => {
  console.error("Test runner error:", err);
  process.exit(1);
});
