/**
 * JARVIS Session Manager
 * 
 * Manages logical Jarvis sessions, mappings to OpenCode sessions,
 * session categories (general, coding, project, research, temporary),
 * persistence in SQLite, and clean lifecycle management.
 */

import { Database, type JarvisSessionRecord } from "./database.ts";
import { OpenCodeClient } from "./opencode_client.ts";
import { Logger } from "./logger.ts";

export type SessionCategory = "general" | "coding" | "project" | "research" | "temporary";

export interface SessionContext {
  jarvisSessionId: string;
  opencodeSessionId?: string;
  title: string;
  category: SessionCategory;
  projectId?: string;
  status: "active" | "archived";
}

export class SessionManager {
  private db: Database;
  private opencode: OpenCodeClient;
  private logger: Logger;
  private activeSessionId: string | null = null;

  constructor(db: Database, opencode: OpenCodeClient, logger: Logger) {
    this.db = db;
    this.opencode = opencode;
    this.logger = logger.forComponent("SessionManager");
  }

  /**
   * Get the current active session, or get/create the default "general" session.
   */
  public async getOrCreateActiveSession(category: SessionCategory = "general", projectId?: string): Promise<JarvisSessionRecord> {
    if (this.activeSessionId) {
      const active = this.db.getSession(this.activeSessionId);
      if (active && active.status === "active") {
        return active;
      }
    }

    // Check if there is an existing active session of this category/project
    const sessions = this.db.listSessions("active");
    const match = sessions.find((s) => s.category === category && (!projectId || s.project_id === projectId));
    if (match) {
      this.activeSessionId = match.id;
      return match;
    }

    // Otherwise create a fresh session
    return await this.createSession({
      title: category === "general" ? "General Conversation" : `${category.toUpperCase()} Session`,
      category,
      projectId,
    });
  }

  /**
   * Create a new logical Jarvis session and optionally pair with an OpenCode session.
   */
  public async createSession(opts: {
    title: string;
    category: SessionCategory;
    projectId?: string;
    createOpenCodeSession?: boolean;
  }): Promise<JarvisSessionRecord> {
    const jarvisId = `jarvis_${opts.category}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    let opencodeId: string | undefined;

    if (opts.createOpenCodeSession) {
      try {
        const oc = await this.opencode.createSession({
          title: `Jarvis: ${opts.title}`,
        });
        opencodeId = oc?.id;
        this.logger.info(`Paired Jarvis session ${jarvisId} with OpenCode session ${opencodeId}`);
      } catch (err: any) {
        this.logger.warn(`Could not create OpenCode session for ${jarvisId}: ${err.message}`);
      }
    }

    const record: JarvisSessionRecord = {
      id: jarvisId,
      title: opts.title,
      category: opts.category,
      project_id: opts.projectId,
      opencode_session_id: opencodeId,
      created_at: Date.now(),
      updated_at: Date.now(),
      status: "active",
    };

    this.db.createSession(record);
    this.activeSessionId = jarvisId;
    this.logger.info(`Created Jarvis session "${opts.title}" (${jarvisId})`);
    return record;
  }

  /**
   * Ensure a logical Jarvis session has a valid, active OpenCode session connected.
   */
  public async ensureOpenCodeSession(jarvisSessionId: string): Promise<string> {
    const session = this.db.getSession(jarvisSessionId);
    if (!session) {
      throw new Error(`Jarvis session ${jarvisSessionId} not found`);
    }

    if (session.opencode_session_id) {
      try {
        // Verify it still exists in OpenCode
        const existing = await this.opencode.getSession(session.opencode_session_id);
        if (existing && existing.id) {
          return session.opencode_session_id;
        }
      } catch (err) {
        this.logger.warn(`OpenCode session ${session.opencode_session_id} unreachable, creating replacement:`, { error: String(err) });
      }
    }

    // Create a new OpenCode session and link it
    const newOc = await this.opencode.createSession({
      title: `Jarvis: ${session.title}`,
    });

    if (!newOc || !newOc.id) {
      throw new Error("Failed to initialize OpenCode session for Jarvis");
    }

    this.db.updateSessionOpencodeId(jarvisSessionId, newOc.id);
    this.logger.info(`Linked Jarvis session ${jarvisSessionId} to new OpenCode session ${newOc.id}`);
    return newOc.id;
  }

  /**
   * Resolve and ensure the mapped OpenCode session ID for a logical Jarvis session or general context.
   */
  public async getOpenCodeSessionForContext(sessionId?: string, projectId?: string): Promise<string> {
    const jarvisSession = sessionId
      ? this.db.getSession(sessionId) || (await this.getOrCreateActiveSession("general", projectId))
      : await this.getOrCreateActiveSession("general", projectId);
    return await this.ensureOpenCodeSession(jarvisSession.id);
  }

  /**
   * Archive a temporary task or completed session.
   */
  public archiveSession(sessionId: string): void {
    const session = this.db.getSession(sessionId);
    if (!session) return;

    // We can mark status as archived
    const updateStmt = (this.db as any).db.prepare("UPDATE jarvis_sessions SET status = 'archived', updated_at = ? WHERE id = ?");
    updateStmt.run(Date.now(), sessionId);

    if (this.activeSessionId === sessionId) {
      this.activeSessionId = null;
    }
    this.logger.info(`Archived session ${sessionId}`);
  }

  /**
   * Set the currently active session.
   */
  public setActiveSession(sessionId: string): boolean {
    const session = this.db.getSession(sessionId);
    if (session && session.status === "active") {
      this.activeSessionId = sessionId;
      return true;
    }
    return false;
  }
}
