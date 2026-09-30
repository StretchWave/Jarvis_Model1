import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { Logger } from "./logger.ts";

export interface UserRecord {
  id: string;
  name: string;
  title: string;
  created_at: number;
}

export interface PreferenceRecord {
  key: string;
  value: string;
  updated_at: number;
}

export interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  description?: string;
  created_at: number;
  last_active: number;
}

export interface MemoryRecord {
  id: string;
  category: "personal" | "project" | "decision" | "fact" | "rule";
  key: string;
  content: string;
  importance: number; // 1 to 5
  project_id?: string;
  created_at: number;
  updated_at: number;
}

export interface TaskRecord {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  project_id?: string;
  details?: string;
  created_at: number;
  updated_at: number;
}

export interface JarvisSessionRecord {
  id: string;
  title: string;
  category: "general" | "coding" | "research" | "temporary";
  project_id?: string;
  opencode_session_id?: string;
  created_at: number;
  updated_at: number;
  status: "active" | "archived";
}

export interface ToolHistoryRecord {
  id: string;
  session_id?: string;
  tool_name: string;
  category: string;
  input_params: string;
  output_result?: string;
  status: "success" | "error" | "denied";
  latency_ms: number;
  created_at: number;
}

export interface AuditLogRecord {
  id: string;
  action: string;
  severity: "safe" | "confirm" | "dangerous";
  details: string;
  confirmed_by?: string;
  created_at: number;
}

export interface ConversationTurnRecord {
  id: string;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  route?: string;
  created_at: number;
}

export interface TaskRunRecord {
  id: string;
  session_id: string;
  route: string;
  model_provider?: string;
  status: "running" | "completed" | "failed" | "cancelled";
  start_time: number;
  end_time?: number;
  current_operation?: string;
  tool_events: string; // JSON serialized array of tool events
  error?: string;
  result?: string;
}

export interface ArtifactRecord {
  id: string;
  run_id: string;
  session_id: string;
  type: string;
  path?: string;
  description: string;
  content?: string;
  created_at: number;
}

export interface ReminderRecord {
  id: string;
  title: string;
  trigger_at: number;
  session_id?: string;
  status: "pending" | "fired" | "cancelled";
  created_at: number;
}

export class Database {
  private db: DatabaseSync;
  private logger: Logger;

  constructor(dbPath: string, logger: Logger) {
    this.logger = logger.forComponent("Database");
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.logger.info(`Opened SQLite database at ${dbPath}`);
    this.initSchema();
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        title TEXT DEFAULT 'Sir',
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS preferences (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        description TEXT,
        created_at INTEGER NOT NULL,
        last_active INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        key TEXT NOT NULL,
        content TEXT NOT NULL,
        importance INTEGER DEFAULT 3,
        project_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        project_id TEXT,
        details TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversation_summaries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        turns_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS jarvis_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        project_id TEXT,
        opencode_session_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        status TEXT DEFAULT 'active'
      );

      CREATE TABLE IF NOT EXISTS tool_history (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        tool_name TEXT NOT NULL,
        category TEXT NOT NULL,
        input_params TEXT NOT NULL,
        output_result TEXT,
        status TEXT NOT NULL,
        latency_ms REAL NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        severity TEXT NOT NULL,
        details TEXT NOT NULL,
        confirmed_by TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversation_turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        route TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        route TEXT NOT NULL,
        model_provider TEXT,
        status TEXT NOT NULL,
        start_time INTEGER NOT NULL,
        end_time INTEGER,
        current_operation TEXT,
        tool_events TEXT,
        error TEXT,
        result TEXT
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        path TEXT,
        description TEXT NOT NULL,
        content TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS reminders (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        trigger_at INTEGER NOT NULL,
        session_id TEXT,
        status TEXT DEFAULT 'pending',
        created_at INTEGER NOT NULL
      );
    `);
    this.logger.debug("Database schema initialized successfully.");
  }

  // Session operations
  public createSession(session: JarvisSessionRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO jarvis_sessions (id, title, category, project_id, opencode_session_id, created_at, updated_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      session.id,
      session.title,
      session.category,
      session.project_id || null,
      session.opencode_session_id || null,
      session.created_at,
      session.updated_at,
      session.status
    );
  }

  public getSession(id: string): JarvisSessionRecord | null {
    const stmt = this.db.prepare("SELECT * FROM jarvis_sessions WHERE id = ?");
    const row = stmt.get(id) as any;
    return row || null;
  }

  public listSessions(status: string = "active"): JarvisSessionRecord[] {
    const stmt = this.db.prepare("SELECT * FROM jarvis_sessions WHERE status = ? ORDER BY updated_at DESC");
    return stmt.all(status) as any[];
  }

  public updateSessionOpencodeId(sessionId: string, opencodeId: string): void {
    const stmt = this.db.prepare("UPDATE jarvis_sessions SET opencode_session_id = ?, updated_at = ? WHERE id = ?");
    stmt.run(opencodeId, Date.now(), sessionId);
  }

  // Memories
  public addMemory(mem: MemoryRecord): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO memories (id, category, key, content, importance, project_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(mem.id, mem.category, mem.key, mem.content, mem.importance, mem.project_id || null, mem.created_at, mem.updated_at);
  }

  public getRelevantMemories(query: string, projectId?: string, limit = 5): MemoryRecord[] {
    let sql = "SELECT * FROM memories";
    const params: any[] = [];
    if (projectId) {
      sql += " WHERE (project_id = ? OR project_id IS NULL)";
      params.push(projectId);
    }
    sql += " ORDER BY importance DESC, updated_at DESC LIMIT ?";
    params.push(limit);

    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as any[];
  }

  // Tool History & Audit
  public recordToolHistory(rec: ToolHistoryRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO tool_history (id, session_id, tool_name, category, input_params, output_result, status, latency_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(rec.id, rec.session_id || null, rec.tool_name, rec.category, rec.input_params, rec.output_result || null, rec.status, rec.latency_ms, rec.created_at);
  }

  public logAudit(rec: AuditLogRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO audit_logs (id, action, severity, details, confirmed_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(rec.id, rec.action, rec.severity, rec.details, rec.confirmed_by || null, rec.created_at);
  }

  // Conversation Turns
  public recordConversationTurn(rec: ConversationTurnRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO conversation_turns (id, session_id, role, content, route, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(rec.id, rec.session_id, rec.role, rec.content, rec.route || null, rec.created_at);
  }

  public getRecentConversationTurns(sessionId: string, limit: number = 6): ConversationTurnRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM conversation_turns
        WHERE session_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      ) ORDER BY created_at ASC
    `);
    return stmt.all(sessionId, limit) as ConversationTurnRecord[];
  }

  public clearConversationTurns(sessionId: string): void {
    const stmt = this.db.prepare("DELETE FROM conversation_turns WHERE session_id = ?");
    stmt.run(sessionId);
  }

  // Task Runs & Run Inspector
  public createTaskRun(rec: TaskRunRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO task_runs (id, session_id, route, model_provider, status, start_time, end_time, current_operation, tool_events, error, result)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      rec.id,
      rec.session_id,
      rec.route,
      rec.model_provider || null,
      rec.status,
      rec.start_time,
      rec.end_time || null,
      rec.current_operation || null,
      rec.tool_events,
      rec.error || null,
      rec.result || null
    );
  }

  public updateTaskRun(rec: Partial<TaskRunRecord> & { id: string }): void {
    const existing = this.getTaskRun(rec.id);
    if (!existing) return;
    const merged = { ...existing, ...rec };
    const stmt = this.db.prepare(`
      UPDATE task_runs
      SET status = ?, end_time = ?, current_operation = ?, tool_events = ?, error = ?, result = ?
      WHERE id = ?
    `);
    stmt.run(
      merged.status,
      merged.end_time || null,
      merged.current_operation || null,
      merged.tool_events,
      merged.error || null,
      merged.result || null,
      merged.id
    );
  }

  public getTaskRun(id: string): TaskRunRecord | null {
    const stmt = this.db.prepare("SELECT * FROM task_runs WHERE id = ?");
    return (stmt.get(id) as any) || null;
  }

  public getActiveTaskRun(sessionId: string): TaskRunRecord | null {
    const stmt = this.db.prepare(
      "SELECT * FROM task_runs WHERE session_id = ? AND status = 'running' ORDER BY start_time DESC LIMIT 1"
    );
    return (stmt.get(sessionId) as any) || null;
  }

  public listTaskRuns(sessionId?: string, limit: number = 20): TaskRunRecord[] {
    if (sessionId) {
      const stmt = this.db.prepare("SELECT * FROM task_runs WHERE session_id = ? ORDER BY start_time DESC LIMIT ?");
      return stmt.all(sessionId, limit) as TaskRunRecord[];
    }
    const stmt = this.db.prepare("SELECT * FROM task_runs ORDER BY start_time DESC LIMIT ?");
    return stmt.all(limit) as TaskRunRecord[];
  }

  // Artifacts
  public recordArtifact(rec: ArtifactRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO artifacts (id, run_id, session_id, type, path, description, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      rec.id,
      rec.run_id,
      rec.session_id,
      rec.type,
      rec.path || null,
      rec.description,
      rec.content || null,
      rec.created_at
    );
  }

  public getArtifact(id: string): ArtifactRecord | null {
    const stmt = this.db.prepare("SELECT * FROM artifacts WHERE id = ?");
    return (stmt.get(id) as any) || null;
  }

  public listArtifacts(sessionId?: string, runId?: string, limit: number = 50): ArtifactRecord[] {
    let sql = "SELECT * FROM artifacts WHERE 1=1";
    const params: any[] = [];
    if (sessionId) {
      sql += " AND session_id = ?";
      params.push(sessionId);
    }
    if (runId) {
      sql += " AND run_id = ?";
      params.push(runId);
    }
    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);
    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as ArtifactRecord[];
  }

  // Reminders
  public recordReminder(rec: ReminderRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO reminders (id, title, trigger_at, session_id, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(rec.id, rec.title, rec.trigger_at, rec.session_id || null, rec.status, rec.created_at);
  }

  public getPendingReminders(now: number = Date.now()): ReminderRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM reminders
      WHERE status = 'pending' AND trigger_at <= ?
      ORDER BY trigger_at ASC
    `);
    return stmt.all(now) as ReminderRecord[];
  }

  public listReminders(status?: "pending" | "fired" | "cancelled", limit: number = 50): ReminderRecord[] {
    if (status) {
      const stmt = this.db.prepare("SELECT * FROM reminders WHERE status = ? ORDER BY trigger_at ASC LIMIT ?");
      return stmt.all(status, limit) as ReminderRecord[];
    }
    const stmt = this.db.prepare("SELECT * FROM reminders ORDER BY trigger_at ASC LIMIT ?");
    return stmt.all(limit) as ReminderRecord[];
  }

  public updateReminderStatus(id: string, status: "pending" | "fired" | "cancelled"): void {
    const stmt = this.db.prepare("UPDATE reminders SET status = ? WHERE id = ?");
    stmt.run(status, id);
  }

  public deleteReminder(id: string): void {
    const stmt = this.db.prepare("DELETE FROM reminders WHERE id = ?");
    stmt.run(id);
  }

  public close(): void {
    this.db.close();
  }
}
