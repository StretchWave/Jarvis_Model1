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
   * Create a new session in OpenCode.
   */
  public async createSession(options?: { title?: string; agent?: string }): Promise<any> {
    if (!this.serviceInfo) this.discoverService();
    if (!this.serviceInfo) throw new Error("OpenCode service not available");

    const payload: Record<string, any> = {};
    if (options?.title) payload.title = options.title;
    if (options?.agent) payload.agent = options.agent;

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
}
