/**
 * Phase 4 Verification Test Suite - OpenCode Real-Time Response & Progress Streaming
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { Logger } from "../src/logger.ts";
import { Database } from "../src/database.ts";
import { SessionManager } from "../src/session_manager.ts";
import { MemoryManager } from "../src/memory/memory_manager.ts";
import { OpenCodeClient } from "../src/opencode_client.ts";
import { AgentDispatcher, type AgentEvent } from "../src/agent/agent_dispatcher.ts";

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

async function runPhase4RefactorTests() {
  console.log("\n=======================================================");
  console.log("       JARVIS PHASE 4 REFACTOR TEST SUITE              ");
  console.log("=======================================================\n");

  const testDir = path.join(process.cwd(), ".test_p4_refactor");
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  fs.mkdirSync(testDir, { recursive: true });

  const logger = new Logger("Phase4Refactor", "error");
  const db = new Database(path.join(testDir, "p4_test.db"), logger);
  const client = new OpenCodeClient("dummy_service.json", logger);
  const sessionMgr = new SessionManager(db, client, logger);
  const memoryMgr = new MemoryManager(db, logger);
  const dispatcher = new AgentDispatcher(sessionMgr, memoryMgr, client, logger);

  // -----------------------------------------------------------------
  // 1. Safe Event Translation Audit
  // -----------------------------------------------------------------
  console.log("▶ Group 1: OpenCode Event Translation & CoT Suppression");
  const targetSession = "ses_target_123";

  // Case A: Read tool
  const evRead = dispatcher.translateEvent({
    event: "tool_call",
    data: { sessionId: targetSession, tool: "read_file", path: "main.ts" },
  }, targetSession);
  assert(evRead?.type === "progress" && evRead.message.includes("Reading project"), "Translates read_file to safe reading progress");

  // Case B: Blueprint tool
  const evBp = dispatcher.translateEvent({
    event: "tool_call",
    data: { sessionId: targetSession, tool: "inspect_blueprint" },
  }, targetSession);
  assert(evBp?.type === "progress" && evBp.message.includes("Blueprint"), "Translates Blueprint tool to animation inspection progress");

  // Case C: Command execution
  const evTest = dispatcher.translateEvent({
    event: "tool_call",
    data: { sessionId: targetSession, tool: "run_command" },
  }, targetSession);
  assert(evTest?.type === "progress" && evTest.message.includes("Running tests"), "Translates command execution to diagnostic progress");

  // Case D: Code patch
  const evFix = dispatcher.translateEvent({
    event: "tool_call",
    data: { sessionId: targetSession, tool: "apply_patch" },
  }, targetSession);
  assert(evFix?.type === "progress" && evFix.message.includes("Applying code"), "Translates patch to code modification progress");

  // Case E: Chain-of-Thought / reasoning suppression
  const evReasoning = dispatcher.translateEvent({
    event: "reasoning",
    data: { sessionId: targetSession, type: "reasoning", text: "Secret hidden thought trace" },
  }, targetSession);
  assert(evReasoning === null, "Suppresses internal reasoning and chain-of-thought events completely");

  // Case F: Session isolation (ignores events for different sessions)
  const evOtherSession = dispatcher.translateEvent({
    event: "tool_call",
    data: { sessionId: "ses_other_456", tool: "read_file" },
  }, targetSession);
  assert(evOtherSession === null, "Ignores events from other OpenCode sessions");

  // -----------------------------------------------------------------
  // 2. Real-Time Streaming over Mock OpenCode Server
  // -----------------------------------------------------------------
  console.log("\n▶ Group 2: End-to-End Live Event Stream Dispatch");

  let sseClientRes: http.ServerResponse | null = null;
  const mockServer = http.createServer((req, res) => {
    if (req.url === "/api/info") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ version: "2.0.15", pid: 9999 }));
    } else if (req.url === "/api/session" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: targetSession, title: "Test Session" }));
    } else if (req.url === `/api/session/${targetSession}` && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: targetSession, title: "Test Session" }));
    } else if (req.url?.includes("/model") && req.method === "POST") {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          if (!parsed.model || !parsed.model.providerID || !parsed.model.id) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing required model fields" }));
            return;
          }
          res.writeHead(204);
          res.end();
        } catch {
          res.writeHead(400);
          res.end();
        }
      });
    } else if (req.url?.includes("/agent") && req.method === "POST") {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          if (!parsed.agent || typeof parsed.agent !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing or invalid 'agent'" }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, agent: parsed.agent }));
        } catch {
          res.writeHead(400);
          res.end();
        }
      });
    } else if (req.url === "/api/agent") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([{ id: "build", name: "Build", mode: "primary", hidden: false }]));
    } else if (req.url === "/api/model") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([{ providerID: "opencode", id: "mimo-v2.6-flash-free" }]));
    } else if (req.url?.startsWith(`/api/session/${targetSession}/prompt`) && req.method === "POST") {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          if (!parsed.prompt || !parsed.prompt.text) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing prompt.text" }));
            return;
          }

          // Simulate tool progress event over SSE while prompt is being processed
          setTimeout(() => {
            if (sseClientRes) {
              sseClientRes.write("event: message\n");
              sseClientRes.write("data: " + JSON.stringify({ sessionId: targetSession, tool: "read_file" }) + "\n\n");
            }
          }, 50);

          setTimeout(() => {
            if (sseClientRes) {
              sseClientRes.write("event: message\n");
              sseClientRes.write("data: " + JSON.stringify({ sessionId: targetSession, tool: "inspect_blueprint" }) + "\n\n");
            }
          }, 100);

          setTimeout(() => {
            if (sseClientRes) {
              sseClientRes.write("event: message\n");
              sseClientRes.write("data: " + JSON.stringify({ type: "session.execution.succeeded", sessionId: targetSession }) + "\n\n");
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
          }, 200);
        } catch {
          res.writeHead(400);
          res.end();
        }
      });
    } else if (req.url === "/api/event") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      res.write(": keepalive\n\n");
      sseClientRes = res;
    } else if (req.url === `/api/session/${targetSession}/message`) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([
        { role: "user", content: "Inspect animations" },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "Internal thinking..." },
            { type: "text", text: "The animation state machine blend space is configured correctly, Sir." }
          ]
        }
      ]));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  const mockPort = 39888;
  await new Promise<void>((resolve) => mockServer.listen(mockPort, "127.0.0.1", resolve));

  // Write mock service.json
  const serviceFile = path.join(testDir, "mock_service.json");
  fs.writeFileSync(serviceFile, JSON.stringify({
    url: `http://127.0.0.1:${mockPort}`,
    pid: 9999,
    version: "2.0.15",
  }));

  const streamingClient = new OpenCodeClient(serviceFile, logger);
  const streamingSessionMgr = new SessionManager(db, streamingClient, logger);
  const streamingDispatcher = new AgentDispatcher(streamingSessionMgr, memoryMgr, streamingClient, logger);

  // Create Jarvis session paired with targetSession
  const jSession = await streamingSessionMgr.createSession({
    title: "Stream Test",
    category: "coding",
  });
  db.updateSessionOpencodeId(jSession.id, targetSession);

  const collectedEvents: AgentEvent[] = [];
  let finalStreamText = "";

  for await (const ev of streamingDispatcher.executeTask("Inspect animations", jSession.id)) {
    collectedEvents.push(ev);
    if (ev.type === "done") {
      finalStreamText = ev.fullText;
    }
  }

  // Verification
  const progressMessages = collectedEvents.filter((e) => e.type === "progress").map((e: any) => e.message);
  assert(progressMessages.some((m) => m.includes("Reading project")), "Live SSE stream yielded 'Reading project files...'");
  assert(progressMessages.some((m) => m.includes("Blueprint")), "Live SSE stream yielded 'Inspecting Blueprint & animation state...'");
  assert(collectedEvents.some((e) => e.type === "tool_activity" && e.status === "completed"), "Yielded tool activity completed event");
  assert(collectedEvents.some((e) => e.type === "token"), "Yielded streaming token events");
  assert(finalStreamText.includes("blend space is configured correctly"), "Received final clean assistant text without CoT leak");
  assert(!finalStreamText.includes("Internal thinking"), "Suppressed internal chain-of-thought tokens from final output");

  // Cleanup
  await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  db.close();

  // -----------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------
  console.log("\n=======================================================");
  console.log(`Phase 4 Tests Total: ${totalTests} | Passed: ${passedTests} | Failed: ${failedTests}`);
  console.log("=======================================================\n");

  if (failedTests > 0) {
    process.exit(1);
  }
}

runPhase4RefactorTests().catch((err) => {
  console.error("Test runner threw uncaught error:", err);
  process.exit(1);
});
