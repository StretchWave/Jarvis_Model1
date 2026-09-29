/**
 * JARVIS Persistent Memory System
 * 
 * Manages persistent facts, personal preferences, project context,
 * active tasks, and conversation summaries in SQLite.
 * Includes importance scoring and intelligent directive extraction.
 */

import { Database, type MemoryRecord, type TaskRecord, type ProjectRecord } from "../database.ts";
import { Logger } from "../logger.ts";

export interface MemoryItem {
  id: string;
  category: "personal" | "project" | "decision" | "fact" | "rule";
  key: string;
  content: string;
  importance: number; // 1 to 5
  projectId?: string;
  updatedAt: number;
}

export class MemoryManager {
  private db: Database;
  private logger: Logger;

  constructor(db: Database, logger: Logger) {
    this.db = db;
    this.logger = logger.forComponent("MemoryManager");
  }

  /**
   * Save a persistent memory fact or preference.
   */
  public remember(params: {
    category?: "personal" | "project" | "decision" | "fact" | "rule";
    key: string;
    content: string;
    importance?: number;
    projectId?: string;
  }): MemoryRecord {
    const id = `mem_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const record: MemoryRecord = {
      id,
      category: params.category || "fact",
      key: params.key.trim(),
      content: params.content.trim(),
      importance: Math.min(Math.max(params.importance ?? 3, 1), 5),
      project_id: params.projectId,
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    this.db.addMemory(record);
    this.logger.info(`Stored memory [${record.category}] ${record.key} (importance: ${record.importance})`);
    return record;
  }

  /**
   * Recall relevant memories based on query keyword and optional project filter.
   */
  public recall(query: string, projectId?: string, limit = 5): MemoryRecord[] {
    return this.db.getRelevantMemories(query, projectId, limit);
  }

  /**
   * Register or update a project context.
   */
  public setProject(project: { id: string; name: string; path: string; description?: string }): ProjectRecord {
    const record: ProjectRecord = {
      id: project.id,
      name: project.name,
      path: project.path,
      description: project.description,
      created_at: Date.now(),
      last_active: Date.now(),
    };

    const stmt = (this.db as any).db.prepare(`
      INSERT OR REPLACE INTO projects (id, name, path, description, created_at, last_active)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(record.id, record.name, record.path, record.description || null, record.created_at, record.last_active);
    this.logger.info(`Updated project: ${record.name} (${record.id})`);
    return record;
  }

  public getProject(projectId: string): ProjectRecord | null {
    const stmt = (this.db as any).db.prepare("SELECT * FROM projects WHERE id = ?");
    return (stmt.get(projectId) as ProjectRecord) || null;
  }

  /**
   * Create an active task.
   */
  public createTask(title: string, projectId?: string, details?: string): TaskRecord {
    const task: TaskRecord = {
      id: `task_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      title,
      status: "pending",
      project_id: projectId,
      details,
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    const stmt = (this.db as any).db.prepare(`
      INSERT INTO tasks (id, title, status, project_id, details, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(task.id, task.title, task.status, task.project_id || null, task.details || null, task.created_at, task.updated_at);
    this.logger.info(`Created task: "${task.title}"`);
    return task;
  }

  /**
   * Update task status.
   */
  public updateTaskStatus(taskId: string, status: "pending" | "in_progress" | "completed" | "cancelled"): void {
    const stmt = (this.db as any).db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?");
    stmt.run(status, Date.now(), taskId);
  }

  /**
   * List tasks.
   */
  public listTasks(status?: "pending" | "in_progress" | "completed", projectId?: string): TaskRecord[] {
    let sql = "SELECT * FROM tasks WHERE 1=1";
    const params: any[] = [];
    if (status) {
      sql += " AND status = ?";
      params.push(status);
    }
    if (projectId) {
      sql += " AND project_id = ?";
      params.push(projectId);
    }
    sql += " ORDER BY updated_at DESC";
    return (this.db as any).db.prepare(sql).all(...params) as TaskRecord[];
  }

  /**
   * Inspect user input for explicit remember commands or active task statements.
   * Does NOT store ephemeral queries like "23 * 8" or "what time is it".
   */
  public processDirectives(input: string, currentProjectId?: string): { storedMemory?: MemoryRecord; createdTask?: TaskRecord } {
    const text = input.trim();
    const lower = text.toLowerCase();

    // 1. Explicit memory directive: "Remember that <key> is <value>" or "Remember that <statement>"
    const rememberMatch = text.match(/^(?:remember that|note that|keep in mind that)\s+(.+)$/i);
    if (rememberMatch) {
      const statement = rememberMatch[1].trim();
      let key = statement.split(/\s+is\s+|\s+uses\s+|\s+has\s+/i)[0] || "Fact";
      if (key.length > 30) key = key.substring(0, 30);

      const mem = this.remember({
        category: currentProjectId ? "project" : "personal",
        key,
        content: statement,
        importance: 4,
        projectId: currentProjectId,
      });
      return { storedMemory: mem };
    }

    // 2. Active task directive: "Today I am debugging..." or "My goal today is..."
    const taskMatch = text.match(/^(?:today I am|today I'm|my goal is to|currently working on)\s+(.+)$/i);
    if (taskMatch) {
      const task = this.createTask(taskMatch[1].trim(), currentProjectId);
      return { createdTask: task };
    }

    return {};
  }
}
