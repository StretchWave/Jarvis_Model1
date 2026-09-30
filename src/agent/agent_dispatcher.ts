/**
 * JARVIS Agent Mode Dispatcher
 * 
 * Orchestrates deep reasoning and coding tasks with OpenCode:
 * - Compact context assembly (user, project, memories, active task, rules)
 * - Logical session mapping to OpenCode
 * - SSE event translation to safe progress indicators
 * - Safe streaming without raw internal chain-of-thought exposure
 */

import { SessionManager } from "../session_manager.ts";
import { MemoryManager } from "../memory/memory_manager.ts";
import { OpenCodeClient } from "../opencode_client.ts";
import { formatContextPrompt } from "../personality.ts";
import { Logger } from "../logger.ts";
import { extractAssistantText } from "../models/provider.ts";

export type AgentEvent =
  | { type: "progress"; message: string }
  | { type: "tool_activity"; tool: string; status: "started" | "running" | "completed" }
  | { type: "token"; text: string }
  | { type: "done"; fullText: string }
  | { type: "error"; error: string };

export class AgentDispatcher {
  private sessionMgr: SessionManager;
  private memoryMgr: MemoryManager;
  private client: OpenCodeClient;
  private logger: Logger;

  constructor(sessionMgr: SessionManager, memoryMgr: MemoryManager, client: OpenCodeClient, logger: Logger) {
    this.sessionMgr = sessionMgr;
    this.memoryMgr = memoryMgr;
    this.client = client;
    this.logger = logger.forComponent("AgentDispatcher");
  }

  /**
   * Safely translate raw OpenCode SSE events into human-friendly, safe progress indicators.
   * Internal chain-of-thought, raw prompts, and sensitive tool arguments are completely suppressed.
   */
  public translateEvent(event: { event: string; data: any; id?: string }, ocSessionId: string): AgentEvent | null {
    const data = event.data;
    if (!data) return null;

    // Filter by session if session ID is provided in data
    if (data.sessionId && data.sessionId !== ocSessionId && data.session_id !== ocSessionId) {
      return null;
    }

    const eventType = (event.event || data.type || "").toLowerCase();

    // 1. Tool Call / Execution events
    const toolName = (data.tool || data.name || data.call?.name || "").toLowerCase();
    if (toolName || eventType.includes("tool")) {
      if (toolName.includes("read") || toolName.includes("file") || toolName.includes("view")) {
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
   * Execute an AGENT task through the paired OpenCode session with live progress streaming.
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

    // 2. Assemble compact context package
    const project = projectId ? this.memoryMgr.getProject(projectId) : null;
    const memories = this.memoryMgr.recall(userPrompt, projectId, 3).map(m => ({
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

    yield { type: "progress", message: "Inspecting task requirements..." };

    // 3. Set up SSE event listener
    const pendingEvents: AgentEvent[] = [];
    let unsubscribeSSE: (() => void) | null = null;

    try {
      unsubscribeSSE = await this.client.subscribeEvents((rawEvent) => {
        const translated = this.translateEvent(rawEvent, ocSessionId);
        if (translated) {
          pendingEvents.push(translated);
        }
      }, signal);
    } catch (err: any) {
      this.logger.debug("SSE subscription skipped:", { error: err.message });
    }

    let completedText = "";

    try {
      // 4. Dispatch prompt asynchronously
      const promptPromise = this.client.sendPrompt(ocSessionId, packagedPrompt);

      // Default safe progress milestones while in-flight
      yield { type: "progress", message: "Analyzing project files and code..." };

      // Poll pending SSE events while awaiting prompt completion
      const checkIntervalMs = 50;
      let promptDone = false;
      promptPromise.then(() => { promptDone = true; }).catch(() => { promptDone = true; });

      while (!promptDone) {
        if (signal?.aborted) return;
        while (pendingEvents.length > 0) {
          const nextEv = pendingEvents.shift()!;
          yield nextEv;
        }
        await new Promise((r) => setTimeout(r, checkIntervalMs));
      }

      // Await promptPromise resolution
      await promptPromise;

      // Flush remaining SSE events
      while (pendingEvents.length > 0) {
        yield pendingEvents.shift()!;
      }

      yield { type: "tool_activity", tool: "OpenCode Engine", status: "completed" };

      // 5. Retrieve verified session messages and extract genuine assistant response
      const messages = await this.client.getMessages(ocSessionId);
      completedText = extractAssistantText(messages);

      // 6. Stream the response tokens smoothly
      const words = completedText.split(" ");
      for (let i = 0; i < words.length; i++) {
        if (signal?.aborted) return;
        const part = (i === 0 ? "" : " ") + words[i];
        yield { type: "token", text: part };
        await new Promise((r) => setTimeout(r, 10));
      }

      yield { type: "done", fullText: completedText };
    } catch (err: any) {
      this.logger.error("Agent execution error:", { error: err.message });
      yield { type: "error", error: `Agent execution failed: ${err.message}` };
    } finally {
      if (unsubscribeSSE) {
        unsubscribeSSE();
      }
    }
  }
}
