/**
 * Phase 5 Verification Test Suite - Skills -> Actions -> Tools -> Functions Hierarchy
 */

import { Logger } from "../src/logger.ts";
import { SkillRegistry } from "../src/skills/registry.ts";
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

async function runPhase5RefactorTests() {
  console.log("\n=======================================================");
  console.log("       JARVIS PHASE 5 REFACTOR TEST SUITE              ");
  console.log("=======================================================\n");

  const logger = new Logger("Phase5Refactor", "error");
  const registry = new SkillRegistry(logger);

  // -----------------------------------------------------------------
  // 1. Skill Discovery & Hierarchy
  // -----------------------------------------------------------------
  console.log("▶ Group 1: Skills Architecture & Registration");
  const skills = registry.listSkills();

  assert(skills.length >= 6, `Registered ${skills.length} modular skills`);
  assert(skills.some((s) => s.id === "windows"), "Registered 'windows' skill");
  assert(skills.some((s) => s.id === "browser"), "Registered 'browser' skill");
  assert(skills.some((s) => s.id === "filesystem"), "Registered 'filesystem' skill");
  assert(skills.some((s) => s.id === "media"), "Registered 'media' skill");
  assert(skills.some((s) => s.id === "research"), "Registered 'research' skill");
  assert(skills.some((s) => s.id === "github"), "Registered 'github' skill");
  assert(skills.some((s) => s.id === "unreal"), "Registered 'unreal' skill");

  // Check action hierarchy in windows skill
  const winSkill = registry.getSkill("windows");
  assert(!!winSkill, "Retrieved 'windows' skill instance");
  assert(typeof winSkill?.actions.time?.execute === "function", "windows.time has executable function");
  assert(winSkill?.actions.time.permission === "SAFE", "windows.time has 'SAFE' permission tier");
  assert(winSkill?.actions.app_close?.permission === "CONFIRM", "windows.app_close has 'CONFIRM' permission tier");

  // -----------------------------------------------------------------
  // 2. Dynamic Tool Schema Generation
  // -----------------------------------------------------------------
  console.log("\n▶ Group 2: Dynamic Scoped Tool Schema Generation");

  // Scoped schemas for specific skills only
  const scopedSchemas = registry.getToolSchemas(["windows", "media"]);
  assert(scopedSchemas.length > 0, "Generated scoped tool schemas");
  assert(scopedSchemas.every((s) => s.function.name.startsWith("windows_") || s.function.name.startsWith("media_")), "Scoped schemas only contain windows and media actions");
  assert(!scopedSchemas.some((s) => s.function.name.startsWith("filesystem_")), "Excluded unrequested filesystem skill schemas");

  // Full tool schema generation
  const allSchemas = registry.getToolSchemas();
  assert(allSchemas.length > scopedSchemas.length, `Generated ${allSchemas.length} total tool schemas across all skills`);
  assert(allSchemas[0].type === "function", "Tool schema adheres to OpenAI function tool calling standard");

  // -----------------------------------------------------------------
  // 3. Action Execution through Registry
  // -----------------------------------------------------------------
  console.log("\n▶ Group 3: Action Execution through Skill Registry");

  const timeRes = await registry.executeAction("time");
  assert(timeRes.success === true && timeRes.message.includes("The current time is"), "Executed 'time' action via registry: " + timeRes.message);

  const calcRes = await registry.executeAction("calculator", { expression: "12 * 12 + 6" });
  assert(calcRes.success === true && calcRes.data?.result === 150, "Executed 'calculator' action via registry (expected 150): " + calcRes.message);

  const fsRes = await registry.executeAction("fs_read", { path: "package.json" });
  assert(fsRes.success === true && fsRes.data?.content.includes("jarvis"), "Executed 'fs_read' action via filesystem skill");

  const unknownRes = await registry.executeAction("non_existent_tool");
  assert(unknownRes.success === false, "Gracefully handles unknown skill actions");

  // -----------------------------------------------------------------
  // 4. End-to-End Integration via JarvisCore
  // -----------------------------------------------------------------
  console.log("\n▶ Group 4: End-to-End JarvisCore Execution with Skills");

  process.env.JARVIS_FAST_PROVIDER = "mock";
  const core = new JarvisCore();
  await core.initialize();

  // Test 1: Time inquiry routed to DIRECT and executed via windows skill
  let timeOutput = "";
  for await (const ev of core.processInput("What is the current time?")) {
    if (ev.type === "token") timeOutput += ev.text;
  }
  assert(timeOutput.includes("The current time is"), "Core executed time command via windows skill: " + timeOutput);

  // Test 2: Math inquiry routed to DIRECT and executed via windows skill
  let mathOutput = "";
  for await (const ev of core.processInput("calculate 50 * 4")) {
    if (ev.type === "token") mathOutput += ev.text;
  }
  assert(mathOutput.includes("200"), "Core executed calculate command via windows skill: " + mathOutput);

  // Cleanup
  core.db.close();
  delete process.env.JARVIS_FAST_PROVIDER;

  // -----------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------
  console.log("\n=======================================================");
  console.log(`Phase 5 Tests Total: ${totalTests} | Passed: ${passedTests} | Failed: ${failedTests}`);
  console.log("=======================================================\n");

  if (failedTests > 0) {
    process.exit(1);
  }
}

runPhase5RefactorTests().catch((err) => {
  console.error("Test runner threw uncaught error:", err);
  process.exit(1);
});
