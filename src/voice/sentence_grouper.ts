/**
 * JARVIS Natural Sentence Grouper
 * 
 * Groups text into coherent linguistic units for natural neural speech synthesis:
 * - Keeps reasonably short responses intact
 * - Splits longer responses at natural sentence boundaries (. ! ? ; and paragraph breaks)
 * - Protects common abbreviations (Mr., Dr., e.g., i.e., vs., etc.) and decimal numbers (3.14)
 * - Never chops text mid-sentence by arbitrary token counts
 */

// Common English abbreviations that shouldn't trigger sentence splitting
const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr",
  "vs", "etc", "eg", "ie", "al", "fig", "no", "vol", "dept"
]);

export function splitIntoSentences(text: string, maxTargetLength: number = 0): string[] {
  const clean = text.trim();
  if (!clean) return [];

  // If a positive target length is provided and clean text is under it, stay as one unit
  if (maxTargetLength > 0 && clean.length <= maxTargetLength && !clean.includes("\n\n")) {
    return [clean];
  }

  const rawParagraphs = clean.split(/\n\s*\n+/);
  const result: string[] = [];

  for (const para of rawParagraphs) {
    const trimmedPara = para.trim();
    if (!trimmedPara) continue;

    if (maxTargetLength > 0 && trimmedPara.length <= maxTargetLength) {
      result.push(trimmedPara);
      continue;
    }

    // Split sentences respecting abbreviations and decimals
    const tokens = trimmedPara.split(/(\s+)/);
    let currentSentence = "";

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      currentSentence += token;

      // Check if this token ends with a sentence delimiter
      const match = token.match(/([.?!;])([)"'\]}]*)$/);
      if (match) {
        const punctuation = match[1];
        // Strip trailing punctuation to check abbreviation
        const wordBody = token.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();

        // Check if it's a decimal number like 3.14 or an abbreviation
        const isDecimal = /^\d+\.\d+$/.test(token);
        const isAbbrev = punctuation === "." && ABBREVIATIONS.has(wordBody);

        if (!isDecimal && !isAbbrev) {
          // Valid sentence ending
          const trimmed = currentSentence.trim();
          if (trimmed.length > 0) {
            result.push(trimmed);
            currentSentence = "";
          }
        }
      }
    }

    const remaining = currentSentence.trim();
    if (remaining.length > 0) {
      if (result.length > 0 && result[result.length - 1].length + remaining.length + 1 <= maxTargetLength) {
        result[result.length - 1] += " " + remaining;
      } else {
        result.push(remaining);
      }
    }
  }

  return result.filter(s => s.length > 0);
}
