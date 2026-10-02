/**
 * JARVIS Response Concision Policy
 * 
 * Enforces natural, concise, and professional persona across all models:
 * - Deterministic concision level classifier (MINIMAL, NORMAL, DETAILED)
 * - Anti-filler sanitization: strips unprompted pleasantries ("Certainly, Sir", "Sure thing!")
 * - Suppresses decorative symbol spam (###, ⚡, 🔧, emojis)
 * - Prevents tool narration chatter
 */

export type ConcisionLevel = "MINIMAL" | "NORMAL" | "DETAILED";

export interface PolicyContext {
  route?: "DIRECT" | "SEARCH" | "FAST" | "AGENT";
  isVoice?: boolean;
}

const DETAILED_TRIGGER_PATTERNS = [
  /\bexplain\s+(?:in\s+detail|thoroughly|deeply|how|why)\b/i,
  /\bstep[\s-]by[\s-]step\b/i,
  /\b(?:write|generate|refactor|debug|create)\s+(?:code|script|implementation|program|file|class|function)\b/i,
  /\b(?:architecture|in-depth|breakdown|guide|tutorial|comprehensive)\b/i,
  /\b(?:detailed|elaborate|analyze|list\s+all)\b/i,
];

const FILLER_PREFIX_REGEX = /^(?:(?:certainly|of course|sure thing|sure|right away|hello|good (?:morning|afternoon|evening)|greetings|absolutely)[,!]?(?:\s+(?:sir|there))?[\s,.:!–—]+)+/i;
const COURTESY_INTRO_REGEX = /^(?:i would be happy to help with that|i can help with that|here is what (?:you asked for|i found)|as an ai language model)[,.:!–—]+\s*/i;
const TRAILING_PLEASANTRY_REGEX = /(?:let me know if you need anything else|hope this helps|feel free to ask if you have more questions|is there anything else i can assist you with)[.!]?$/i;
const EMOJI_AND_DECORATIVE_REGEX = /[\u{1F300}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}⚡🔧🤖🚀✨🎯💡]/gu;

/**
 * Classifies required brevity based on user prompt and execution route.
 */
export function classifyConcisionLevel(prompt: string, context?: PolicyContext): ConcisionLevel {
  const clean = prompt.trim();

  // If in voice call mode, default to MINIMAL unless explicitly requesting detailed explanation
  if (context?.isVoice) {
    for (const pat of DETAILED_TRIGGER_PATTERNS) {
      if (pat.test(clean)) return "DETAILED";
    }
    return "MINIMAL";
  }

  // Check for explicit detailed/code triggers
  for (const pat of DETAILED_TRIGGER_PATTERNS) {
    if (pat.test(clean)) {
      return "DETAILED";
    }
  }

  // DIRECT and simple FAST queries default to MINIMAL
  if (context?.route === "DIRECT") {
    return "MINIMAL";
  }

  if (context?.route === "FAST" && clean.length < 60) {
    return "MINIMAL";
  }

  return "NORMAL";
}

/**
 * Generates an LLM system directive tailored to the active concision level.
 */
export function getConcisionDirective(level: ConcisionLevel, userTitle: string = "Sir"): string {
  if (level === "MINIMAL") {
    return `
Strict Brevity Mandate:
- Target 1 to 2 crisp, direct sentences.
- Never open with filler greetings ("Certainly ${userTitle}", "Sure thing", "Hello", "Of course").
- Never repeat or restate the user's question.
- Do not use markdown headers or bullet points for simple single-fact answers.
- Zero decorative emojis or symbols.
`.trim();
  }

  if (level === "NORMAL") {
    return `
Brevity Guidelines:
- Answer directly in 2 to 4 sentences or concise paragraphs.
- Address the user respectfully as "${userTitle}" only when appropriate, without conversational padding.
- Do not open with redundant filler ("Sure!", "I'd be glad to help").
- Use bullet points or code blocks only when they genuinely improve clarity.
`.trim();
  }

  return `
Detailed Response Guidelines:
- Provide a clear, structured breakdown or implementation.
- Keep explanations high-signal and technical without unnecessary preamble.
`.trim();
}

/**
 * Sanitizes and strips conversational fluff and decorative markers from an assistant response.
 */
export function sanitizeResponseForPersona(rawText: string, level: ConcisionLevel = "NORMAL"): string {
  let cleaned = rawText.trim();
  if (!cleaned) return cleaned;

  // 1. Strip repetitive decorative markdown headers on short replies (e.g. "### Answer\n\nIt is 5 PM")
  if (cleaned.length < 200 && /^#{1,4}\s+.*?\n+/m.test(cleaned)) {
    cleaned = cleaned.replace(/^#{1,4}\s+.*?\n+/m, "").trim();
  }

  // 2. Strip leading conversational greetings & pleasantries
  let prev = "";
  while (prev !== cleaned) {
    prev = cleaned;
    cleaned = cleaned.replace(FILLER_PREFIX_REGEX, "").trim();
    cleaned = cleaned.replace(COURTESY_INTRO_REGEX, "").trim();
  }

  // 3. Strip trailing conversational pleasantries
  cleaned = cleaned.replace(TRAILING_PLEASANTRY_REGEX, "").trim();

  // 4. Strip decorative symbols and emoji spam
  cleaned = cleaned.replace(EMOJI_AND_DECORATIVE_REGEX, "").trim();

  // 5. If MINIMAL mode and response is overly verbose, keep up to first 2 sentences unless it's code
  if (level === "MINIMAL" && !cleaned.includes("```")) {
    const sentences = cleaned.split(/(?<=[.?!])\s+/);
    if (sentences.length > 2) {
      cleaned = sentences.slice(0, 2).join(" ");
    }
  }

  // Capitalize first character if stripping greetings left it lowercase
  if (cleaned.length > 0 && /^[a-z]/.test(cleaned)) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }

  return cleaned;
}
