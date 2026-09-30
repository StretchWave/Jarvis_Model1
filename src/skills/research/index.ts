/**
 * Research & Web Intelligence Skill
 */

import { WebSearchEngine } from "../../search.ts";
import { Logger } from "../../logger.ts";
import { type Skill } from "../types.ts";

const logger = new Logger("ResearchSkill", "info");
const searchEngine = new WebSearchEngine(logger);

export const researchSkill: Skill = {
  id: "research",
  name: "Research & Web Intelligence",
  description: "Live web search, factual query extraction, and source retrieval",
  actions: {
    search_web: {
      id: "search_web",
      name: "Search Web",
      description: "Perform real-time web search for fresh facts, news, documentation, or driver updates",
      permission: "SAFE",
      parametersSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query string" },
        },
        required: ["query"],
      },
      execute: async (params: { query: string }) => {
        const res = await searchEngine.executeSearch(params.query);
        return {
          success: true,
          message: res.answer,
          data: { sources: res.sources },
        };
      },
    },
  },
};
