/**
 * Filesystem Operations Skill
 */

import { DirectTools } from "../../tools/direct_tools.ts";
import { type Skill } from "../types.ts";

export const filesystemSkill: Skill = {
  id: "filesystem",
  name: "Filesystem Operations",
  description: "Deterministic file reading, directory listing, and pattern searches",
  actions: {
    fs_read: {
      id: "fs_read",
      name: "Read File",
      description: "Read the text content of a local file safely",
      permission: "SAFE",
      parametersSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or relative file path" },
        },
        required: ["path"],
      },
      execute: async (params: { path: string }) => DirectTools.readFile(params.path),
    },
    fs_list: {
      id: "fs_list",
      name: "List Directory",
      description: "List directory files and folders",
      permission: "SAFE",
      parametersSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path" },
        },
        required: ["path"],
      },
      execute: async (params: { path: string }) => DirectTools.listFiles(params.path),
    },
    fs_search: {
      id: "fs_search",
      name: "Search Files",
      description: "Search for files matching a pattern in a directory",
      permission: "SAFE",
      parametersSchema: {
        type: "object",
        properties: {
          dir: { type: "string", description: "Directory root" },
          pattern: { type: "string", description: "Filename regex or substring" },
        },
        required: ["dir", "pattern"],
      },
      execute: async (params: { dir: string; pattern: string }) => DirectTools.searchFiles(params.dir, params.pattern),
    },
  },
};
