import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface OpenCodeModelProfile {
  providerID: string;
  modelID: string;
  variant?: string;
}

export interface JarvisModelsConfig {
  fast: OpenCodeModelProfile;
  agent: OpenCodeModelProfile;
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

export function getDefaultConfig(): JarvisConfig {
  const home = os.homedir();
  const defaultDataDir = path.join(process.cwd(), ".jarvis_data");
  
  // Prefer .local/state/opencode/service.json then fallback to .config/opencode/service.json
  const defaultStateFile = path.join(home, ".local", "state", "opencode", "service.json");
  const fallbackStateFile = path.join(home, ".config", "opencode", "service.json");
  const chosenServiceFile = fs.existsSync(defaultStateFile) ? defaultStateFile : fallbackStateFile;

  // Detect CLI binary if possible
  const possibleCliPaths = [
    path.join(home, "AppData", "Roaming", "ai.opencode.desktop", "cli", "2.0.15", "opencode-cli.exe"),
    path.join(home, "AppData", "Local", "Programs", "@opencodedesktop", "resources", "opencode-cli.exe"),
  ];
  let detectedCli: string | undefined;
  for (const cp of possibleCliPaths) {
    if (fs.existsSync(cp)) {
      detectedCli = cp;
      break;
    }
  }

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
      },
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
        opencode: { ...defaults.opencode, ...(userCfg.opencode || {}) },
        models: {
          fast: { ...defaults.models.fast, ...(userCfg.models?.fast || {}) },
          agent: { ...defaults.models.agent, ...(userCfg.models?.agent || {}) },
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
