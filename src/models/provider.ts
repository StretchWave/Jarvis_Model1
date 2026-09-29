/**
 * JARVIS Model Abstraction Layer
 * 
 * Provides unified interfaces for FAST and AGENT model providers:
 * - MockFastProvider (zero external cost, offline, instantaneous)
 * - OpenAICompatibleProvider (OpenAI, Groq, OpenRouter, Ollama, LM Studio, etc.)
 * - OpenCodeProvider (local OpenCode daemon)
 */

import { getSystemPrompt } from "../personality.ts";
import { Logger } from "../logger.ts";
import { OpenCodeClient } from "../opencode_client.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatInput {
  messages: ChatMessage[];
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
  name: string;
  chat(input: ChatInput, signal?: AbortSignal): AsyncIterable<ChatEvent>;
  health(): Promise<boolean>;
}

/**
 * Built-in mock fast provider for offline / local conversational responses.
 * Strictly adheres to the Jarvis persona.
 */
export class MockFastProvider implements ModelProvider {
  public name = "MockFastProvider";

  public async health(): Promise<boolean> {
    return true;
  }

  public async *chat(input: ChatInput, signal?: AbortSignal): AsyncIterable<ChatEvent> {
    const lastMsg = input.messages[input.messages.length - 1]?.content.toLowerCase() || "";

    let reply = "I am at your service, Sir. How may I assist you today?";

    if (lastMsg.includes("what are you doing")) {
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
      await new Promise(r => setTimeout(r, 20));
    }

    yield { type: "done", fullText: accumulated };
  }
}

/**
 * Cloud OpenAI-compatible Fast Model Provider.
 * Works with OpenAI, Groq, Ollama, LM Studio, Together AI, etc.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  public name: string;
  private apiKey?: string;
  private baseURL: string;
  private model: string;
  private logger: Logger;

  constructor(options: { model: string; apiKey?: string; baseURL?: string; name?: string }, logger: Logger) {
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.baseURL = options.baseURL || "https://api.openai.com/v1";
    this.name = options.name || `OpenAICompatible(${this.model})`;
    this.logger = logger.forComponent("OpenAICompatibleProvider");
  }

  public async health(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.baseURL}/models`, {
        headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
        signal: AbortSignal.timeout(3000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  public async *chat(input: ChatInput, signal?: AbortSignal): AsyncIterable<ChatEvent> {
    const url = `${this.baseURL}/chat/completions`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.model,
          messages: input.messages,
          temperature: input.temperature ?? 0.7,
          max_tokens: input.maxTokens ?? 512,
          stream: true,
        }),
        signal,
      });

      if (!resp.ok) {
        const text = await resp.text();
        yield { type: "error", error: `HTTP ${resp.status}: ${text}` };
        return;
      }

      if (!resp.body) {
        yield { type: "error", error: "No response body received" };
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
            const dataStr = trimmed.substring(6);
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
      yield { type: "error", error: err.message };
    }
  }
}

/**
 * OpenCode Model Provider.
 * Wraps local OpenCode session prompt flow into the ModelProvider interface.
 */
export class OpenCodeProvider implements ModelProvider {
  public name = "OpenCodeLocalProvider";
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

  public async *chat(input: ChatInput, signal?: AbortSignal): AsyncIterable<ChatEvent> {
    // Extract last user message
    const userPrompt = input.messages[input.messages.length - 1]?.content || "";
    try {
      const session = await this.client.createSession({ title: "Jarvis Agent Task" });
      const promptRes = await this.client.sendPrompt(session.id, userPrompt);
      yield { type: "token", text: `[OpenCode Task Dispatched: ${session.id}] ` };
      yield { type: "done", fullText: `Task completed in OpenCode session ${session.id}` };
    } catch (err: any) {
      yield { type: "error", error: err.message };
    }
  }
}
