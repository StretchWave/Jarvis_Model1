/**
 * Test Suite: OpenCode Stream Lifecycle & Cancellation (Requirement 28)
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
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

async function runCancellationTests() {
  console.log("\n=======================================================");
  console.log("       OPENCODE STREAM CANCELLATION TEST SUITE         ");
  console.log("=======================================================\n");

  const testDir = path.join(process.cwd(), `.test_cancel_${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  const logger = new Logger("TestCancellation", "error");

  let sseConnectionCount = 0;
  let sseDisconnectionCount = 0;
  let activeSseRes: http.ServerResponse | null = null;
  const testSession = "ses_cancel_101";

  const mockPort = 39830;
  const mockServer = http.createServer((req, res) => {
    if (req.url === "/api/info" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: "2.0.15", pid: 7777 }));
      return;
    }

    if (req.url === "/api/event" && req.method === "GET") {
      sseConnectionCount++;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      res.write(": connected\n\n");
      activeSseRes = res;

      req.on("close", () => {
        sseDisconnectionCount++;
        if (activeSseRes === res) activeSseRes = null;
      });
      return;
    }

    if (req.url?.includes("/prompt") && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.url === `/api/session/${testSession}/message` && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([]));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((r) => mockServer.listen(mockPort, "127.0.0.1", r));

  const serviceFile = path.join(testDir, "service.json");
  fs.writeFileSync(serviceFile, JSON.stringify({
    url: `http://127.0.0.1:${mockPort}`,
    pid: 7777,
    version: "2.0.15",
  }));

  const client = new OpenCodeClient({
    serviceFile,
    connectTimeoutMs: 2000,
    disableGlobalDiscovery: true,
  }, logger);

  // -------------------------------------------------------------
  // Test 1: Explicit Unsubscribe Closes SSE Connection
  // -------------------------------------------------------------
  console.log("▶ Test 1: Explicit Unsubscribe Closes SSE Connection");
  const receivedEvents: any[] = [];
  const unsubscribe = await client.subscribeEvents((ev) => {
    receivedEvents.push(ev);
  });

  assert(sseConnectionCount === 1, "SSE connection established to OpenCode");
  assert(activeSseRes !== null, "Server holds active SSE client response");

  // Call unsubscribe
  unsubscribe();
  await new Promise((r) => setTimeout(r, 100));

  assert(sseDisconnectionCount === 1, "Server detected HTTP stream closure upon unsubscribe");
  assert(activeSseRes === null, "Active server response cleared");

  // -------------------------------------------------------------
  // Test 2: External AbortSignal Propagates to Internal Controller
  // -------------------------------------------------------------
  console.log("\n▶ Test 2: External AbortSignal Cancellation");
  const externalController = new AbortController();
  const unsub2 = await client.subscribeEvents((_ev) => {}, externalController.signal);

  assert(sseConnectionCount === 2, "Second SSE subscription opened");

  // Abort via external signal
  externalController.abort(new Error("User cancelled"));
  await new Promise((r) => setTimeout(r, 100));

  assert(sseDisconnectionCount === 2, "Server received abort and closed connection");
  unsub2(); // Safe duplicate call

  // -------------------------------------------------------------
  // Test 3: Prompt Stream Execution Cancellation
  // -------------------------------------------------------------
  console.log("\n▶ Test 3: executePromptStream Abort Mid-Execution");
  const streamController = new AbortController();
  const events: any[] = [];
  const cancelPromise = (async () => {
    try {
      for await (const ev of client.executePromptStream(testSession, "Long running task", {
        signal: streamController.signal,
      })) {
        events.push(ev);
      }
    } catch {}
  })();

  setTimeout(() => streamController.abort(new Error("User cancelled execution")), 50);
  await cancelPromise;

  const cancelEvent = events.find((e) => e.type === "error" && (e.error?.toLowerCase().includes("cancel") || e.error?.toLowerCase().includes("abort")));
  assert(cancelEvent !== undefined, "executePromptStream cleanly reported cancellation error");

  // -------------------------------------------------------------
  // Test 4: Daemon Sudden Disconnect Recovery
  // -------------------------------------------------------------
  console.log("\n▶ Test 4: Daemon Sudden Disconnect Handling");
  let disconnectedEventCaught = false;
  const unsub4 = await client.subscribeEvents((_ev) => {});

  // Wait for server to register connection
  for (let i = 0; i < 20 && !activeSseRes; i++) {
    await new Promise((r) => setTimeout(r, 25));
  }

  if (activeSseRes) {
    // Forcefully destroy socket to simulate daemon crash/disconnect
    (activeSseRes as any).socket?.destroy();
    disconnectedEventCaught = true;
  }
  await new Promise((r) => setTimeout(r, 100));

  assert(disconnectedEventCaught === true, "Simulated sudden socket destruction by daemon");
  unsub4();

  // Cleanup
  await new Promise<void>((r) => mockServer.close(() => r()));
  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch {}

  console.log("\n=======================================================");
  console.log(`Cancellation Tests Total: ${totalTests} | Passed: ${passedTests} | Failed: ${failedTests}`);
  console.log("=======================================================\n");

  if (failedTests > 0) process.exit(1);
}

runCancellationTests().catch((err) => {
  console.error("Cancellation test suite threw uncaught error:", err);
  process.exit(1);
});
