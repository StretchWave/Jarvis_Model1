/**
 * Test Suite: OpenCode Permissions Flow, Reply Payload & E2E Confirmation Deadlock Prevention
 * Covers Requirements 2, 3, and 17.
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { OpenCodeClient } from "../src/opencode_client.ts";
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

async function runPermissionsTests() {
  console.log("\n=======================================================");
  console.log("       OPENCODE PERMISSION CONFIRMATION TEST SUITE     ");
  console.log("=======================================================\n");

  const testDir = path.join(process.cwd(), `.test_perms_${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  const logger = new Logger("TestPermissions", "error");

  const repliesReceived: Array<{ requestId: string; reply: string; rawBody: any }> = [];
  const testSession = "ses_perm_999";

  const mockPort = 39820;
  const mockServer = http.createServer((req, res) => {
    if ((req.url === "/api/health" || req.url === "/api/info") && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: "2.0.15", pid: 6666 }));
      return;
    }

    if (req.url === "/api/model" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([
        { providerID: "opencode", id: "mimo-v2.6-flash-free", modelID: "mimo-v2.6-flash-free", variants: ["default"] },
      ]));
      return;
    }

    if (req.url === "/api/agent" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([
        { id: "build", mode: "primary" },
      ]));
      return;
    }

    // Permission reply endpoint (Requirement 2)
    if (req.url?.includes("/permission/") && req.url.endsWith("/reply") && req.method === "POST") {
      const match = req.url.match(/\/permission\/([^/]+)\/reply/);
      const requestId = match ? match[1] : "unknown";

      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body);

          // Reject unknown / forbidden fields such as 'decision' (Requirement 2)
          if ("decision" in parsed) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Forbidden field 'decision' present in permission reply" }));
            return;
          }

          if (!parsed.reply || !["once", "always", "reject"].includes(parsed.reply)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid reply payload format" }));
            return;
          }

          repliesReceived.push({
            requestId,
            reply: parsed.reply,
            rawBody: parsed,
          });

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
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

  await new Promise<void>((r) => mockServer.listen(mockPort, "127.0.0.1", r));

  const serviceFile = path.join(testDir, "service.json");
  fs.writeFileSync(serviceFile, JSON.stringify({
    url: `http://127.0.0.1:${mockPort}`,
    pid: 6666,
    version: "2.0.15",
  }));

  const client = new OpenCodeClient({
    serviceFile,
    connectTimeoutMs: 1500,
    disableGlobalDiscovery: true,
  }, logger);

  // Set up JarvisCore with custom config
  const dbPath = path.join(testDir, "perm_test.db");
  const configPath = path.join(testDir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    dataDir: testDir,
    databasePath: dbPath,
    opencode: { serviceFile, spawnIfDown: false },
    logging: { level: "error", format: "pretty" },
  }));

  const core = new JarvisCore(configPath);
  await core.initialize();

  // -------------------------------------------------------------
  // Test 1: User Approves -> confirmAction dispatches "once" (never "always" by default)
  // -------------------------------------------------------------
  console.log("▶ Test 1: User Approves Permission -> Dispatches 'once'");
  const p1 = core.requestConfirmation({
    sessionId: "test-session",
    opencodeSessionId: testSession,
    opencodeRequestId: "perm_req_01",
    action: "file_edit",
    resources: ["src/main.ts"],
    timeoutMs: 5000,
  });

  assert(core.getPendingPermissions().length === 1, "Registered pending permission request in JarvisCore");
  assert(repliesReceived.length === 0, "No reply automatically sent before user decision");

  // User clicks "Approve Once"
  const ok1 = core.confirmAction(p1.requestId, "once");
  assert(ok1 === true, "confirmAction resolved pending request successfully");
  const decision1 = await p1.promise;
  assert(decision1 === "once", "Resolved decision is 'once'");

  // Wait a small tick for background OpenCode dispatch
  await new Promise((r) => setTimeout(r, 60));
  assert(repliesReceived.length === 1, "Dispatched permission reply to OpenCode");
  assert(repliesReceived[0].reply === "once", "OpenCode received strictly 'once' approval (not 'always')");
  assert(!("decision" in repliesReceived[0].rawBody), "Permission reply body contains NO 'decision' field (Requirement 2)");

  // -------------------------------------------------------------
  // Test 2: User Denies -> confirmAction dispatches "reject"
  // -------------------------------------------------------------
  console.log("\n▶ Test 2: User Denies Permission -> Dispatches 'reject'");
  const p2 = core.requestConfirmation({
    sessionId: "test-session",
    opencodeSessionId: testSession,
    opencodeRequestId: "perm_req_02",
    action: "bash_exec",
    timeoutMs: 5000,
  });

  const ok2 = core.confirmAction(p2.requestId, "reject");
  assert(ok2 === true, "confirmAction resolved pending rejection");
  const decision2 = await p2.promise;
  assert(decision2 === "reject", "Resolved decision is 'reject'");

  await new Promise((r) => setTimeout(r, 60));
  assert(repliesReceived.length === 2 && repliesReceived[1].reply === "reject", "OpenCode received 'reject' decision");
  assert(!("decision" in repliesReceived[1].rawBody), "Rejection reply body contains NO 'decision' field");

  // -------------------------------------------------------------
  // Test 3: Permission Request Times Out -> defaults to "reject"
  // -------------------------------------------------------------
  console.log("\n▶ Test 3: Permission Request Timeout -> Defaults to 'reject'");
  const p3 = core.requestConfirmation({
    sessionId: "test-session",
    opencodeSessionId: testSession,
    opencodeRequestId: "perm_req_03",
    action: "rmdir",
    timeoutMs: 200, // Short timeout for testing
  });

  const decision3 = await p3.promise;
  assert(decision3 === "reject", "Timed out permission automatically defaulted to 'reject'");
  assert(core.getPendingPermissions().length === 0, "Timed out request removed from pending map");

  await new Promise((r) => setTimeout(r, 60));
  assert(repliesReceived.length === 3 && repliesReceived[2].reply === "reject", "OpenCode received auto-reject on timeout");

  // Attempting to confirm after timeout should fail
  const lateConfirm = core.confirmAction(p3.requestId, "once");
  assert(lateConfirm === false, "Late confirmation after timeout rejected (non-reusable ID)");

  // -------------------------------------------------------------
  // Test 4: Explicit "Always Allow" -> confirmAction dispatches "always"
  // -------------------------------------------------------------
  console.log("\n▶ Test 4: Explicit 'Always Allow' -> Dispatches 'always'");
  const p4 = core.requestConfirmation({
    sessionId: "test-session",
    opencodeSessionId: testSession,
    opencodeRequestId: "perm_req_04",
    action: "git_push",
    timeoutMs: 5000,
  });

  const ok4 = core.confirmAction(p4.requestId, "always");
  assert(ok4 === true, "confirmAction resolved with 'always'");
  const decision4 = await p4.promise;
  assert(decision4 === "always", "Resolved decision is 'always'");

  await new Promise((r) => setTimeout(r, 60));
  assert(repliesReceived.length === 4 && repliesReceived[3].reply === "always", "OpenCode received durable 'always' approval on explicit user action");
  assert(!("decision" in repliesReceived[3].rawBody), "Always reply body contains NO 'decision' field");

  // -------------------------------------------------------------
  // Test 5: End-to-End Deadlock-Free Permission Integration Flow (Requirement 3 & 17)
  // -------------------------------------------------------------
  console.log("\n▶ Test 5: End-to-End Permission Flow with Execution Pause & Resume (Requirement 3 & 17)");

  const e2ePort = 39821;
  let sseClientRes: http.ServerResponse | null = null;
  let e2ePermissionReplyReceived: any = null;
  let executionResumedAfterReply = false;

  const e2eServer = http.createServer((req, res) => {
    if ((req.url === "/api/health" || req.url === "/api/info") && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: "2.0.15", pid: 7777 }));
      return;
    }
    if (req.url === "/api/model" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([
        { providerID: "opencode", id: "mimo-v2.6-flash-free", modelID: "mimo-v2.6-flash-free", variants: ["default"] },
      ]));
      return;
    }
    if (req.url === "/api/agent" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([{ id: "build", mode: "primary" }]));
      return;
    }
    if (req.url?.startsWith("/api/session/") && req.url.endsWith("/model") && req.method === "POST") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.url?.startsWith("/api/session/") && req.url.endsWith("/agent") && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === "/api/session" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "ses_e2e_1" }));
      return;
    }
    if (req.url?.match(/^\/api\/session\/[^/]+$/) && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "ses_e2e_1",
        model: { providerID: "opencode", id: "mimo-v2.6-flash-free", variant: "default" },
        agent: "build",
        data: {
          id: "ses_e2e_1",
          model: { providerID: "opencode", id: "mimo-v2.6-flash-free", variant: "default" },
          agent: "build",
        },
      }));
      return;
    }
    // SSE Stream
    if (req.url === "/api/event" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      res.flushHeaders();
      res.write(": keepalive\n\n");
      sseClientRes = res;
      return;
    }
    // Prompt endpoint
    if (req.url?.includes("/prompt") && req.method === "POST") {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));

        // Emit permission requested via SSE
        setTimeout(() => {
          if (sseClientRes) {
            sseClientRes.write(`event: message\ndata: ${JSON.stringify({
              type: "permission.requested",
              data: {
                id: "oc_perm_e2e_99",
                sessionID: "ses_e2e_1",
                action: "bash_execute",
                details: "Run deploy script",
                resources: ["deploy.sh"],
              }
            })}\n\n`);
          }
        }, 50);
      });
      return;
    }
    // Permission reply endpoint
    if (req.url?.includes("/permission/") && req.url.endsWith("/reply") && req.method === "POST") {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", () => {
        e2ePermissionReplyReceived = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));

        // OpenCode resumes execution after permission reply!
        setTimeout(() => {
          executionResumedAfterReply = true;
          if (sseClientRes) {
            sseClientRes.write(`event: message\ndata: ${JSON.stringify({
              type: "session.text.delta",
              data: {
                sessionID: "ses_e2e_1",
                delta: "Deployment confirmed and executed successfully.",
              }
            })}\n\n`);
            sseClientRes.write(`event: message\ndata: ${JSON.stringify({
              type: "session.execution.succeeded",
              data: { sessionID: "ses_e2e_1" }
            })}\n\n`);
          }
        }, 50);
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((r) => e2eServer.listen(e2ePort, "127.0.0.1", r));

  const e2eServiceFile = path.join(testDir, "service_e2e.json");
  fs.writeFileSync(e2eServiceFile, JSON.stringify({
    url: `http://127.0.0.1:${e2ePort}`,
    pid: 7777,
    version: "2.0.15",
  }));

  const e2eDbPath = path.join(testDir, "e2e_perm.db");
  const e2eConfigPath = path.join(testDir, "config_e2e.json");
  fs.writeFileSync(e2eConfigPath, JSON.stringify({
    dataDir: testDir,
    databasePath: e2eDbPath,
    opencode: { serviceFile: e2eServiceFile, spawnIfDown: false },
    logging: { level: "error", format: "pretty" },
    models: {
      fast: { providerID: "opencode", modelID: "mimo-v2.6-flash-free", variant: "default" },
      agent: { providerID: "opencode", modelID: "mimo-v2.6-flash-free", variant: "default", agentID: "build" },
    },
  }));

  const e2eCore = new JarvisCore(e2eConfigPath);
  await e2eCore.initialize();

  // Create logical session
  const jarvisSession = await e2eCore.sessionMgr.getOrCreateActiveSession("general");
  // Force pairing to ses_e2e_1
  e2eCore.db.updateSessionOpencodeId(jarvisSession.id, "ses_e2e_1");

  let receivedConfirmRequiredEvent: any = null;
  let e2eDoneReceived = false;
  let finalResponseText = "";

  // Start processing input in the background
  const processPromise = (async () => {
    for await (const ev of e2eCore.processInput("Deploy the project", jarvisSession.id)) {
      if (ev.type === "confirm_required") {
        receivedConfirmRequiredEvent = ev;
      } else if (ev.type === "done") {
        e2eDoneReceived = true;
        finalResponseText = ev.fullText;
      }
    }
  })();

  // 1. Wait for confirmation event to reach UI level
  let waitCount = 0;
  while (!receivedConfirmRequiredEvent && waitCount < 30) {
    await new Promise((r) => setTimeout(r, 50));
    waitCount++;
  }

  assert(receivedConfirmRequiredEvent !== null, "OpenCode permission request visibly reached JARVIS UI as confirm_required");
  assert(receivedConfirmRequiredEvent?.action === "bash_execute", "confirm_required event preserved action");
  assert(e2eCore.getPendingPermissions().length === 1, "Created authoritative pending confirmation in JarvisCore");
  assert(!executionResumedAfterReply, "Execution strictly BLOCKED awaiting user approval (deadlock prevented)");
  assert(e2ePermissionReplyReceived === null, "No permission reply sent to OpenCode before user decision");

  // 2. User approves through confirmation UI
  const jarvisReqId = receivedConfirmRequiredEvent.requestId;
  const approved = e2eCore.confirmAction(jarvisReqId, "once");
  assert(approved === true, "User approval processed by confirmAction");

  // 3. Verify reply sent to OpenCode and execution resumed
  await new Promise((r) => setTimeout(r, 100));
  assert(e2ePermissionReplyReceived !== null, "Permission reply transmitted to OpenCode HTTP endpoint");
  assert(e2ePermissionReplyReceived?.reply === "once", "OpenCode received 'once' reply");
  assert(!("decision" in e2ePermissionReplyReceived), "OpenCode reply payload strictly omits 'decision'");

  // 4. Wait for execution to complete
  await processPromise;
  assert(executionResumedAfterReply === true, "Execution resumed after user approval");
  assert(e2eDoneReceived === true, "Execution completed and emitted done event");
  assert(finalResponseText.includes("Deployment confirmed"), "Final response includes post-approval output");
  assert(e2eCore.getPendingPermissions().length === 0, "Pending permissions cleaned up after execution");

  // Cleanup
  core.shutdown();
  e2eCore.shutdown();
  await new Promise<void>((r) => mockServer.close(() => r()));
  await new Promise<void>((r) => e2eServer.close(() => r()));
  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch {}

  console.log("\n=======================================================");
  console.log(`Permission Tests Total: ${totalTests} | Passed: ${passedTests} | Failed: ${failedTests}`);
  console.log("=======================================================\n");

  if (failedTests > 0) process.exit(1);
}

runPermissionsTests().catch((err) => {
  console.error("Permission test suite threw uncaught error:", err);
  process.exit(1);
});
