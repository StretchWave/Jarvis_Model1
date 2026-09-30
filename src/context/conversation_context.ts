/**
 * JARVIS Rolling Conversational Context Layer
 * 
 * Manages short-term rolling conversational state:
 * - Recent turns (bounded history to prevent context explosion)
 * - Current topic detection and tracking
 * - Active entity extraction (e.g., "MiMo", "Jarvis", "RTX 4050", "REPP")
 * - Pronoun & reference resolution ("it", "that", "this")
 * - Project & task context binding
 * - Compact context injection for FAST and AGENT model prompts
 */

import { Database, type ConversationTurnRecord } from "../database.ts";
import { Logger } from "../logger.ts";
import { type ChatMessage } from "../models/provider.ts";

export interface ConversationContextState {
  sessionId: string;
  currentTopic?: string;
  currentTask?: string;
  currentProject?: string;
  activeEntities: string[];
  lastActive: number;
}

export interface PronounResolutionResult {
  hasPronoun: boolean;
  pronoun?: string;
  referent?: string;
  topic?: string;
  annotatedQuery?: string;
}

export class ConversationContextManager {
  private db: Database;
  private logger: Logger;
  private inMemoryStates: Map<string, ConversationContextState> = new Map();

  constructor(db: Database, logger: Logger) {
    this.db = db;
    this.logger = logger.forComponent("ConversationContext");
  }

  /**
   * Get or initialize the active context state for a given session.
   */
  public getState(sessionId: string): ConversationContextState {
    let state = this.inMemoryStates.get(sessionId);
    if (!state) {
      state = {
        sessionId,
        activeEntities: [],
        lastActive: Date.now(),
      };
      this.inMemoryStates.set(sessionId, state);
    }
    return state;
  }

  /**
   * Set or update active project for this session context.
   */
  public setProject(sessionId: string, projectId?: string): void {
    if (!projectId) return;
    const state = this.getState(sessionId);
    state.currentProject = projectId;
    if (!state.activeEntities.includes(projectId)) {
      state.activeEntities.unshift(projectId);
    }
  }

  /**
   * Set or update active task for this session context.
   */
  public setTask(sessionId: string, task?: string): void {
    if (!task) return;
    const state = this.getState(sessionId);
    state.currentTask = task;
  }

  /**
   * Record a conversation turn and update rolling topic/entity state.
   */
  public addTurn(
    sessionId: string,
    role: "user" | "assistant",
    content: string,
    route?: string
  ): void {
    const trimmed = content.trim();
    if (!trimmed) return;

    // 1. Record turn to SQLite persistent history
    const turnRecord: ConversationTurnRecord = {
      id: `turn_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      session_id: sessionId,
      role,
      content: trimmed,
      route,
      created_at: Date.now(),
    };
    this.db.recordConversationTurn(turnRecord);

    // 2. Extract and update in-memory state
    const state = this.getState(sessionId);
    state.lastActive = Date.now();

    if (role === "user") {
      this.extractEntitiesAndTopic(trimmed, state);
    }
  }

  /**
   * Extract key topics and named entities from user statements.
   */
  private extractEntitiesAndTopic(text: string, state: ConversationContextState): void {
    // 1. Topic discovery: "thinking about [using] X for Y", "working on X", "regarding X"
    const topicPattern = /(?:thinking about (?:using )?|working on |looking at |regarding |using |evaluate )([a-zA-Z0-9_\-\.\s]{3,35}?)(?: for | in | with | \?|\.|$)/i;
    const topicMatch = text.match(topicPattern);
    if (topicMatch && topicMatch[1]) {
      const candidateTopic = topicMatch[1].trim();
      if (!["something", "anything", "nothing", "this", "that", "it"].includes(candidateTopic.toLowerCase())) {
        state.currentTopic = candidateTopic;
      }
    }

    // 2. Entity extraction: Capitalized acronyms/names (MiMo, Jarvis, RTX, GPT, REPP, Claude, OpenCode)
    const entityCandidates = new Set<string>();

    // Words with camelCase, PascalCase, or ALL_CAPS acronyms
    const properNounRegex = /\b([A-Z][a-zA-Z0-9_\-]+|[A-Z]{2,})\b/g;
    let match;
    while ((match = properNounRegex.exec(text)) !== null) {
      const word = match[1];
      const lower = word.toLowerCase();
      // Filter common English words capitalized at sentence start
      if (!["The", "What", "How", "Why", "When", "Where", "Who", "Is", "Are", "Can", "Could", "Would", "Should", "If", "Then", "Yes", "No", "Please", "Sir", "Hello", "Hey", "Good"].includes(word)) {
        entityCandidates.add(word);
      }
    }

    // Quoted strings: "something"
    const quoteRegex = /"([^"]+)"|'([^']+)'/g;
    while ((match = quoteRegex.exec(text)) !== null) {
      const q = (match[1] || match[2]).trim();
      if (q.length > 1 && q.length < 30) {
        entityCandidates.add(q);
      }
    }

    // Technology / component keywords
    if (/mimo/i.test(text)) entityCandidates.add("MiMo");
    if (/jarvis/i.test(text)) entityCandidates.add("Jarvis");
    if (/opencode/i.test(text)) entityCandidates.add("OpenCode");
    if (/repp/i.test(text)) entityCandidates.add("REPP");

    // Merge into active entities list (most recent first, capped at 5)
    for (const ent of entityCandidates) {
      state.activeEntities = [ent, ...state.activeEntities.filter(e => e.toLowerCase() !== ent.toLowerCase())];
    }
    if (state.activeEntities.length > 5) {
      state.activeEntities = state.activeEntities.slice(0, 5);
    }

    // If no topic was explicitly matched but we have an active entity, set default topic
    if (!state.currentTopic && state.activeEntities.length > 0) {
      state.currentTopic = state.activeEntities[0];
    }
  }

  /**
   * Resolve pronouns ("it", "that", "this", "they") against active context.
   */
  public resolvePronoun(query: string, sessionId: string): PronounResolutionResult {
    const state = this.getState(sessionId);
    const pronounMatch = query.match(/\b(it|this|that|they|them|he|she)\b/i);

    if (!pronounMatch) {
      return { hasPronoun: false };
    }

    const pronoun = pronounMatch[1];
    // Find the most relevant referent entity (excluding the assistant's own name 'Jarvis')
    const candidates = state.activeEntities.filter(e => e.toLowerCase() !== "jarvis");
    const referent = candidates[0] || state.currentTopic || state.activeEntities[0];

    if (!referent) {
      return { hasPronoun: true, pronoun };
    }

    return {
      hasPronoun: true,
      pronoun,
      referent,
      topic: state.currentTopic,
      annotatedQuery: `${query} [Context: "${pronoun}" refers to ${referent}]`,
    };
  }

  /**
   * Construct compact, rolling conversational chat messages for LLM inference.
   * Avoids token explosion by limiting historical turns.
   */
  public buildPromptMessages(
    rawUserQuery: string,
    sessionId: string,
    options: {
      systemPrompt: string;
      maxTurns?: number;
      activeProject?: string;
      activeTask?: string;
    }
  ): ChatMessage[] {
    const maxTurns = options.maxTurns ?? 6;
    if (options.activeProject) this.setProject(sessionId, options.activeProject);
    if (options.activeTask) this.setTask(sessionId, options.activeTask);

    const state = this.getState(sessionId);
    const recentDbTurns = this.db.getRecentConversationTurns(sessionId, maxTurns);

    // Build system message with compact context annotation
    let contextAnnotation = "";
    if (state.currentTopic || state.activeEntities.length > 0 || state.currentProject || state.currentTask) {
      const parts: string[] = [];
      if (state.currentTopic) parts.push(`Topic: "${state.currentTopic}"`);
      if (state.activeEntities.length > 0) parts.push(`Active Entities: [${state.activeEntities.join(", ")}]`);
      if (state.currentProject) parts.push(`Project: "${state.currentProject}"`);
      if (state.currentTask) parts.push(`Task: "${state.currentTask}"`);
      contextAnnotation = `\n\n[Active Conversation Context: ${parts.join(" | ")}]`;
    }

    const messages: ChatMessage[] = [
      {
        role: "system",
        content: options.systemPrompt + contextAnnotation,
      },
    ];

    // Append recent turns
    for (const turn of recentDbTurns) {
      messages.push({
        role: turn.role,
        content: turn.content,
      });
    }

    // Pronoun resolution check for current query
    const res = this.resolvePronoun(rawUserQuery, sessionId);
    let finalUserContent = rawUserQuery;
    if (res.hasPronoun && res.referent) {
      // Provide explicit context annotation so the model resolves "it" without hesitation
      finalUserContent = `${rawUserQuery} (Note: "${res.pronoun}" refers to ${res.referent}${res.topic ? ` in the context of ${res.topic}` : ""})`;
    }

    messages.push({
      role: "user",
      content: finalUserContent,
    });

    return messages;
  }
}
