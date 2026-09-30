/**
 * JARVIS Model Abstraction Layer
 * 
 * Provides unified interfaces for FAST and AGENT model providers:
 * - ModelProvider: Unified streaming chat interface
 * - OpenAICompatibleProvider: Generic cloud/local OpenAI-compatible endpoint
 * - UnconfiguredFastProvider: Explicit error reporter when no valid model credentials are provided
 * - MockFastProvider: Explicit development and test provider (never the production default)
 * - OpenCodeProvider: Real assistant response extractor via local OpenCode daemon
 */

import { getSystemPrompt } from "../personality.ts";
import { Logger } from "../logger.ts";
import { OpenCodeClient, type OpenCodeModelRef, type OpenCodeStreamEvent, validateModelProfileAgainstCatalog } from "../opencode_client.ts";
import { type OpenCodeModelProfile } from "../config.ts";
import { type SessionManager } from "../session_manager.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatInput {
  messages: ChatMessage[];
  sessionId?: string;
  projectId?: string;
  temperature?: number;
  maxTokens?: number;
}

export type ChatEventType = "token" | "done" | "error";

export interface ChatEvent {
  type: ChatEventType;
  text?: string;
  fullText?: string;
  error?: string;
}

export interface ModelProvider {
  readonly name: string;
  chat(input: ChatInput, signal?: AbortSignal): AsyncIterable<ChatEvent>;
  health(): Promise<boolean>;
}

export type FastModelProvider = ModelProvider;
export type AgentModelProvider = ModelProvider;

/**
 * Common preset base URLs for popular OpenAI-compatible providers.
 */
export const PRESET_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  groq: "https://api.groq.com/openai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  deepseek: "https://api.deepseek.com/v1",
  mistral: "https://api.mistral.ai/v1",
  together: "https://api.together.xyz/v1",
  ollama: "http://127.0.0.1:11434/v1",
  lmstudio: "http://127.0.0.1:1234/v1",
};

/**
 * Unconfigured Model Provider.
 * Used when no API credentials or endpoints are provided.
 * Emits an explicit configuration error rather than fabricating canned answers.
 */
export class UnconfiguredFastProvider implements ModelProvider {
  public readonly name = "UnconfiguredFastProvider";
  private reason: string;

  constructor(reason?: string) {
    this.reason = reason || "FAST model is not configured. Please set the FAST_MODEL_API_KEY environment variable or configure fastModel in jarvis.config.json.";
  }

  public async health(): Promise<boolean> {
    return false;
  }

  public async *chat(input: ChatInput, signal?: AbortSignal): AsyncIterable<ChatEvent> {
    yield { type: "error", error: this.reason };
  }
}

/**
 * Built-in mock fast provider for offline development and testing.
 * MUST only be used when explicitly selected in dev/test configuration.
 */
export class MockFastProvider implements ModelProvider {
  public readonly name = "MockFastProvider";
  public readonly isDevMock = true;

  public async health(): Promise<boolean> {
    return true;
  }

  public async *chat(input: ChatInput, signal?: AbortSignal): AsyncIterable<ChatEvent> {
    const lastMsg = input.messages[input.messages.length - 1]?.content.toLowerCase() || "";
    const priorContent = input.messages.map(m => m.content.toLowerCase()).join(" ");

    let reply = "I am at your service, Sir. How may I assist you today?";

    if ((lastMsg.includes("good enough") || lastMsg.includes("is it good")) && priorContent.includes("mimo")) {
      reply = "Regarding MiMo for Jarvis, Sir: While MiMo offers competitive lightweight latency, we should evaluate its context window and tool-calling consistency before deploying it as your primary driver.";
    } else if (lastMsg.includes("what are you doing")) {
      reply = "Monitoring system diagnostics and standing by for your instructions, Sir.";
    } else if (lastMsg.includes("tell me a joke")) {
      reply = "Why do programmers prefer dark mode? Because light attracts bugs, Sir.";
    } else if (lastMsg.includes("tcp") && lastMsg.includes("udp")) {
      reply = "TCP is a connection-oriented protocol that guarantees delivery, error checking, and order of packets. UDP is connectionless, prioritizing speed and low latency over reliability, Sir.";
    } else if (lastMsg.includes("who are you") || lastMsg.includes("your name")) {
      reply = "I am JARVIS, your personal artificial intelligence assistant.";
    } else if (lastMsg.includes("thank")) {
      reply = "You are most welcome, Sir. Let me know if you need anything else.";
    } else if (lastMsg.includes("hello") || lastMsg.includes("hey jarvis") || lastMsg.includes("hi")) {
      reply = "Good day, Sir. All systems are operational.";
    } else {
      reply = `Understood, Sir. Regarding "${input.messages[input.messages.length - 1]?.content}": I am ready to assist.`;
    }

    // Stream word-by-word with micro delays to simulate natural streaming
    const words = reply.split(" ");
    let accumulated = "";

    for (let i = 0; i < words.length; i++) {
      if (signal?.aborted) return;
      const piece = (i === 0 ? "" : " ") + words[i];
      accumulated += piece;
      yield { type: "token", text: piece };
      await new Promise(r => setTimeout(r, 15));
    }

    yield { type: "done", fullText: accumulated };
  }
}

export interface OpenAICompatibleOptions {
  model: string;
  baseURL?: string;
  apiKeyEnv?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  name?: string;
}

/**
 * Generic OpenAI-Compatible Fast Model Provider.
 * Works with OpenAI, Groq, OpenRouter, Mistral, Ollama, LM Studio, etc.
 * Resolves credentials dynamically from environment variables or secure storage.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  public readonly name: string;
  private apiKey?: string;
  private apiKeyEnv?: string;
  private baseURL: string;
  private model: string;
  private customHeaders: Record<string, string>;
  private logger: Logger;

  constructor(options: OpenAICompatibleOptions, logger: Logger) {
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.apiKeyEnv = options.apiKeyEnv || "FAST_MODEL_API_KEY";
    this.customHeaders = options.headers || {};

    let rawBase = options.baseURL || "https://api.openai.com/v1";
    if (PRESET_BASE_URLS[rawBase.toLowerCase()]) {
      rawBase = PRESET_BASE_URLS[rawBase.toLowerCase()];
    }
    let base = rawBase.replace(/\/+$/, "");
    if (base.endsWith("/chat/completions")) {
      base = base.substring(0, base.length - "/chat/completions".length);
    }
    this.baseURL = base;
    this.name = options.name || `OpenAICompatible(${this.model})`;
    this.logger = logger.forComponent("OpenAICompatibleProvider");
  }

  public resolveApiKey(): string | undefined {
    if (this.apiKey) return this.apiKey;
    if (this.apiKeyEnv && process.env[this.apiKeyEnv]) {
      return process.env[this.apiKeyEnv];
    }
    return process.env.FAST_MODEL_API_KEY || process.env.OPENAI_API_KEY;
  }

  public isLocalEndpoint(): boolean {
    return (
      this.baseURL.includes("localhost") ||
      this.baseURL.includes("127.0.0.1") ||
      this.baseURL.includes("0.0.0.0")
    );
  }

  public async health(): Promise<boolean> {
    const key = this.resolveApiKey();
    if (!key && !this.isLocalEndpoint()) {
      return false;
    }

    try {
      const resp = await fetch(`${this.baseURL}/models`, {
        headers: key ? { Authorization: `Bearer ${key}` } : {},
        signal: AbortSignal.timeout(3000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  public async *chat(input: ChatInput, signal?: AbortSignal): AsyncIterable<ChatEvent> {
    const key = this.resolveApiKey();
    if (!key && !this.isLocalEndpoint()) {
      yield {
        type: "error",
        error: `FAST model is not configured. Please set the ${this.apiKeyEnv || "FAST_MODEL_API_KEY"} environment variable or configure fastModel in jarvis.config.json.`,
      };
      return;
    }

    const url = `${this.baseURL}/chat/completions`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.customHeaders,
    };
    if (key) {
      headers["Authorization"] = `Bearer ${key}`;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20000);
      
      const onAbort = () => controller.abort();
      if (signal) signal.addEventListener("abort", onAbort);

      let resp: Response;
      try {
        resp = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: this.model,
            messages: input.messages,
            temperature: input.temperature ?? 0.7,
            max_tokens: input.maxTokens ?? 512,
            stream: true,
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
        if (signal) signal.removeEventListener("abort", onAbort);
      }

      if (!resp.ok) {
        const text = await resp.text();
        yield { type: "error", error: `Cloud Model HTTP ${resp.status}: ${text}` };
        return;
      }

      if (!resp.body) {
        yield { type: "error", error: "No response body received from model endpoint" };
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let accumulated = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("data: ")) {
            const dataStr = trimmed.substring(6).trim();
            if (dataStr === "[DONE]") {
              yield { type: "done", fullText: accumulated };
              return;
            }
            try {
              const parsed = JSON.parse(dataStr);
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) {
                accumulated += delta;
                yield { type: "token", text: delta };
              }
            } catch {}
          }
        }
      }

      yield { type: "done", fullText: accumulated };
    } catch (err: any) {
      if (err.name === "AbortError") {
        yield { type: "error", error: "Model request timed out after 20s" };
      } else {
        yield { type: "error", error: err.message };
      }
    }
  }
}

/**
 * Helper to safely extract readable assistant text from OpenCode message structure.
 */
export function extractAssistantText(messages: any[]): string {
  if (!Array.isArray(messages) || messages.length === 0) {
    return "OpenCode task completed, Sir.";
  }

  // Filter for assistant messages
  const assistantMsgs = messages.filter(
    (m: any) => m.type === "assistant" || m.role === "assistant" || m.sender === "assistant"
  );
  const target = assistantMsgs.length > 0 ? assistantMsgs[assistantMsgs.length - 1] : messages[messages.length - 1];

  // Case 1: OpenCode V2 content array: [{ type: "text", text: "..." }, { type: "reasoning", ... }]
  if (Array.isArray(target.content)) {
    const textParts = target.content
      .filter((part: any) => (part.type === "text" || !part.type) && typeof (part.text || part.content) === "string")
      .map((part: any) => part.text || part.content);

    if (textParts.length > 0) {
      return textParts.join("\n\n").trim();
    }
  }

  // Case 2: Direct string content
  if (typeof target.content === "string" && target.content.trim().length > 0) {
    return target.content.trim();
  }

  // Case 3: Direct text field
  if (typeof target.text === "string" && target.text.trim().length > 0) {
    return target.text.trim();
  }

  return "Task completed in OpenCode, Sir.";
}

/**
 * OpenCode Model Provider.
 * Connects to the local OpenCode daemon and extracts genuine assistant output.
 */
export class OpenCodeProvider implements ModelProvider {
  public readonly name = "OpenCodeLocalProvider";
  private client: OpenCodeClient;
  private logger: Logger;

  constructor(client: OpenCodeClient, logger: Logger) {
    this.client = client;
    this.logger = logger.forComponent("OpenCodeProvider");
  }

  public async health(): Promise<boolean> {
    const h = await this.client.health();
    return h.ok;
  }

  public extractAssistantText(messages: any[]): string {
    return extractAssistantText(messages);
  }

  public async *chat(input: ChatInput, signal?: AbortSignal): AsyncIterable<ChatEvent> {
    const userPrompt = input.messages[input.messages.length - 1]?.content || "";
    try {
      const session = await this.client.createSession({ title: "Jarvis Agent Task" });
      await this.client.sendPrompt(session.id, userPrompt);
      const messages = await this.client.getMessages(session.id);
      const replyText = this.extractAssistantText(messages);

      // Stream the response tokens smoothly
      const words = replyText.split(" ");
      for (let i = 0; i < words.length; i++) {
        if (signal?.aborted) return;
        const part = (i === 0 ? "" : " ") + words[i];
        yield { type: "token", text: part };
        await new Promise(r => setTimeout(r, 10));
      }

      yield { type: "done", fullText: replyText };
    } catch (err: any) {
      yield { type: "error", error: err.message };
    }
  }
}

export interface OpenCodeModelProviderOptions {
  client: OpenCodeClient;
  sessionMgr?: SessionManager;
  modelProfile: OpenCodeModelProfile;
  name?: string;
}

/**
 * OpenCode Unified Model Provider.
 * Serves as the primary LLM executor for JARVIS via the local OpenCode daemon.
 * Supports configurable model profiles and real-time SSE token streaming.
 */
export class OpenCodeModelProvider implements ModelProvider {
  public readonly name: string;
  private client: OpenCodeClient;
  private sessionMgr?: SessionManager;
  private modelProfile: OpenCodeModelProfile;
  private logger: Logger;

  constructor(options: OpenCodeModelProviderOptions, logger: Logger) {
    this.client = options.client;
    this.sessionMgr = options.sessionMgr;
    this.modelProfile = options.modelProfile;
    this.name = options.name || `OpenCode(${this.modelProfile.providerID}/${this.modelProfile.modelID})`;
    this.logger = logger.forComponent("OpenCodeModelProvider");
  }

  public async health(): Promise<boolean> {
    const h = await this.client.health();
    return h.ok;
  }

  public async *chat(input: ChatInput, signal?: AbortSignal): AsyncIterable<ChatEvent> {
    const health = await this.client.health();
    if (!health.ok) {
      yield {
        type: "error",
        error: `OpenCode daemon unreachable: ${health.error || "Cannot connect to OpenCode"}`,
      };
      return;
    }

    // Validate model, provider, and variant against catalog (Requirements 12 & 13)
    const validation = await validateModelProfileAgainstCatalog(this.client, this.modelProfile, "FAST");
    if (!validation.ok) {
      yield {
        type: "error",
        error: validation.error || "FAST model validation failed",
      };
      return;
    }

    let ocSessionId: string;
    let shouldCleanup = false;

    if (this.sessionMgr) {
      try {
        ocSessionId = await this.sessionMgr.getOpenCodeSessionForContext(input.sessionId, input.projectId);
      } catch (err: any) {
        yield { type: "error", error: `Failed to acquire OpenCode session: ${err.message}` };
        return;
      }
    } else {
      try {
        const ses = await this.client.createSession({
          title: "Jarvis OpenCode Session",
          model: {
            providerID: this.modelProfile.providerID,
            id: this.modelProfile.modelID,
            variant: this.modelProfile.variant,
          },
        });
        ocSessionId = ses.id;
        shouldCleanup = true;
      } catch (err: any) {
        yield { type: "error", error: `Failed to create OpenCode session: ${err.message}` };
        return;
      }
    }

    const lastUserMsg = [...input.messages].reverse().find(m => m.role === "user");
    let promptText = lastUserMsg?.content || "";
    if (!promptText.trim()) {
      yield { type: "done", fullText: "" };
      return;
    }

    // If this session has no prior turns, include system prompt context
    try {
      const existingMsgs = await this.client.getMessages(ocSessionId);
      if (existingMsgs.length === 0) {
        const sysMsg = input.messages.find(m => m.role === "system");
        if (sysMsg && sysMsg.content) {
          promptText = `[Context: ${sysMsg.content.trim()}]\n\n${promptText}`;
        }
      }
    } catch {
      // Non-critical check, continue with promptText
    }

    try {
      for await (const ev of this.client.executePromptStream(ocSessionId, promptText, {
        model: {
          providerID: this.modelProfile.providerID,
          id: this.modelProfile.modelID,
          variant: this.modelProfile.variant || "default",
        },
        signal,
      })) {
        if (ev.type === "token") {
          yield { type: "token", text: ev.text };
        } else if (ev.type === "done") {
          yield { type: "done", fullText: ev.fullText };
        } else if (ev.type === "error") {
          yield { type: "error", error: ev.error };
        }
      }
    } catch (err: any) {
      yield { type: "error", error: `OpenCode execution failed: ${err.message}` };
    } finally {
      if (shouldCleanup) {
        this.client.deleteSession(ocSessionId).catch(() => {});
      }
    }
  }
}
