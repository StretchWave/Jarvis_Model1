/**
 * Phase 2 Verification Test Suite - Model/Provider Abstraction, Factory & OpenCode Extraction
 */

import * as http from "node:http";
import { Logger } from "../src/logger.ts";
import {
  PRESET_BASE_URLS,
  OpenAICompatibleProvider,
  MockFastProvider,
  UnconfiguredFastProvider,
  OpenCodeProvider,
  extractAssistantText,
} from "../src/models/provider.ts";
import { createFastModelProvider, createAgentModelProvider } from "../src/models/factory.ts";
import { OpenCodeClient } from "../src/opencode_client.ts";

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

async function runPhase2RefactorTests() {
  console.log("\n=======================================================");
  console.log("       JARVIS PHASE 2 REFACTOR TEST SUITE              ");
  console.log("=======================================================\n");

  const logger = new Logger("Phase2Refactor", "error");

  // -----------------------------------------------------------------
  // 1. Preset Base URL Mapping
  // -----------------------------------------------------------------
  console.log("▶ Group 1: Preset Base URL Mapping");
  assert(PRESET_BASE_URLS["openai"] === "https://api.openai.com/v1", "OpenAI preset URL is mapped correctly");
  assert(PRESET_BASE_URLS["groq"] === "https://api.groq.com/openai/v1", "Groq preset URL is mapped correctly");
  assert(PRESET_BASE_URLS["openrouter"] === "https://openrouter.ai/api/v1", "OpenRouter preset URL is mapped correctly");
  assert(PRESET_BASE_URLS["deepseek"] === "https://api.deepseek.com/v1", "DeepSeek preset URL is mapped correctly");
  assert(PRESET_BASE_URLS["ollama"] === "http://127.0.0.1:11434/v1", "Ollama local preset URL is mapped correctly");

  const pGroq = new OpenAICompatibleProvider({ model: "llama-3-70b", baseURL: "groq" }, logger);
  assert((pGroq as any).baseURL === "https://api.groq.com/openai/v1", "Provider normalizes 'groq' alias to full baseURL");

  const pOllama = new OpenAICompatibleProvider({ model: "llama3", baseURL: "ollama" }, logger);
  assert((pOllama as any).baseURL === "http://127.0.0.1:11434/v1", "Provider normalizes 'ollama' alias to full baseURL");

  // -----------------------------------------------------------------
  // 2. Factory Pattern for Fast Model Providers
  // -----------------------------------------------------------------
  console.log("\n▶ Group 2: Model Provider Factory Functionality");

  const mockFast = createFastModelProvider({ provider: "mock", model: "dev-test" }, logger);
  assert(mockFast instanceof MockFastProvider, "createFastModelProvider creates MockFastProvider for 'mock'");

  const cloudFast = createFastModelProvider({
    provider: "openai-compatible",
    model: "gpt-4o",
    baseURL: "openai",
    apiKey: "test-direct-key",
    headers: { "X-Test-Header": "JarvisTest" },
  }, logger);
  assert(cloudFast instanceof OpenAICompatibleProvider, "createFastModelProvider creates OpenAICompatibleProvider for 'openai-compatible'");
  assert((cloudFast as any).customHeaders?.["X-Test-Header"] === "JarvisTest", "Custom headers propagated to OpenAICompatibleProvider");

  const unconfiguredFast = createFastModelProvider({ provider: "unconfigured", model: "none" }, logger);
  assert(unconfiguredFast instanceof UnconfiguredFastProvider, "createFastModelProvider creates UnconfiguredFastProvider for 'unconfigured'");

  // -----------------------------------------------------------------
  // 3. Agent Model Factory
  // -----------------------------------------------------------------
  console.log("\n▶ Group 3: Agent Model Provider Factory");
  const dummyClient = new OpenCodeClient("dummy.json", logger);
  const agentProvider = createAgentModelProvider(dummyClient, logger);
  assert(agentProvider instanceof OpenCodeProvider, "createAgentModelProvider creates OpenCodeProvider");
  assert(agentProvider.name === "OpenCodeLocalProvider", "OpenCodeProvider has correct name identifier");

  // -----------------------------------------------------------------
  // 4. OpenCode V2 Assistant Response & CoT Extraction
  // -----------------------------------------------------------------
  console.log("\n▶ Group 4: Assistant Text Extraction (Reasoning & Tool Suppression)");

  // Scenario A: OpenCode V2 with separate reasoning and text parts
  const v2MsgWithCoT = [
    { role: "user", content: "What is 2+2?" },
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "The user is asking a basic arithmetic question. Let me think: 2+2=4." },
        { type: "text", text: "The answer is 4, Sir." }
      ]
    }
  ];
  const extractedCoT = extractAssistantText(v2MsgWithCoT);
  assert(extractedCoT === "The answer is 4, Sir.", "extractAssistantText extracts only text part, omitting internal reasoning");

  // Scenario B: OpenCode V2 with tool invocation parts alongside text
  const v2MsgWithTools = [
    { role: "user", content: "Read foo.txt" },
    {
      role: "assistant",
      content: [
        { type: "tool", name: "read_file", args: { path: "foo.txt" } },
        { type: "text", text: "I have read foo.txt, Sir. The file is empty." }
      ]
    }
  ];
  const extractedTools = extractAssistantText(v2MsgWithTools);
  assert(extractedTools === "I have read foo.txt, Sir. The file is empty.", "extractAssistantText suppresses tool objects and returns text");

  // Scenario C: Traditional string content
  const stringMsg = [
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Greetings, Sir." }
  ];
  assert(extractAssistantText(stringMsg) === "Greetings, Sir.", "extractAssistantText handles classic string content");

  // Scenario D: Direct text property
  const directTextMsg = [
    { role: "user", content: "Hello" },
    { role: "assistant", text: "Ready for your instructions, Sir." }
  ];
  assert(extractAssistantText(directTextMsg) === "Ready for your instructions, Sir.", "extractAssistantText handles direct text property");

  // Scenario E: Empty array fallback
  assert(typeof extractAssistantText([]) === "string", "extractAssistantText handles empty messages gracefully");

  // -----------------------------------------------------------------
  // 5. Custom Headers HTTP Verification
  // -----------------------------------------------------------------
  console.log("\n▶ Group 5: Custom Headers Verification over HTTP");
  let receivedHeader = "";
  const testServer = http.createServer((req, res) => {
    receivedHeader = (req.headers["x-custom-jarvis-auth"] as string) || "";
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "Header received." } }] }) + "\n\n");
    res.write("data: [DONE]\n\n");
    res.end();
  });

  await new Promise<void>((resolve) => testServer.listen(39123, "127.0.0.1", resolve));

  try {
    const customHeaderProvider = new OpenAICompatibleProvider(
      {
        model: "test-model",
        baseURL: "http://127.0.0.1:39123/v1",
        apiKey: "test-key",
        headers: { "x-custom-jarvis-auth": "secret-token-1234" },
      },
      logger
    );

    let fullOutput = "";
    for await (const event of customHeaderProvider.chat({ messages: [{ role: "user", content: "test" }] })) {
      if (event.type === "token") fullOutput += event.text;
    }

    assert(receivedHeader === "secret-token-1234", "Server received custom headers correctly");
    assert(fullOutput === "Header received.", "Server streamed response through provider with custom headers");
  } finally {
    await new Promise<void>((resolve) => testServer.close(() => resolve()));
  }

  // -----------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------
  console.log("\n=======================================================");
  console.log(`Phase 2 Tests Total: ${totalTests} | Passed: ${passedTests} | Failed: ${failedTests}`);
  console.log("=======================================================\n");

  if (failedTests > 0) {
    process.exit(1);
  }
}

runPhase2RefactorTests().catch((err) => {
  console.error("Test runner threw uncaught error:", err);
  process.exit(1);
});
