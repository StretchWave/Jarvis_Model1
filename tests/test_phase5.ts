/**
 * Phase 5 Verification Test Suite - FAST Model Provider Abstraction
 */

import { MockFastProvider, OpenAICompatibleProvider, OpenCodeProvider } from "../src/models/provider.ts";
import { getDefaultConfig } from "../src/config.ts";
import { OpenCodeClient } from "../src/opencode_client.ts";
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

async function runPhase5() {
  console.log("\n=======================================================");
  console.log("             JARVIS PHASE 5 TEST SUITE                 ");
  console.log("=======================================================\n");

  const logger = new Logger("Phase5Test", "error");

  // 1. Mock Fast Provider
  console.log("▶ Step 1: Mock Fast Model Provider");
  const mockFast = new MockFastProvider();
  assert(await mockFast.health(), "Mock Fast Provider health check reports OK");

  // Conversational response
  const tokens: string[] = [];
  let fullAnswer = "";
  for await (const ev of mockFast.chat({
    messages: [{ role: "user", content: "Hey Jarvis, what are you doing?" }],
  })) {
    if (ev.type === "token" && ev.text) tokens.push(ev.text);
    if (ev.type === "done" && ev.fullText) fullAnswer = ev.fullText;
  }

  assert(tokens.length > 0, `Streams conversational tokens (count: ${tokens.length})`);
  assert(fullAnswer.includes("Sir") && fullAnswer.includes("standing by"), `Response adheres to Jarvis persona: "${fullAnswer}"`);

  // Explanation response
  let tcpUdpReply = "";
  for await (const ev of mockFast.chat({
    messages: [{ role: "user", content: "What's the difference between TCP and UDP?" }],
  })) {
    if (ev.type === "done" && ev.fullText) tcpUdpReply = ev.fullText;
  }
  assert(tcpUdpReply.includes("TCP") && tcpUdpReply.includes("UDP") && tcpUdpReply.includes("Sir"), "Delivers concise explanation with Jarvis tone");

  // 2. OpenCode Provider Abstraction
  console.log("\n▶ Step 2: OpenCode Provider Interface");
  const cfg = getDefaultConfig();
  const ocClient = new OpenCodeClient(cfg.opencode.serviceFile, logger);
  const ocProvider = new OpenCodeProvider(ocClient, logger);
  const ocHealth = await ocProvider.health();
  assert(ocHealth, "OpenCodeProvider wraps local daemon and satisfies ModelProvider.health()");

  console.log("\n=======================================================");
  console.log(`  TOTAL: ${totalTests}  |  PASSED: ${passedTests}  |  FAILED: ${failedTests}`);
  console.log("=======================================================\n");

  if (failedTests > 0) process.exit(1);
  process.exit(0);
}

runPhase5().catch((err) => {
  console.error("Phase 5 test failed:", err);
  process.exit(1);
});
