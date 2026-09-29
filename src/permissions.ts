/**
 * JARVIS Permission & Safety Controller
 * 
 * Enforces three permission tiers:
 * - SAFE: Can execute automatically (read_file, get_system_info, time, open_app, etc.)
 * - CONFIRM: Requires explicit user confirmation (write_file, delete_file, move_file, etc.)
 * - DANGEROUS: High-risk operations (delete directory, shutdown, credential alteration)
 * 
 * Prevents silent privilege escalation and logs every privileged action.
 */

import { Database } from "./database.ts";
import { Logger } from "./logger.ts";

export type PermissionLevel = "SAFE" | "CONFIRM" | "DANGEROUS";

export interface PermissionCheckResult {
  allowed: boolean;
  level: PermissionLevel;
  requiresPrompt: boolean;
  reason: string;
}

export class PermissionManager {
  private db: Database;
  private logger: Logger;
  private autoConfirmSafe: boolean = true;

  constructor(db: Database, logger: Logger) {
    this.db = db;
    this.logger = logger.forComponent("PermissionManager");
  }

  /**
   * Determine the permission level of a tool action and evaluate execution safety.
   */
  public evaluate(action: string, params: Record<string, any> = {}): PermissionCheckResult {
    const act = action.toLowerCase();

    // DANGEROUS actions
    if (
      act === "shutdown_pc" ||
      act === "restart_pc" ||
      act === "delete_directory" ||
      act.includes("format") ||
      act.includes("credential")
    ) {
      return {
        allowed: false,
        level: "DANGEROUS",
        requiresPrompt: true,
        reason: "Dangerous action requiring explicit override and confirmation.",
      };
    }

    // CONFIRM actions
    if (
      act === "write_file" ||
      act === "create_file" ||
      act === "delete_file" ||
      act === "move_file" ||
      act === "lock_pc" ||
      act === "run_shell_command"
    ) {
      return {
        allowed: false, // Must be confirmed explicitly by user
        level: "CONFIRM",
        requiresPrompt: true,
        reason: `Action '${action}' can modify state and requires confirmation.`,
      };
    }

    // SAFE actions (default)
    return {
      allowed: true,
      level: "SAFE",
      requiresPrompt: false,
      reason: "Safe non-destructive operation.",
    };
  }

  /**
   * Log an audited action to the database.
   */
  public logAudit(action: string, level: PermissionLevel, details: string, confirmedBy?: string): void {
    const auditRecord = {
      id: `audit_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      action,
      severity: level.toLowerCase() as "safe" | "confirm" | "dangerous",
      details,
      confirmed_by: confirmedBy,
      created_at: Date.now(),
    };
    this.db.logAudit(auditRecord);
    this.logger.debug(`Audit: [${level}] ${action} - ${details}`);
  }
}
