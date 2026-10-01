/**
 * JARVIS Central Controller Core
 * 
 * Orchestrates all 4 Execution Paths:
 * 1. DIRECT: Deterministic OS/PC tools (zero LLM overhead)
 * 2. SEARCH: Independent web search & source extraction
 * 3. FAST: Configurable conversational LLM
 * 4. AGENT: Deep reasoning & coding with local OpenCode
 */

import path from "node:path";
import { loadConfig, saveConfig, compareSemver, type JarvisConfig } from "./config.ts";
import { Logger, rootLogger } from "./logger.ts";
import { Database } from "./database.ts";
import { Router, type RoutingDecision } from "./router.ts";
import { OpenCodeClient, type OpenCodeModelRef, modelSupportsVariant } from "./opencode_client.ts";
import { SessionManager } from "./session_manager.ts";
import { MemoryManager } from "./memory/memory_manager.ts";
import { PermissionManager, type PermissionCheckResult } from "./permissions.ts";
import { DirectTools } from "./tools/direct_tools.ts";
import { WebSearchEngine, type SearchResult } from "./search.ts";
import { type ModelProvider } from "./models/provider.ts";
import { createModelExecutor } from "./models/factory.ts";
import { AgentDispatcher, type AgentEvent } from "./agent/agent_dispatcher.ts";
import { VoiceService } from "./voice/voice_service.ts";
import { ConversationContextManager } from "./context/conversation_context.ts";
import { SkillRegistry } from "./skills/registry.ts";
import { RunInspector, type TaskRun, type RecoveryResult } from "./inspector/run_inspector.ts";
import { getSystemPrompt } from "./personality.ts";
import { ArtifactManager } from "./artifacts/artifact_manager.ts";
import { ProactivePulse } from "./proactive/pulse.ts";

export type JarvisEvent =
  | { type: "route"; route: string; reason: string; latencyMs: number }
  | { type: "progress"; message: string }
  | { type: "tool"; name: string; status: "started" | "running" | "completed"; details?: string }
  | { type: "token"; text: string }
  | { type: "confirm_required"; action: string; details: string; requestId: string }
  | { type: "done"; fullText: string; sources?: SearchResult[] }
  | { type: "error"; error: string };

export interface PendingPermission {
  jarvisRequestId: string;
  sessionId: string;
  opencodeSessionId?: string;
  opencodeRequestId?: string;
  action: string;
  resources?: string[];
  details?: string;
  expiresAt: number;
  resolve: (decision: "once" | "always" | "reject") => void;
}

export class JarvisCore {
  public configPath: string;
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
  public contextMgr: ConversationContextManager;
  public skills: SkillRegistry;
  public inspector: RunInspector;
  public artifacts: ArtifactManager;
  public pulse: ProactivePulse;

  private pendingPermissions: Map<string, PendingPermission> = new Map();

  constructor(customConfigPath?: string) {
    this.configPath = customConfigPath || path.resolve(process.cwd(), "jarvis.config.json");
    this.config = loadConfig(customConfigPath);
    this.logger = new Logger("JarvisCore", this.config.logging.level, this.config.logging.format);
    this.db = new Database(this.config.databasePath, this.logger);
    this.router = new Router();
    if (this.config.models.agentWeight !== undefined) {
      this.router.setAgentWeight(this.config.models.agentWeight);
    }
    this.opencode = new OpenCodeClient(this.config.opencode.serviceFile, this.logger, {
      connectTimeoutMs: this.config.opencode.connectTimeoutMs,
      spawnIfDown: this.config.opencode.spawnIfDown,
      cliPath: this.config.opencode.cliPath,
      disableGlobalDiscovery: this.config.opencode.disableGlobalDiscovery,
      legacyProtocolMode: this.config.opencode.legacyProtocolMode,
    });
    this.sessionMgr = new SessionManager(this.db, this.opencode, this.logger);
    this.memoryMgr = new MemoryManager(this.db, this.logger);
    this.perms = new PermissionManager(this.db, this.logger);
    this.searchEngine = new WebSearchEngine(this.logger);
    this.contextMgr = new ConversationContextManager(this.db, this.logger);
    this.skills = new SkillRegistry(this.logger);
    this.inspector = new RunInspector(this.db, this.logger);
    this.agentDispatcher = new AgentDispatcher(this.sessionMgr, this.memoryMgr, this.opencode, this.logger, this.config.models.agent);
    this.voice = new VoiceService(this.logger);
    this.artifacts = new ArtifactManager(this.db, this.logger, this.config.artifacts?.storageDir);
    this.pulse = new ProactivePulse(this.db, this.opencode, this.logger, {
      enabled: this.config.proactivePulse?.enabled ?? false,
      intervalMs: this.config.proactivePulse?.intervalMs,
    });

    // Initialize unified OpenCode Model Executor
    this.fastModel = createModelExecutor({
      config: this.config,
      client: this.opencode,
      sessionMgr: this.sessionMgr,
      profileType: "fast",
      logger: this.logger,
    });
  }

  public async initialize(): Promise<void> {
    this.logger.info(`Initializing JARVIS Core v${this.config.version}...`);

    const cliFound = this.opencode.findCliExecutable();
    const daemonStarted = await this.opencode.ensureDaemonRunning();
    const ocHealth = await this.opencode.health();

    if (ocHealth.ok) {
      this.logger.info(`Connected to OpenCode daemon at ${ocHealth.url} (version: ${ocHealth.version}, pid: ${ocHealth.pid})`);

      if (this.config.opencode.legacyProtocolMode === undefined && ocHealth.version && !this.config.opencode.disableGlobalDiscovery) {
        const isLegacy = compareSemver(ocHealth.version, "2.1.0") < 0;
        if (isLegacy) {
          this.logger.info(`Live OpenCode daemon version ${ocHealth.version} (< 2.1.0) detected; activating legacy unnested prompt mode.`);
          this.opencode.legacyProtocolMode = true;
        }
      }

      // 1. Validate configured OpenCode model profiles
      try {
        const availableModels = await this.opencode.listModels();
        const fastTarget = `${this.config.models.fast.providerID}/${this.config.models.fast.modelID}`;
        const agentTarget = `${this.config.models.agent.providerID}/${this.config.models.agent.modelID}`;

        const hasFast = availableModels.some((m) => `${m.providerID}/${m.id}` === fastTarget || m.id === this.config.models.fast.modelID);
        const hasAgent = availableModels.some((m) => `${m.providerID}/${m.id}` === agentTarget || m.id === this.config.models.agent.modelID);

        if (hasFast) {
          this.logger.info(`Verified FAST model profile: ${fastTarget}`);
        } else {
          this.logger.warn(`Configured FAST model '${fastTarget}' not found in OpenCode catalog (${availableModels.length} models available).`);
        }

        if (hasAgent) {
          this.logger.info(`Verified AGENT model profile: ${agentTarget}`);
        } else {
          this.logger.warn(`Configured AGENT model '${agentTarget}' not found in OpenCode catalog.`);
        }
      } catch (err: any) {
        this.logger.warn("OpenCode model catalog check failed:", { error: err.message });
      }

      // 2. Validate configured OpenCode agent profile
      try {
        const availableAgents = await this.opencode.listAgents({ primaryOnly: true });
        const targetAgent = this.config.models.agent.agentID || "build";
        const hasAgentId = availableAgents.some((a) => a.id === targetAgent);

        if (hasAgentId) {
          this.logger.info(`Verified AGENT primary agent: ${targetAgent}`);
        } else {
          this.logger.warn(`Configured primary agent '${targetAgent}' not found in OpenCode agents catalog (${availableAgents.map((a) => a.id).join(", ")}).`);
        }
      } catch (err: any) {
        this.logger.warn("OpenCode agent catalog check failed:", { error: err.message });
      }

      // 3. Reconcile active session model/agent state across startup (Requirements 10 & 14)
      try {
        const active = await this.sessionMgr.getOrCreateActiveSession("general");
        const ocSessionId = await this.sessionMgr.ensureOpenCodeSession(active.id).catch(() => active.opencode_session_id || null);
        if (ocSessionId) {
          const sessionState = await this.opencode.getSession(ocSessionId);
          const currentModel = sessionState?.model;
          const currentAgent = sessionState?.agent;

          const targetModel = {
            providerID: this.config.models.fast.providerID,
            id: this.config.models.fast.modelID,
            variant: this.config.models.fast.variant || "default",
          };

          const targetVariant = targetModel.variant || "default";
          const currentVariant = currentModel?.variant || "default";
          const modelMatches =
            currentModel &&
            currentModel.providerID === targetModel.providerID &&
            (currentModel.id === targetModel.id || currentModel.modelID === targetModel.id) &&
            (!currentModel.variant || currentVariant === targetVariant);

          if (!modelMatches) {
            this.logger.info(`Reconciling session model from ${currentModel ? `${currentModel.providerID}/${currentModel.id}` : "none"} to ${targetModel.providerID}/${targetModel.id}...`);
            try {
              await this.opencode.switchSessionModel(ocSessionId, targetModel);
              this.logger.info(`Session model successfully reconciled to ${targetModel.providerID}/${targetModel.id}`);
            } catch (switchErr: any) {
              this.logger.error(`Startup model reconciliation failed for session ${ocSessionId}: ${switchErr.message}`);
            }
          } else {
            this.logger.info(`Session model already aligned with configured FAST model (${targetModel.providerID}/${targetModel.id})`);
          }

          const targetAgent = this.config.models.agent.agentID || "build";
          if (currentAgent !== targetAgent) {
            this.logger.info(`Reconciling session agent from "${currentAgent}" to "${targetAgent}"...`);
            try {
              await this.opencode.switchSessionAgent(ocSessionId, targetAgent);
              this.logger.info(`Session agent successfully reconciled to "${targetAgent}"`);
            } catch (agentErr: any) {
              this.logger.error(`Startup agent reconciliation failed for session ${ocSessionId}: ${agentErr.message}`);
            }
          } else {
            this.logger.info(`Session agent already aligned with configured AGENT agent ("${targetAgent}")`);
          }
        }
      } catch (err: any) {
        this.logger.error(`Startup session reconciliation failed: ${err.message}`);
      }
    } else {
      // Diagnostic human-readable error reporting (Requirement 19)
      if (!cliFound) {
        this.logger.error("OpenCode is not installed on this system or the CLI executable could not be resolved. Please install OpenCode or configure OPENCODE_CLI_PATH.");
      } else if (!daemonStarted && this.config.opencode.spawnIfDown) {
        this.logger.error(`OpenCode daemon failed to start via ${cliFound}. Please run 'opencode service start' or 'npm run daemon:opencode' manually.`);
      } else {
        this.logger.warn(`OpenCode daemon not currently connected: ${ocHealth.error}`);
      }
    }
  }

  public updateModels(
    models: { fast?: any; agent?: any; agentWeight?: number; creativityWeight?: number },
    persist: boolean = true
  ): void {
    if (!persist) {
      return;
    }
    if (models.fast) {
      this.config.models.fast = { ...this.config.models.fast, ...models.fast };
      this.fastModel = createModelExecutor({
        config: this.config,
        client: this.opencode,
        sessionMgr: this.sessionMgr,
        profileType: "fast",
        logger: this.logger,
      });
      this.logger.info(`Updated active FAST model to ${this.config.models.fast.providerID}/${this.config.models.fast.modelID}`);
    }
    if (models.agent) {
      this.config.models.agent = { ...this.config.models.agent, ...models.agent };
      this.agentDispatcher = new AgentDispatcher(
        this.sessionMgr,
        this.memoryMgr,
        this.opencode,
        this.logger,
        this.config.models.agent
      );
      this.logger.info(`Updated active AGENT model to ${this.config.models.agent.providerID}/${this.config.models.agent.modelID} (agent: ${this.config.models.agent.agentID || "build"})`);
    }
    if (typeof models.agentWeight === "number") {
      this.config.models.agentWeight = models.agentWeight;
      this.router.setAgentWeight(models.agentWeight);
      this.logger.info(`Updated router agent weight to ${models.agentWeight}`);
    }

    try {
      saveConfig(this.config, this.configPath);
      this.logger.info(`Persisted configuration to ${this.configPath}`);
    } catch (err: any) {
      this.logger.error(`Failed to persist configuration to ${this.configPath}: ${err.message}`);
      throw err;
    }
  }

  public async switchSessionModel(sessionId: string, model: OpenCodeModelRef): Promise<void> {
    const ocSessionId = await this.sessionMgr.ensureOpenCodeSession(sessionId);
    await this.opencode.switchSessionModel(ocSessionId, model);
  }

  public async switchSessionAgent(sessionId: string, agentId: string): Promise<void> {
    const ocSessionId = await this.sessionMgr.ensureOpenCodeSession(sessionId);
    await this.opencode.switchSessionAgent(ocSessionId, agentId);
  }

  public requestConfirmation(params: {
    sessionId: string;
    opencodeSessionId?: string;
    opencodeRequestId?: string;
    action: string;
    resources?: string[];
    details?: string;
    timeoutMs?: number;
  }): { requestId: string; promise: Promise<"once" | "always" | "reject"> } {
    const jarvisRequestId = `perm_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const timeoutMs = params.timeoutMs ?? 30000;
    const expiresAt = Date.now() + timeoutMs;

    let resolver!: (decision: "once" | "always" | "reject") => void;
    const promise = new Promise<"once" | "always" | "reject">((resolve) => {
      resolver = resolve;
    });

    const timer = setTimeout(() => {
      if (this.pendingPermissions.has(jarvisRequestId)) {
        const p = this.pendingPermissions.get(jarvisRequestId);
        this.pendingPermissions.delete(jarvisRequestId);
        this.logger.warn(`Permission request ${jarvisRequestId} timed out; defaulting to 'reject'`);
        resolver("reject");
        if (p?.opencodeSessionId && p?.opencodeRequestId) {
          this.opencode.replyPermission(p.opencodeSessionId, p.opencodeRequestId, "reject").catch(() => {});
        }
      }
    }, timeoutMs);

    this.pendingPermissions.set(jarvisRequestId, {
      jarvisRequestId,
      sessionId: params.sessionId,
      opencodeSessionId: params.opencodeSessionId,
      opencodeRequestId: params.opencodeRequestId,
      action: params.action,
      resources: params.resources,
      details: params.details,
      expiresAt,
      resolve: (decision: "once" | "always" | "reject") => {
        clearTimeout(timer);
        resolver(decision);
      },
    });

    return { requestId: jarvisRequestId, promise };
  }

  public getPendingPermissions(): PendingPermission[] {
    return Array.from(this.pendingPermissions.values());
  }

  public confirmAction(requestId: string, decision: "once" | "always" | "reject" | boolean): boolean {
    let pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      for (const p of this.pendingPermissions.values()) {
        if (p.opencodeRequestId === requestId) {
          pending = p;
          break;
        }
      }
    }
    if (!pending) return false;

    if (Date.now() > pending.expiresAt) {
      this.pendingPermissions.delete(pending.jarvisRequestId);
      pending.resolve("reject");
      if (pending.opencodeSessionId && pending.opencodeRequestId) {
        this.opencode.replyPermission(pending.opencodeSessionId, pending.opencodeRequestId, "reject").catch(() => {});
      }
      return false;
    }

    let dec: "once" | "always" | "reject";
    if (typeof decision === "boolean") {
      dec = decision ? "once" : "reject";
    } else {
      dec = decision;
    }

    this.pendingPermissions.delete(pending.jarvisRequestId);
    pending.resolve(dec);

    if (pending.opencodeSessionId && pending.opencodeRequestId) {
      this.opencode.replyPermission(pending.opencodeSessionId, pending.opencodeRequestId, dec).catch((err) => {
        this.logger.warn(`Failed sending OpenCode permission reply for ${pending.opencodeRequestId}:`, err);
      });
    }
    return true;
  }

  private async waitForConfirmation(requestId: string, timeoutMs: number = 30000): Promise<boolean> {
    const { promise } = this.requestConfirmation({
      sessionId: "direct",
      action: requestId,
      details: `Permission requested for direct action ${requestId}`,
      timeoutMs,
    });
    const decision = await promise;
    return decision !== "reject";
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
    if (projectId || session.project_id) {
      this.contextMgr.setProject(session.id, projectId || session.project_id);
    }

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

    // 4. Initialize Run Inspector tracking
    const taskRun = this.inspector.startRun({
      sessionId: session.id,
      route: decision.route,
      modelProvider: decision.route === "FAST" ? this.fastModel.name : (decision.route === "AGENT" ? "OpenCode" : undefined),
      initialOperation: `Routing: ${decision.route}`,
    });

    // =====================================================================
    // PATH 1: DIRECT PATH (Deterministic OS/PC operations)
    // =====================================================================
    if (decision.route === "DIRECT" && decision.directAction) {
      const act = decision.directAction;
      this.inspector.updateOperation(taskRun.runId, `Executing deterministic command: ${act.type}`);
      yield { type: "progress", message: `Executing deterministic command: ${act.type}...` };

      // Permission Check
      const permCheck = this.perms.evaluate(act.type, act.payload);
      if (!permCheck.allowed && permCheck.requiresPrompt) {
        const { requestId: reqId, promise: permPromise } = this.requestConfirmation({
          sessionId: session.id,
          action: act.type,
          details: permCheck.reason,
        });

        yield {
          type: "confirm_required",
          action: act.type,
          details: permCheck.reason,
          requestId: reqId,
        };

        const decisionResult = await permPromise;
        if (decisionResult === "reject") {
          this.inspector.failRun(taskRun.runId, `Action '${act.type}' was not confirmed`);
          yield { type: "done", fullText: `Action '${act.type}' was not confirmed, Sir.` };
          return;
        }
      }

      const toolStart = Date.now();
      let toolMessage = "";

      const skillRes = await this.skills.executeAction(act.type, act.payload);
      if (skillRes.message !== `Unknown skill action: ${act.type}`) {
        toolMessage = skillRes.message;
      } else {
        toolMessage = `Executed direct command: ${act.type}`;
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

      this.inspector.recordToolEvent(taskRun.runId, act.type, "completed", toolMessage);
      this.contextMgr.addTurn(session.id, "user", raw, "DIRECT");
      this.contextMgr.addTurn(session.id, "assistant", toolMessage, "DIRECT");
      this.inspector.completeRun(taskRun.runId, toolMessage);

      yield { type: "token", text: toolMessage };
      yield { type: "done", fullText: toolMessage };
      return;
    }

    // =====================================================================
    // PATH 2: SEARCH PATH (Factual web queries)
    // =====================================================================
    if (decision.route === "SEARCH") {
      this.inspector.updateOperation(taskRun.runId, "Searching the web for fresh information");
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

      this.inspector.recordToolEvent(taskRun.runId, "web_search", "completed", q);
      this.contextMgr.addTurn(session.id, "user", raw, "SEARCH");
      this.contextMgr.addTurn(session.id, "assistant", searchRes.answer, "SEARCH");
      this.inspector.completeRun(taskRun.runId, searchRes.answer);

      yield { type: "token", text: searchRes.answer };
      yield { type: "done", fullText: searchRes.answer, sources: searchRes.sources };
      return;
    }

    // =====================================================================
    // PATH 3: FAST PATH (Conversations, definitions, small talk)
    // =====================================================================
    if (decision.route === "FAST") {
      this.inspector.updateOperation(taskRun.runId, "Synthesizing conversational response");
      yield { type: "progress", message: "Synthesizing conversational response..." };
      let fullText = "";

      const chatMessages = this.contextMgr.buildPromptMessages(raw, session.id, {
        systemPrompt: getSystemPrompt(this.config.personality.userTitle, this.config.personality.conciseByDefault),
        maxTurns: 6,
        activeProject: projectId || session.project_id,
      });

      for await (const ev of this.fastModel.chat({
        messages: chatMessages,
        sessionId: session.id,
        projectId: projectId || session.project_id,
      }, signal)) {
        if (ev.type === "token" && ev.text) {
          fullText += ev.text;
          yield { type: "token", text: ev.text };
        } else if (ev.type === "done") {
          const finalAns = ev.fullText || fullText;
          this.contextMgr.addTurn(session.id, "user", raw, "FAST");
          this.contextMgr.addTurn(session.id, "assistant", finalAns, "FAST");
          this.inspector.completeRun(taskRun.runId, finalAns);
          yield { type: "done", fullText: finalAns };
        } else if (ev.type === "error") {
          this.inspector.failRun(taskRun.runId, ev.error || "Fast model error");
          yield { type: "error", error: ev.error || "Fast model error" };
          yield { type: "done", fullText: `FAST model error: ${ev.error}` };
          return;
        }
      }
      return;
    }

    // =====================================================================
    // PATH 4: AGENT PATH (Deep reasoning, OpenCode coding & project tools)
    // =====================================================================
    if (decision.route === "AGENT") {
      let agentFinalText = "";

      for await (const ev of this.agentDispatcher.executeTask(raw, session.id, projectId, signal)) {
        if (ev.type === "confirm_required") {
          const { requestId: jarvisRequestId } = this.requestConfirmation({
            sessionId: session.id,
            opencodeSessionId: ev.opencodeSessionId,
            opencodeRequestId: ev.requestId,
            action: ev.action,
            details: ev.details,
            resources: ev.resources,
          });
          yield {
            type: "confirm_required",
            action: ev.action,
            details: ev.details,
            requestId: jarvisRequestId,
          };
        } else if (ev.type === "progress") {
          this.inspector.updateOperation(taskRun.runId, ev.message);
          yield { type: "progress", message: ev.message };
        } else if (ev.type === "tool_activity") {
          this.inspector.recordToolEvent(taskRun.runId, ev.tool, ev.status);
          yield { type: "tool", name: ev.tool, status: ev.status };
        } else if (ev.type === "token") {
          yield { type: "token", text: ev.text };
        } else if (ev.type === "done") {
          agentFinalText = ev.fullText;
          this.inspector.completeRun(taskRun.runId, agentFinalText);
          yield { type: "done", fullText: ev.fullText };
        } else if (ev.type === "error") {
          this.inspector.failRun(taskRun.runId, ev.error);
          yield { type: "error", error: ev.error };
        }
      }
      if (agentFinalText) {
        this.contextMgr.addTurn(session.id, "user", raw, "AGENT");
        this.contextMgr.addTurn(session.id, "assistant", agentFinalText, "AGENT");
      }
      return;
    }
  }

  public async recoverSession(sessionId: string): Promise<RecoveryResult> {
    return await this.inspector.recoverSession(sessionId, this.opencode);
  }

  public shutdown(): void {
    this.logger.info("Shutting down JARVIS Core.");
    this.pulse.stop();
    this.db.close();
  }
}
