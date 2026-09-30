/**
 * Phase 8 Verification Test Suite - Decoupled Voice Architecture, Wake/Sleep & Interruption
 */

import { Logger } from "../src/logger.ts";
import {
  VoiceService,
  MockTTSProvider,
  DefaultWakeWordDetector,
} from "../src/voice/voice_service.ts";

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

async function runPhase8RefactorTests() {
  console.log("\n=======================================================");
  console.log("       JARVIS PHASE 8 REFACTOR TEST SUITE              ");
  console.log("=======================================================\n");

  const logger = new Logger("Phase8Refactor", "error");
  const mockTts = new MockTTSProvider();
  const voice = new VoiceService(logger, { tts: mockTts, initialState: "awake" });

  // -----------------------------------------------------------------
  // 1. Initial State & Status
  // -----------------------------------------------------------------
  console.log("▶ Group 1: Voice Architecture Decoupling & Initial State");
  assert(voice.getState() === "awake", "Initial voice state is 'awake'");
  const status = voice.getStatus();
  assert(status.ttsProvider === "MockTTSProvider", "Uses pluggable TTS provider");
  assert(status.wakeDetector === "DefaultWakeWordDetector", "Uses pluggable wake-word detector");

  // -----------------------------------------------------------------
  // 2. Sleep Command Processing
  // -----------------------------------------------------------------
  console.log("\n▶ Group 2: Sleep State Transition");
  const sleepRes = voice.processTranscript("Jarvis, go to sleep");
  assert(sleepRes.action === "sleep", "Recognized sleep directive");
  assert(sleepRes.proceed === false, "Does not execute prompt when transitioning to sleep");
  assert(voice.getState() === "sleeping", "Voice state transitioned to 'sleeping'");

  // -----------------------------------------------------------------
  // 3. Sleeping State Ignores Casual Speech
  // -----------------------------------------------------------------
  console.log("\n▶ Group 3: Sleeping State Isolation");
  const casualRes = voice.processTranscript("What is the current time?");
  assert(casualRes.proceed === false, "Ignored casual query while in sleep state");
  assert(voice.getState() === "sleeping", "Remains in sleeping state");

  // -----------------------------------------------------------------
  // 4. Wake-Word Activation
  // -----------------------------------------------------------------
  console.log("\n▶ Group 4: Wake-Word Detection & Activation");
  const wakeRes = voice.processTranscript("Hey Jarvis, what is the latest RTX 4050 driver?");
  assert(wakeRes.action === "wake", "Detected wake-word 'hey jarvis'");
  assert(wakeRes.proceed === true, "Allowed query to proceed after wake-up");
  assert(voice.getState() === "awake", "State transitioned to 'awake'");
  assert(wakeRes.prompt === "what is the latest RTX 4050 driver?", "Cleanly stripped wake word prefix: " + wakeRes.prompt);

  // Wake greeting alone
  voice.sleep();
  const wakeOnlyRes = voice.processTranscript("Wake up Jarvis");
  assert(wakeOnlyRes.action === "wake", "Detected wake greeting 'Wake up Jarvis'");
  assert(wakeOnlyRes.proceed === true, "Allowed greeting to proceed");
  assert(voice.getState() === "awake", "State transitioned to 'awake'");

  // -----------------------------------------------------------------
  // 5. Push-to-Talk Architecture
  // -----------------------------------------------------------------
  console.log("\n▶ Group 5: Push-to-Talk Mode");
  voice.sleep();
  assert(voice.getState() === "sleeping", "Confirmed sleeping before push-to-talk");

  voice.startPushToTalk();
  assert(voice.getStatus().isPushToTalkActive === true, "Push-to-talk marked active");
  assert(voice.getState() === "awake", "Push-to-talk automatically awakened assistant");

  voice.endPushToTalk();
  assert(voice.getStatus().isPushToTalkActive === false, "Push-to-talk deactivated");

  // -----------------------------------------------------------------
  // 6. Speech Synthesis & Instant Interruption
  // -----------------------------------------------------------------
  console.log("\n▶ Group 6: Speech Synthesis & Interruption");

  const speakPromise = voice.speak("Good day, Sir. All systems are operational.");
  assert(mockTts.spokenHistory.length === 1, "Dispatched text to TTS provider");

  voice.interrupt();
  await speakPromise;
  assert(mockTts.isCurrentlySpeaking === false, "Interrupted and silenced TTS immediately");

  // -----------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------
  console.log("\n=======================================================");
  console.log(`Phase 8 Tests Total: ${totalTests} | Passed: ${passedTests} | Failed: ${failedTests}`);
  console.log("=======================================================\n");

  if (failedTests > 0) {
    process.exit(1);
  }
}

runPhase8RefactorTests().catch((err) => {
  console.error("Test runner threw uncaught error:", err);
  process.exit(1);
});
