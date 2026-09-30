/**
 * JARVIS Agent Mode Dispatcher
 * 
 * Orchestrates deep reasoning and coding tasks with OpenCode:
 * - Compact context assembly (user, project, memories, active task, rules)
 * - Logical session mapping to OpenCode
 * - OpenCode primary agent selection
 * - Safe progress indicators
 * - Safe streaming without raw internal chain-of-thought exposure
 * - Permission confirmation flow
 */

import { SessionManager } from "../session_manager.ts";
import { MemoryManager } from "../memory/memory_manager.ts";
import { OpenCodeClient, type OpenCodeModelRef, validateModelProfileAgainstCatalog } from "../opencode_client.ts";
import { formatContextPrompt } from "../personality.ts";
import { Logger } from "../logger.ts";
import { type OpenCodeModelProfile } from "../config.ts";

export type AgentEvent =
  | { type: "progress"; message: string }
  | { type: "tool_activity"; tool: string; status: "started" | "running" | "completed" }
  | { type: "token"; text: string }
  | { type: "confirm_required"; action: string; details: string; requestId: string; opencodeSessionId?: string; resources?: string[] }
  | { type: "done"; fullText: string }
  | { type: "error"; error: string };

export class AgentDispatcher {
  private sessionMgr: SessionManager;
  private memoryMgr: MemoryManager;
  private client: OpenCodeClient;
  private logger: Logger;
  private agentModelProfile?: OpenCodeModelProfile;

  constructor(
    sessionMgr: SessionManager,
    memoryMgr: MemoryManager,
    client: OpenCodeClient,
    logger: Logger,
    agentModelProfile?: OpenCodeModelProfile
  ) {
    this.sessionMgr = sessionMgr;
    this.memoryMgr = memoryMgr;
    this.client = client;
    this.logger = logger.forComponent("AgentDispatcher");
    this.agentModelProfile = agentModelProfile || {
      providerID: "opencode",
      modelID: "mimo-v2.6-flash-free",
      variant: "default",
      agentID: "build",
    };
  }

  public setAgentModelProfile(profile: OpenCodeModelProfile): void {
    this.agentModelProfile = profile;
  }

  public getAgentModelProfile(): OpenCodeModelProfile | undefined {
    return this.agentModelProfile;
  }

  /**
   * Translate raw OpenCode SSE events into friendly, high-level user status messages.
   * Suppresses raw chain-of-thought, file dumps, and JSON payloads.
   */
  public translateEvent(rawEvent: { event: string; data: any }, targetSessionId: string): AgentEvent | null {
    const { event, data } = rawEvent;
    if (!data) return null;

    // Filter events to target session
    const evSessionId = data.sessionID || data.sessionId || data.data?.sessionID || data.data?.sessionId;
    if (evSessionId && evSessionId !== targetSessionId) {
      return null;
    }

    const eventType = String(data.type || event || "").toLowerCase();

    // 1. Tool Call Events
    if (eventType.includes("tool") || data.tool || data.name || data.call) {
      const toolName = String(data.tool || data.name || data.call?.name || "").toLowerCase();

      if (toolName.includes("read") || toolName.includes("view") || toolName.includes("cat")) {
        return { type: "progress", message: "Reading project files..." };
      }
      if (toolName.includes("blueprint") || toolName.includes("unreal") || toolName.includes("uasset")) {
        return { type: "progress", message: "Inspecting Blueprint & animation state..." };
      }
      if (toolName.includes("test") || toolName.includes("exec") || toolName.includes("bash") || toolName.includes("command")) {
        return { type: "progress", message: "Running tests and diagnostics..." };
      }
      if (toolName.includes("edit") || toolName.includes("write") || toolName.includes("patch") || toolName.includes("fix")) {
        return { type: "progress", message: "Applying code modifications..." };
      }
      if (toolName.includes("search") || toolName.includes("grep") || toolName.includes("find")) {
        return { type: "progress", message: "Searching codebase..." };
      }
      if (toolName) {
        return { type: "tool_activity", tool: data.tool || data.name || "Tool", status: "running" };
      }
    }

    // 2. Status / Progress lifecycle events
    if (eventType.includes("start") || eventType.includes("init")) {
      return { type: "progress", message: "Connecting to OpenCode engine..." };
    }
    if (eventType.includes("planning") || eventType.includes("analysis")) {
      return { type: "progress", message: "Analyzing project files and code..." };
    }

    // Suppress reasoning, CoT tokens, internal chunks
    return null;
  }

  /**
   * Execute an AGENT task through the paired OpenCode session with live genuine progress & token streaming.
   */
  public async *executeTask(
    userPrompt: string,
    jarvisSessionId: string,
    projectId?: string,
    signal?: AbortSignal
  ): AsyncIterable<AgentEvent> {
    this.logger.info(`Starting Agent task in session ${jarvisSessionId}: "${userPrompt.substring(0, 60)}..."`);
    yield { type: "progress", message: "Connecting to OpenCode engine..." };

    // 1. Ensure active OpenCode session
    let ocSessionId: string;
    try {
      ocSessionId = await this.sessionMgr.ensureOpenCodeSession(jarvisSessionId);
    } catch (err: any) {
      yield { type: "error", error: `Failed to connect to OpenCode session: ${err.message}` };
      return;
    }

    // 2. Strict runtime model validation against catalog
    if (this.agentModelProfile) {
      const valRes = await validateModelProfileAgainstCatalog(this.client, this.agentModelProfile, "AGENT");
      if (!valRes.ok) {
        yield { type: "error", error: valRes.error || "AGENT model validation failed" };
        return;
      }
    }

    // 3. Assemble compact context package
    const project = projectId ? this.memoryMgr.getProject(projectId) : null;
    const memories = this.memoryMgr.recall(userPrompt, projectId, 3).map((m) => ({
      category: m.category,
      key: m.key,
      content: m.content,
    }));
    const activeTasks = this.memoryMgr.listTasks("in_progress", projectId);
    const currentTask = activeTasks.length > 0 ? activeTasks[0].title : undefined;

    const contextHeader = formatContextPrompt({
      userTitle: "Sir",
      projectName: project?.name,
      memories,
      currentTask,
      capabilities: ["filesystem", "command_execution", "code_analysis", "git"],
    });

    const packagedPrompt = `${contextHeader}\n\nTask:\n${userPrompt}`;

    yield { type: "progress", message: "Analyzing task requirements with OpenCode Agent..." };

    // 4. Genuine real-time streaming via OpenCode executePromptStream
    let accumulatedText = "";
    try {
      const modelRef: OpenCodeModelRef | undefined = this.agentModelProfile
        ? {
            providerID: this.agentModelProfile.providerID,
            id: this.agentModelProfile.modelID,
            variant: this.agentModelProfile.variant || "default",
          }
        : undefined;

      const targetAgent = this.agentModelProfile?.agentID || "build";

      for await (const ev of this.client.executePromptStream(ocSessionId, packagedPrompt, {
        model: modelRef,
        agent: targetAgent,
        signal,
      })) {
        if (ev.type === "permission_request") {
          yield {
            type: "confirm_required",
            action: ev.action,
            details: ev.details || `Permission required for ${ev.action}`,
            requestId: ev.requestId,
            opencodeSessionId: ocSessionId,
            resources: ev.resources,
          };
        } else if (ev.type === "progress") {
          yield { type: "progress", message: ev.message };
        } else if (ev.type === "tool_activity") {
          const translated = this.translateEvent({ event: "tool_call", data: { tool: ev.tool } }, ocSessionId);
          if (translated && translated.type === "progress") {
            yield translated;
          }
          yield { type: "tool_activity", tool: ev.tool, status: ev.status };
        } else if (ev.type === "token") {
          accumulatedText += ev.text;
          yield { type: "token", text: ev.text };
        } else if (ev.type === "done") {
          yield { type: "tool_activity", tool: "OpenCode Engine", status: "completed" };
          const finalAns = ev.fullText || accumulatedText;
          yield { type: "done", fullText: finalAns };
          return;
        } else if (ev.type === "error") {
          yield { type: "error", error: ev.error };
          return;
        }
      }

      if (!accumulatedText) {
        yield { type: "done", fullText: "" };
      }
    } catch (err: any) {
      this.logger.error("Agent execution failed:", err);
      yield { type: "error", error: `Agent execution failed: ${err.message}` };
    }
  }
}
