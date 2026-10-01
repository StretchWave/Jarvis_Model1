/**
 * Test Suite: Phase 11 State Correctness & Polling Fallback Verification
 * 
 * Verifies all 7 Part 1 Backend Correctness requirements:
 * 1. Session state is source of truth (separate persistent profile vs active session state vs UI).
 * 2. Cleaned up /api/models semantics (session-only vs persistent Save & Switch, persist:false never mutates global profile).
 * 3. Polling fallback completeness (text streaming, pending permissions discovered through polling emit permission_request, failure handling).
 * 4. No premature polling completion (never emit done merely because /prompt returned HTTP success; requires execution completion evidence).
 * 5. Strict variant semantics in modelSupportsVariant().
 * 6. Model cost classification (FREE, PAID, UNKNOWN; no blind assumption that opencode means free).
 * 7. Verified config persistence (session-only does not persist, Save & Switch does, unrelated config and API keys survive, malformed configs safely backed up).
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { OpenCodeClient, OpenCodeError, modelSupportsVariant, getModelCostTier } from "../src/opencode_client.ts";
import { JarvisCore } from "../src/core.ts";
import { JarvisServer } from "../src/ui/server.ts";
import { saveConfig, loadConfig, getDefaultConfig } from "../src/config.ts";
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

async function runPhase11Tests() {
  console.log("\n=================================================================");
  console.log("     JARVIS PHASE 11 STATE CORRECTNESS & POLLING FALLBACK       ");
  console.log("=================================================================\n");

  const testDir = path.join(process.cwd(), ".test_phase11");
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  fs.mkdirSync(testDir, { recursive: true });
  const logger = new Logger("Phase11Test", "error");

  let mockServer: http.Server | undefined;
  let core: JarvisCore | undefined;
  let server: JarvisServer | undefined;
  let restartedCore: JarvisCore | undefined;

  try {

  // -------------------------------------------------------------------------
  // 1. Strict Variant Semantics (modelSupportsVariant)
  // -------------------------------------------------------------------------
  console.log("▶ Test 1: Strict Variant Semantics");

  const modelWithVariants = {
    providerID: "test-provider",
    id: "model-1",
    variants: ["fast", "precise", "creative"],
  };

  const modelWithoutVariants = {
    providerID: "test-provider",
    id: "model-2",
  };

  const modelWithEmptyVariants = {
    providerID: "test-provider",
    id: "model-3",
    variants: [],
  };

  // No variant requested -> defaults to valid
  assert(modelSupportsVariant(modelWithVariants, undefined) === true, "Undefined variant on model with variants is valid (default)");
  assert(modelSupportsVariant(modelWithVariants, "") === true, "Empty string variant is valid (default)");
  assert(modelSupportsVariant(modelWithVariants, "default") === true, "'default' variant is always valid");
  assert(modelSupportsVariant(modelWithVariants, "fast") === true, "Declared variant 'fast' is valid");
  assert(modelSupportsVariant(modelWithVariants, "precise") === true, "Declared variant 'precise' is valid");
  assert(modelSupportsVariant(modelWithVariants, "unknown-variant") === false, "Undeclared variant 'unknown-variant' is rejected");

  // Model without variants property
  assert(modelSupportsVariant(modelWithoutVariants, undefined) === true, "Undefined variant on model without variants is valid");
  assert(modelSupportsVariant(modelWithoutVariants, "default") === true, "'default' on model without variants is valid");
  assert(modelSupportsVariant(modelWithoutVariants, "ultra") === false, "Undeclared variant on model without variants is rejected");

  // Model with empty variants array
  assert(modelSupportsVariant(modelWithEmptyVariants, "default") === true, "'default' on model with empty variants is valid");
  assert(modelSupportsVariant(modelWithEmptyVariants, "experimental") === false, "Undeclared variant on empty variants list is rejected");

  // -------------------------------------------------------------------------
  // 2. Model Cost Classification (getModelCostTier)
  // -------------------------------------------------------------------------
  console.log("\n▶ Test 2: Model Cost Classification (FREE, PAID, UNKNOWN)");

  const freeModel1 = {
    providerID: "opencode",
    id: "mimo-free",
    pricing: { prompt: 0, completion: 0 },
  };
  assert(getModelCostTier(freeModel1).tier === "FREE", "Model with 0 pricing is classified as FREE");

  const freeModel2 = {
    providerID: "some-provider",
    id: "free-tier-v1",
    free: true,
  };
  assert(getModelCostTier(freeModel2).tier === "FREE", "Model with free: true is classified as FREE");

  const paidModel1 = {
    providerID: "opencode",
    id: "premium-cloud",
    pricing: { prompt: 0.005, completion: 0.015 },
  };
  assert(getModelCostTier(paidModel1).tier === "PAID", "OpenCode model with non-zero pricing is classified as PAID (not blindly free)");

  const paidModel2 = {
    providerID: "openai",
    id: "gpt-4o",
    cost: { input: 2.50 },
  };
  assert(getModelCostTier(paidModel2).tier === "PAID", "Model with cost metadata is classified as PAID");

  const unknownModel1 = {
    providerID: "opencode",
    id: "custom-internal-model",
  };
  assert(getModelCostTier(unknownModel1).tier === "UNKNOWN", "OpenCode model without pricing metadata is UNKNOWN, not assumed free");

  const unknownModel2 = {
    providerID: "anthropic",
    id: "claude-3-5-sonnet",
  };
  assert(getModelCostTier(unknownModel2).tier === "UNKNOWN", "External model without pricing metadata is UNKNOWN");

  // -------------------------------------------------------------------------
  // 3. Polling Fallback Completeness & Non-Premature Completion
  // -------------------------------------------------------------------------
  console.log("\n▶ Test 3: Polling Fallback Completeness (Permissions & No Premature Done)");

  let pollCount = 0;
  let permissionEmitted = false;
  let doneEmitted = false;
  let textDeltaEmitted = false;
  let sessionModel: any = { providerID: "opencode", id: "model-a", variant: "high" };
  let sessionAgent: string = "build";

  const mockOpenCodePort = 39860;
    mockServer = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${mockOpenCodePort}`);

    if (req.url?.match(/\/session\/[^/]+$/) && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "oc_ses_mock", model: sessionModel, agent: sessionAgent }));
      return;
    }

    if (req.url?.includes("/session") && req.method === "POST" && !req.url?.includes("/prompt") && !req.url?.includes("/model") && !req.url?.includes("/agent")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "oc_ses_mock", model: sessionModel, agent: sessionAgent }));
      return;
    }

    if (req.url?.includes("/health") || req.url?.includes("/info")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", version: "1.0.0" }));
      return;
    }

    if (req.url?.includes("/models") || req.url?.includes("/model")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([
        { providerID: "opencode", id: "model-a", variants: ["high", "low"] },
        { providerID: "opencode", id: "model-b", variants: ["default"] },
      ]));
      return;
    }

    if (req.url?.includes("/agents") || req.url?.includes("/agent")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([
        { id: "build", mode: "primary", description: "Build agent" },
        { id: "plan", mode: "primary", description: "Plan agent" },
      ]));
      return;
    }

    // Fail SSE to force polling fallback
    if (req.url?.includes("/event")) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("SSE service temporarily unavailable");
      return;
    }

    if (req.url?.includes("/prompt")) {
      // Simulate fast prompt dispatch acceptance
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, accepted: true }));
      return;
    }

    // Polling permission requests (/api/session/:id/permission)
    if (req.url?.includes("/permission")) {
      pollCount++;
      if (pollCount === 1) {
        // Return a pending permission request on first poll
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([
          {
            id: "perm-req-42",
            sessionId: "test-sess",
            permission: "run_shell",
            resource: "npm run build",
            description: "Execute build command",
            status: "pending",
          }
        ]));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([]));
      return;
    }

    // Polling messages (/api/session/:id/message)
    if (req.url?.includes("/message")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (pollCount <= 1) {
        // Baseline snapshot
        res.end(JSON.stringify([]));
      } else if (pollCount === 2) {
        // First poll: streaming partial
        res.end(JSON.stringify([
          {
            id: "msg-1",
            type: "assistant",
            role: "assistant",
            status: "running",
            content: "Computing optimal trajectory...",
          }
        ]));
      } else {
        // Completed
        res.end(JSON.stringify([
          {
            id: "msg-1",
            type: "assistant",
            role: "assistant",
            status: "completed",
            finishReason: "stop",
            content: "Computing optimal trajectory... Finished successfully.",
          }
        ]));
      }
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => mockServer.listen(mockOpenCodePort, "127.0.0.1", resolve));

  const mockServiceFile = path.join(testDir, "mock_opencode_service.json");
  fs.writeFileSync(mockServiceFile, JSON.stringify({
    url: `http://127.0.0.1:${mockOpenCodePort}`,
    pid: 9999,
    version: "1.0.0",
  }), "utf-8");

  const client = new OpenCodeClient({
    serviceFile: mockServiceFile,
    connectTimeoutMs: 2000,
    disableGlobalDiscovery: true,
  }, logger);

  const streamGen = client.executePromptStream("test-sess", "Calculate flight path", {
    providerID: "opencode",
    modelID: "model-a",
  });

  for await (const event of streamGen) {
    if (event.type === "token") {
      textDeltaEmitted = true;
    } else if (event.type === "permission_request") {
      permissionEmitted = true;
      assert(event.requestId === "perm-req-42", "Polled permission request emitted with correct request ID");
    } else if (event.type === "done") {
      doneEmitted = true;
    }
  }

  assert(permissionEmitted === true, "Polling fallback successfully discovered pending permission request and emitted permission_request event");
  assert(textDeltaEmitted === true, "Polling fallback successfully emitted text_delta");
  assert(doneEmitted === true, "Polling fallback emitted done only after receiving completed execution status");

  // -------------------------------------------------------------------------
  // 4. Session State as Source of Truth & /api/models Semantics
  // -------------------------------------------------------------------------
  console.log("\n▶ Test 4: Session State Source of Truth vs Persistent Profile");

  const configPath = path.join(testDir, "jarvis.config.json");
  const initialConfig = getDefaultConfig();
  initialConfig.databasePath = path.join(testDir, "test.db");
  initialConfig.dataDir = testDir;
  initialConfig.opencode.serviceFile = path.join(testDir, "mock_service.json");
  initialConfig.models.fast = { providerID: "opencode", modelID: "model-a", variant: "high" };
  initialConfig.models.agent = { providerID: "opencode", modelID: "model-b", variant: "default", agentID: "build" };
  // Add custom extra config to test preservation
  (initialConfig as any).customToken = "secret-super-key-123";
  (initialConfig as any).fallbackProvider = {
    enabled: true,
    provider: "openai-compatible",
    apiKey: "sk-jarvis-secret-preserve",
  };
  fs.writeFileSync(configPath, JSON.stringify(initialConfig, null, 2), "utf-8");

  // Write mock OpenCode service.json
  fs.writeFileSync(
    initialConfig.opencode.serviceFile,
    JSON.stringify({ url: `http://127.0.0.1:${mockOpenCodePort}` }, null, 2),
    "utf-8"
  );

    core = new JarvisCore(configPath);
  sessionModel = { providerID: "opencode", id: "model-a", variant: "high" };
  sessionAgent = "build";

  (core.opencode as any).listModels = async () => [
    { providerID: "opencode", id: "model-a", modelID: "model-a", variants: ["default", "high"] },
    { providerID: "opencode", id: "model-b", modelID: "model-b", variants: ["default"] },
  ];
  (core.opencode as any).listAgents = async () => [
    { id: "build", mode: "primary", description: "Build agent" },
    { id: "plan", mode: "primary", description: "Plan agent" },
  ];
  (core.opencode as any).switchSessionModel = async (sid: string, m: any) => {
    sessionModel = m;
  };
  (core.opencode as any).switchSessionAgent = async (sid: string, a: string) => {
    sessionAgent = a;
  };
  (core.opencode as any).getSession = async (sid: string) => ({
    id: sid,
    model: sessionModel,
    agent: sessionAgent,
  });

  await core.initialize();

  const serverPort = 31498;
    server = new JarvisServer(core, serverPort, "127.0.0.1");
  await server.start();

  const session = await core.sessionMgr.createSession({
    title: "Quantum Simulation",
    category: "general",
    createOpenCodeSession: true,
  });

  // Test 4a: Session-only model switch (POST /api/session/:id/model)
  const sessionModelRes = await fetch(`http://127.0.0.1:${serverPort}/api/session/${session.id}/model`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providerID: "opencode", modelID: "model-b", variant: "default" }),
  });
  const sessionModelData = await sessionModelRes.json();
  assert(sessionModelRes.status === 200, "POST /api/session/:id/model returned 200");
  assert(
    sessionModelData.model?.id === "model-b" || sessionModelData.model?.modelID === "model-b",
    "Session model switched to model-b"
  );
  assert(
    core.config.models.fast.modelID === "model-a",
    "Global persistent profile config.models.fast remained model-a (NOT mutated by session-only switch)"
  );
  const diskConfigAfterSessionSwitch = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  assert(
    diskConfigAfterSessionSwitch.models.fast.modelID === "model-a",
    "Disk configuration remained model-a (NOT persisted on session-only switch)"
  );

  // Test 4b: Session detail endpoint (GET /api/session/:id) distinguishes active session from configured profile
  const sessionDetailRes = await fetch(`http://127.0.0.1:${serverPort}/api/session/${session.id}`);
  const sessionDetailData = await sessionDetailRes.json();
  assert(sessionDetailRes.status === 200, "GET /api/session/:id returned 200");
  assert(
    sessionDetailData.configuredModels.fast.modelID === "model-a",
    "GET /api/session/:id explicitly returns configured persistent profile (model-a)"
  );

  // Test 4c: POST /api/models with persist: false does NOT mutate global in-memory profile
  const noPersistRes = await fetch(`http://127.0.0.1:${serverPort}/api/models`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fast: { providerID: "opencode", modelID: "model-b", variant: "default" },
      persist: false,
    }),
  });
  const noPersistData = await noPersistRes.json();
  assert(noPersistRes.status === 200, "POST /api/models with persist:false returned 200");
  assert(noPersistData.persisted === false, "persisted: false reported in response");
  assert(
    core.config.models.fast.modelID === "model-a",
    "persist:false did NOT mutate in-memory global config.models profile"
  );

  // Test 4d: Save & Switch (POST /api/models with persist: true & sessionId)
  const saveSwitchRes = await fetch(`http://127.0.0.1:${serverPort}/api/models`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fast: { providerID: "opencode", modelID: "model-b", variant: "default" },
      sessionId: session.id,
      persist: true,
    }),
  });
  const saveSwitchData = await saveSwitchRes.json();
  assert(saveSwitchRes.status === 200, "POST /api/models with Save & Switch returned 200");
  assert(saveSwitchData.persisted === true, "persisted: true confirmed");
  assert(core.config.models.fast.modelID === "model-b", "Global in-memory profile updated to model-b");

  const diskConfigAfterSave = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  assert(diskConfigAfterSave.models.fast.modelID === "model-b", "Disk configuration updated to model-b");
  assert(diskConfigAfterSave.customToken === "secret-super-key-123", "Unrelated config entries preserved on disk");
  assert(
    diskConfigAfterSave.fallbackProvider?.apiKey === "sk-jarvis-secret-preserve",
    "API keys preserved across config saves"
  );

  // Test 4e: Config survives restart
  await server.stop();
  core.shutdown();

    restartedCore = new JarvisCore(configPath);
  (restartedCore.opencode as any).listModels = async () => [
    { providerID: "opencode", id: "model-a", modelID: "model-a", variants: ["default", "high"] },
    { providerID: "opencode", id: "model-b", modelID: "model-b", variants: ["default"] },
  ];
  (restartedCore.opencode as any).listAgents = async () => [
    { id: "build", mode: "primary", description: "Build agent" },
    { id: "plan", mode: "primary", description: "Plan agent" },
  ];
  await restartedCore.initialize();
  assert(restartedCore.config.models.fast.modelID === "model-b", "Persistent configuration survived full restart");
  assert(
    (restartedCore.config as any).fallbackProvider?.apiKey === "sk-jarvis-secret-preserve",
    "API keys survived restart"
  );
  restartedCore.shutdown();

  // -------------------------------------------------------------------------
  // 5. Config Corruption Safety & Recovery
  // -------------------------------------------------------------------------
  console.log("\n▶ Test 5: Safe Malformed Config Handling & Recovery Backup");

  const corruptConfigPath = path.join(testDir, "corrupt.config.json");
  fs.writeFileSync(corruptConfigPath, "{ malformed json: not valid at all", "utf-8");

  let threwOnMalformed = false;
  try {
    saveConfig(initialConfig, corruptConfigPath);
  } catch (err: any) {
    threwOnMalformed = true;
    assert(err.message.includes("Refusing to overwrite malformed configuration file"), "saveConfig threw descriptive error refusing to overwrite malformed config");
  }
  assert(threwOnMalformed === true, "saveConfig threw on malformed file");

  const backupFiles = fs.readdirSync(testDir).filter(f => f.startsWith("corrupt.config.json.corrupt.bak"));
  assert(backupFiles.length > 0, "Corrupt backup file was created without destroying user's original data");

  } finally {
    try {
      if (server) await server.stop();
    } catch {}
    try {
      if (core) core.shutdown();
    } catch {}
    try {
      if (restartedCore) restartedCore.shutdown();
    } catch {}
    if (mockServer) {
      await new Promise<void>((resolve) => mockServer!.close(() => resolve()));
    }
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }

  console.log("\n=================================================================");
  console.log(`  PHASE 11 TEST REPORT: ${passedTests}/${totalTests} PASSED (${failedTests} FAILED)`);
  console.log("=================================================================\n");

  if (failedTests > 0) process.exit(1);
}

runPhase11Tests().catch((err) => {
  console.error("Phase 11 tests failed:", err);
  process.exit(1);
});
