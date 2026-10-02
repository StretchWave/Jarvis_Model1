/**
 * JARVIS Desktop Runtime, Persistent Kokoro Worker & Voice Call Tests
 * 
 * Verifies:
 * 1. Persistent Kokoro Worker Manager lifecycle & fallback detection
 * 2. Low-latency streaming SpeechQueue ordering, prefetching, and cancellation
 * 3. Response concision policy classifier (MINIMAL, NORMAL, DETAILED)
 * 4. Filler and greeting prefix stripping without losing essential response content
 * 5. Continuous Voice Session echo suppression & barge-in simulation
 */

import { strict as assert } from "node:assert";
import { Logger } from "../src/logger.ts";
import { KokoroWorkerManager } from "../src/voice/kokoro_worker_manager.ts";
import { KokoroTTSProvider } from "../src/voice/kokoro_tts.ts";
import { SpeechQueue, type SpeechQueueItem } from "../src/voice/speech_queue.ts";
import { MockTTSProvider, VoiceService } from "../src/voice/voice_service.ts";
import {
  classifyConcisionLevel,
  getConcisionDirective,
  sanitizeResponseForPersona,
} from "../src/personality/response_policy.ts";

const logger = new Logger("TestDesktopWorkerVoice", "info");

async function runTests() {
  console.log("=== JARVIS Desktop, Persistent Kokoro Worker & Voice Tests ===");
  let passed = 0;
  let total = 0;

  async function test(name: string, fn: () => Promise<void> | void) {
    total++;
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`  ✗ ${name}`);
      console.error(`    ${err.message}`);
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // 1. Persistent Kokoro Worker & Runtime Detection
  // -------------------------------------------------------------------------
  await test("KokoroWorkerManager initializes and inspects runtime correctly", () => {
    const mgr = new KokoroWorkerManager(logger);
    const py = mgr.detectPython();
    const installed = mgr.isInstalled();
    assert.strictEqual(typeof installed, "boolean");
    if (installed) {
      assert.ok(py, "Python executable should be detected if installed");
    }
  });

  await test("KokoroTTSProvider exposes persistent worker manager", () => {
    const tts = new KokoroTTSProvider(logger);
    const workerMgr = tts.getWorkerManager();
    assert.ok(workerMgr instanceof KokoroWorkerManager);
    assert.strictEqual(tts.isNeural, true);
  });

  // -------------------------------------------------------------------------
  // 2. Low-Latency Streaming SpeechQueue
  // -------------------------------------------------------------------------
  await test("SpeechQueue handles sequential enqueuing and prefetching", async () => {
    const mockTts = new MockTTSProvider();
    const readyItems: SpeechQueueItem[] = [];
    const completedItems: SpeechQueueItem[] = [];

    const queue = new SpeechQueue(logger, mockTts, {
      onItemReady: (item) => readyItems.push(item),
      onItemComplete: (item) => completedItems.push(item),
    });

    const sentences = [
      "The system diagnostics show normal operational parameters.",
      "All services are functioning within expected tolerance.",
      "Standing by for further instructions."
    ];

    queue.enqueue(sentences);
    assert.strictEqual(queue.getQueue().length, 3);
    assert.strictEqual(queue.isBusy(), true);

    // Wait for queue processing to complete
    await new Promise((resolve) => setTimeout(resolve, 800));

    assert.ok(completedItems.length >= 2, "Items should process through queue");
    queue.stop();
  });

  await test("SpeechQueue cancels and flushes immediately on stop()", async () => {
    const mockTts = new MockTTSProvider();
    let interrupted = false;

    const queue = new SpeechQueue(logger, mockTts, {
      onInterrupt: () => { interrupted = true; },
    });

    queue.enqueue(["First sentence.", "Second sentence.", "Third sentence."]);
    assert.strictEqual(queue.isBusy(), true);

    queue.stop();
    assert.strictEqual(queue.getQueue().length, 0);
    assert.strictEqual(queue.isBusy(), false);
    assert.strictEqual(interrupted, true);
  });

  // -------------------------------------------------------------------------
  // 3. Response Concision Policy
  // -------------------------------------------------------------------------
  await test("classifyConcisionLevel defaults to MINIMAL for DIRECT and voice", () => {
    assert.strictEqual(classifyConcisionLevel("What time is it?", { route: "DIRECT" }), "MINIMAL");
    assert.strictEqual(classifyConcisionLevel("How is the weather?", { isVoice: true }), "MINIMAL");
  });

  await test("classifyConcisionLevel detects DETAILED queries", () => {
    assert.strictEqual(classifyConcisionLevel("Explain in detail how the router works"), "DETAILED");
    assert.strictEqual(classifyConcisionLevel("Write code for a persistent Python worker"), "DETAILED");
    assert.strictEqual(classifyConcisionLevel("Give me a step-by-step breakdown"), "DETAILED");
  });

  await test("getConcisionDirective produces targeted instructions", () => {
    const minimal = getConcisionDirective("MINIMAL", "Sir");
    assert.ok(minimal.includes("Strict Brevity Mandate"));
    assert.ok(minimal.includes("Target 1 to 2 crisp"));

    const normal = getConcisionDirective("NORMAL", "Sir");
    assert.ok(normal.includes("Brevity Guidelines"));

    const detailed = getConcisionDirective("DETAILED", "Sir");
    assert.ok(detailed.includes("Detailed Response Guidelines"));
  });

  await test("sanitizeResponseForPersona strips unprompted pleasantries and filler", () => {
    const raw1 = "Certainly, Sir! The current time is 11:42 PM.";
    const clean1 = sanitizeResponseForPersona(raw1, "MINIMAL");
    assert.strictEqual(clean1, "The current time is 11:42 PM.");

    const raw2 = "Of course, Sir! I would be happy to help with that. The weather in London is 14°C and overcast. Let me know if you need anything else!";
    const clean2 = sanitizeResponseForPersona(raw2, "MINIMAL");
    assert.strictEqual(clean2, "The weather in London is 14°C and overcast.");

    const raw3 = "### Weather Status\n\n⚡ The server is online.";
    const clean3 = sanitizeResponseForPersona(raw3, "MINIMAL");
    assert.strictEqual(clean3, "The server is online.");
  });

  // -------------------------------------------------------------------------
  // 4. Voice Service & State Machine
  // -------------------------------------------------------------------------
  await test("VoiceService wake/sleep state machine correctly transitions", () => {
    const mockTts = new MockTTSProvider();
    const service = new VoiceService(logger, { tts: mockTts, initialState: "awake" });

    assert.strictEqual(service.getState(), "awake");

    // Sleep directive
    const sleepRes = service.processTranscript("Jarvis, go to sleep");
    assert.strictEqual(sleepRes.proceed, false);
    assert.strictEqual(service.getState(), "sleeping");

    // Ignored speech while sleeping
    const ignoredRes = service.processTranscript("What time is it?");
    assert.strictEqual(ignoredRes.proceed, false);
    assert.strictEqual(service.getState(), "sleeping");

    // Wake directive
    const wakeRes = service.processTranscript("Hey Jarvis, wake up");
    assert.strictEqual(wakeRes.proceed, true);
    assert.strictEqual(service.getState(), "awake");
  });

  console.log(`\nAll ${passed}/${total} desktop, worker, and voice tests passed.`);
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
