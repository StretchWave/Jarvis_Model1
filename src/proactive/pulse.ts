import { Database, type ReminderRecord, type TaskRunRecord } from "../database.ts";
import { OpenCodeClient } from "../opencode_client.ts";
import { Logger } from "../logger.ts";

export type PulseNotificationType =
  | "reminder"
  | "task_complete"
  | "task_failed"
  | "health_alert";

export interface PulseNotification {
  id: string;
  type: PulseNotificationType;
  title: string;
  message: string;
  timestamp: number;
  metadata?: Record<string, any>;
}

export interface PulseHealthStatus {
  ok: boolean;
  timestamp: number;
  opencode: boolean;
  database: boolean;
  activeRuns: number;
  pendingReminders: number;
  error?: string;
}

export interface ProactivePulseOptions {
  enabled?: boolean;
  intervalMs?: number;
}

export class ProactivePulse {
  private db: Database;
  private opencode: OpenCodeClient;
  private logger: Logger;
  private enabled: boolean;
  private intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private listeners: Set<(notification: PulseNotification) => void> = new Set();

  constructor(
    db: Database,
    opencode: OpenCodeClient,
    logger: Logger,
    options?: ProactivePulseOptions
  ) {
    this.db = db;
    this.opencode = opencode;
    this.logger = logger.forComponent("ProactivePulse");
    // CRITICAL: Proactive pulse must remain disabled by default
    this.enabled = options?.enabled ?? false;
    this.intervalMs = options?.intervalMs ?? 60000;

    if (this.enabled) {
      this.start();
    }
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public enable(): void {
    this.enabled = true;
    this.start();
  }

  public disable(): void {
    this.enabled = false;
    this.stop();
  }

  public start(): void {
    if (this.timer) return;
    this.logger.info(`Starting Proactive Pulse (interval: ${this.intervalMs}ms)`);
    this.timer = setInterval(async () => {
      try {
        await this.tick();
      } catch (err) {
        this.logger.error("Error during proactive pulse tick:", err);
      }
    }, this.intervalMs);
    // unref timer so Node process is not blocked from exiting
    if (this.timer && typeof this.timer.unref === "function") {
      this.timer.unref();
    }
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.logger.info("Proactive Pulse stopped.");
    }
  }

  public onNotification(listener: (notification: PulseNotification) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public emitNotification(notification: PulseNotification): void {
    this.logger.info(`[Pulse Event] [${notification.type.toUpperCase()}] ${notification.title}: ${notification.message}`);
    for (const listener of this.listeners) {
      try {
        listener(notification);
      } catch (err) {
        this.logger.error("Error in pulse listener callback:", err);
      }
    }
  }

  /**
   * Executes a single pulse cycle: checks due reminders and emits notifications.
   */
  public async tick(now: number = Date.now()): Promise<PulseNotification[]> {
    const generated: PulseNotification[] = [];

    // 1. Process due reminders
    try {
      const due = this.db.getPendingReminders(now);
      for (const rem of due) {
        this.db.updateReminderStatus(rem.id, "fired");
        const notif: PulseNotification = {
          id: `notif_rem_${rem.id}`,
          type: "reminder",
          title: "Scheduled Reminder",
          message: rem.title,
          timestamp: Date.now(),
          metadata: {
            reminderId: rem.id,
            sessionId: rem.session_id,
            triggerAt: rem.trigger_at,
          },
        };
        generated.push(notif);
        this.emitNotification(notif);
      }
    } catch (err) {
      this.logger.error("Failed to query reminders in pulse tick:", err);
    }

    return generated;
  }

  /**
   * Add a new scheduled reminder.
   */
  public addReminder(params: { title: string; triggerAt: number; sessionId?: string }): ReminderRecord {
    const rec: ReminderRecord = {
      id: `rem_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      title: params.title,
      trigger_at: params.triggerAt,
      session_id: params.sessionId,
      status: "pending",
      created_at: Date.now(),
    };

    this.db.recordReminder(rec);
    this.logger.info(`Scheduled reminder registered: "${rec.title}" for ${new Date(rec.trigger_at).toISOString()}`);
    return rec;
  }

  /**
   * Retrieves pending reminders.
   */
  public getPendingReminders(): ReminderRecord[] {
    return this.db.listReminders("pending");
  }

  /**
   * Cancels a pending reminder.
   */
  public cancelReminder(id: string): void {
    this.db.updateReminderStatus(id, "cancelled");
    this.logger.info(`Cancelled reminder ${id}`);
  }

  /**
   * Notifies pulse subscribers that a task run has completed.
   */
  public notifyTaskCompleted(taskRun: TaskRunRecord): void {
    const notif: PulseNotification = {
      id: `notif_task_done_${taskRun.id}`,
      type: "task_complete",
      title: "Task Completed",
      message: `Task run ${taskRun.id} (${taskRun.route}) completed successfully.`,
      timestamp: Date.now(),
      metadata: {
        runId: taskRun.id,
        sessionId: taskRun.session_id,
        result: taskRun.result,
      },
    };
    this.emitNotification(notif);
  }

  /**
   * Notifies pulse subscribers that a task run has failed.
   */
  public notifyTaskFailed(taskRun: TaskRunRecord, error: string): void {
    const notif: PulseNotification = {
      id: `notif_task_fail_${taskRun.id}`,
      type: "task_failed",
      title: "Task Failed",
      message: `Task run ${taskRun.id} failed: ${error}`,
      timestamp: Date.now(),
      metadata: {
        runId: taskRun.id,
        sessionId: taskRun.session_id,
        error,
      },
    };
    this.emitNotification(notif);
  }

  /**
   * Performs an instantaneous system health check.
   */
  public async checkHealth(): Promise<PulseHealthStatus> {
    const ts = Date.now();
    let ocOk = false;
    let dbOk = false;
    let activeRunsCount = 0;
    let pendingCount = 0;

    // Check OpenCode
    try {
      const ocRes = await this.opencode.health();
      ocOk = ocRes.ok;
    } catch {
      ocOk = false;
    }

    // Check DB & metrics
    try {
      const pending = this.db.listReminders("pending");
      pendingCount = pending.length;
      const runs = this.db.listTaskRuns(undefined, 50);
      activeRunsCount = runs.filter((r) => r.status === "running").length;
      dbOk = true;
    } catch {
      dbOk = false;
    }

    return {
      ok: ocOk && dbOk,
      timestamp: ts,
      opencode: ocOk,
      database: dbOk,
      activeRuns: activeRunsCount,
      pendingReminders: pendingCount,
    };
  }
}
