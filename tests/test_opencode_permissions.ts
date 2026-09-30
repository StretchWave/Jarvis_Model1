/**
 * Test Suite: OpenCode Permissions Flow & JARVIS Confirmation (Requirement 27)
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

  const repliesReceived: Array<{ requestId: string; reply: string; decision: string }> = [];
  const testSession = "ses_perm_999";

  const mockPort = 39820;
  const mockServer = http.createServer((req, res) => {
    if (req.url === "/api/info" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: "2.0.15", pid: 6666 }));
      return;
    }

    if (req.url?.includes("/permission/") && req.url.endsWith("/reply") && req.method === "POST") {
      const match = req.url.match(/\/permission\/([^/]+)\/reply/);
      const requestId = match ? match[1] : "unknown";

      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          if (!parsed.reply || !["once", "always", "reject"].includes(parsed.reply)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid reply payload format" }));
            return;
          }

          repliesReceived.push({
            requestId,
            reply: parsed.reply,
            decision: parsed.decision || parsed.reply,
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
  // Test 1: User Approves -> replies "once" (never "always" by default)
  // -------------------------------------------------------------
  console.log("▶ Test 1: User Approves Permission -> Replies 'once'");
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

  // Dispatch reply to OpenCode
  await client.replyPermission(testSession, "perm_req_01", decision1);
  assert(repliesReceived.length === 1, "Dispatched permission reply to OpenCode");
  assert(repliesReceived[0].reply === "once", "OpenCode received strictly 'once' approval (not 'always')");

  // -------------------------------------------------------------
  // Test 2: User Denies -> replies "reject"
  // -------------------------------------------------------------
  console.log("\n▶ Test 2: User Denies Permission -> Replies 'reject'");
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

  await client.replyPermission(testSession, "perm_req_02", decision2);
  assert(repliesReceived.length === 2 && repliesReceived[1].reply === "reject", "OpenCode received 'reject' decision");

  // -------------------------------------------------------------
  // Test 3: Permission Request Times Out -> defaults to "reject"
  // -------------------------------------------------------------
  console.log("\n▶ Test 3: Permission Request Timeout -> Defaults to 'reject'");
  const p3 = core.requestConfirmation({
    sessionId: "test-session",
    opencodeSessionId: testSession,
    opencodeRequestId: "perm_req_03",
    action: "rmdir",
    timeoutMs: 250, // Short timeout for testing
  });

  const decision3 = await p3.promise;
  assert(decision3 === "reject", "Timed out permission automatically defaulted to 'reject'");
  assert(core.getPendingPermissions().length === 0, "Timed out request removed from pending map");

  // Attempting to confirm after timeout should fail
  const lateConfirm = core.confirmAction(p3.requestId, "once");
  assert(lateConfirm === false, "Late confirmation after timeout rejected (non-reusable ID)");

  // -------------------------------------------------------------
  // Test 4: Explicit "Always Allow" -> replies "always"
  // -------------------------------------------------------------
  console.log("\n▶ Test 4: Explicit 'Always Allow' -> Replies 'always'");
  const p4 = core.requestConfirmation({
    sessionId: "test-session",
    opencodeSessionId: testSession,
    opencodeRequestId: "perm_req_04",
    action: "git_push",
    timeoutMs: 5000,
  });

  // User explicitly clicked "Always Allow"
  const ok4 = core.confirmAction(p4.requestId, "always");
  assert(ok4 === true, "confirmAction resolved with 'always'");
  const decision4 = await p4.promise;
  assert(decision4 === "always", "Resolved decision is 'always'");

  await client.replyPermission(testSession, "perm_req_04", decision4);
  assert(repliesReceived.length === 3 && repliesReceived[2].reply === "always", "OpenCode received durable 'always' approval on explicit user action");

  // Cleanup
  core.shutdown();
  await new Promise<void>((r) => mockServer.close(() => r()));
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
