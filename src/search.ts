/**
 * JARVIS Search Engine & Web Abstraction
 * 
 * Provides independent web search, page fetching, and text extraction
 * without requiring OpenCode for factual lookup.
 */

import { Logger } from "./logger.ts";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchAnswer {
  query: string;
  answer: string;
  sources: SearchResult[];
}

export class WebSearchEngine {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.forComponent("WebSearchEngine");
  }

  /**
   * Search the web for a given query and return top results.
   */
  public async search(query: string, maxResults: number = 5): Promise<SearchResult[]> {
    this.logger.info(`Performing web search for: "${query}"`);
    const results: SearchResult[] = [];

    // 1. First try DuckDuckGo Instant Answer API for quick definitions/facts
    try {
      const ddgApiUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
      const apiResp = await fetch(ddgApiUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) JarvisAssistant/1.0" },
        signal: AbortSignal.timeout(4000),
      });

      if (apiResp.ok) {
        const data = (await apiResp.json()) as any;
        if (data.AbstractText && data.AbstractURL) {
          results.push({
            title: data.Heading || query,
            url: data.AbstractURL,
            snippet: data.AbstractText,
          });
        }
        if (Array.isArray(data.RelatedTopics)) {
          for (const item of data.RelatedTopics) {
            if (results.length >= maxResults) break;
            if (item.Text && item.FirstURL) {
              results.push({
                title: item.Text.split(" - ")[0] || item.Text.substring(0, 50),
                url: item.FirstURL,
                snippet: item.Text,
              });
            }
          }
        }
      }
    } catch (err: any) {
      this.logger.debug("DuckDuckGo Instant Answer API skipped/failed:", { error: err.message });
    }

    // 2. If we need more results, scrape DuckDuckGo HTML
    if (results.length < maxResults) {
      try {
        const htmlUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const resp = await fetch(htmlUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml",
          },
          signal: AbortSignal.timeout(6000),
        });

        if (resp.ok) {
          const html = await resp.text();
          const parsed = this.parseDdgHtml(html, maxResults - results.length);
          for (const r of parsed) {
            if (!results.some(existing => existing.url === r.url)) {
              results.push(r);
            }
          }
        }
      } catch (err: any) {
        this.logger.warn("DuckDuckGo HTML search fallback failed:", { error: err.message });
      }
    }

    // 3. Step 3: Reliable open encyclopedia search fallback
    if (results.length < maxResults) {
      try {
        const keywords = query
          .replace(/[^\w\s]/g, " ")
          .split(/\s+/)
          .filter(w => !/^(what|whats|is|the|latest|current|when|where|who|tell|me|about|how|are|price|of|for)$/i.test(w))
          .join(" ")
          .trim();

        const cleanQuery = keywords.length > 0 ? keywords : query;
        const wikiUrl = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(cleanQuery)}&limit=${maxResults}&namespace=0&format=json`;
        const resp = await fetch(wikiUrl, {
          headers: { "User-Agent": "JarvisAssistant/1.0 (contact@jarvis.local)" },
          signal: AbortSignal.timeout(4000),
        });

        if (resp.ok) {
          const [searchQuery, titles, snippets, urls] = (await resp.json()) as [string, string[], string[], string[]];
          if (Array.isArray(titles) && Array.isArray(urls)) {
            for (let i = 0; i < titles.length && results.length < maxResults; i++) {
              if (urls[i] && !results.some(existing => existing.url === urls[i])) {
                results.push({
                  title: titles[i],
                  url: urls[i],
                  snippet: snippets[i] || `Information on ${titles[i]} regarding ${query}`,
                });
              }
            }
          }
        }
      } catch (err: any) {
        this.logger.debug("Wikipedia fallback skipped:", { error: err.message });
      }
    }

    // 4. Guarantee at least 1 authoritative source link if live search engines rate-limited
    if (results.length === 0) {
      results.push({
        title: `${query} — Web Search`,
        url: `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
        snippet: `Web search link for "${query}".`,
      });
    }

    return results;
  }

  /**
   * Parse DuckDuckGo HTML response for organic results.
   */
  private parseDdgHtml(html: string, limit: number): SearchResult[] {
    const results: SearchResult[] = [];
    const resultBlocks = html.split('<div class="result results_links');

    for (let i = 1; i < resultBlocks.length && results.length < limit; i++) {
      const block = resultBlocks[i];

      // Extract title & URL
      const titleMatch = block.match(/<a class="result__snippet[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/) ||
        block.match(/<a class="result__url"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/) ||
        block.match(/<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);

      const snippetMatch = block.match(/<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);

      if (titleMatch) {
        let rawUrl = titleMatch[1];
        // Decode DDG redirect URL if present
        if (rawUrl.includes("uddg=")) {
          const match = rawUrl.match(/uddg=([^&]+)/);
          if (match) rawUrl = decodeURIComponent(match[1]);
        }

        const rawTitle = titleMatch[2] ? titleMatch[2].replace(/<[^>]+>/g, "").trim() : "Result";
        const rawSnippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, "").trim() : "";

        if (rawUrl.startsWith("http")) {
          results.push({
            title: this.cleanEntities(rawTitle),
            url: rawUrl,
            snippet: this.cleanEntities(rawSnippet),
          });
        }
      }
    }

    return results;
  }

  /**
   * Fetch raw page content via HTTP with size and time limits.
   */
  public async fetch(url: string, timeoutMs: number = 8000): Promise<string> {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,text/plain",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    }

    return await resp.text();
  }

  /**
   * Extract readable text content from an HTML document.
   */
  public extractText(html: string): string {
    // 1. Remove script, style, nav, svg, noscript, header, footer tags
    let cleaned = html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
      .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, "")
      .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, "")
      .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, "")
      .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, "");

    // 2. Convert line breaks and paragraph breaks
    cleaned = cleaned
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<br\s*[\/]?>/gi, "\n")
      .replace(/<\/h[1-6]>/gi, "\n\n")
      .replace(/<\/li>/gi, "\n");

    // 3. Remove all remaining tags
    cleaned = cleaned.replace(/<[^>]+>/g, " ");

    // 4. Decode HTML entities
    cleaned = this.cleanEntities(cleaned);

    // 5. Normalize whitespace
    return cleaned
      .split("\n")
      .map(line => line.trim().replace(/\s+/g, " "))
      .filter(line => line.length > 0)
      .join("\n\n");
  }

  private cleanEntities(str: string): string {
    return str
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/&#x27;/g, "'")
      .replace(/&#x2F;/g, "/");
  }

  /**
   * Execute full Search Path pipeline: search -> extract -> synthesize answer.
   */
  public async executeSearch(query: string): Promise<SearchAnswer> {
    const results = await this.search(query, 4);

    if (results.length === 0) {
      return {
        query,
        answer: `I looked online for "${query}", but was unable to retrieve live search results at this moment, Sir.`,
        sources: [],
      };
    }

    // Build synthesized factual summary from top snippets
    const topSnippets = results
      .filter(r => r.snippet && r.snippet.length > 20)
      .slice(0, 3)
      .map(r => r.snippet);

    let summaryText = "";
    if (topSnippets.length > 0) {
      summaryText = topSnippets.join("\n\n");
    } else {
      summaryText = `Found ${results.length} relevant sources for "${query}".`;
    }

    return {
      query,
      answer: summaryText,
      sources: results,
    };
  }
}
