/**
 * Test Suite: OpenCode Model & Agent Switching, Discovery & Prompt Schema (Requirements 1, 4, 5, 11, 12, 13, 14)
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { OpenCodeClient, OpenCodeError, modelSupportsVariant, validateModelProfileAgainstCatalog } from "../src/opencode_client.ts";
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

async function runModelAgentTests() {
  console.log("\n=======================================================");
  console.log("    OPENCODE MODEL & AGENT SWITCHING TEST SUITE        ");
  console.log("=======================================================\n");

  const testDir = path.join(process.cwd(), ".test_models");
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  fs.mkdirSync(testDir, { recursive: true });
  const logger = new Logger("TestModelAgent", "error");

  const testSession = "ses_switch_test_101";
  let activeSessionModel = { providerID: "opencode", id: "model-a", variant: "default" };
  let activeSessionAgent = "build";
  let lastPromptSessionModel: any = null;
  let lastReceivedPromptBody: any = null;

  const mockServerPort = 39810;
  let mockServer: http.Server | undefined;

  try {
    mockServer = http.createServer((req, res) => {
    // 1. /api/health or /api/info
    if ((req.url === "/api/health" || req.url === "/api/info") && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: "2.0.15", pid: 5555 }));
      return;
    }

    // 2. /api/model - catalog with string variants AND object variants (Requirement 5)
    if (req.url === "/api/model" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([
        {
          providerID: "opencode",
          id: "model-a",
          modelID: "model-a",
          name: "Model Alpha",
          variants: ["default", "fast"],
          capabilities: ["chat"],
        },
        {
          providerID: "opencode",
          id: "model-b",
          modelID: "model-b",
          name: "Model Beta",
          variants: ["default", "precise", "creative"],
          capabilities: ["chat", "tools"],
        },
        {
          providerID: "opencode",
          id: "model-c",
          modelID: "model-c",
          name: "Model Gamma (Object Variants)",
          variants: [
            { id: "high", settings: {} },
            { id: "low", settings: {} },
          ],
          capabilities: ["chat"],
        },
      ]));
      return;
    }

    // 3. /api/agent - catalog covering primary, all, subagent, hidden, disabled (Requirement 4)
    if (req.url === "/api/agent" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([
        { id: "build", name: "Build Agent", mode: "primary", hidden: false, disabled: false },
        { id: "plan", name: "Plan Agent (All)", mode: "all", hidden: false, disabled: false },
        { id: "subagent_only", name: "Subagent Only", mode: "subagent", hidden: false, disabled: false },
        { id: "hidden_primary", name: "Hidden Primary", mode: "primary", hidden: true, disabled: false },
        { id: "disabled_primary", name: "Disabled Primary", mode: "primary", hidden: false, disabled: true },
        { id: "hidden_all", name: "Hidden All", mode: "all", hidden: true, disabled: false },
        { id: "disabled_all", name: "Disabled All", mode: "all", hidden: false, disabled: true },
      ]));
      return;
    }

    // 4. GET /api/session/:id - session state inspection & verification (Requirement 14)
    if (req.url === `/api/session/${testSession}` && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        data: {
          id: testSession,
          model: activeSessionModel,
          agent: activeSessionAgent,
        },
      }));
      return;
    }

    // 5. POST /api/session/:id/model - strict payload validation
    if (req.url === `/api/session/${testSession}/model` && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          if (!parsed.model || !parsed.model.providerID || !parsed.model.id) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing required model payload fields" }));
            return;
          }

          if (parsed.model.id === "model-reject") {
            res.writeHead(422, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Model rejected by OpenCode upstream" }));
            return;
          }

          activeSessionModel = {
            providerID: parsed.model.providerID,
            id: parsed.model.id,
            variant: parsed.model.variant || "default",
          };
          res.writeHead(204);
          res.end();
        } catch {
          res.writeHead(400);
          res.end();
        }
      });
      return;
    }

    // 6. POST /api/session/:id/agent - strict payload validation
    if (req.url === `/api/session/${testSession}/agent` && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          if (!parsed.agent || typeof parsed.agent !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing or invalid 'agent' field" }));
            return;
          }

          if (parsed.agent === "subagent-only" || parsed.agent === "unknown") {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: `Agent ${parsed.agent} cannot be used as primary agent` }));
            return;
          }

          activeSessionAgent = parsed.agent;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, agent: parsed.agent }));
        } catch {
          res.writeHead(400);
          res.end();
        }
      });
      return;
    }

    // 7. POST /api/session/:id/prompt - strict payload schema verification (Requirement 1)
    if (req.url === `/api/session/${testSession}/prompt` && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          lastReceivedPromptBody = parsed;

          // Reject undocumented / forbidden top-level fields (Requirement 1)
          if (
            "text" in parsed ||
            "files" in parsed ||
            "agents" in parsed ||
            "skills" in parsed ||
            "metadata" in parsed
          ) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Forbidden top-level fields detected" }));
            return;
          }

          if (!parsed.prompt || typeof parsed.prompt.text !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing nested prompt.text" }));
            return;
          }

          lastPromptSessionModel = { ...activeSessionModel };

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, model: activeSessionModel, agent: activeSessionAgent }));
        } catch {
          res.writeHead(400);
          res.end();
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((r) => mockServer.listen(mockServerPort, "127.0.0.1", r));

  const serviceFile = path.join(testDir, "service.json");
  fs.writeFileSync(serviceFile, JSON.stringify({
    url: `http://127.0.0.1:${mockServerPort}`,
    pid: 5555,
    version: "2.0.15",
  }));

  const client = new OpenCodeClient({
    serviceFile,
    connectTimeoutMs: 1500,
    disableGlobalDiscovery: true,
  }, logger);

  // -------------------------------------------------------------
  // Test 1: Model Discovery & Variant Support (Requirement 5)
  // -------------------------------------------------------------
  console.log("▶ Group 1: Model Discovery & Variant Validation");
  const models = await client.listModels();
  assert(models.length === 3, `Discovered 3 models from OpenCode catalog (got ${models.length})`);
  assert(models[0].providerID === "opencode" && models[0].id === "model-a", "First model providerID/modelID parsed correctly");
  assert(Array.isArray(models[1].variants) && models[1].variants.includes("creative"), "String-style variants preserved");
  assert(Array.isArray(models[2].variants) && models[2].variants.some((v: any) => v.id === "high"), "Object-style variants preserved");

  // modelSupportsVariant helper tests (Requirement 5)
  assert(modelSupportsVariant(models[0], "fast") === true, "String variant 'fast' recognized as supported");
  assert(modelSupportsVariant(models[0], "unknown") === false, "String variant 'unknown' rejected");
  assert(modelSupportsVariant(models[2], "high") === true, "Object variant 'high' recognized as supported");
  assert(modelSupportsVariant(models[2], "low") === true, "Object variant 'low' recognized as supported");
  assert(modelSupportsVariant(models[2], "extreme") === false, "Object variant 'extreme' rejected");
  assert(modelSupportsVariant(models[0], undefined) === true, "Undefined variant defaults to supported");
  assert(modelSupportsVariant(models[0], "default") === true, "'default' variant recognized as supported");

  // -------------------------------------------------------------
  // Test 2: Agent Discovery & Primary Filter (Requirement 4)
  // -------------------------------------------------------------
  console.log("\n▶ Group 2: Agent Discovery with mode: 'all' Support");
  const primaryAgents = await client.listAgents({ primaryOnly: true });
  assert(primaryAgents.length === 2, `Filtered catalog to 2 usable primary agents (got ${primaryAgents.length})`);
  assert(primaryAgents.some(a => a.id === "build"), "Found 'build' agent with mode: 'primary'");
  assert(primaryAgents.some(a => a.id === "plan"), "Found 'plan' agent with mode: 'all'");
  assert(!primaryAgents.some(a => a.id === "subagent_only"), "Subagent-only agent excluded");
  assert(!primaryAgents.some(a => a.id === "hidden_primary"), "Hidden primary agent excluded");
  assert(!primaryAgents.some(a => a.id === "disabled_primary"), "Disabled primary agent excluded");
  assert(!primaryAgents.some(a => a.id === "hidden_all"), "Hidden 'all' agent excluded");
  assert(!primaryAgents.some(a => a.id === "disabled_all"), "Disabled 'all' agent excluded");

  // -------------------------------------------------------------
  // Test 3: Prompt Request Payload Schema (Requirement 1)
  // -------------------------------------------------------------
  console.log("\n▶ Group 3: Canonical Prompt Payload Schema");
  await client.promptSession(testSession, {
    text: "Test prompt execution",
    files: [{ path: "test.ts" }],
    agents: [{ id: "build" }],
    delivery: "steer",
    resume: true,
  });

  assert(lastReceivedPromptBody !== null, "Prompt request received by mock server");
  assert(lastReceivedPromptBody?.prompt?.text === "Test prompt execution", "prompt.text exists inside prompt object");
  assert(Array.isArray(lastReceivedPromptBody?.prompt?.files), "prompt.files is nested inside prompt object");
  assert(Array.isArray(lastReceivedPromptBody?.prompt?.agents), "prompt.agents is nested inside prompt object");
  assert(lastReceivedPromptBody?.delivery === "steer", "delivery is top-level");
  assert(lastReceivedPromptBody?.resume === true, "resume is top-level");
  assert(!("text" in lastReceivedPromptBody), "Forbidden top-level 'text' does NOT exist");
  assert(!("files" in lastReceivedPromptBody), "Forbidden top-level 'files' does NOT exist");
  assert(!("agents" in lastReceivedPromptBody), "Forbidden top-level 'agents' does NOT exist");
  assert(!("skills" in lastReceivedPromptBody), "Forbidden top-level 'skills' does NOT exist");
  assert(!("metadata" in lastReceivedPromptBody), "Forbidden top-level 'metadata' does NOT exist");

  // -------------------------------------------------------------
  // Test 4: Model Switching & Session State Verification (Requirement 14)
  // -------------------------------------------------------------
  console.log("\n▶ Group 4: Model Switching & Session State Verification");
  await client.switchSessionModel(testSession, { providerID: "opencode", id: "model-a", variant: "default" });
  assert(activeSessionModel.id === "model-a", "Switched session to model-a on server and verified session state");

  // Switch to Model B with variant
  await client.switchSessionModel(testSession, { providerID: "opencode", id: "model-b", variant: "creative" });
  assert(activeSessionModel.id === "model-b" && activeSessionModel.variant === "creative", "Switched session to model-b and verified session state");

  // Switch rejection
  let caughtError: OpenCodeError | null = null;
  try {
    await client.switchSessionModel(testSession, { providerID: "opencode", id: "model-reject" });
  } catch (err: any) {
    caughtError = err;
  }
  assert(caughtError !== null, "Model switch rejection threw an error");
  assert(caughtError instanceof OpenCodeError, "Error is an instance of OpenCodeError");
  assert(caughtError?.status === 422, "Error captures HTTP 422 status");

  // -------------------------------------------------------------
  // Test 5: Agent Switching Lifecycle (Requirement 11 & 14)
  // -------------------------------------------------------------
  console.log("\n▶ Group 5: Agent Switching Lifecycle");
  await client.switchSessionAgent(testSession, "plan");
  assert(activeSessionAgent === "plan", "Switched session to 'plan' agent and verified state");

  await client.switchSessionAgent(testSession, "build");
  assert(activeSessionAgent === "build", "Switched session back to 'build' agent and verified state");

  // Subagent-only switch rejection
  let agentError: OpenCodeError | null = null;
  try {
    await client.switchSessionAgent(testSession, "subagent-only");
  } catch (err: any) {
    agentError = err;
  }
  assert(agentError !== null && agentError.status === 404, "Subagent-only agent switch rejected with 404 OpenCodeError");

  // -------------------------------------------------------------
  // Test 6: Strict Runtime Model Validation (Requirement 13)
  // -------------------------------------------------------------
  console.log("\n▶ Group 6: Strict Runtime Model Validation");
  const validFast = await validateModelProfileAgainstCatalog(
    client,
    { providerID: "opencode", modelID: "model-a", variant: "fast" },
    "FAST"
  );
  assert(validFast.ok === true, "Valid configured model profile passed validation");

  const invalidModel = await validateModelProfileAgainstCatalog(
    client,
    { providerID: "opencode", modelID: "nonexistent", variant: "default" },
    "FAST"
  );
  assert(invalidModel.ok === false && (invalidModel.error?.includes("not available") || invalidModel.error?.includes("not found") || invalidModel.error?.includes("does not exist")), "Missing model cleanly rejected by validation helper");

  const invalidVariant = await validateModelProfileAgainstCatalog(
    client,
    { providerID: "opencode", modelID: "model-a", variant: "unsupported_var" },
    "FAST"
  );
  assert(invalidVariant.ok === false && invalidVariant.error?.includes("Variant"), "Unsupported variant cleanly rejected by validation helper");

  } finally {
    if (mockServer) {
      await new Promise<void>((r) => mockServer!.close(() => r()));
    }
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }

  console.log("\n=======================================================");
  console.log(`Model & Agent Tests Total: ${totalTests} | Passed: ${passedTests} | Failed: ${failedTests}`);
  console.log("=======================================================\n");

  if (failedTests > 0) process.exit(1);
}

runModelAgentTests().catch((err) => {
  console.error("Model/Agent test suite threw uncaught error:", err);
  process.exit(1);
});
