import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface OpenCodeModelProfile {
  providerID: string;
  modelID: string;
  variant?: string;
  agentID?: string;
  temperature?: number;
  weight?: number;
}

export interface JarvisModelsConfig {
  fast: OpenCodeModelProfile;
  agent: OpenCodeModelProfile;
  agentWeight?: number;
  creativityWeight?: number;
}

export interface FallbackProviderConfig {
  enabled: boolean;
  provider?: "openai-compatible" | "mock" | string;
  model?: string;
  baseURL?: string;
  apiKeyEnv?: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

export interface JarvisConfig {
  version: string;
  port: number;
  host: string;
  dataDir: string;
  databasePath: string;
  opencode: {
    serviceFile: string;
    cliPath?: string;
    spawnIfDown: boolean;
    connectTimeoutMs: number;
    disableGlobalDiscovery?: boolean;
    legacyProtocolMode?: boolean;
  };
  models: JarvisModelsConfig;
  fallbackProvider?: FallbackProviderConfig;
  fastModel?: any; // Retained for backward-compatibility with older tests
  agentModel?: {
    provider: "opencode";
    defaultModel?: string;
  };
  logging: {
    level: "debug" | "info" | "warn" | "error";
    format: "pretty" | "json";
  };
  personality: {
    name: string;
    userTitle: string;
    conciseByDefault: boolean;
  };
  artifacts?: {
    storageDir?: string;
  };
  proactivePulse?: {
    enabled: boolean;
    intervalMs?: number;
  };
}

export function parseSemver(v: string): [number, number, number] {
  const cleaned = v.replace(/^[v^~]/, "").trim();
  const parts = cleaned.split(".").map(p => parseInt(p, 10) || 0);
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

export function compareSemver(a: string, b: string): number {
  const [a1, a2, a3] = parseSemver(a);
  const [b1, b2, b3] = parseSemver(b);
  if (a1 !== b1) return a1 - b1;
  if (a2 !== b2) return a2 - b2;
  return a3 - b3;
}

export function findOpenCodeCli(home: string = os.homedir()): string | undefined {
  if (process.env.OPENCODE_CLI_PATH && fs.existsSync(process.env.OPENCODE_CLI_PATH)) {
    return process.env.OPENCODE_CLI_PATH;
  }
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const cliBase = path.join(appData, "ai.opencode.desktop", "cli");
  if (fs.existsSync(cliBase)) {
    try {
      const dirs = fs.readdirSync(cliBase).filter(d => {
        try {
          return fs.statSync(path.join(cliBase, d)).isDirectory();
        } catch {
          return false;
        }
      });
      dirs.sort(compareSemver);
      if (dirs.length > 0) {
        const highest = dirs[dirs.length - 1];
        const exe = path.join(cliBase, highest, "opencode-cli.exe");
        if (fs.existsSync(exe)) return exe;
      }
    } catch {}
  }
  const localPrograms = path.join(home, "AppData", "Local", "Programs", "@opencodedesktop", "resources", "opencode-cli.exe");
  if (fs.existsSync(localPrograms)) return localPrograms;

  return undefined;
}

export function getDefaultConfig(): JarvisConfig {
  const home = os.homedir();
  const defaultDataDir = path.join(process.cwd(), ".jarvis_data");
  
  // Standard OpenCode shared service registration path
  const defaultStateFile = path.join(home, ".local", "state", "opencode", "service.json");
  const fallbackStateFile = path.join(home, ".config", "opencode", "service.json");
  const chosenServiceFile = fs.existsSync(defaultStateFile) ? defaultStateFile : fallbackStateFile;
  const detectedCli = findOpenCodeCli(home);

  return {
    version: "1.0.0",
    port: 31415,
    host: "127.0.0.1",
    dataDir: defaultDataDir,
    databasePath: path.join(defaultDataDir, "jarvis.db"),
    opencode: {
      serviceFile: chosenServiceFile,
      cliPath: detectedCli,
      spawnIfDown: true,
      connectTimeoutMs: 5000,
      legacyProtocolMode: process.env.OPENCODE_LEGACY_PROTOCOL_MODE === "true",
    },
    models: {
      fast: {
        providerID: process.env.JARVIS_FAST_PROVIDER_ID || "opencode",
        modelID: process.env.JARVIS_FAST_MODEL_ID || "mimo-v2.6-flash-free",
        variant: "default",
      },
      agent: {
        providerID: process.env.JARVIS_AGENT_PROVIDER_ID || "opencode",
        modelID: process.env.JARVIS_AGENT_MODEL_ID || "mimo-v2.6-flash-free",
        variant: "default",
        agentID: process.env.JARVIS_AGENT_ID || "build",
      },
      agentWeight: 0.5,
      creativityWeight: 0.7,
    },
    fallbackProvider: process.env.JARVIS_FAST_PROVIDER === "mock"
      ? {
          enabled: true,
          provider: "mock",
          model: "mock-fast",
        }
      : {
          enabled: false,
        },
    fastModel: process.env.JARVIS_FAST_PROVIDER === "mock"
      ? {
          provider: "mock",
          model: "mock-fast",
        }
      : {
          provider: "openai-compatible",
          model: "gpt-4o-mini",
          baseURL: "https://api.openai.com/v1",
          apiKeyEnv: "FAST_MODEL_API_KEY",
        },
    agentModel: {
      provider: "opencode",
    },
    logging: {
      level: "info",
      format: "pretty",
    },
    personality: {
      name: "JARVIS",
      userTitle: "Sir",
      conciseByDefault: true,
    },
    artifacts: {
      storageDir: path.join(defaultDataDir, "artifacts"),
    },
    proactivePulse: {
      enabled: false,
      intervalMs: 60000,
    },
  };
}

export function loadConfig(configPath?: string): JarvisConfig {
  const defaults = getDefaultConfig();
  const targetPath = configPath || path.join(process.cwd(), "jarvis.config.json");
  
  if (fs.existsSync(targetPath)) {
    try {
      const raw = fs.readFileSync(targetPath, "utf-8");
      const userCfg = JSON.parse(raw);
      const loaded: JarvisConfig = {
        ...defaults,
        ...userCfg,
        opencode: {
          ...defaults.opencode,
          ...(userCfg.opencode || {}),
          legacyProtocolMode: userCfg.opencode?.legacyProtocolMode !== undefined
            ? Boolean(userCfg.opencode.legacyProtocolMode)
            : (process.env.OPENCODE_LEGACY_PROTOCOL_MODE === "true"),
        },
        models: {
          fast: { ...defaults.models.fast, ...(userCfg.models?.fast || {}) },
          agent: { ...defaults.models.agent, ...(userCfg.models?.agent || {}) },
          agentWeight: userCfg.models?.agentWeight !== undefined ? userCfg.models.agentWeight : defaults.models.agentWeight,
          creativityWeight: userCfg.models?.creativityWeight !== undefined ? userCfg.models.creativityWeight : defaults.models.creativityWeight,
        },
        fallbackProvider: { ...defaults.fallbackProvider, ...(userCfg.fallbackProvider || {}) },
        logging: { ...defaults.logging, ...(userCfg.logging || {}) },
        personality: { ...defaults.personality, ...(userCfg.personality || {}) },
        artifacts: { ...defaults.artifacts, ...(userCfg.artifacts || {}) },
        proactivePulse: { ...defaults.proactivePulse, ...(userCfg.proactivePulse || {}) },
      };

      // Compatibility: if user config provided fastModel (e.g. tests or legacy config)
      if (userCfg.fastModel) {
        loaded.fastModel = userCfg.fastModel;
        if (userCfg.fastModel.provider === "mock" || userCfg.fastModel.provider === "openai-compatible" || userCfg.fastModel.provider === "unconfigured") {
          loaded.fallbackProvider = {
            enabled: true,
            provider: userCfg.fastModel.provider,
            model: userCfg.fastModel.model,
            baseURL: userCfg.fastModel.baseURL,
            apiKeyEnv: userCfg.fastModel.apiKeyEnv,
            apiKey: userCfg.fastModel.apiKey,
          };
        }
      }

      return loaded;
    } catch (err) {
      console.warn(`[Config] Failed to parse ${targetPath}, using defaults:`, err);
    }
  }

  return defaults;
}

/**
 * Persist configuration changes to disk with atomic write semantics.
 * Preserves unrelated configuration entries and avoids exposing secrets.
 */
export function saveConfig(config: JarvisConfig, configPath?: string): void {
  const targetPath = configPath || path.join(process.cwd(), "jarvis.config.json");
  let existing: Record<string, any> = {};

  if (fs.existsSync(targetPath)) {
    const raw = fs.readFileSync(targetPath, "utf-8").trim();
    if (raw.length > 0) {
      try {
        existing = JSON.parse(raw);
        if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
          throw new Error("Configuration root must be a JSON object");
        }
      } catch (parseErr: any) {
        const corruptBackupPath = `${targetPath}.corrupt.bak.${Date.now()}`;
        try {
          fs.writeFileSync(corruptBackupPath, raw, "utf-8");
        } catch {}
        throw new Error(
          `Refusing to overwrite malformed configuration file at ${targetPath}: ${parseErr.message}. A recovery backup was saved to ${corruptBackupPath}`
        );
      }
    }
  }

  const updated: Record<string, any> = {
    ...existing,
    models: {
      ...(existing.models || {}),
      fast: {
        providerID: config.models.fast.providerID,
        modelID: config.models.fast.modelID,
        variant: config.models.fast.variant || "default",
      },
      agent: {
        providerID: config.models.agent.providerID,
        modelID: config.models.agent.modelID,
        variant: config.models.agent.variant || "default",
        agentID: config.models.agent.agentID || "build",
      },
      ...(config.models.agentWeight !== undefined ? { agentWeight: config.models.agentWeight } : {}),
    },
  };

  // Atomic write semantics: write to unique temporary file, then renameSync
  const tmpPath = `${targetPath}.tmp.${Date.now()}.${Math.random().toString(36).substring(2, 7)}`;
  fs.writeFileSync(tmpPath, JSON.stringify(updated, null, 2), "utf-8");
  fs.renameSync(tmpPath, targetPath);
}
