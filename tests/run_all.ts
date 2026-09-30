/**
 * JARVIS Master Test Suite Runner
 * Runs all phase test suites and final acceptance tests sequentially.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const suites = [
  "tests/test_phase1.ts",
  "tests/test_phase1_refactor.ts",
  "tests/test_phase2.ts",
  "tests/test_phase2_refactor.ts",
  "tests/test_phase3.ts",
  "tests/test_phase3_refactor.ts",
  "tests/test_phase4.ts",
  "tests/test_phase4_refactor.ts",
  "tests/test_phase5.ts",
  "tests/test_phase5_refactor.ts",
  "tests/test_phase6.ts",
  "tests/test_phase6_refactor.ts",
  "tests/test_phase7.ts",
  "tests/test_phase7_refactor.ts",
  "tests/test_phase8_refactor.ts",
  "tests/test_phase9_refactor.ts",
  "tests/test_final_acceptance.ts",
  "tests/test_opencode_gateway.ts",
];

async function runAll() {
  console.log("=================================================================");
  console.log("             RUNNING ALL JARVIS VERIFICATION SUITES              ");
  console.log("=================================================================\n");

  let totalFailed = 0;
  let opencodeTested = false;

  for (const suite of suites) {
    console.log(`\n>>> Executing ${suite}...`);
    try {
      const { stdout } = await execAsync(`node --experimental-strip-types ${suite}`);
      console.log(stdout.trim());
      if (suite.includes("opencode_gateway") && stdout.includes("OPENCODE INTEGRATION TESTS PASSED")) {
        opencodeTested = true;
      }
    } catch (err: any) {
      console.error(`FAILED: ${suite}`);
      console.error(err.stdout || err.stderr || err.message);
      totalFailed++;
    }
  }

  console.log("\n=================================================================");
  if (totalFailed === 0) {
    console.log("  UNIT TESTS PASSED");
    console.log("  MOCK ACCEPTANCE TESTS PASSED");
    if (opencodeTested) {
      console.log("  OPENCODE INTEGRATION TESTS PASSED: Live gateway verified.");
    } else {
      console.log("  OPENCODE INTEGRATION TESTS SKIPPED: daemon unavailable or not tested.");
    }
  } else {
    console.error(`  ${totalFailed} SUITE(S) FAILED.`);
    process.exit(1);
  }
  console.log("=================================================================\n");
}

runAll();
