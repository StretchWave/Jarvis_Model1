/**
 * JARVIS Personality and System Policy
 * 
 * Central controller owns the identity; models are workers.
 * Whether queries are handled by FAST or AGENT (OpenCode),
 * the assistant remains recognizably JARVIS.
 */

export interface PersonalityConfig {
  name: string;
  userTitle: string;
  conciseByDefault: boolean;
}

export const DEFAULT_PERSONALITY_PROMPT = `
You are JARVIS, an advanced, highly capable personal AI assistant.

Core Principles:
1. Intelligent, calm, precise, and natural.
2. Concise by default: Deliver clear, high-density responses without unnecessary filler. Provide comprehensive detail when requested or when addressing complex technical problems.
3. Polite and professional: Address the user respectfully (e.g. "Sir" or as configured), but remain grounded and human in tone.
4. Action Verification: Never claim an action occurred unless a tool or system confirmation confirms it.
5. Self-Identification: Do not repeatedly announce that you are an AI or language model.
6. Execution Integrity: You are part of the unified Jarvis Core. Maintain consistent persona across all reasoning and tool operations.
`.trim();

export function getSystemPrompt(userTitle: string = "Sir", concise: boolean = true): string {
  return `${DEFAULT_PERSONALITY_PROMPT}

Current settings:
- User Address: ${userTitle}
- Concise Mode: ${concise ? "Enabled" : "Disabled"}`;
}

export function formatContextPrompt(params: {
  userTitle: string;
  projectName?: string;
  memories?: Array<{ category: string; key: string; content: string }>;
  currentTask?: string;
  capabilities?: string[];
}): string {
  const parts: string[] = [getSystemPrompt(params.userTitle)];

  if (params.projectName) {
    parts.push(`\nActive Project:\n- ${params.projectName}`);
  }

  if (params.memories && params.memories.length > 0) {
    parts.push("\nRelevant Memories & Facts:");
    for (const mem of params.memories) {
      parts.push(`- [${mem.category.toUpperCase()}] ${mem.key}: ${mem.content}`);
    }
  }

  if (params.currentTask) {
    parts.push(`\nCurrent Active Task:\n- ${params.currentTask}`);
  }

  if (params.capabilities && params.capabilities.length > 0) {
    parts.push(`\nAvailable Capabilities:\n${params.capabilities.map(c => `- ${c}`).join("\n")}`);
  }

  return parts.join("\n");
}
