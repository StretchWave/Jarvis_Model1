/**
 * JARVIS Model Executor Factory
 * 
 * Instantiates the primary OpenCode model executor,
 * optional direct fallback executor (opt-in only),
 * or mock executor for offline testing.
 */

import { type JarvisConfig } from "../config.ts";
import { Logger } from "../logger.ts";
import { OpenCodeClient } from "../opencode_client.ts";
import { SessionManager } from "../session_manager.ts";
import {
  type ModelProvider,
  type FastModelProvider,
  type AgentModelProvider,
  OpenCodeModelProvider,
  OpenAICompatibleProvider,
  MockFastProvider,
  UnconfiguredFastProvider,
  OpenCodeProvider,
} from "./provider.ts";

export interface CreateModelExecutorOptions {
  config: JarvisConfig;
  client: OpenCodeClient;
  sessionMgr?: SessionManager;
  profileType: "fast" | "agent";
  logger: Logger;
}

/**
 * Creates the model executor for a given profile (FAST or AGENT).
 * By default, routes through OpenCode as the sole unified model gateway.
 */
export function createModelExecutor(options: CreateModelExecutorOptions): ModelProvider {
  const { config, client, sessionMgr, profileType, logger } = options;

  // 1. Check if an explicit fallback provider is configured and enabled (opt-in only)
  if (config.fallbackProvider?.enabled) {
    const fb = config.fallbackProvider;
    if (fb.provider === "mock") {
      logger.warn("[Executor] Using MockFastProvider (development/mock mode only).");
      return new MockFastProvider();
    }
    if (fb.provider === "openai-compatible" || fb.provider === "openai") {
      return new OpenAICompatibleProvider(
        {
          model: fb.model || "gpt-4o-mini",
          baseURL: fb.baseURL,
          apiKeyEnv: fb.apiKeyEnv || "FAST_MODEL_API_KEY",
          apiKey: fb.apiKey,
          headers: fb.headers,
        },
        logger
      );
    }
    if (fb.provider === "unconfigured") {
      return new UnconfiguredFastProvider();
    }
  }

  // Legacy fastModel provider overrides (for test suite compatibility)
  if (config.fastModel?.provider === "unconfigured") {
    return new UnconfiguredFastProvider();
  }
  if (config.fastModel?.provider === "mock") {
    logger.warn("[Executor] Using MockFastProvider via legacy fastModel.provider.");
    return new MockFastProvider();
  }

  // 2. Primary Production Gateway: OpenCode
  const profile = profileType === "fast" ? config.models.fast : config.models.agent;
  return new OpenCodeModelProvider(
    {
      client,
      sessionMgr,
      modelProfile: profile,
      name: `OpenCodeExecutor(${profile.providerID}/${profile.modelID})`,
    },
    logger
  );
}

/**
 * Backward compatibility factory function.
 */
export function createFastModelProvider(
  configOrOptions: any,
  logger: Logger,
  client?: OpenCodeClient,
  sessionMgr?: SessionManager
): FastModelProvider {
  if (configOrOptions && configOrOptions.provider) {
    if (configOrOptions.provider === "mock") {
      return new MockFastProvider();
    }
    if (configOrOptions.provider === "openai-compatible" || configOrOptions.provider === "openai") {
      return new OpenAICompatibleProvider(configOrOptions, logger);
    }
    if (configOrOptions.provider === "unconfigured") {
      return new UnconfiguredFastProvider();
    }
  }

  if (client) {
    return createModelExecutor({
      config: configOrOptions,
      client,
      sessionMgr,
      profileType: "fast",
      logger,
    });
  }

  return new UnconfiguredFastProvider();
}

export function createAgentModelProvider(
  client: OpenCodeClient,
  logger: Logger
): AgentModelProvider {
  return new OpenCodeProvider(client, logger);
}
