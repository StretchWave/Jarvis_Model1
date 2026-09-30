/**
 * JARVIS Intent & Complexity Router
 * 
 * Deterministic classification layer:
 * - Sub-50ms execution
 * - Zero LLM overhead for routing decisions
 * - Clean pattern matching and intent evaluation
 */

import { performance } from "node:perf_hooks";

export type ExecutionRoute = "DIRECT" | "SEARCH" | "FAST" | "AGENT";

export interface DirectAction {
  type:
    | "time"
    | "date"
    | "calculator"
    | "volume_set"
    | "volume_get"
    | "volume_mute"
    | "app_open"
    | "app_close"
    | "web_open"
    | "system_info"
    | "media_play_pause"
    | "media_next"
    | "media_prev"
    | "lock_pc"
    | "fs_read"
    | "fs_list";
  payload?: any;
}

export interface RoutingDecision {
  route: ExecutionRoute;
  confidence: number;
  reason: string;
  directAction?: DirectAction;
  searchQuery?: string;
  latencyMs: number;
}

export class Router {
  /**
   * Deterministically route a user prompt to one of the 4 execution paths.
   */
  public route(input: string): RoutingDecision {
    const startTime = performance.now();
    const text = input.trim();
    const lower = text.toLowerCase();

    // 1. DIRECT PATH CHECKS (Deterministic PC & System operations)
    const directAction = this.matchDirectAction(text, lower);
    if (directAction) {
      return {
        route: "DIRECT",
        confidence: 0.98,
        reason: `Matched direct deterministic system command: ${directAction.type}`,
        directAction,
        latencyMs: performance.now() - startTime,
      };
    }

    // 2. SEARCH PATH CHECKS (Fresh real-time / web factual queries)
    const searchMatch = this.matchSearchIntent(text, lower);
    if (searchMatch) {
      return {
        route: "SEARCH",
        confidence: 0.92,
        reason: searchMatch.reason,
        searchQuery: searchMatch.query,
        latencyMs: performance.now() - startTime,
      };
    }

    // 3. AGENT PATH CHECKS (Deep reasoning, coding, repo analysis, multi-step execution)
    const agentMatch = this.matchAgentIntent(text, lower);
    if (agentMatch) {
      return {
        route: "AGENT",
        confidence: 0.90,
        reason: agentMatch.reason,
        latencyMs: performance.now() - startTime,
      };
    }

    // 4. FAST PATH (Default for conversation, simple Q&A, definitions, rewrites)
    return {
      route: "FAST",
      confidence: 0.85,
      reason: "General conversational / explanatory query without complex tooling or live web requirements",
      latencyMs: performance.now() - startTime,
    };
  }

  private matchDirectAction(raw: string, lower: string): DirectAction | null {
    // Time & Date
    if (/^(what('?s| is) the (current )?time\??|what time is it\??|tell me the time)$/i.test(lower)) {
      return { type: "time" };
    }
    if (/^(what('?s| is) (today'?s |the )?date\??|what day is it( today)?\??)$/i.test(lower)) {
      return { type: "date" };
    }

    // Calculator / Math evaluation
    const mathPattern = /^(?:calculate|compute|what('?s| is))\s+([\d\.\s\+\-\*\/\^\(\)\%]+)\??$/i;
    const mathMatch = lower.match(mathPattern);
    if (mathMatch && /[\d]+[\s]*[\+\-\*\/\%][\s]*[\d]+/.test(mathMatch[2])) {
      return { type: "calculator", payload: { expression: mathMatch[2].trim() } };
    }
    // Direct arithmetic expressions: "23 * 8", "100 / 4"
    if (/^[\d\.\s\+\-\*\/\^\(\)]+$/.test(lower) && /[\+\-\*\/]/.test(lower)) {
      return { type: "calculator", payload: { expression: lower.trim() } };
    }

    // Volume control
    const volSetMatch = lower.match(/^(?:set|change|turn)\s+(?:the\s+)?volume\s+(?:to\s+)?(\d{1,3})%?$/i);
    if (volSetMatch) {
      return { type: "volume_set", payload: { level: parseInt(volSetMatch[1], 10) } };
    }
    if (/^(?:what('?s| is) the (current )?volume\??|get volume)$/i.test(lower)) {
      return { type: "volume_get" };
    }
    if (/^(?:mute|unmute|silence)(?:\s+(?:the\s+)?audio|\s+(?:the\s+)?sound|\s+(?:the\s+)?volume)?$/i.test(lower)) {
      return { type: "volume_mute" };
    }

    // Application Launch / Close
    const openAppMatch = lower.match(/^(?:open|launch|start|run)\s+([a-zA-Z0-9_\-\.\s]+)$/i);
    if (openAppMatch && !lower.includes("project") && !lower.includes("repo") && !lower.includes("file") && !lower.includes("test")) {
      const appName = openAppMatch[1].trim();
      // Check if it's a URL
      if (appName.includes(".com") || appName.includes(".org") || appName.includes(".net") || appName.includes(".io") || appName.startsWith("http")) {
        return { type: "web_open", payload: { url: appName } };
      }
      return { type: "app_open", payload: { appName } };
    }

    const closeAppMatch = lower.match(/^(?:close|kill|terminate|quit|exit)\s+([a-zA-Z0-9_\-\.\s]+)$/i);
    if (closeAppMatch && !lower.includes("session") && !lower.includes("window")) {
      return { type: "app_close", payload: { appName: closeAppMatch[1].trim() } };
    }

    // Website launching
    const webMatch = lower.match(/^(?:open|go to|browse to|launch)\s+(https?:\/\/[^\s]+|[a-zA-Z0-9\-]+\.(?:com|org|net|io|edu|gov|dev)[^\s]*)$/i);
    if (webMatch) {
      return { type: "web_open", payload: { url: webMatch[1] } };
    }

    // System Information
    if (/^(?:get |show |display )?(?:system info|system information|specs|pc info|hardware info)$/i.test(lower)) {
      return { type: "system_info" };
    }

    // Media Control
    if (/^(?:play|pause|resume|media play|media pause|toggle playback)$/i.test(lower)) {
      return { type: "media_play_pause" };
    }
    if (/^(?:next track|skip song|next song|next audio)$/i.test(lower)) {
      return { type: "media_next" };
    }
    if (/^(?:previous track|prev song|previous song)$/i.test(lower)) {
      return { type: "media_prev" };
    }

    // PC Lock
    if (/^(?:lock(?: the)? pc|lock screen|lock computer)$/i.test(lower)) {
      return { type: "lock_pc" };
    }

    return null;
  }

  private matchSearchIntent(raw: string, lower: string): { query: string; reason: string } | null {
    // Explicit web search commands
    const searchPrefix = lower.match(/^(?:search (?:the )?web for|google|search for|look up|search:)\s+(.+)$/i);
    if (searchPrefix) {
      return { query: searchPrefix[1].trim(), reason: "Explicit web search prefix" };
    }

    // Temporal freshness queries (latest, current, today, news, update)
    const freshPattern = /\b(latest|current price|stock price|who won|next update|patch notes|release date of|weather (?:in|for|today)|breaking news)\b/i;
    if (freshPattern.test(lower)) {
      return { query: raw.trim(), reason: `Matches fresh factual information pattern (${freshPattern.exec(lower)?.[0]})` };
    }

    // Specific driver / version inquiries (e.g., "latest RTX 4050 driver", "current Nvidia driver")
    if (/\b(?:driver|firmware|patch|stock price)\b/i.test(lower) && /\b(?:latest|newest|current|recent)\b/i.test(lower)) {
      return { query: raw.trim(), reason: "Matches latest driver/firmware inquiry" };
    }

    return null;
  }

  private matchAgentIntent(raw: string, lower: string): { reason: string } | null {
    // Coding & Repository Operations
    const codingKeywords = [
      "inspect my project",
      "inspect the project",
      "inspect project",
      "inspect repo",
      "analyze repository",
      "analyze this repo",
      "analyze workspace",
      "analyze this workspace",
      "inspect workspace",
      "debug this",
      "find the bug",
      "fix the bug",
      "run tests",
      "git commit",
      "git status",
      "git diff",
      "refactor",
      "compile",
      "build project",
      "in unreal engine",
      "animation blueprint",
      "write a function",
      "implement",
      "pull request",
      "code review",
      "code audit",
      "audit code",
    ];

    for (const kw of codingKeywords) {
      if (lower.includes(kw)) {
        return { reason: `Contains agent keyword/pattern: "${kw}"` };
      }
    }

    // Multi-step instruction patterns
    if (lower.startsWith("inspect") && (lower.includes("project") || lower.includes("file") || lower.includes("code"))) {
      return { reason: "Multi-step inspection task" };
    }

    if (/\b(?:modify|edit|refactor|rewrite|debug|troubleshoot)\b.*\b(?:code|file|repository|project|script|blueprint)\b/i.test(lower)) {
      return { reason: "Code or project modification task requiring reasoning & tool execution" };
    }

    return null;
  }
}
