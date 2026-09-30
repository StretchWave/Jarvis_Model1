/**
 * Test Suite: OpenCode Model & Agent Switching and Discovery (Requirements 25 & 26)
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { OpenCodeClient, OpenCodeError } from "../src/opencode_client.ts";
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

  const testDir = path.join(process.cwd(), `.test_models_${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  const logger = new Logger("TestModelAgent", "error");

  const testSession = "ses_switch_test_101";
  let activeSessionModel = { providerID: "opencode", id: "model-a", variant: "default" };
  let activeSessionAgent = "build";
  let lastPromptSessionModel: any = null;

  const mockServerPort = 39810;
  const mockServer = http.createServer((req, res) => {
    // 1. /api/info
    if (req.url === "/api/info" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: "2.0.15", pid: 5555 }));
      return;
    }

    // 2. /api/model - catalog
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
      ]));
      return;
    }

    // 3. /api/agent - catalog
    if (req.url === "/api/agent" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([
        { id: "build", name: "Build Agent", mode: "primary", hidden: false, disabled: false },
        { id: "plan", name: "Plan Agent", mode: "primary", hidden: false, disabled: false },
        { id: "general", name: "General Subagent", mode: "subagent", hidden: false, disabled: false },
        { id: "hidden_agent", name: "Internal", mode: "primary", hidden: true, disabled: false },
        { id: "disabled_agent", name: "Disabled", mode: "primary", hidden: false, disabled: true },
      ]));
      return;
    }

    // 4. POST /api/session/:id/model - strict payload validation
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

    // 5. POST /api/session/:id/agent - strict payload validation
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

    // 6. POST /api/session/:id/prompt - canonical prompt protocol
    if (req.url === `/api/session/${testSession}/prompt` && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          if (!parsed.prompt || typeof parsed.prompt.text !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Protocol violation: missing prompt.text" }));
            return;
          }

          // Record what model the server actively has for this session during this prompt
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
  // Test 1: Model Discovery & Normalization
  // -------------------------------------------------------------
  console.log("▶ Group 1: Model Discovery & Canonical Representation");
  const models = await client.listModels();
  assert(models.length === 2, `Discovered 2 models from OpenCode catalog (got ${models.length})`);
  assert(models[0].providerID === "opencode" && models[0].id === "model-a", "First model providerID/modelID parsed correctly");
  assert(Array.isArray(models[1].variants) && models[1].variants.includes("creative"), "Model variants parsed and preserved");

  // -------------------------------------------------------------
  // Test 2: Agent Discovery & Primary Filter
  // -------------------------------------------------------------
  console.log("\n▶ Group 2: Agent Discovery & Usable Primary Filtering");
  const primaryAgents = await client.listAgents({ primaryOnly: true });
  assert(primaryAgents.length === 2, `Filtered catalog to 2 usable primary agents (got ${primaryAgents.length})`);
  assert(primaryAgents.some(a => a.id === "build"), "Found 'build' primary agent");
  assert(primaryAgents.some(a => a.id === "plan"), "Found 'plan' primary agent");
  assert(!primaryAgents.some(a => a.id === "general"), "Subagent-only 'general' agent excluded from primary list");
  assert(!primaryAgents.some(a => a.id === "hidden_agent"), "Hidden agent excluded from primary list");
  assert(!primaryAgents.some(a => a.id === "disabled_agent"), "Disabled agent excluded from primary list");

  // -------------------------------------------------------------
  // Test 3: Model Switching - Success on HTTP 204
  // -------------------------------------------------------------
  console.log("\n▶ Group 3: Model Switching Lifecycle");
  // Initial switch to Model A
  await client.switchSessionModel(testSession, { providerID: "opencode", id: "model-a", variant: "default" });
  assert(activeSessionModel.id === "model-a", "Switched session to model-a on server");

  // Prompt on Model A
  await client.promptSession(testSession, { text: "Prompt on model A" });
  assert(lastPromptSessionModel.id === "model-a", "Server executed prompt on Model A");

  // Switch to Model B with variant
  await client.switchSessionModel(testSession, { providerID: "opencode", id: "model-b", variant: "creative" });
  assert(activeSessionModel.id === "model-b" && activeSessionModel.variant === "creative", "Switched session to model-b (variant: creative) on server");

  // Prompt on Model B -> verify server sees B
  await client.promptSession(testSession, { text: "Prompt on model B" });
  assert(lastPromptSessionModel.id === "model-b" && lastPromptSessionModel.variant === "creative", "Server executed next prompt strictly on Model B (creative)");

  // -------------------------------------------------------------
  // Test 4: Model Switching - Rejection Throws Typed OpenCodeError
  // -------------------------------------------------------------
  console.log("\n▶ Group 4: Model Switching Rejection Error Handling");
  let caughtError: OpenCodeError | null = null;
  try {
    await client.switchSessionModel(testSession, { providerID: "opencode", id: "model-reject" });
  } catch (err: any) {
    caughtError = err;
  }
  assert(caughtError !== null, "Model switch rejection threw an error");
  assert(caughtError instanceof OpenCodeError, "Error is an instance of OpenCodeError");
  assert(caughtError?.status === 422, "Error captures HTTP 422 status");
  assert(activeSessionModel.id === "model-b", "Active model on server remained Model B after failed switch");

  // -------------------------------------------------------------
  // Test 5: Agent Switching - build -> plan and plan -> build
  // -------------------------------------------------------------
  console.log("\n▶ Group 5: Agent Switching Lifecycle");
  await client.switchSessionAgent(testSession, "plan");
  assert(activeSessionAgent === "plan", "Switched session to 'plan' agent");

  await client.switchSessionAgent(testSession, "build");
  assert(activeSessionAgent === "build", "Switched session back to 'build' agent");

  // Subagent-only / unknown agent switch rejection
  let agentError: OpenCodeError | null = null;
  try {
    await client.switchSessionAgent(testSession, "subagent-only");
  } catch (err: any) {
    agentError = err;
  }
  assert(agentError !== null && agentError.status === 404, "Subagent-only agent switch rejected with 404 OpenCodeError");

  // Cleanup
  await new Promise<void>((r) => mockServer.close(() => r()));
  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch {}

  console.log("\n=======================================================");
  console.log(`Model & Agent Tests Total: ${totalTests} | Passed: ${passedTests} | Failed: ${failedTests}`);
  console.log("=======================================================\n");

  if (failedTests > 0) process.exit(1);
}

runModelAgentTests().catch((err) => {
  console.error("Model/Agent test suite threw uncaught error:", err);
  process.exit(1);
});
