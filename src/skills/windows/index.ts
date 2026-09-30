/**
 * Windows System Control Skill
 */

import { DirectTools } from "../../tools/direct_tools.ts";
import { type Skill, type SkillAction } from "../types.ts";

export const windowsSkill: Skill = {
  id: "windows",
  name: "Windows System Control",
  description: "Deterministic PC control, system info, clock, calculator, application launcher, and locks",
  actions: {
    time: {
      id: "time",
      name: "Get Time",
      description: "Get the current system time",
      permission: "SAFE",
      execute: async () => DirectTools.getTime(),
    },
    date: {
      id: "date",
      name: "Get Date",
      description: "Get today's date",
      permission: "SAFE",
      execute: async () => DirectTools.getDate(),
    },
    calculator: {
      id: "calculator",
      name: "Calculate",
      description: "Evaluate a mathematical expression without eval",
      permission: "SAFE",
      parametersSchema: {
        type: "object",
        properties: {
          expression: { type: "string", description: "Arithmetic formula to compute" },
        },
        required: ["expression"],
      },
      execute: async (params: { expression: string }) => DirectTools.calculate(params.expression),
    },
    system_info: {
      id: "system_info",
      name: "Get System Info",
      description: "Inspect PC specs, memory, CPU, and platform uptime",
      permission: "SAFE",
      execute: async () => DirectTools.getSystemInfo(),
    },
    app_open: {
      id: "app_open",
      name: "Open Application",
      description: "Launch an installed desktop application or executable",
      permission: "SAFE",
      parametersSchema: {
        type: "object",
        properties: {
          appName: { type: "string", description: "Name of the application (e.g. notepad, calc, chrome)" },
        },
        required: ["appName"],
      },
      execute: async (params: { appName: string }) => DirectTools.openApp(params.appName),
    },
    app_close: {
      id: "app_close",
      name: "Close Application",
      description: "Terminate an open desktop application process",
      permission: "CONFIRM",
      parametersSchema: {
        type: "object",
        properties: {
          appName: { type: "string", description: "Name of process to close" },
        },
        required: ["appName"],
      },
      execute: async (params: { appName: string }) => DirectTools.closeApp(params.appName),
    },
    lock_pc: {
      id: "lock_pc",
      name: "Lock PC",
      description: "Lock the Windows workstation screen",
      permission: "SAFE",
      execute: async () => DirectTools.lockPC(),
    },
  },
};
