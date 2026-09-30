import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface FastModelConfig {
  provider: "openai-compatible" | "mock" | "unconfigured" | string;
  model: string;
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
  fastModel: FastModelConfig;
  agentModel: {
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
    fastModel: process.env.JARVIS_FAST_PROVIDER === "mock"
      ? {
          provider: "mock",
          model: "mock-fast",
        }
      : {
          provider: "openai-compatible",
          model: process.env.FAST_MODEL || "gpt-4o-mini",
          baseURL: process.env.FAST_MODEL_BASE_URL || "https://api.openai.com/v1",
          apiKeyEnv: "FAST_MODEL_API_KEY",
          apiKey: process.env.FAST_MODEL_API_KEY || process.env.OPENAI_API_KEY,
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
      return {
        ...defaults,
        ...userCfg,
        opencode: { ...defaults.opencode, ...(userCfg.opencode || {}) },
        fastModel: { ...defaults.fastModel, ...(userCfg.fastModel || {}) },
        agentModel: { ...defaults.agentModel, ...(userCfg.agentModel || {}) },
        logging: { ...defaults.logging, ...(userCfg.logging || {}) },
        personality: { ...defaults.personality, ...(userCfg.personality || {}) },
        artifacts: { ...defaults.artifacts, ...(userCfg.artifacts || {}) },
        proactivePulse: { ...defaults.proactivePulse, ...(userCfg.proactivePulse || {}) },
      };
    } catch (err) {
      console.warn(`[Config] Failed to parse ${targetPath}, using defaults:`, err);
    }
  }

  return defaults;
}
