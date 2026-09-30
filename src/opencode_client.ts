/**
 * JARVIS OpenCode Local Client
 * 
 * Communicates strictly with the local OpenCode daemon via official HTTP REST & SSE.
 * Dynamic discovery via service.json (port and credentials are never hard-coded).
 * Implements bounded timeouts, robust service resolution, canonical prompt protocol,
 * strict model/agent switching, and real agent/model discovery.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { Logger } from "./logger.ts";
import { compareSemver, findOpenCodeCli } from "./config.ts";

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
  variants?: any[];
  status?: string;
  enabled?: boolean;
  cost?: any[];
  limit?: {
    context?: number;
    output?: number;
  };
}

export interface OpenCodeAgentInfo {
  id: string;
  name: string;
  description?: string;
  mode: "primary" | "subagent" | string;
  hidden?: boolean;
  disabled?: boolean;
  tools?: string[];
  permissions?: any;
  model?: OpenCodeModelRef;
}

export interface PromptSessionRequest {
  text: string;
  files?: any[];
  agents?: any[];
  skills?: any[];
  metadata?: Record<string, any>;
  delivery?: any;
  resume?: boolean;
}

export interface SendMessageOptions {
  model?: OpenCodeModelRef;
  agent?: string;
  metadata?: Record<string, any>;
  files?: any[];
  skills?: any[];
  resume?: boolean;
}

export interface RequestOptions {
  method?: string;
  body?: any;
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type OpenCodeStreamEvent =
  | { type: "token"; text: string }
  | { type: "progress"; message: string }
  | { type: "tool_activity"; tool: string; status: "started" | "running" | "completed" }
  | { type: "permission_request"; requestId: string; sessionId: string; action: string; details?: string; resources?: string[] }
  | { type: "done"; fullText: string }
  | { type: "error"; error: string };

export class OpenCodeError extends Error {
  public status: number;
  public code?: string;
  public details?: any;

  constructor(message: string, status: number = 500, code?: string, details?: any) {
    super(message);
    this.name = "OpenCodeError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class OpenCodeClient {
  private serviceFile: string;
  private logger: Logger;
  private serviceInfo: ServiceInfo | null = null;
  public connectTimeoutMs: number;
  public spawnIfDown: boolean;
  private disableGlobalDiscovery: boolean;

  constructor(
    serviceFileOrOptions?: string | {
      serviceFile?: string;
      connectTimeoutMs?: number;
      spawnIfDown?: boolean;
      cliPath?: string;
      disableGlobalDiscovery?: boolean;
    },
    logger?: Logger,
    options?: {
      connectTimeoutMs?: number;
      spawnIfDown?: boolean;
      cliPath?: string;
      disableGlobalDiscovery?: boolean;
    }
  ) {
    if (typeof serviceFileOrOptions === "object" && serviceFileOrOptions !== null) {
      this.serviceFile = serviceFileOrOptions.serviceFile || "";
      this.connectTimeoutMs = serviceFileOrOptions.connectTimeoutMs ?? 5000;
      this.spawnIfDown = serviceFileOrOptions.spawnIfDown ?? true;
      this.cliPath = serviceFileOrOptions.cliPath;
      this.disableGlobalDiscovery = Boolean(serviceFileOrOptions.disableGlobalDiscovery);
    } else {
      this.serviceFile = typeof serviceFileOrOptions === "string" ? serviceFileOrOptions : "";
      this.connectTimeoutMs = options?.connectTimeoutMs ?? 5000;
      this.spawnIfDown = options?.spawnIfDown ?? true;
      this.cliPath = options?.cliPath;
      this.disableGlobalDiscovery = Boolean(options?.disableGlobalDiscovery);
    }

    const log = logger || new Logger("OpenCodeClient", "info");
    this.logger = log.forComponent("OpenCodeClient");
  }

  public getServiceInfo(): ServiceInfo | null {
    return this.serviceInfo;
  }

  public setServiceInfo(info: ServiceInfo | null): void {
    this.serviceInfo = info;
  }

  /**
   * Search known local paths for the OpenCode CLI executable using semver resolution.
   */
  public findCliExecutable(): string | null {
    if (this.cliPath && fs.existsSync(this.cliPath)) {
      return this.cliPath;
    }
    const detected = findOpenCodeCli();
    return detected || null;
  }

  /**
   * Robust service resolution that never retains a stale dead service entry.
   * 1. Explicit configured service file if it exists and is healthy.
   * 2. Standard OpenCode shared service registration (~/.local/state/opencode/service.json).
   * 3. Revalidates the endpoint after discovery.
   * 4. If a discovered service is unhealthy, invalidates cached serviceInfo.
   * 5. Does not edit or delete OpenCode's service files.
   */
  public async resolveService(): Promise<ServiceInfo | null> {
    const candidates: string[] = [];

    // 1. Explicit configured service file
    if (this.serviceFile) {
      candidates.push(this.serviceFile);
    }

    // 2. Standard shared service registration path (unless global discovery disabled for testing)
    if (!this.disableGlobalDiscovery) {
      const sharedPath = path.join(os.homedir(), ".local", "state", "opencode", "service.json");
      if (!candidates.includes(sharedPath)) {
        candidates.push(sharedPath);
      }

      // Secondary fallback path
      const fallbackPath = path.join(os.homedir(), ".config", "opencode", "service.json");
      if (!candidates.includes(fallbackPath)) {
        candidates.push(fallbackPath);
      }
    }

    for (const candidate of candidates) {
      if (candidate && fs.existsSync(candidate)) {
        try {
          const raw = fs.readFileSync(candidate, "utf-8");
          const parsed = JSON.parse(raw);
          if (parsed && parsed.url) {
            const tempInfo: ServiceInfo = {
              url: parsed.url,
              pid: parsed.pid,
              version: parsed.version,
              password: parsed.password,
            };

            // Revalidate endpoint after discovery
            const isAlive = await this.testEndpointAlive(tempInfo);
            if (isAlive) {
              this.serviceInfo = tempInfo;
              this.logger.debug(`Resolved live OpenCode service at ${this.serviceInfo.url} (PID: ${this.serviceInfo.pid})`);
              return this.serviceInfo;
            } else {
              this.logger.debug(`Candidate service file ${candidate} pointed to dead endpoint ${tempInfo.url}, ignoring stale entry.`);
            }
          }
        } catch (err: any) {
          this.logger.debug(`Failed reading candidate service file ${candidate}:`, { error: err.message });
        }
      }
    }

    // Invalidate stale cached service info
    this.serviceInfo = null;
    return null;
  }

  /**
   * Discover service without throwing (backward compatibility for synchronous call sites).
   */
  public discoverService(): ServiceInfo | null {
    if (this.serviceInfo) return this.serviceInfo;

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
            return this.serviceInfo;
          }
        } catch {}
      }
    }

    return null;
  }

  private async testEndpointAlive(info: ServiceInfo): Promise<boolean> {
    const controller = new AbortController();
    const timeout = Math.min(this.connectTimeoutMs, 2000);
    const timer = setTimeout(() => controller.abort(new Error("Alive check timeout")), timeout);

    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (info.password) {
        headers["Authorization"] = `Basic ${Buffer.from(`opencode:${info.password}`).toString("base64")}`;
      }
      const resp = await fetch(`${info.url}/api/info`, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
      return resp.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
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
   * Bounded HTTP request helper with timeout, authentication, cancellation, and typed error handling.
   */
  public async request<T = any>(endpoint: string, options: RequestOptions = {}): Promise<T> {
    if (!this.serviceInfo) {
      await this.resolveService();
    }
    if (!this.serviceInfo) {
      throw new OpenCodeError("OpenCode service not available", 503, "ServiceUnavailable");
    }

    const timeoutMs = options.timeoutMs ?? this.connectTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`OpenCode request to ${endpoint} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    let abortCleanup: (() => void) | null = null;
    if (options.signal) {
      if (options.signal.aborted) {
        clearTimeout(timer);
        throw options.signal.reason || new Error("Request aborted");
      }
      const onExternalAbort = () => {
        clearTimeout(timer);
        controller.abort(options.signal?.reason);
      };
      options.signal.addEventListener("abort", onExternalAbort, { once: true });
      abortCleanup = () => options.signal?.removeEventListener("abort", onExternalAbort);
    }

    const url = endpoint.startsWith("http") ? endpoint : `${this.serviceInfo.url}${endpoint}`;
    const headers = { ...this.getAuthHeaders(), ...(options.headers || {}) };
    let body = options.body;
    if (body !== undefined && typeof body !== "string") {
      body = JSON.stringify(body);
    }

    try {
      this.logger.debug(`HTTP ${options.method || "GET"} ${endpoint}`);
      const resp = await fetch(url, {
        method: options.method || "GET",
        headers,
        body,
        signal: controller.signal,
      });

      if (resp.status === 204) {
        return undefined as unknown as T;
      }

      const text = await resp.text();
      let data: any;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = text;
      }

      if (!resp.ok) {
        const errorMsg = data?.message || (typeof data === "string" ? data : `HTTP ${resp.status} ${resp.statusText}`);
        throw new OpenCodeError(errorMsg, resp.status, data?._tag || data?.error, data);
      }

      return (data?.data !== undefined && !endpoint.includes("/prompt")) ? data.data : data;
    } catch (err: any) {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        const msg = reason?.message || String(reason) || `Request timed out after ${timeoutMs}ms`;
        throw new OpenCodeError(msg, 408, "TimeoutError");
      }
      if (err instanceof OpenCodeError) throw err;
      throw new OpenCodeError(`OpenCode request failed: ${err.message}`, 502, "NetworkError", { cause: err });
    } finally {
      clearTimeout(timer);
      if (abortCleanup) abortCleanup();
    }
  }

  /**
   * Ensures OpenCode daemon is running respecting config.opencode.spawnIfDown.
   */
  public async ensureDaemonRunning(): Promise<boolean> {
    const current = await this.health();
    if (current.ok) return true;

    // Respect spawnIfDown configuration
    if (!this.spawnIfDown) {
      this.logger.debug("OpenCode daemon is down and spawnIfDown=false; will not spawn daemon.");
      return false;
    }

    const cliPath = this.findCliExecutable();
    if (!cliPath) {
      this.logger.warn("OpenCode daemon is not running and OpenCode CLI executable could not be located.");
      return false;
    }

    this.logger.info(`Starting OpenCode background service via ${cliPath}...`);

    // 1. Prefer OpenCode supported service lifecycle: opencode service start
    let serviceStarted = false;
    try {
      const child = spawn(cliPath, ["service", "start"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
      serviceStarted = true;
    } catch (err: any) {
      this.logger.debug(`'service start' failed: ${err.message}; trying 'serve --service' fallback`);
    }

    if (!serviceStarted) {
      try {
        const fallback = spawn(cliPath, ["serve", "--service"], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        });
        fallback.unref();
      } catch (err: any) {
        this.logger.warn(`Could not spawn OpenCode service: ${err.message}`);
        return false;
      }
    }

    // Wait for service registration and verify health
    const maxWaitMs = 6000;
    const intervalMs = 300;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      await new Promise((r) => setTimeout(r, intervalMs));
      const resolved = await this.resolveService();
      if (resolved) {
        const h = await this.health();
        if (h.ok) {
          this.logger.info(`OpenCode daemon ready at ${h.url} (PID: ${h.pid})`);
          return true;
        }
      }
    }

    this.logger.warn(`OpenCode daemon failed to become healthy within ${maxWaitMs}ms.`);
    return false;
  }

  /**
   * Check connection to OpenCode daemon and fetch system info.
   */
  public async health(): Promise<OpenCodeHealth> {
    if (!this.serviceInfo) {
      await this.resolveService();
    }
    if (!this.serviceInfo) {
      return { ok: false, error: "OpenCode service not found or dead. Is OpenCode running?" };
    }

    try {
      const info = await this.request<any>("/api/info", {
        method: "GET",
        timeoutMs: this.connectTimeoutMs,
      });
      return {
        ok: true,
        url: this.serviceInfo.url,
        version: info?.version || this.serviceInfo.version,
        pid: info?.pid || this.serviceInfo.pid,
      };
    } catch (err: any) {
      this.serviceInfo = null;
      return {
        ok: false,
        error: `Could not connect to OpenCode daemon: ${err.message}`,
      };
    }
  }

  /**
   * List available models configured in OpenCode.
   */
  public async listModels(retries = 2): Promise<OpenCodeModelInfo[]> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const json = await this.request<any>("/api/model", {
          method: "GET",
          timeoutMs: this.connectTimeoutMs,
        });
        const items = Array.isArray(json) ? json : (json?.data || []);
        if (items.length > 0 || attempt === retries) {
          return items.map((m: any) => ({
            id: m.id || m.modelID,
            modelID: m.modelID || m.id,
            providerID: m.providerID,
            name: m.name || m.id,
            family: m.family,
            capabilities: m.capabilities,
            variants: m.variants,
            status: m.status,
            enabled: m.enabled,
            cost: m.cost,
            limit: m.limit,
          }));
        }
      } catch (err: any) {
        if (attempt === retries) throw err;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return [];
  }

  /**
   * Retrieve registered agents from OpenCode.
   * Exposes only usable primary agents by default (mode === "primary" && !hidden && !disabled).
   */
  public async listAgents(options: { primaryOnly?: boolean } = { primaryOnly: true }): Promise<OpenCodeAgentInfo[]> {
    const json = await this.request<any>("/api/agent", {
      method: "GET",
      timeoutMs: this.connectTimeoutMs,
    });
    const items: any[] = Array.isArray(json) ? json : (json?.data || []);
    let agents: OpenCodeAgentInfo[] = items.map((a: any) => ({
      id: a.id,
      name: a.name || a.id,
      description: a.description,
      mode: a.mode || "primary",
      hidden: Boolean(a.hidden),
      disabled: Boolean(a.disabled),
      tools: a.tools,
      permissions: a.permissions,
      model: a.model,
    }));

    if (options.primaryOnly) {
      agents = agents.filter((a) => a.mode === "primary" && !a.hidden && !a.disabled);
    }
    return agents;
  }

  /**
   * Retrieve the system default model configured in OpenCode.
   */
  public async getDefaultModel(): Promise<OpenCodeModelInfo | null> {
    try {
      const data = await this.request<any>("/api/model/default", {
        method: "GET",
        timeoutMs: this.connectTimeoutMs,
      });
      if (!data || !data.id) return null;
      return {
        id: data.id || data.modelID,
        modelID: data.modelID || data.id,
        providerID: data.providerID,
        name: data.name || data.id,
        family: data.family,
        capabilities: data.capabilities,
        variants: data.variants,
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

    return this.request("/api/session", {
      method: "POST",
      body: payload,
      timeoutMs: this.connectTimeoutMs,
    });
  }

  /**
   * Switch the model used by an existing OpenCode session.
   * Expects HTTP 204. Throws typed OpenCodeError on failure.
   */
  public async switchSessionModel(sessionId: string, model: OpenCodeModelRef): Promise<void> {
    try {
      await this.request(`/api/session/${sessionId}/model`, {
        method: "POST",
        body: {
          model: {
            providerID: model.providerID,
            id: model.id,
            variant: model.variant || "default",
          },
        },
        timeoutMs: this.connectTimeoutMs,
      });
    } catch (err: any) {
      throw new OpenCodeError(
        `Failed to switch session ${sessionId} to model ${model.providerID}/${model.id} (variant: ${model.variant || "default"}): ${err.message}`,
        err.status || 500,
        "ModelSwitchError",
        { providerID: model.providerID, modelID: model.id, variant: model.variant, status: err.status, message: err.message }
      );
    }
  }

  /**
   * Switch the active agent used by an existing OpenCode session.
   * Expects HTTP 204. Throws typed OpenCodeError on failure.
   */
  public async switchSessionAgent(sessionId: string, agent: string): Promise<void> {
    try {
      await this.request(`/api/session/${sessionId}/agent`, {
        method: "POST",
        body: { agent },
        timeoutMs: this.connectTimeoutMs,
      });
    } catch (err: any) {
      throw new OpenCodeError(
        `Failed to switch session ${sessionId} to agent '${agent}': ${err.message}`,
        err.status || 500,
        "AgentSwitchError",
        { agent, status: err.status, message: err.message }
      );
    }
  }

  /**
   * Get an existing session by ID.
   */
  public async getSession(sessionId: string): Promise<any> {
    return this.request(`/api/session/${sessionId}`, {
      method: "GET",
      timeoutMs: this.connectTimeoutMs,
    });
  }

  /**
   * List existing sessions.
   */
  public async listSessions(): Promise<any[]> {
    return this.request(`/api/session`, {
      method: "GET",
      timeoutMs: this.connectTimeoutMs,
    });
  }

  /**
   * Delete an existing session.
   */
  public async deleteSession(sessionId: string): Promise<boolean> {
    try {
      await this.request(`/api/session/${sessionId}`, {
        method: "DELETE",
        timeoutMs: this.connectTimeoutMs,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Canonical prompt method conforming to OpenCode v2 protocol.
   * Request body includes { prompt: { text, ... }, text: ... } to satisfy all validators.
   */
  public async promptSession(sessionId: string, req: PromptSessionRequest, options: RequestOptions = {}): Promise<any> {
    const payload: Record<string, any> = {
      prompt: {
        text: req.text,
        ...(req.files ? { files: req.files } : {}),
        ...(req.agents ? { agents: req.agents } : {}),
        ...(req.skills ? { skills: req.skills } : {}),
        ...(req.delivery ? { delivery: req.delivery } : {}),
        ...(req.resume !== undefined ? { resume: req.resume } : {}),
      },
      text: req.text,
    };
    if (req.files) payload.files = req.files;
    if (req.agents) payload.agents = req.agents;
    if (req.skills) payload.skills = req.skills;
    if (req.metadata) payload.metadata = req.metadata;
    if (req.delivery) payload.delivery = req.delivery;
    if (req.resume !== undefined) payload.resume = req.resume;

    return this.request(`/api/session/${sessionId}/prompt`, {
      method: "POST",
      body: payload,
      timeoutMs: options.timeoutMs ?? this.connectTimeoutMs,
      signal: options.signal,
    });
  }

  public async sendPrompt(sessionId: string, prompt: string, options?: RequestOptions): Promise<any> {
    return this.promptSession(sessionId, { text: prompt }, options);
  }

  public async sendMessage(sessionId: string, prompt: string, options?: SendMessageOptions & RequestOptions): Promise<any> {
    if (options?.model) {
      await this.switchSessionModel(sessionId, options.model);
    }
    if (options?.agent) {
      await this.switchSessionAgent(sessionId, options.agent);
    }
    return this.promptSession(
      sessionId,
      {
        text: prompt,
        files: options?.files,
        agents: options?.agent ? [{ id: options.agent }] : undefined,
        skills: options?.skills,
        metadata: options?.metadata,
        resume: options?.resume,
      },
      options
    );
  }

  /**
   * Interrupt a running session task.
   */
  public async interruptSession(sessionId: string): Promise<boolean> {
    try {
      await this.request(`/api/session/${sessionId}/interrupt`, {
        method: "POST",
        timeoutMs: this.connectTimeoutMs,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Retrieve messages for a session.
   */
  public async getMessages(sessionId: string): Promise<any[]> {
    return this.request(`/api/session/${sessionId}/message`, {
      method: "GET",
      timeoutMs: this.connectTimeoutMs,
    });
  }

  /**
   * Retrieve diff for a session.
   */
  public async getDiff(sessionId: string): Promise<any> {
    return this.request(`/api/session/${sessionId}/diff`, {
      method: "GET",
      timeoutMs: this.connectTimeoutMs,
    });
  }

  /**
   * List pending permission requests for a session.
   */
  public async getSessionPermissions(sessionId: string): Promise<any[]> {
    try {
      const json = await this.request(`/api/session/${sessionId}/permission`, {
        method: "GET",
        timeoutMs: this.connectTimeoutMs,
      });
      return Array.isArray(json) ? json : (json?.data || []);
    } catch {
      return [];
    }
  }

  /**
   * Reply to a pending permission request in an OpenCode session.
   * Conforms to OpenCode v2 permission protocol: { reply, decision }.
   */
  public async replyPermission(
    sessionId: string,
    requestId: string,
    reply: "once" | "always" | "reject",
    message?: string
  ): Promise<void> {
    const body: Record<string, any> = {
      reply,
      decision: reply,
    };
    if (message) body.message = message;

    try {
      await this.request(`/api/session/${sessionId}/permission/${requestId}/reply`, {
        method: "POST",
        body,
        timeoutMs: this.connectTimeoutMs,
      });
    } catch (err: any) {
      throw new OpenCodeError(
        `Failed to reply to permission request ${requestId}: ${err.message}`,
        err.status || 500,
        "PermissionReplyError",
        { sessionId, requestId, reply, status: err.status }
      );
    }
  }

  /**
   * Subscribe to the OpenCode SSE event stream with complete lifecycle management.
   * Internal AbortController links to external signal. Unsubscribe always aborts.
   * Reader cancelled in finally.
   */
  public async subscribeEvents(
    onEvent: (event: { event: string; data: any; id?: string }) => void,
    externalSignal?: AbortSignal
  ): Promise<() => void> {
    if (!this.serviceInfo) await this.resolveService();
    if (!this.serviceInfo) throw new OpenCodeError("OpenCode service not available", 503, "ServiceUnavailable");

    const headers = this.getAuthHeaders();
    headers["Accept"] = "text/event-stream";

    const internalController = new AbortController();
    const onExternalAbort = () => internalController.abort(externalSignal?.reason);

    if (externalSignal) {
      if (externalSignal.aborted) {
        internalController.abort(externalSignal.reason);
      } else {
        externalSignal.addEventListener("abort", onExternalAbort, { once: true });
      }
    }

    let resp: Response;
    try {
      resp = await fetch(`${this.serviceInfo.url}/api/event`, {
        method: "GET",
        headers,
        signal: internalController.signal,
      });
    } catch (err: any) {
      if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
      throw err;
    }

    if (!resp.ok || !resp.body) {
      if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
      throw new OpenCodeError(`Failed to subscribe to events: HTTP ${resp.status}`, resp.status, "SSEConnectionError");
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    (async () => {
      try {
        while (!internalController.signal.aborted) {
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
        if (!internalController.signal.aborted) {
          this.logger.debug("Event stream disconnected:", { error: err.message });
        }
      } finally {
        try {
          await reader.cancel().catch(() => {});
        } catch {}
        if (externalSignal) {
          externalSignal.removeEventListener("abort", onExternalAbort);
        }
      }
    })();

    return () => {
      if (!internalController.signal.aborted) {
        internalController.abort();
      }
      if (externalSignal) {
        externalSignal.removeEventListener("abort", onExternalAbort);
      }
    };
  }

  /**
   * Dispatches a prompt to an OpenCode session and yields incremental text and progress tokens over SSE.
   * Implements strict model/agent switching, state machine execution tracking, inactivity timeout,
   * permission event routing, and clean stream termination without fabricating output.
   */
  public async *executePromptStream(
    sessionId: string,
    prompt: string,
    options?: {
      model?: OpenCodeModelRef;
      agent?: string;
      signal?: AbortSignal;
      onPermissionRequest?: (perm: {
        opencodeSessionId: string;
        opencodeRequestId: string;
        action: string;
        details?: string;
        resources?: string[];
      }) => Promise<"once" | "always" | "reject">;
    }
  ): AsyncIterable<OpenCodeStreamEvent> {
    if (options?.signal?.aborted) {
      yield { type: "error", error: "Execution cancelled before start" };
      return;
    }

    const health = await this.health();
    if (!health.ok) {
      yield { type: "error", error: `OpenCode daemon unreachable: ${health.error || "Cannot connect"}` };
      return;
    }

    // 1. Strict model switch: failure aborts execution immediately
    if (options?.model) {
      try {
        await this.switchSessionModel(sessionId, options.model);
      } catch (err: any) {
        yield { type: "error", error: err.message };
        return;
      }
    }

    // 2. Strict agent switch: failure aborts execution immediately
    if (options?.agent) {
      try {
        await this.switchSessionAgent(sessionId, options.agent);
      } catch (err: any) {
        yield { type: "error", error: err.message };
        return;
      }
    }

    // 3. Execution State Machine: idle -> dispatching -> running -> streaming -> completed/failed
    type StreamState = "idle" | "dispatching" | "running" | "streaming" | "completed" | "failed" | "cancelled" | "timed_out";
    let state: StreamState = "idle";

    const eventQueue: OpenCodeStreamEvent[] = [];
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

        const evSessionId = d.data?.sessionID || d.data?.sessionId || d.sessionId || d.sessionID;
        if (evSessionId && evSessionId !== sessionId) {
          return;
        }

        lastActivityTime = Date.now();
        const evType = String(d.type || raw.event || "").toLowerCase();

        // Incremental Text Tokens
        if (evType === "session.text.delta") {
          state = "streaming";
          const delta = d.data?.delta || d.data?.text;
          this.logger.debug(`[executePromptStream SSE] received text.delta: "${delta}"`);
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
          if (state === "dispatching") state = "running";
          pushEvent({ type: "progress", message: "Processing request..." });
        } else if (evType.includes("tool") || d.data?.tool || d.tool || d.call?.name) {
          state = "running";
          const tName = d.data?.tool || d.tool || d.data?.name || d.name || "Tool";
          pushEvent({ type: "tool_activity", tool: tName, status: "running" });
        }
        // Permission Request handling: NEVER silently grant 'always'
        else if (evType.includes("permission")) {
          const reqId = d.data?.id || d.data?.requestID || d.id;
          const act = d.data?.action || d.data?.tool || "Tool execution";
          if (reqId) {
            if (options?.onPermissionRequest) {
              options.onPermissionRequest({
                opencodeSessionId: sessionId,
                opencodeRequestId: reqId,
                action: act,
                details: d.data?.details || d.data?.reason,
                resources: d.data?.resources,
              }).then((decision) => {
                this.replyPermission(sessionId, reqId, decision).catch((err) => {
                  this.logger.warn(`Failed replying to permission request ${reqId}:`, err);
                });
              }).catch(() => {
                this.replyPermission(sessionId, reqId, "reject").catch(() => {});
              });
            } else {
              // Emit event to stream consumer for confirmation
              pushEvent({
                type: "permission_request",
                requestId: reqId,
                sessionId,
                action: act,
                details: d.data?.details || d.data?.reason,
                resources: d.data?.resources,
              });
            }
          }
        }
        // Completion or Failure
        else if (evType === "session.execution.succeeded") {
          state = "completed";
          if (accumulatedText) {
            pushEvent({ type: "done", fullText: accumulatedText });
          }
        } else if (evType === "session.execution.failed") {
          state = "failed";
          const errMsg = d.data?.error?.message || "OpenCode execution failed";
          executionError = errMsg;
          pushEvent({ type: "error", error: errMsg });
        }
      }, options?.signal);
    } catch (err: any) {
      this.logger.warn("SSE subscription error, falling back to message polling:", err);
    }

    try {
      // 4. Send canonical prompt
      state = "dispatching";
      const promptPromise = this.promptSession(sessionId, { text: prompt }, { signal: options?.signal });
      promptPromise.then(() => {
        if (state === "dispatching") state = "running";
      }).catch((err) => {
        executionError = err.message;
        state = "failed";
        pushEvent({ type: "error", error: `Prompt dispatch failed: ${err.message}` });
      });

      // 5. Stream events until completed, failed, or timed out
      const inactivityTimeoutMs = 180000; // 3-minute inactivity window for deep tool runs

      while (
        (state !== "completed" && state !== "failed" && state !== "cancelled" && state !== "timed_out") ||
        eventQueue.length > 0
      ) {
        if (options?.signal?.aborted) {
          state = "cancelled";
          yield { type: "error", error: "Execution cancelled by user" };
          return;
        }

        while (eventQueue.length > 0) {
          lastActivityTime = Date.now();
          const ev = eventQueue.shift()!;
          yield ev;
          if (ev.type === "done" || ev.type === "error") {
            return;
          }
        }

        if (state === "completed" && eventQueue.length === 0) {
          break;
        }

        if (Date.now() - lastActivityTime > inactivityTimeoutMs) {
          state = "timed_out";
          yield { type: "error", error: "Request timed out awaiting OpenCode response (inactivity timeout)" };
          return;
        }

        await new Promise<void>((resolve) => {
          wakeQueue = resolve;
          setTimeout(resolve, 50);
        });
      }

      await promptPromise.catch(() => {});

      // 6. Terminal Handling: If completed without streamed tokens, retrieve message directly
      if (!accumulatedText && !executionError && state !== "failed" && state !== "cancelled") {
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

      if (!executionError && state !== "failed" && state !== "cancelled") {
        yield { type: "done", fullText: accumulatedText };
      }
    } finally {
      if (unsubscribeSSE) {
        unsubscribeSSE();
      }
    }
  }
}
