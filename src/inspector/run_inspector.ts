/**
 * JARVIS Run Inspector & Task Recovery System
 * 
 * Provides end-to-end task run auditing and lifecycle inspection:
 * - Unique runId per task
 * - Live operation status & elapsed time tracking
 * - Safe tool event history
 * - Seamless disconnection recovery without re-executing prompts
 */

import { Database, type TaskRunRecord } from "../database.ts";
import { Logger } from "../logger.ts";
import { OpenCodeClient } from "../opencode_client.ts";
import { extractAssistantText } from "../models/provider.ts";

export interface ToolEventRecord {
  tool: string;
  status: "started" | "running" | "completed" | "error";
  timestamp: number;
  details?: string;
}

export interface TaskRun {
  runId: string;
  sessionId: string;
  route: string;
  modelProvider?: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startTime: number;
  endTime?: number;
  elapsedMs: number;
  currentOperation?: string;
  toolEvents: ToolEventRecord[];
  error?: string;
  result?: string;
}

export interface RecoveryResult {
  recovered: boolean;
  run: TaskRun | null;
  opencodeState?: any;
  message: string;
}

export class RunInspector {
  private db: Database;
  private logger: Logger;
  private memoryCache: Map<string, TaskRun> = new Map();

  constructor(db: Database, logger: Logger) {
    this.db = db;
    this.logger = logger.forComponent("RunInspector");
  }

  private mapRecordToRun(rec: TaskRunRecord): TaskRun {
    let toolEvents: ToolEventRecord[] = [];
    try {
      toolEvents = JSON.parse(rec.tool_events || "[]");
    } catch {
      toolEvents = [];
    }

    const elapsedMs = (rec.end_time ? rec.end_time : Date.now()) - rec.start_time;

    return {
      runId: rec.id,
      sessionId: rec.session_id,
      route: rec.route,
      modelProvider: rec.model_provider,
      status: rec.status,
      startTime: rec.start_time,
      endTime: rec.end_time,
      elapsedMs,
      currentOperation: rec.current_operation,
      toolEvents,
      error: rec.error,
      result: rec.result,
    };
  }

  /**
   * Start a new task run and persist to database.
   */
  public startRun(opts: {
    runId?: string;
    sessionId: string;
    route: string;
    modelProvider?: string;
    initialOperation?: string;
  }): TaskRun {
    const runId = opts.runId || `run_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const now = Date.now();

    const record: TaskRunRecord = {
      id: runId,
      session_id: opts.sessionId,
      route: opts.route,
      model_provider: opts.modelProvider,
      status: "running",
      start_time: now,
      current_operation: opts.initialOperation || "Starting task...",
      tool_events: JSON.stringify([]),
    };

    this.db.createTaskRun(record);

    const run = this.mapRecordToRun(record);
    this.memoryCache.set(runId, run);
    this.logger.info(`Started run ${runId} [route: ${opts.route}, session: ${opts.sessionId}]`);
    return run;
  }

  /**
   * Update the currently active operation description for a run.
   */
  public updateOperation(runId: string, operation: string): void {
    const run = this.memoryCache.get(runId) || this.getRun(runId);
    if (!run) return;

    run.currentOperation = operation;
    this.memoryCache.set(runId, run);

    this.db.updateTaskRun({
      id: runId,
      current_operation: operation,
    });
  }

  /**
   * Record a tool lifecycle event to the run.
   */
  public recordToolEvent(
    runId: string,
    tool: string,
    status: "started" | "running" | "completed" | "error",
    details?: string
  ): void {
    const run = this.memoryCache.get(runId) || this.getRun(runId);
    if (!run) return;

    const event: ToolEventRecord = {
      tool,
      status,
      timestamp: Date.now(),
      details,
    };

    run.toolEvents.push(event);
    this.memoryCache.set(runId, run);

    this.db.updateTaskRun({
      id: runId,
      tool_events: JSON.stringify(run.toolEvents),
    });
  }

  /**
   * Mark a task run as successfully completed with final result.
   */
  public completeRun(runId: string, result: string): void {
    const run = this.memoryCache.get(runId) || this.getRun(runId);
    const now = Date.now();

    if (run) {
      run.status = "completed";
      run.endTime = now;
      run.elapsedMs = now - run.startTime;
      run.result = result;
      run.currentOperation = "Completed";
      this.memoryCache.set(runId, run);
    }

    this.db.updateTaskRun({
      id: runId,
      status: "completed",
      end_time: now,
      current_operation: "Completed",
      result,
    });
    this.logger.info(`Completed run ${runId} in ${run?.elapsedMs || 0}ms`);
  }

  /**
   * Mark a task run as failed with error details.
   */
  public failRun(runId: string, error: string): void {
    const run = this.memoryCache.get(runId) || this.getRun(runId);
    const now = Date.now();

    if (run) {
      run.status = "failed";
      run.endTime = now;
      run.elapsedMs = now - run.startTime;
      run.error = error;
      run.currentOperation = "Failed";
      this.memoryCache.set(runId, run);
    }

    this.db.updateTaskRun({
      id: runId,
      status: "failed",
      end_time: now,
      current_operation: "Failed",
      error,
    });
    this.logger.warn(`Failed run ${runId}: ${error}`);
  }

  /**
   * Retrieve a run by ID.
   */
  public getRun(runId: string): TaskRun | null {
    if (this.memoryCache.has(runId)) {
      return this.memoryCache.get(runId)!;
    }
    const rec = this.db.getTaskRun(runId);
    if (!rec) return null;
    const run = this.mapRecordToRun(rec);
    this.memoryCache.set(runId, run);
    return run;
  }

  /**
   * Get the currently active running task for a session.
   */
  public getActiveRun(sessionId: string): TaskRun | null {
    const rec = this.db.getActiveTaskRun(sessionId);
    if (!rec) return null;
    return this.mapRecordToRun(rec);
  }

  /**
   * List task runs, optionally filtered by session.
   */
  public listRuns(sessionId?: string, limit: number = 20): TaskRun[] {
    const records = this.db.listTaskRuns(sessionId, limit);
    return records.map(r => this.mapRecordToRun(r));
  }

  /**
   * Format a task inspector summary for UI or diagnostics.
   */
  public formatInspectorSummary(runId: string): string {
    const run = this.getRun(runId);
    if (!run) return `Task run ${runId} not found.`;

    const lines: string[] = [
      `Task: ${run.runId}`,
      `├── route: ${run.route}`,
      `├── status: ${run.status.toUpperCase()}`,
      `├── elapsed time: ${run.elapsedMs}ms`,
      `├── current operation: ${run.currentOperation || "N/A"}`,
      `├── tool events: ${run.toolEvents.length} recorded`,
    ];

    for (const ev of run.toolEvents.slice(-3)) {
      lines.push(`│   └── [${ev.status.toUpperCase()}] ${ev.tool}${ev.details ? ` (${ev.details})` : ""}`);
    }

    if (run.result) {
      lines.push(`└── final result: "${run.result.substring(0, 80)}${run.result.length > 80 ? "..." : ""}"`);
    } else if (run.error) {
      lines.push(`└── error: "${run.error}"`);
    } else {
      lines.push(`└── in progress...`);
    }

    return lines.join("\n");
  }

  /**
   * Reconnect and recover task state if the UI disconnected during execution.
   * Without replaying the user's original request unnecessarily.
   */
  public async recoverSession(
    sessionId: string,
    opencodeClient?: OpenCodeClient
  ): Promise<RecoveryResult> {
    this.logger.info(`Attempting task recovery for session: ${sessionId}`);

    // 1. Check for active run in local database
    const activeRun = this.getActiveRun(sessionId);
    const session = this.db.getSession(sessionId);

    if (!activeRun) {
      // No task was left in 'running' state; return the most recent completed run
      const recent = this.listRuns(sessionId, 1);
      return {
        recovered: false,
        run: recent[0] || null,
        message: "No active task was running in this session.",
      };
    }

    // 2. If OpenCode client is available and session has a paired OpenCode session
    if (opencodeClient && session?.opencode_session_id) {
      try {
        const ocId = session.opencode_session_id;
        const ocSession = await opencodeClient.getSession(ocId);
        const messages = await opencodeClient.getMessages(ocId);

        // Check if OpenCode has completed the assistant response while UI was disconnected
        const hasAssistantReply = messages.some(
          (m: any) => m.type === "assistant" || m.role === "assistant" || m.sender === "assistant"
        );

        if (hasAssistantReply) {
          const finalOutput = extractAssistantText(messages);
          this.completeRun(activeRun.runId, finalOutput);
          activeRun.status = "completed";
          activeRun.result = finalOutput;

          return {
            recovered: true,
            run: activeRun,
            opencodeState: ocSession,
            message: "OpenCode task finished while disconnected; output recovered successfully.",
          };
        }

        return {
          recovered: true,
          run: activeRun,
          opencodeState: ocSession,
          message: "OpenCode task is still actively running; re-attached to live session.",
        };
      } catch (err: any) {
        this.logger.warn(`Could not query OpenCode during recovery: ${err.message}`);
      }
    }

    return {
      recovered: true,
      run: activeRun,
      message: `Active task run ${activeRun.runId} restored.`,
    };
  }
}
