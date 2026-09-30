/**
 * JARVIS 5-Layer Persistent & Working Memory Architecture
 * 
 * Divides memory into 5 distinct architectural tiers:
 * 1. Working Memory: Active session scratchpad & immediate entity state
 * 2. Short-Term Conversation: Bounded rolling multi-turn context
 * 3. Long-Term Memory: High-importance personal facts, preferences, and rules
 * 4. Project Memory: Repository-specific architecture facts, tech stacks, paths
 * 5. Task Memory: Active, pending, and completed tasks with status lifecycle
 * 
 * Includes intelligent relevance scoring and directive extraction.
 */

import { Database, type MemoryRecord, type TaskRecord, type ProjectRecord } from "../database.ts";
import { Logger } from "../logger.ts";

export type MemoryLayer = "working" | "short_term" | "long_term" | "project" | "task";
export type MemoryCategory = "personal" | "project" | "decision" | "fact" | "rule" | "preference";

export interface MemoryItem {
  id: string;
  category: MemoryCategory;
  key: string;
  content: string;
  importance: number; // 1 to 5
  projectId?: string;
  updatedAt: number;
}

export interface WorkingMemoryState {
  sessionId: string;
  activeGoal?: string;
  variables: Record<string, any>;
  lastUpdated: number;
}

export class MemoryManager {
  private db: Database;
  private logger: Logger;
  private workingMemoryStore: Map<string, WorkingMemoryState> = new Map();

  constructor(db: Database, logger: Logger) {
    this.db = db;
    this.logger = logger.forComponent("MemoryManager");
  }

  // =========================================================================
  // LAYER 1: WORKING MEMORY (In-Memory Session Scratchpad)
  // =========================================================================

  public getWorkingMemory(sessionId: string): WorkingMemoryState {
    let state = this.workingMemoryStore.get(sessionId);
    if (!state) {
      state = {
        sessionId,
        variables: {},
        lastUpdated: Date.now(),
      };
      this.workingMemoryStore.set(sessionId, state);
    }
    return state;
  }

  public setWorkingVariable(sessionId: string, key: string, value: any): void {
    const wm = this.getWorkingMemory(sessionId);
    wm.variables[key] = value;
    wm.lastUpdated = Date.now();
  }

  public getWorkingVariable<T = any>(sessionId: string, key: string): T | undefined {
    const wm = this.getWorkingMemory(sessionId);
    return wm.variables[key];
  }

  public setWorkingGoal(sessionId: string, goal: string): void {
    const wm = this.getWorkingMemory(sessionId);
    wm.activeGoal = goal;
    wm.lastUpdated = Date.now();
  }

  public clearWorkingMemory(sessionId: string): void {
    this.workingMemoryStore.delete(sessionId);
  }

  // =========================================================================
  // LAYER 3 & 4: LONG-TERM & PROJECT MEMORY
  // =========================================================================

  /**
   * Store a persistent fact with importance scoring (1-5).
   */
  public remember(params: {
    category?: MemoryCategory;
    key: string;
    content: string;
    importance?: number;
    projectId?: string;
  }): MemoryRecord {
    const id = `mem_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const record: MemoryRecord = {
      id,
      category: (params.category as any) || (params.projectId ? "project" : "fact"),
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
   * Intelligent Relevance-Scored Recall:
   * Only returns memories genuinely relevant to the query words and context.
   */
  public recall(query: string, projectId?: string, limit = 5): MemoryRecord[] {
    const allCandidates = this.db.getRelevantMemories("", projectId, 100);
    if (!query || query.trim() === "") {
      return allCandidates.slice(0, limit);
    }

    const stopWords = new Set(["the", "a", "an", "is", "in", "it", "of", "to", "for", "with", "on", "at", "by", "this", "that", "my", "your", "what", "how", "why", "where", "who"]);
    const queryTokens = query
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w));

    if (queryTokens.length === 0) {
      return allCandidates.slice(0, limit);
    }

    const scored = allCandidates.map(mem => {
      let score = 0;
      const keyLower = mem.key.toLowerCase();
      const contentLower = mem.content.toLowerCase();

      for (const token of queryTokens) {
        if (keyLower === token) score += 10;
        else if (keyLower.includes(token)) score += 5;
        if (contentLower.includes(token)) score += 3;
      }

      // Project match boost
      if (projectId && mem.project_id === projectId) {
        score += 3;
      }

      // Importance weighting
      score += mem.importance * 1.5;

      return { mem, score };
    });

    // Filter to relevant items only (score > baseline importance)
    const filtered = scored.filter(s => s.score > s.mem.importance * 1.5);
    filtered.sort((a, b) => b.score - a.score);

    // If query specifically searched for something but nothing matched keyword, return empty (don't hallucinate irrelevant memories)
    return filtered.slice(0, limit).map(s => s.mem);
  }

  // =========================================================================
  // LAYER 4: PROJECT MEMORY
  // =========================================================================

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

  // =========================================================================
  // LAYER 5: TASK MEMORY
  // =========================================================================

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

  public updateTaskStatus(taskId: string, status: "pending" | "in_progress" | "completed" | "cancelled"): void {
    const stmt = (this.db as any).db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?");
    stmt.run(status, Date.now(), taskId);
  }

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

  // =========================================================================
  // INTELLIGENT DIRECTIVE EXTRACTION (Filtered Persistence)
  // =========================================================================

  public processDirectives(
    input: string,
    currentProjectId?: string
  ): { storedMemory?: MemoryRecord; createdTask?: TaskRecord } {
    const text = input.trim();

    // 1. Explicit preferences & rules: "Always use TypeScript", "I prefer dark mode"
    const ruleMatch = text.match(/^(?:always use|never use|prefer|my preference is to)\s+(.+)$/i);
    if (ruleMatch) {
      const statement = text;
      const mem = this.remember({
        category: "rule",
        key: "Preference / Rule",
        content: statement,
        importance: 5,
        projectId: currentProjectId,
      });
      return { storedMemory: mem };
    }

    // 2. Decisions: "We decided to...", "The plan is to..."
    const decisionMatch = text.match(/^(?:we decided (?:to|that)|decision:)\s+(.+)$/i);
    if (decisionMatch) {
      const statement = decisionMatch[1].trim();
      const mem = this.remember({
        category: "decision",
        key: "Decision",
        content: statement,
        importance: 4,
        projectId: currentProjectId,
      });
      return { storedMemory: mem };
    }

    // 3. Explicit memory directive: "Remember that <key> is <value>"
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

    // 4. Active task directive: "Today I am debugging..." or "My goal today is..."
    const taskMatch = text.match(/^(?:today I am|today I'm|my goal is to|currently working on)\s+(.+)$/i);
    if (taskMatch) {
      const task = this.createTask(taskMatch[1].trim(), currentProjectId);
      return { createdTask: task };
    }

    // Do NOT persist casual sentences like "what's the time", "23 * 8", "tell me a joke"
    return {};
  }
}
