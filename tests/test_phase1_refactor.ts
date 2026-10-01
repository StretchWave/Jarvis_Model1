/**
 * Phase 1 Verification Test Suite - Real Configurable Cloud Model & Secret Resolution
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { getDefaultConfig, loadConfig } from "../src/config.ts";
import { OpenAICompatibleProvider, MockFastProvider, UnconfiguredFastProvider } from "../src/models/provider.ts";
import { JarvisCore } from "../src/core.ts";
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

async function runPhase1RefactorTests() {
  console.log("\n=======================================================");
  console.log("       JARVIS PHASE 1 REFACTOR TEST SUITE              ");
  console.log("=======================================================\n");

  const testDir = path.join(process.cwd(), ".test_p1_refactor");
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  fs.mkdirSync(testDir, { recursive: true });

  const logger = new Logger("Phase1Refactor", "error");

  const origEnvMock = process.env.JARVIS_FAST_PROVIDER;
  const origKey = process.env.FAST_MODEL_API_KEY;
  let mockServer: http.Server | null = null;
  let errorServer: http.Server | null = null;
  let coreUnconfigured: JarvisCore | null = null;
  let coreMock: JarvisCore | null = null;

  try {
    // -----------------------------------------------------------------
    // 1. Production Default Configuration Audit
    // -----------------------------------------------------------------
    console.log("▶ Group 1: Production Default Configuration Audit");
    delete process.env.JARVIS_FAST_PROVIDER;

  const cfg = getDefaultConfig();
  assert(cfg.fastModel.provider === "openai-compatible", "Production default provider is 'openai-compatible' (NOT 'mock')");
  assert(cfg.fastModel.apiKeyEnv === "FAST_MODEL_API_KEY", "Default apiKeyEnv is 'FAST_MODEL_API_KEY'");
  assert(typeof cfg.fastModel.baseURL === "string" && cfg.fastModel.baseURL.startsWith("http"), "Default baseURL points to valid HTTP endpoint");

  // -----------------------------------------------------------------
  // 2. Unconfigured Provider Rejection (No Canned Fallbacks)
  // -----------------------------------------------------------------
  console.log("\n▶ Group 2: Explicit Error on Unconfigured Provider");
  // Ensure env key is absent
  delete process.env.FAST_MODEL_API_KEY;
  delete process.env.OPENAI_API_KEY;

  const unconfiguredProvider = new OpenAICompatibleProvider(
    {
      model: "gpt-4o-mini",
      baseURL: "https://api.openai.com/v1",
      apiKeyEnv: "FAST_MODEL_API_KEY",
    },
    logger
  );

  assert(!(await unconfiguredProvider.health()), "Health check correctly returns false when key is missing");

  let errorReported = false;
  let errorMsg = "";
  for await (const ev of unconfiguredProvider.chat({
    messages: [{ role: "user", content: "Hey Jarvis, what are you doing?" }],
  })) {
    if (ev.type === "error") {
      errorReported = true;
      errorMsg = ev.error || "";
    }
  }

  assert(errorReported, "Chat yields explicit error when API key is missing");
  assert(errorMsg.includes("FAST model is not configured"), `Error message is clear and transparent: "${errorMsg}"`);

  // Verify JarvisCore with default unconfigured config reports error rather than mock text
  const unconfiguredConfigFile = path.join(testDir, "unconfigured_jarvis.json");
  fs.writeFileSync(
    unconfiguredConfigFile,
    JSON.stringify({
      dataDir: testDir,
      databasePath: path.join(testDir, "test.db"),
      fastModel: {
        provider: "openai-compatible",
        model: "gpt-4o-mini",
        apiKeyEnv: "NON_EXISTENT_KEY_ENV",
      },
    })
  );

  coreUnconfigured = new JarvisCore(unconfiguredConfigFile);
  const events: any[] = [];
  for await (const ev of coreUnconfigured.processInput("Hey Jarvis, what are you doing?")) {
    events.push(ev);
  }
  const errorEvent = events.find((e) => e.type === "error");
  assert(errorEvent !== undefined, "JarvisCore emits error event on unconfigured model without silent mock fallback");
  coreUnconfigured.shutdown();

  // -----------------------------------------------------------------
  // 3. Explicit Development/Test Mode Selection
  // -----------------------------------------------------------------
  console.log("\n▶ Group 3: Explicit Dev/Test Mock Mode");
  const mockConfigFile = path.join(testDir, "mock_jarvis.json");
  fs.writeFileSync(
    mockConfigFile,
    JSON.stringify({
      dataDir: testDir,
      databasePath: path.join(testDir, "test_mock.db"),
      fastModel: {
        provider: "mock",
        model: "mock-fast",
      },
    })
  );

  coreMock = new JarvisCore(mockConfigFile);
  assert((coreMock.fastModel as any).isDevMock === true, "MockFastProvider is only created when explicitly configured as 'mock'");
  coreMock.shutdown();

  // -----------------------------------------------------------------
  // 4. Dynamic Environment Variable Secret Resolution
  // -----------------------------------------------------------------
  console.log("\n▶ Group 4: Dynamic Secret Resolution via apiKeyEnv");
  process.env.TEST_CUSTOM_API_KEY = "sk-test-live-key-99999";
  const dynamicProvider = new OpenAICompatibleProvider(
    {
      model: "test-model",
      baseURL: "https://api.openai.com/v1",
      apiKeyEnv: "TEST_CUSTOM_API_KEY",
    },
    logger
  );

  const resolvedKey = (dynamicProvider as any).resolveApiKey();
  assert(resolvedKey === "sk-test-live-key-99999", "Successfully resolved key dynamically from process.env via apiKeyEnv");
  delete process.env.TEST_CUSTOM_API_KEY;

  // -----------------------------------------------------------------
  // 5. OpenAI-Compatible HTTP Streaming Verification
  // -----------------------------------------------------------------
  console.log("\n▶ Group 5: Real OpenAI-Compatible Server & Streaming");
  const mockServerPort = 39281;
  let receivedAuthHeader = "";
  let receivedModelName = "";

  mockServer = http.createServer((req, res) => {
    receivedAuthHeader = req.headers["authorization"] || "";

    if (req.url === "/v1/chat/completions" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const parsed = JSON.parse(body);
        receivedModelName = parsed.model;

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });

        // Stream real SSE tokens
        const tokens = ["Good ", "day, ", "Sir. ", "All ", "systems ", "optimal."];
        for (const token of tokens) {
          const sseData = JSON.stringify({
            choices: [{ delta: { content: token } }],
          });
          res.write(`data: ${sseData}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => mockServer.listen(mockServerPort, "127.0.0.1", resolve));

  const realCompatibleProvider = new OpenAICompatibleProvider(
    {
      model: "mistral-7b-instruct",
      baseURL: `http://127.0.0.1:${mockServerPort}/v1`,
      apiKey: "sk-mock-auth-token-1234",
    },
    logger
  );

  const streamTokens: string[] = [];
  let streamFullText = "";

  for await (const ev of realCompatibleProvider.chat({
    messages: [{ role: "user", content: "Status report" }],
  })) {
    if (ev.type === "token" && ev.text) streamTokens.push(ev.text);
    if (ev.type === "done" && ev.fullText) streamFullText = ev.fullText;
  }

  assert(receivedAuthHeader === "Bearer sk-mock-auth-token-1234", "Correct Bearer Authorization header was sent to cloud endpoint");
  assert(receivedModelName === "mistral-7b-instruct", "Correct model identifier was requested in JSON payload");
  assert(streamTokens.length === 6, `Successfully streamed 6 real SSE tokens from cloud provider`);
  assert(streamFullText === "Good day, Sir. All systems optimal.", `Full text assembled correctly: "${streamFullText}"`);

  // -----------------------------------------------------------------
  // 6. Cloud Provider Error Handling (HTTP 401 / 429)
  // -----------------------------------------------------------------
  console.log("\n▶ Group 6: Cloud Provider HTTP Error Handling");
  const errorServerPort = 39282;
  errorServer = http.createServer((req, res) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Invalid API key provided" } }));
  });
  await new Promise<void>((resolve) => errorServer.listen(errorServerPort, "127.0.0.1", resolve));

  const failingProvider = new OpenAICompatibleProvider(
    {
      model: "gpt-4o",
      baseURL: `http://127.0.0.1:${errorServerPort}/v1`,
      apiKey: "sk-bad-key",
    },
    logger
  );

  let capturedError = "";
  for await (const ev of failingProvider.chat({
    messages: [{ role: "user", content: "Hello" }],
  })) {
    if (ev.type === "error") capturedError = ev.error || "";
  }

  assert(capturedError.includes("401") && capturedError.includes("Invalid API key"), "Handles HTTP 401 gracefully and yields structured error event");

  } finally {
    if (coreUnconfigured) {
      try { coreUnconfigured.shutdown(); } catch {}
    }
    if (coreMock) {
      try { coreMock.shutdown(); } catch {}
    }
    if (mockServer) {
      try { mockServer.close(); } catch {}
    }
    if (errorServer) {
      try { errorServer.close(); } catch {}
    }
    if (origEnvMock) process.env.JARVIS_FAST_PROVIDER = origEnvMock;
    if (origKey) process.env.FAST_MODEL_API_KEY = origKey;

    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }

  console.log("\n=======================================================");
  console.log(`  TOTAL: ${totalTests}  |  PASSED: ${passedTests}  |  FAILED: ${failedTests}`);
  console.log("=======================================================\n");

  if (failedTests > 0) process.exit(1);
}

runPhase1RefactorTests().catch((err) => {
  console.error("Phase 1 refactor test failed:", err);
  process.exit(1);
});
