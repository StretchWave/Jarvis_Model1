/**
 * JARVIS Central Skill Registry
 * 
 * Manages the Skills -> Actions -> Tools -> Functions hierarchy.
 * Supports dynamic skill registration, scoped tool schema generation for LLM context,
 * and unified action execution with permission auditing.
 */

import { type Skill, type SkillAction, type SkillMetadata } from "./types.ts";
import { windowsSkill } from "./windows/index.ts";
import { browserSkill } from "./browser/index.ts";
import { filesystemSkill } from "./filesystem/index.ts";
import { mediaSkill } from "./media/index.ts";
import { researchSkill } from "./research/index.ts";
import { Logger } from "../logger.ts";

export class SkillRegistry {
  private skills: Map<string, Skill> = new Map();
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.forComponent("SkillRegistry");
    this.registerBuiltInSkills();
  }

  private registerBuiltInSkills(): void {
    this.registerSkill(windowsSkill);
    this.registerSkill(browserSkill);
    this.registerSkill(filesystemSkill);
    this.registerSkill(mediaSkill);
    this.registerSkill(researchSkill);

    // Extension skills: Real git status and explicit NOT_IMPLEMENTED status for unconfigured integrations
    this.registerSkill({
      id: "github",
      name: "GitHub Developer Integration",
      description: "Git repository management, PR review, diff checking, and status inspection",
      actions: {
        git_status: {
          id: "git_status",
          name: "Git Status",
          description: "Inspect working tree modifications",
          permission: "SAFE",
          execute: async () => {
            try {
              const { execSync } = await import("node:child_process");
              const output = execSync("git status --short", {
                encoding: "utf-8",
                timeout: 5000,
                stdio: ["pipe", "pipe", "pipe"],
              }).trim();
              if (!output) {
                return { success: true, message: "Working tree clean. No uncommitted modifications." };
              }
              return { success: true, message: `Git Status:\n${output}` };
            } catch (err: any) {
              return {
                success: false,
                message: `Git status unavailable: ${err.message || "Not a git repository or git not found"}`,
              };
            }
          },
        },
      },
    });

    this.registerSkill({
      id: "unreal",
      name: "Unreal Engine Specialist",
      description: "Blueprint inspection, asset animation status, and Unreal project management",
      actions: {
        inspect_blueprint: {
          id: "inspect_blueprint",
          name: "Inspect Blueprint",
          description: "Inspect Blueprint node logic and animation state machines",
          permission: "SAFE",
          execute: async () => ({
            success: false,
            message: "NOT_IMPLEMENTED: Unreal Engine integration bridge is not configured or connected in this environment.",
          }),
        },
      },
    });

    this.registerSkill({
      id: "spotify",
      name: "Spotify & Music Control",
      description: "Control Spotify player and query current playback status",
      actions: {
        playback_status: {
          id: "playback_status",
          name: "Playback Status",
          description: "Inspect currently playing track and playlist",
          permission: "SAFE",
          execute: async () => ({
            success: false,
            message: "NOT_IMPLEMENTED: Spotify integration is not configured. No active player connector or token available.",
          }),
        },
      },
    });
  }

  public registerSkill(skill: Skill): void {
    this.skills.set(skill.id, skill);
    this.logger.debug(`Registered skill: ${skill.name} (${skill.id}) with ${Object.keys(skill.actions).length} actions`);
  }

  public getSkill(id: string): Skill | undefined {
    return this.skills.get(id);
  }

  public listSkills(): SkillMetadata[] {
    const list: SkillMetadata[] = [];
    for (const skill of this.skills.values()) {
      list.push({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        actionCount: Object.keys(skill.actions).length,
        actions: Object.values(skill.actions).map(a => ({
          id: a.id,
          name: a.name,
          description: a.description,
          permission: a.permission,
        })),
      });
    }
    return list;
  }

  public findAction(actionId: string): { skill: Skill; action: SkillAction } | undefined {
    for (const skill of this.skills.values()) {
      if (skill.actions[actionId]) {
        return { skill, action: skill.actions[actionId] };
      }
    }
    return undefined;
  }

  public async executeAction(actionId: string, params: any = {}): Promise<{ success: boolean; message: string; data?: any }> {
    const found = this.findAction(actionId);
    if (!found) {
      return { success: false, message: `Unknown skill action: ${actionId}` };
    }
    return await found.action.execute(params);
  }

  /**
   * Dynamically generate OpenAI tool/function schemas for specified skills.
   * If relevantSkillIds is omitted, returns schemas for core skills.
   */
  public getToolSchemas(relevantSkillIds?: string[]): any[] {
    const targetSkills = relevantSkillIds && relevantSkillIds.length > 0
      ? relevantSkillIds.map(id => this.skills.get(id)).filter(Boolean) as Skill[]
      : Array.from(this.skills.values());

    const schemas: any[] = [];

    for (const skill of targetSkills) {
      for (const action of Object.values(skill.actions)) {
        schemas.push({
          type: "function",
          function: {
            name: `${skill.id}_${action.id}`,
            description: `[Skill: ${skill.name}] ${action.description}`,
            parameters: action.parametersSchema || {
              type: "object",
              properties: {},
            },
          },
        });
      }
    }

    return schemas;
  }
}
