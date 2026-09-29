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

  public close(): void {
    this.db.close();
  }
}
