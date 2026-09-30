/**
 * Browser Navigation Skill
 */

import { DirectTools } from "../../tools/direct_tools.ts";
import { type Skill } from "../types.ts";

export const browserSkill: Skill = {
  id: "browser",
  name: "Browser Navigation",
  description: "Web browser launching, URL navigation, and tab control",
  actions: {
    web_open: {
      id: "web_open",
      name: "Open URL",
      description: "Navigate to a website URL in the default web browser",
      permission: "SAFE",
      parametersSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Destination website URL" },
        },
        required: ["url"],
      },
      execute: async (params: { url: string }) => DirectTools.openUrl(params.url),
    },
  },
};
