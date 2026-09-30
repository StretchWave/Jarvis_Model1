/**
 * JARVIS Skills Architecture - Type Definitions
 * 
 * Hierarchy: Skills -> Actions -> Tools -> Functions
 * Inspired by Leon and modern agentic skill registries.
 */

export type SkillPermissionLevel = "SAFE" | "CONFIRM" | "DANGEROUS";

export interface SkillAction {
  id: string;
  name: string;
  description: string;
  permission: SkillPermissionLevel;
  parametersSchema?: Record<string, any>;
  execute(params: any): Promise<{ success: boolean; message: string; data?: any }>;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  actions: Record<string, SkillAction>;
  getToolSchemas?(): any[];
}

export interface SkillMetadata {
  id: string;
  name: string;
  description: string;
  actionCount: number;
  actions: Array<{
    id: string;
    name: string;
    description: string;
    permission: SkillPermissionLevel;
  }>;
}
