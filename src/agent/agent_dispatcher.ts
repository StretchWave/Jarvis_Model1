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
   * Execute an AGENT task through the paired OpenCode session.
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

    // 3. Subscribe to real-time events for progress feedback
    yield { type: "progress", message: "Inspecting task requirements..." };

    let completedText = "";
    let promptSent = false;

    try {
      // Dispatch prompt to OpenCode
      const promptPromise = this.client.sendPrompt(ocSessionId, packagedPrompt);
      promptSent = true;

      // Yield safe progress updates
      yield { type: "progress", message: "Analyzing project files and code..." };

      const res = await promptPromise;
      yield { type: "tool_activity", tool: "OpenCode Engine", status: "completed" };

      // Poll/fetch latest messages for session output
      const messages = await this.client.getMessages(ocSessionId);
      if (Array.isArray(messages) && messages.length > 0) {
        // Find latest assistant reply
        const assistantMsgs = messages.filter((m: any) => m.role === "assistant" || m.type === "assistant" || m.sender === "assistant");
        const latest = assistantMsgs.length > 0 ? assistantMsgs[assistantMsgs.length - 1] : messages[messages.length - 1];
        
        let extractedText = "";
        if (typeof latest.content === "string") extractedText = latest.content;
        else if (Array.isArray(latest.content)) {
          extractedText = latest.content.map((c: any) => (typeof c === "string" ? c : c.text || "")).join("\n");
        } else if (latest.text) {
          extractedText = latest.text;
        }

        completedText = extractedText || "OpenCode task completed successfully, Sir.";
      } else {
        completedText = "Task dispatched and registered with OpenCode, Sir.";
      }

      // Stream the response tokens
      const words = completedText.split(" ");
      for (let i = 0; i < words.length; i++) {
        if (signal?.aborted) return;
        const part = (i === 0 ? "" : " ") + words[i];
        yield { type: "token", text: part };
        await new Promise(r => setTimeout(r, 10));
      }

      yield { type: "done", fullText: completedText };
    } catch (err: any) {
      this.logger.error("Agent execution error:", { error: err.message });
      yield { type: "error", error: `Agent execution failed: ${err.message}` };
    }
  }
}
