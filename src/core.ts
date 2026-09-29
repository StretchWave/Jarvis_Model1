/**
 * JARVIS Central Controller Core
 * 
 * Orchestrates all 4 Execution Paths:
 * 1. DIRECT: Deterministic OS/PC tools (zero LLM overhead)
 * 2. SEARCH: Independent web search & source extraction
 * 3. FAST: Configurable conversational LLM
 * 4. AGENT: Deep reasoning & coding with local OpenCode
 */

import { loadConfig, type JarvisConfig } from "./config.ts";
import { Logger, rootLogger } from "./logger.ts";
import { Database } from "./database.ts";
import { Router, type RoutingDecision } from "./router.ts";
import { OpenCodeClient } from "./opencode_client.ts";
import { SessionManager } from "./session_manager.ts";
import { MemoryManager } from "./memory/memory_manager.ts";
import { PermissionManager, type PermissionCheckResult } from "./permissions.ts";
import { DirectTools } from "./tools/direct_tools.ts";
import { WebSearchEngine, type SearchResult } from "./search.ts";
import { MockFastProvider, OpenAICompatibleProvider, type ModelProvider } from "./models/provider.ts";
import { AgentDispatcher, type AgentEvent } from "./agent/agent_dispatcher.ts";
import { VoiceService } from "./voice/voice_service.ts";
import { getSystemPrompt } from "./personality.ts";

export type JarvisEvent =
  | { type: "route"; route: string; reason: string; latencyMs: number }
  | { type: "progress"; message: string }
  | { type: "tool"; name: string; status: "started" | "running" | "completed"; details?: string }
  | { type: "token"; text: string }
  | { type: "confirm_required"; action: string; details: string; requestId: string }
  | { type: "done"; fullText: string; sources?: SearchResult[] }
  | { type: "error"; error: string };

export class JarvisCore {
  public config: JarvisConfig;
  public logger: Logger;
  public db: Database;
  public router: Router;
  public opencode: OpenCodeClient;
  public sessionMgr: SessionManager;
  public memoryMgr: MemoryManager;
  public perms: PermissionManager;
  public searchEngine: WebSearchEngine;
  public fastModel: ModelProvider;
  public agentDispatcher: AgentDispatcher;
  public voice: VoiceService;

  private pendingConfirmations: Map<string, { action: string; resolve: (approved: boolean) => void }> = new Map();

  constructor(customConfigPath?: string) {
    this.config = loadConfig(customConfigPath);
    this.logger = new Logger("JarvisCore", this.config.logging.level, this.config.logging.format);
    this.db = new Database(this.config.databasePath, this.logger);
    this.router = new Router();
    this.opencode = new OpenCodeClient(this.config.opencode.serviceFile, this.logger);
    this.sessionMgr = new SessionManager(this.db, this.opencode, this.logger);
    this.memoryMgr = new MemoryManager(this.db, this.logger);
    this.perms = new PermissionManager(this.db, this.logger);
    this.searchEngine = new WebSearchEngine(this.logger);
    this.agentDispatcher = new AgentDispatcher(this.sessionMgr, this.memoryMgr, this.opencode, this.logger);
    this.voice = new VoiceService(this.logger);

    // Initialize Fast Provider
    if (this.config.fastModel.provider === "openai" && this.config.fastModel.apiKey) {
      this.fastModel = new OpenAICompatibleProvider(
        {
          model: this.config.fastModel.model,
          apiKey: this.config.fastModel.apiKey,
          baseURL: this.config.fastModel.baseURL,
        },
        this.logger
      );
    } else {
      this.fastModel = new MockFastProvider();
    }
  }

  public async initialize(): Promise<void> {
    this.logger.info(`Initializing JARVIS Core v${this.config.version}...`);
    const ocHealth = await this.opencode.health();
    if (ocHealth.ok) {
      this.logger.info(`Connected to OpenCode daemon at ${ocHealth.url} (version: ${ocHealth.version}, pid: ${ocHealth.pid})`);
    } else {
      this.logger.warn(`OpenCode daemon not currently connected: ${ocHealth.error}`);
    }
  }

  /**
   * Main interaction pipeline: Routes input and executes through the appropriate path.
   */
  public async *processInput(
    userInput: string,
    sessionId?: string,
    projectId?: string,
    signal?: AbortSignal
  ): AsyncIterable<JarvisEvent> {
    const raw = userInput.trim();
    if (!raw) return;

    // 1. Get or create active session
    const session = sessionId ? this.db.getSession(sessionId) || (await this.sessionMgr.getOrCreateActiveSession("general", projectId)) : await this.sessionMgr.getOrCreateActiveSession("general", projectId);

    // 2. Intelligent Directive Processing (Memory & Tasks)
    this.memoryMgr.processDirectives(raw, projectId || session.project_id);

    // 3. Routing
    const decision = this.router.route(raw);
    yield {
      type: "route",
      route: decision.route,
      reason: decision.reason,
      latencyMs: decision.latencyMs,
    };

    // =====================================================================
    // PATH 1: DIRECT PATH (Deterministic OS/PC operations)
    // =====================================================================
    if (decision.route === "DIRECT" && decision.directAction) {
      const act = decision.directAction;
      yield { type: "progress", message: `Executing deterministic command: ${act.type}...` };

      // Permission Check
      const permCheck = this.perms.evaluate(act.type, act.payload);
      if (!permCheck.allowed && permCheck.requiresPrompt) {
        const reqId = `req_${Date.now()}`;
        yield {
          type: "confirm_required",
          action: act.type,
          details: permCheck.reason,
          requestId: reqId,
        };
        // Wait for confirmation or timeout
        const confirmed = await this.waitForConfirmation(reqId);
        if (!confirmed) {
          yield { type: "done", fullText: `Action '${act.type}' was not confirmed, Sir.` };
          return;
        }
      }

      const toolStart = Date.now();
      let toolMessage = "";

      switch (act.type) {
        case "time": {
          const res = DirectTools.getTime();
          toolMessage = res.message;
          break;
        }
        case "date": {
          const res = DirectTools.getDate();
          toolMessage = res.message;
          break;
        }
        case "calculator": {
          const res = DirectTools.calculate(act.payload.expression);
          toolMessage = res.message;
          break;
        }
        case "system_info": {
          const res = DirectTools.getSystemInfo();
          toolMessage = res.message;
          break;
        }
        case "volume_set": {
          const res = await DirectTools.volume("set", act.payload.level);
          toolMessage = res.message;
          break;
        }
        case "volume_get":
        case "volume_mute": {
          const res = await DirectTools.volume("mute");
          toolMessage = res.message;
          break;
        }
        case "media_play_pause": {
          const res = await DirectTools.media("play_pause");
          toolMessage = res.message;
          break;
        }
        case "media_next": {
          const res = await DirectTools.media("next");
          toolMessage = res.message;
          break;
        }
        case "media_prev": {
          const res = await DirectTools.media("prev");
          toolMessage = res.message;
          break;
        }
        case "app_open": {
          const res = await DirectTools.openApp(act.payload.appName);
          toolMessage = res.message;
          break;
        }
        case "app_close": {
          const res = await DirectTools.closeApp(act.payload.appName);
          toolMessage = res.message;
          break;
        }
        case "web_open": {
          const res = await DirectTools.openUrl(act.payload.url);
          toolMessage = res.message;
          break;
        }
        default: {
          toolMessage = `Executed direct command: ${act.type}`;
        }
      }

      this.db.recordToolHistory({
        id: `th_${Date.now()}`,
        session_id: session.id,
        tool_name: act.type,
        category: "system",
        input_params: JSON.stringify(act.payload || {}),
        output_result: toolMessage,
        status: "success",
        latency_ms: Date.now() - toolStart,
        created_at: Date.now(),
      });

      yield { type: "token", text: toolMessage };
      yield { type: "done", fullText: toolMessage };
      return;
    }

    // =====================================================================
    // PATH 2: SEARCH PATH (Factual web queries)
    // =====================================================================
    if (decision.route === "SEARCH") {
      yield { type: "progress", message: "Searching the web for fresh information..." };
      const q = decision.searchQuery || raw;
      const searchRes = await this.searchEngine.executeSearch(q);

      this.db.recordToolHistory({
        id: `th_${Date.now()}`,
        session_id: session.id,
        tool_name: "web_search",
        category: "search",
        input_params: JSON.stringify({ query: q }),
        output_result: searchRes.answer.substring(0, 100),
        status: "success",
        latency_ms: 100,
        created_at: Date.now(),
      });

      yield { type: "token", text: searchRes.answer };
      yield { type: "done", fullText: searchRes.answer, sources: searchRes.sources };
      return;
    }

    // =====================================================================
    // PATH 3: FAST PATH (Conversations, definitions, small talk)
    // =====================================================================
    if (decision.route === "FAST") {
      yield { type: "progress", message: "Synthesizing conversational response..." };
      let fullText = "";

      for await (const ev of this.fastModel.chat({
        messages: [
          { role: "system", content: getSystemPrompt(this.config.personality.userTitle, this.config.personality.conciseByDefault) },
          { role: "user", content: raw },
        ],
      }, signal)) {
        if (ev.type === "token" && ev.text) {
          fullText += ev.text;
          yield { type: "token", text: ev.text };
        } else if (ev.type === "done") {
          yield { type: "done", fullText: ev.fullText || fullText };
        } else if (ev.type === "error") {
          yield { type: "error", error: ev.error || "Fast model error" };
        }
      }
      return;
    }

    // =====================================================================
    // PATH 4: AGENT PATH (Deep reasoning, OpenCode coding & project tools)
    // =====================================================================
    if (decision.route === "AGENT") {
      for await (const ev of this.agentDispatcher.executeTask(raw, session.id, projectId, signal)) {
        if (ev.type === "progress") yield { type: "progress", message: ev.message };
        else if (ev.type === "tool_activity") yield { type: "tool", name: ev.tool, status: ev.status };
        else if (ev.type === "token") yield { type: "token", text: ev.text };
        else if (ev.type === "done") yield { type: "done", fullText: ev.fullText };
        else if (ev.type === "error") yield { type: "error", error: ev.error };
      }
      return;
    }
  }

  public confirmAction(requestId: string, approved: boolean): boolean {
    const pending = this.pendingConfirmations.get(requestId);
    if (pending) {
      pending.resolve(approved);
      this.pendingConfirmations.delete(requestId);
      return true;
    }
    return false;
  }

  private waitForConfirmation(requestId: string, timeoutMs: number = 30000): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingConfirmations.has(requestId)) {
          this.pendingConfirmations.delete(requestId);
          resolve(false);
        }
      }, timeoutMs);

      this.pendingConfirmations.set(requestId, {
        action: requestId,
        resolve: (approved: boolean) => {
          clearTimeout(timer);
          resolve(approved);
        },
      });
    });
  }

  public shutdown(): void {
    this.logger.info("Shutting down JARVIS Core.");
    this.db.close();
  }
}
