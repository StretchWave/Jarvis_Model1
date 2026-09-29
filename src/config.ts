import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface FastModelConfig {
  provider: "mock" | "openai" | "anthropic" | "gemini" | "groq" | "custom";
  model: string;
  apiKey?: string;
  baseURL?: string;
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
    fastModel: {
      provider: "mock",
      model: "fast-default",
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
      };
    } catch (err) {
      console.warn(`[Config] Failed to parse ${targetPath}, using defaults:`, err);
    }
  }

  return defaults;
}
