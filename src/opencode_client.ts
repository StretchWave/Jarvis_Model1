/**
 * JARVIS OpenCode Local Client
 * 
 * Communicates strictly with the local OpenCode daemon via official HTTP REST & SSE.
 * Dynamic discovery via service.json (port and credentials are never hard-coded).
 * All secrets are redacted and never logged.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { Logger } from "./logger.ts";

export interface ServiceInfo {
  url: string;
  pid: number;
  version: string;
  password?: string;
}

export interface OpenCodeHealth {
  ok: boolean;
  url?: string;
  version?: string;
  pid?: number;
  error?: string;
}

export interface OpenCodeModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

export interface OpenCodeModelInfo {
  id: string;
  modelID: string;
  providerID: string;
  name: string;
  family?: string;
  capabilities?: {
    tools?: boolean;
    input?: string[];
    output?: string[];
  };
}

export interface SendMessageOptions {
  model?: OpenCodeModelRef;
  agent?: string;
  metadata?: Record<string, any>;
  files?: any[];
  skills?: any[];
  resume?: boolean;
}

export type OpenCodeStreamEvent =
  | { type: "token"; text: string }
  | { type: "progress"; message: string }
  | { type: "tool_activity"; tool: string; status: "started" | "running" | "completed" }
  | { type: "done"; fullText: string }
  | { type: "error"; error: string };

export class OpenCodeClient {
  private serviceFile: string;
  private logger: Logger;
  private serviceInfo: ServiceInfo | null = null;

  constructor(serviceFile: string, logger: Logger) {
    this.serviceFile = serviceFile;
    this.logger = logger.forComponent("OpenCodeClient");
  }

  /**
   * Discover and load the local OpenCode service.json configuration dynamically.
   */
  public discoverService(): ServiceInfo | null {
    const candidates = [
      this.serviceFile,
      path.join(os.homedir(), ".local", "state", "opencode", "service.json"),
      path.join(os.homedir(), ".config", "opencode", "service.json"),
    ];

    for (const candidate of candidates) {
      if (candidate && fs.existsSync(candidate)) {
        try {
          const raw = fs.readFileSync(candidate, "utf-8");
          const parsed = JSON.parse(raw);
          if (parsed && parsed.url) {
            this.serviceInfo = {
              url: parsed.url,
              pid: parsed.pid,
              version: parsed.version,
              password: parsed.password,
            };
            this.logger.debug(`Discovered OpenCode service at ${this.serviceInfo.url} (PID: ${this.serviceInfo.pid})`);
            return this.serviceInfo;
          }
        } catch (err) {
          this.logger.warn(`Failed reading candidate service file ${candidate}:`, { error: String(err) });
        }
      }
    }

    return null;
  }

  private getAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json",
    };

    if (this.serviceInfo?.password) {
      const basic = Buffer.from(`opencode:${this.serviceInfo.password}`).toString("base64");
      headers["Authorization"] = `Basic ${basic}`;
    }

    return headers;
  }

  /**
   * Check connection to OpenCode daemon and fetch system info.
   */
  public async health(): Promise<OpenCodeHealth> {
    if (!this.serviceInfo) {
      this.discoverService();
    }

    if (!this.serviceInfo) {
      return { ok: false, error: "OpenCode service.json not found. Is OpenCode running?" };
    }

    try {
      const resp = await fetch(`${this.serviceInfo.url}/api/info`, {
        method: "GET",
        headers: this.getAuthHeaders(),
      });

      if (!resp.ok) {
        return {
          ok: false,
          error: `OpenCode /api/info returned HTTP ${resp.status} ${resp.statusText}`,
        };
      }

      const info = (await resp.json()) as any;
      return {
        ok: true,
        url: this.serviceInfo.url,
        version: info?.version || this.serviceInfo.version,
        pid: info?.pid || this.serviceInfo.pid,
      };
    } catch (err: any) {
      return {
        ok: false,
        error: `Could not connect to OpenCode daemon at ${this.serviceInfo.url}: ${err.message}`,
      };
    }
  }

  /**
   * List available models configured in OpenCode.
  /**
   * Search known local paths for the OpenCode CLI executable.
   */
  public findCliExecutable(): string | null {
    if (process.env.OPENCODE_CLI_PATH && fs.existsSync(process.env.OPENCODE_CLI_PATH)) {
      return process.env.OPENCODE_CLI_PATH;
    }
    const appData = process.env.APPDATA;
    if (appData) {
      const cliBase = path.join(appData, "ai.opencode.desktop", "cli");
      if (fs.existsSync(cliBase)) {
        try {
          const versions = fs.readdirSync(cliBase).sort().reverse();
          for (const ver of versions) {
            const candidate = path.join(cliBase, ver, "opencode-cli.exe");
            if (fs.existsSync(candidate)) return candidate;
          }
        } catch {}
      }
    }
    return null;
  }

  /**
   * Automatically verify OpenCode daemon is running; auto-starts it if the binary exists.
   */
  public async ensureDaemonRunning(): Promise<boolean> {
    const current = await this.health();
    if (current.ok) return true;

    const cliPath = this.findCliExecutable();
    if (!cliPath) {
      return false;
    }

    this.logger.info(`OpenCode daemon not running. Launching background service via ${cliPath}...`);
    try {
      const child = spawn(cliPath, ["serve", "--service"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();

      // Wait up to 5 seconds for service.json to be created and health check to pass
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 350));
        this.discoverService();
        const h = await this.health();
        if (h.ok) {
          this.logger.info(`OpenCode daemon ready at ${h.url} (PID: ${h.pid})`);
          return true;
        }
      }
    } catch (err: any) {
      this.logger.warn(`Could not auto-start OpenCode daemon: ${err.message}`);
    }

    return false;
  }

  /**
   * List available models configured in OpenCode.
   */
  public async listModels(retries = 2): Promise<OpenCodeModelInfo[]> {
    if (!this.serviceInfo) this.discoverService();
    if (!this.serviceInfo) throw new Error("OpenCode service not available");

    for (let attempt = 0; attempt <= retries; attempt++) {
      const resp = await fetch(`${this.serviceInfo.url}/api/model`, {
        method: "GET",
        headers: this.getAuthHeaders(),
      });

      if (!resp.ok) {
        throw new Error(`Failed to list OpenCode models: HTTP ${resp.status}`);
      }

      const json = (await resp.json()) as any;
      const items = Array.isArray(json) ? json : (json.data || []);
      if (items.length > 0 || attempt === retries) {
        return items.map((m: any) => ({
          id: m.id || m.modelID,
          modelID: m.modelID || m.id,
          providerID: m.providerID,
          name: m.name || m.id,
          family: m.family,
          capabilities: m.capabilities,
        }));
      }
      await new Promise(r => setTimeout(r, 600));
    }
    return [];
  }

  /**
   * Retrieve the system default model configured in OpenCode.
   */
  public async getDefaultModel(): Promise<OpenCodeModelInfo | null> {
    if (!this.serviceInfo) this.discoverService();
    if (!this.serviceInfo) return null;

    try {
      const resp = await fetch(`${this.serviceInfo.url}/api/model/default`, {
        method: "GET",
        headers: this.getAuthHeaders(),
      });
      if (!resp.ok) return null;
      const json = (await resp.json()) as any;
      const data = json.data || json;
      if (!data || !data.id) return null;
      return {
        id: data.id || data.modelID,
        modelID: data.modelID || data.id,
        providerID: data.providerID,
        name: data.name || data.id,
        family: data.family,
        capabilities: data.capabilities,
      };
    } catch {
      return null;
    }
  }

  /**
   * Create a new session in OpenCode with optional model profile and agent.
   */
  public async createSession(options?: {
    title?: string;
    agent?: string;
    model?: OpenCodeModelRef;
  }): Promise<any> {
    if (!this.serviceInfo) this.discoverService();
    if (!this.serviceInfo) throw new Error("OpenCode service not available");

    const payload: Record<string, any> = {};
    if (options?.title) payload.title = options.title;
    if (options?.agent) payload.agent = options.agent;
    if (options?.model) {
      payload.model = {
        providerID: options.model.providerID,
        id: options.model.id,
        variant: options.model.variant || "default",
      };
    }

    const resp = await fetch(`${this.serviceInfo.url}/api/session`, {
      method: "POST",
      headers: this.getAuthHeaders(),
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Failed to create OpenCode session: HTTP ${resp.status} ${text}`);
    }

    const json = await resp.json() as any;
    return json.data !== undefined ? json.data : json;
  }

  /**
   * Switch the model used by an existing OpenCode session.
   */
  public async switchSessionModel(sessionId: string, model: OpenCodeModelRef): Promise<boolean> {
    if (!this.serviceInfo) this.discoverService();
    if (!this.serviceInfo) throw new Error("OpenCode service not available");

    const resp = await fetch(`${this.serviceInfo.url}/api/session/${sessionId}/model`, {
      method: "POST",
      headers: this.getAuthHeaders(),
      body: JSON.stringify({
        model: {
          providerID: model.providerID,
          id: model.id,
          variant: model.variant || "default",
        },
      }),
    });

    return resp.ok;
  }

  /**
   * Switch the active agent used by an existing OpenCode session.
   */
  public async switchSessionAgent(sessionId: string, agent: string): Promise<boolean> {
    if (!this.serviceInfo) this.discoverService();
    if (!this.serviceInfo) throw new Error("OpenCode service not available");

    const resp = await fetch(`${this.serviceInfo.url}/api/session/${sessionId}/agent`, {
      method: "POST",
      headers: this.getAuthHeaders(),
      body: JSON.stringify({ agent }),
    });

    return resp.ok;
  }

  /**
   * Get an existing session by ID.
   */
  public async getSession(sessionId: string): Promise<any> {
    if (!this.serviceInfo) this.discoverService();
    if (!this.serviceInfo) throw new Error("OpenCode service not available");

    const resp = await fetch(`${this.serviceInfo.url}/api/session/${sessionId}`, {
      method: "GET",
      headers: this.getAuthHeaders(),
    });

    if (!resp.ok) {
      throw new Error(`Failed to get session ${sessionId}: HTTP ${resp.status}`);
    }

    const json = await resp.json() as any;
    return json.data !== undefined ? json.data : json;
  }

  /**
   * List existing sessions.
   */
  public async listSessions(): Promise<any[]> {
    if (!this.serviceInfo) this.discoverService();
    if (!this.serviceInfo) throw new Error("OpenCode service not available");

    const resp = await fetch(`${this.serviceInfo.url}/api/session`, {
      method: "GET",
      headers: this.getAuthHeaders(),
    });

    if (!resp.ok) {
      throw new Error(`Failed to list sessions: HTTP ${resp.status}`);
    }

    const json = await resp.json() as any;
    return json.data !== undefined ? json.data : json;
  }

  /**
   * Delete an existing session.
   */
  public async deleteSession(sessionId: string): Promise<boolean> {
    if (!this.serviceInfo) this.discoverService();
    if (!this.serviceInfo) throw new Error("OpenCode service not available");

    const resp = await fetch(`${this.serviceInfo.url}/api/session/${sessionId}`, {
      method: "DELETE",
      headers: this.getAuthHeaders(),
    });

    return resp.ok;
  }

  /**
   * Post a prompt to a session.
   */
  public async sendPrompt(sessionId: string, text: string): Promise<any> {
    if (!this.serviceInfo) this.discoverService();
    if (!this.serviceInfo) throw new Error("OpenCode service not available");

    const resp = await fetch(`${this.serviceInfo.url}/api/session/${sessionId}/prompt`, {
      method: "POST",
      headers: this.getAuthHeaders(),
      body: JSON.stringify({ text }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to send prompt to session ${sessionId}: HTTP ${resp.status} ${errText}`);
    }

    const json = await resp.json() as any;
    return json.data !== undefined ? json.data : json;
  }

  /**
   * Send a message to a session with model-aware options, agent selection, attachments, and metadata.
   */
  public async sendMessage(sessionId: string, prompt: string, options?: SendMessageOptions): Promise<any> {
    if (!this.serviceInfo) this.discoverService();
    if (!this.serviceInfo) throw new Error("OpenCode service not available");

    // 1. Switch model if specified
    if (options?.model) {
      await this.switchSessionModel(sessionId, options.model);
    }

    // 2. Switch agent if specified
    if (options?.agent) {
      await this.switchSessionAgent(sessionId, options.agent);
    }

    // 3. Post prompt to session
    const payload: Record<string, any> = { text: prompt };
    if (options?.metadata) payload.metadata = options.metadata;
    if (options?.files) payload.files = options.files;
    if (options?.skills) payload.skills = options.skills;
    if (options?.resume !== undefined) payload.resume = options.resume;

    const resp = await fetch(`${this.serviceInfo.url}/api/session/${sessionId}/prompt`, {
      method: "POST",
      headers: this.getAuthHeaders(),
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to send message to session ${sessionId}: HTTP ${resp.status} ${errText}`);
    }

    const json = await resp.json() as any;
    return json.data !== undefined ? json.data : json;
  }

  /**
   * Interrupt a running session task.
   */
  public async interruptSession(sessionId: string): Promise<boolean> {
    if (!this.serviceInfo) this.discoverService();
    if (!this.serviceInfo) throw new Error("OpenCode service not available");

    const resp = await fetch(`${this.serviceInfo.url}/api/session/${sessionId}/interrupt`, {
      method: "POST",
      headers: this.getAuthHeaders(),
    });

    return resp.ok;
  }

  /**
   * Retrieve messages for a session.
   */
  public async getMessages(sessionId: string): Promise<any[]> {
    if (!this.serviceInfo) this.discoverService();
    if (!this.serviceInfo) throw new Error("OpenCode service not available");

    const resp = await fetch(`${this.serviceInfo.url}/api/session/${sessionId}/message`, {
      method: "GET",
      headers: this.getAuthHeaders(),
    });

    if (!resp.ok) {
      throw new Error(`Failed to get messages: HTTP ${resp.status}`);
    }

    const json = await resp.json() as any;
    return json.data !== undefined ? json.data : json;
  }

  /**
   * Retrieve diff for a session.
   */
  public async getDiff(sessionId: string): Promise<any> {
    if (!this.serviceInfo) this.discoverService();
    if (!this.serviceInfo) throw new Error("OpenCode service not available");

    const resp = await fetch(`${this.serviceInfo.url}/api/session/${sessionId}/diff`, {
      method: "GET",
      headers: this.getAuthHeaders(),
    });

    if (!resp.ok) {
      throw new Error(`Failed to get diff: HTTP ${resp.status}`);
    }

    const json = await resp.json() as any;
    return json.data !== undefined ? json.data : json;
  }

  /**
   * List pending permission requests for a session.
   */
  public async getSessionPermissions(sessionId: string): Promise<any[]> {
    if (!this.serviceInfo) this.discoverService();
    if (!this.serviceInfo) return [];

    try {
      const resp = await fetch(`${this.serviceInfo.url}/api/session/${sessionId}/permission`, {
        method: "GET",
        headers: this.getAuthHeaders(),
      });
      if (!resp.ok) return [];
      const json = await resp.json() as any;
      return Array.isArray(json) ? json : (json?.data || []);
    } catch {
      return [];
    }
  }

  /**
   * Reply to a pending permission request in an OpenCode session.
   */
  public async replyPermission(
    sessionId: string,
    requestId: string,
    decision: "once" | "always" | "reject" = "always",
    message?: string
  ): Promise<boolean> {
    if (!this.serviceInfo) this.discoverService();
    if (!this.serviceInfo) return false;

    try {
      const resp = await fetch(`${this.serviceInfo.url}/api/session/${sessionId}/permission/${requestId}/reply`, {
        method: "POST",
        headers: {
          ...this.getAuthHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ decision, message: message || null }),
      });
      return resp.status === 204 || resp.ok;
    } catch {
      return false;
    }
  }


  /**
   * Subscribe to the OpenCode SSE event stream.
   */
  public async subscribeEvents(
    onEvent: (event: { event: string; data: any; id?: string }) => void,
    abortSignal?: AbortSignal
  ): Promise<() => void> {
    if (!this.serviceInfo) this.discoverService();
    if (!this.serviceInfo) throw new Error("OpenCode service not available");

    const headers = this.getAuthHeaders();
    headers["Accept"] = "text/event-stream";

    const controller = new AbortController();
    const signal = abortSignal || controller.signal;

    const resp = await fetch(`${this.serviceInfo.url}/api/event`, {
      method: "GET",
      headers,
      signal,
    });

    if (!resp.ok || !resp.body) {
      throw new Error(`Failed to subscribe to events: HTTP ${resp.status}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    (async () => {
      try {
        while (!signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          let currentEvent = "message";
          let currentId = "";
          let dataLines: string[] = [];

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed === "") {
              if (dataLines.length > 0) {
                const combined = dataLines.join("\n");
                try {
                  const parsed = JSON.parse(combined);
                  onEvent({ event: currentEvent, data: parsed, id: currentId || undefined });
                } catch {
                  onEvent({ event: currentEvent, data: combined, id: currentId || undefined });
                }
                dataLines = [];
                currentEvent = "message";
                currentId = "";
              }
            } else if (trimmed.startsWith("event:")) {
              currentEvent = trimmed.substring(6).trim();
            } else if (trimmed.startsWith("id:")) {
              currentId = trimmed.substring(3).trim();
            } else if (trimmed.startsWith("data:")) {
              dataLines.push(trimmed.substring(5).trim());
            }
          }
        }
      } catch (err: any) {
        if (!signal.aborted) {
          this.logger.debug("Event stream disconnected:", { error: err.message });
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }

  /**
   * Dispatches a prompt to an OpenCode session and yields incremental text and progress tokens over SSE.
   * Suppresses raw chain-of-thought and internal tool arguments.
   */
  public async *executePromptStream(
    sessionId: string,
    prompt: string,
    options?: {
      model?: OpenCodeModelRef;
      agent?: string;
      signal?: AbortSignal;
    }
  ): AsyncIterable<OpenCodeStreamEvent> {
    if (!this.serviceInfo) this.discoverService();
    if (!this.serviceInfo) {
      yield { type: "error", error: "OpenCode service not available. Is the OpenCode daemon running?" };
      return;
    }

    const health = await this.health();
    if (!health.ok) {
      yield { type: "error", error: `OpenCode daemon unreachable: ${health.error || "Cannot connect"}` };
      return;
    }

    // 1. Switch model (defaults to mimo-v2.6-flash-free if unspecified to prevent unauthenticated provider errors)
    const targetModel: OpenCodeModelRef = options?.model || {
      providerID: "opencode",
      id: "mimo-v2.6-flash-free",
      variant: "default",
    };
    try {
      await this.switchSessionModel(sessionId, targetModel);
    } catch (err: any) {
      this.logger.warn(`Failed to switch model to ${targetModel.providerID}/${targetModel.id}:`, err);
    }

    // 2. Switch agent if specified
    if (options?.agent) {
      try {
        await this.switchSessionAgent(sessionId, options.agent);
      } catch (err: any) {
        this.logger.warn(`Failed to switch agent to ${options.agent}:`, err);
      }
    }

    // 3. Queue for SSE events
    const eventQueue: OpenCodeStreamEvent[] = [];
    let isFinished = false;
    let accumulatedText = "";
    let executionError: string | null = null;
    let wakeQueue: (() => void) | null = null;
    let lastActivityTime = Date.now();

    const pushEvent = (ev: OpenCodeStreamEvent) => {
      eventQueue.push(ev);
      if (wakeQueue) {
        wakeQueue();
        wakeQueue = null;
      }
    };

    let unsubscribeSSE: (() => void) | null = null;

    try {
      unsubscribeSSE = await this.subscribeEvents((raw) => {
        const d = raw.data;
        if (!d || typeof d !== "object") return;

        // Check if event belongs to this session
        const evSessionId = d.data?.sessionID || d.data?.sessionId || d.sessionId || d.sessionID;
        if (evSessionId && evSessionId !== sessionId) {
          return;
        }

        // Reset inactivity timer on any event for this session
        lastActivityTime = Date.now();

        const evType = String(d.type || raw.event || "").toLowerCase();

        // Incremental Text Tokens
        if (evType === "session.text.delta") {
          const delta = d.data?.delta || d.data?.text;
          if (delta && typeof delta === "string") {
            accumulatedText += delta;
            pushEvent({ type: "token", text: delta });
          }
        } else if (evType === "session.text.ended") {
          const full = d.data?.text;
          if (full && typeof full === "string" && !accumulatedText) {
            accumulatedText = full;
          }
        }
        // Step and Tool Progress
        else if (evType.includes("step.started") || evType.includes("inbox.delivered")) {
          pushEvent({ type: "progress", message: "Processing request..." });
        } else if (evType.includes("tool") || d.data?.tool || d.tool || d.call?.name) {
          const tName = d.data?.tool || d.tool || d.data?.name || d.name || "Tool";
          pushEvent({ type: "tool_activity", tool: tName, status: "running" });
        }
        // Permission Request handling
        else if (evType.includes("permission")) {
          const reqId = d.data?.id || d.data?.requestID || d.id;
          if (reqId) {
            this.replyPermission(sessionId, reqId, "always").catch(() => {});
          }
        }
        // Completion or Failure
        else if (evType === "session.execution.succeeded") {
          isFinished = true;
          if (accumulatedText) {
            pushEvent({ type: "done", fullText: accumulatedText });
          }
        } else if (evType === "session.execution.failed") {
          isFinished = true;
          const errMsg = d.data?.error?.message || "OpenCode execution failed";
          executionError = errMsg;
          pushEvent({ type: "error", error: errMsg });
        }
      }, options?.signal);
    } catch (err: any) {
      this.logger.warn("SSE subscription error, falling back to message polling:", err);
    }

    try {
      // 4. Send the prompt
      const promptPromise = this.sendPrompt(sessionId, prompt);
      promptPromise.catch((err) => {
        executionError = err.message;
        isFinished = true;
        pushEvent({ type: "error", error: `Prompt dispatch failed: ${err.message}` });
      });

      // 5. Stream events from queue until finished or aborted
      const inactivityTimeoutMs = 180000; // 3-minute inactivity window for deep tool runs
      let lastPermCheck = 0;

      while (!isFinished || eventQueue.length > 0) {
        if (options?.signal?.aborted) return;

        // Proactively resolve any pending permission requests for this session
        if (Date.now() - lastPermCheck > 800) {
          lastPermCheck = Date.now();
          this.getSessionPermissions(sessionId).then(perms => {
            for (const p of perms) {
              if (p?.id) {
                this.replyPermission(sessionId, p.id, "always").catch(() => {});
              }
            }
          }).catch(() => {});
        }

        while (eventQueue.length > 0) {
          lastActivityTime = Date.now();
          const ev = eventQueue.shift()!;
          yield ev;
          if (ev.type === "done" || ev.type === "error") {
            return;
          }
        }

        if (isFinished && eventQueue.length === 0) {
          break;
        }

        if (Date.now() - lastActivityTime > inactivityTimeoutMs) {
          yield { type: "error", error: "Request timed out awaiting OpenCode response (inactivity timeout)" };
          return;
        }

        await new Promise<void>((resolve) => {
          wakeQueue = resolve;
          setTimeout(resolve, 50);
        });
      }

      await promptPromise;

      // 6. Safeguard: if finished without tokens streamed, retrieve message directly
      if (!accumulatedText && !executionError) {
        try {
          const msgs = await this.getMessages(sessionId);
          const assistantMsg = [...msgs].reverse().find((m: any) => m.type === "assistant" || m.role === "assistant");
          if (assistantMsg) {
            let extracted = "";
            if (Array.isArray(assistantMsg.content)) {
              extracted = assistantMsg.content
                .filter((p: any) => p && (p.type === "text" || (!p.type && typeof p.text === "string")))
                .map((p: any) => p.text || "")
                .join("").trim();
            } else if (typeof assistantMsg.content === "string") {
              extracted = assistantMsg.content.trim();
            }
            if (extracted) {
              accumulatedText = extracted;
              yield { type: "token", text: extracted };
            }
          }
        } catch (err: any) {
          this.logger.debug("Failed message retrieval fallback:", err);
        }
      }

      if (!executionError) {
        yield { type: "done", fullText: accumulatedText };
      }
    } finally {
      if (unsubscribeSSE) {
        unsubscribeSSE();
      }
    }
  }
}
