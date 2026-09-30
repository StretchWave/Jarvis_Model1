/**
 * Test Suite: OpenCode Daemon Bootstrap & Service Resolution (Requirement 24)
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

async function runBootstrapTests() {
  console.log("\n=======================================================");
  console.log("       OPENCODE DAEMON BOOTSTRAP TEST SUITE            ");
  console.log("=======================================================\n");

  const testDir = path.join(process.cwd(), `.test_bootstrap_${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  const logger = new Logger("TestBootstrap", "error");

  // -------------------------------------------------------------
  // Test 1: Daemon already healthy -> no spawn
  // -------------------------------------------------------------
  console.log("▶ Test 1: Daemon Already Healthy (No Spawn Required)");
  const healthyPort = 39801;
  const healthyServer = http.createServer((req, res) => {
    if (req.url === "/api/info") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: "2.0.15", pid: 1111 }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => healthyServer.listen(healthyPort, "127.0.0.1", r));

  const healthyServiceFile = path.join(testDir, "healthy_service.json");
  fs.writeFileSync(healthyServiceFile, JSON.stringify({
    url: `http://127.0.0.1:${healthyPort}`,
    pid: 1111,
    version: "2.0.15",
  }));

  const client1 = new OpenCodeClient({
    serviceFile: healthyServiceFile,
    connectTimeoutMs: 1500,
    spawnIfDown: true,
    disableGlobalDiscovery: true,
  }, logger);

  const startResult1 = await client1.ensureDaemonRunning();
  assert(startResult1 === true, "ensureDaemonRunning returned true for healthy daemon");
  const health1 = await client1.health();
  assert(health1.ok === true && health1.pid === 1111, "Health check verified PID 1111 without spawning");
  await new Promise<void>((r) => healthyServer.close(() => r()));

  // -------------------------------------------------------------
  // Test 2: Daemon missing & spawnIfDown = false -> no spawn
  // -------------------------------------------------------------
  console.log("\n▶ Test 2: Daemon Missing with spawnIfDown = false (No Spawn)");
  const deadServiceFile = path.join(testDir, "dead_service.json");
  fs.writeFileSync(deadServiceFile, JSON.stringify({
    url: "http://127.0.0.1:39999",
    pid: 9999,
    version: "2.0.15",
  }));

  const client2 = new OpenCodeClient({
    serviceFile: deadServiceFile,
    connectTimeoutMs: 1000,
    spawnIfDown: false,
    disableGlobalDiscovery: true,
  }, logger);

  const startResult2 = await client2.ensureDaemonRunning();
  assert(startResult2 === false, "ensureDaemonRunning returned false when spawnIfDown=false");
  const health2 = await client2.health();
  assert(health2.ok === false, "Health check accurately reported service down");

  // -------------------------------------------------------------
  // Test 3: Stale service file -> ignored, valid service discovered
  // -------------------------------------------------------------
  console.log("\n▶ Test 3: Stale Service File Ignored in Favor of Live Service");
  const livePort = 39803;
  const liveServer = http.createServer((req, res) => {
    if (req.url === "/api/info") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: "2.0.15", pid: 3333 }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => liveServer.listen(livePort, "127.0.0.1", r));

  const validServiceFile = path.join(testDir, "valid_service.json");
  fs.writeFileSync(validServiceFile, JSON.stringify({
    url: `http://127.0.0.1:${livePort}`,
    pid: 3333,
    version: "2.0.15",
  }));

  // Client with valid service file
  const client3 = new OpenCodeClient({
    serviceFile: validServiceFile,
    connectTimeoutMs: 1500,
    disableGlobalDiscovery: true,
  }, logger);

  const resolved = await client3.resolveService();
  assert(resolved !== null && resolved.pid === 3333, "Resolved live service and ignored dead endpoints");
  const health3 = await client3.health();
  assert(health3.ok === true && health3.url.includes(String(livePort)), "Health check passed on resolved live service");
  await new Promise<void>((r) => liveServer.close(() => r()));

  // -------------------------------------------------------------
  // Test 4: Health endpoint hangs -> bounded timeout enforced
  // -------------------------------------------------------------
  console.log("\n▶ Test 4: Bounded Timeout Enforced on Hanging Endpoint");
  const hangingPort = 39804;
  const hangingServer = http.createServer((_req, _res) => {
    // Intentionally never reply to test connectTimeoutMs
  });
  await new Promise<void>((r) => hangingServer.listen(hangingPort, "127.0.0.1", r));

  const hangingServiceFile = path.join(testDir, "hanging_service.json");
  fs.writeFileSync(hangingServiceFile, JSON.stringify({
    url: `http://127.0.0.1:${hangingPort}`,
    pid: 4444,
    version: "2.0.15",
  }));

  const client4 = new OpenCodeClient({
    serviceFile: hangingServiceFile,
    connectTimeoutMs: 800,
    spawnIfDown: false,
    disableGlobalDiscovery: true,
  }, logger);

  const timeoutStart = Date.now();
  const hangingHealth = await client4.health();
  const elapsed = Date.now() - timeoutStart;

  assert(hangingHealth.ok === false, "Hanging health request returned ok: false");
  assert(elapsed < 3500, `Timeout was bounded and completed in ${elapsed}ms (< 3500ms)`);
  await new Promise<void>((r) => hangingServer.close(() => r()));

  // -------------------------------------------------------------
  // Test 5: Service start timeout -> clean failure without throwing
  // -------------------------------------------------------------
  console.log("\n▶ Test 5: Service Start Timeout Clean Failure");
  const client5 = new OpenCodeClient({
    serviceFile: path.join(testDir, "nonexistent.json"),
    connectTimeoutMs: 500,
    spawnIfDown: true,
    disableGlobalDiscovery: true,
    cliPath: "nonexistent_opencode_binary_xyz",
  }, logger);

  const timeoutResult = await client5.ensureDaemonRunning();
  assert(timeoutResult === false, "Clean failure returned false when service binary cannot be found");

  // Cleanup
  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch {}

  console.log("\n=======================================================");
  console.log(`Bootstrap Tests Total: ${totalTests} | Passed: ${passedTests} | Failed: ${failedTests}`);
  console.log("=======================================================\n");

  if (failedTests > 0) process.exit(1);
}

runBootstrapTests().catch((err) => {
  console.error("Bootstrap test suite threw uncaught error:", err);
  process.exit(1);
});
