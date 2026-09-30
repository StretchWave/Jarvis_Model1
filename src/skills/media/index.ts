/**
 * Media & Audio Control Skill
 */

import { DirectTools } from "../../tools/direct_tools.ts";
import { type Skill } from "../types.ts";

export const mediaSkill: Skill = {
  id: "media",
  name: "Media & Audio Control",
  description: "PC volume level adjustment, muting, and media playback transport",
  actions: {
    volume_set: {
      id: "volume_set",
      name: "Set Volume",
      description: "Set system master volume percentage (0-100)",
      permission: "SAFE",
      parametersSchema: {
        type: "object",
        properties: {
          level: { type: "number", description: "Volume level between 0 and 100" },
        },
        required: ["level"],
      },
      execute: async (params: { level: number }) => DirectTools.volume("set", params.level),
    },
    volume_get: {
      id: "volume_get",
      name: "Get Volume",
      description: "Inspect current audio volume status",
      permission: "SAFE",
      execute: async () => DirectTools.volume("get"),
    },
    volume_mute: {
      id: "volume_mute",
      name: "Mute Volume",
      description: "Toggle audio mute state",
      permission: "SAFE",
      execute: async () => DirectTools.volume("mute"),
    },
    media_play_pause: {
      id: "media_play_pause",
      name: "Play / Pause",
      description: "Toggle media player playback",
      permission: "SAFE",
      execute: async () => DirectTools.media("play_pause"),
    },
    media_next: {
      id: "media_next",
      name: "Next Track",
      description: "Skip to next media track",
      permission: "SAFE",
      execute: async () => DirectTools.media("next"),
    },
    media_prev: {
      id: "media_prev",
      name: "Previous Track",
      description: "Return to previous media track",
      permission: "SAFE",
      execute: async () => DirectTools.media("prev"),
    },
  },
};
