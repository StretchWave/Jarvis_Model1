/**
 * JARVIS Model Provider Factory
 * 
 * Central factory for instantiating model providers based on generic configuration.
 */

import { type FastModelConfig } from "../config.ts";
import { Logger } from "../logger.ts";
import { OpenCodeClient } from "../opencode_client.ts";
import {
  type ModelProvider,
  type FastModelProvider,
  type AgentModelProvider,
  OpenAICompatibleProvider,
  MockFastProvider,
  UnconfiguredFastProvider,
  OpenCodeProvider,
} from "./provider.ts";

export function createFastModelProvider(
  config: FastModelConfig,
  logger: Logger
): FastModelProvider {
  if (config.provider === "mock") {
    logger.warn("Using MockFastProvider (development/test mode only). Production must use a real cloud or local model.");
    return new MockFastProvider();
  }

  if (config.provider === "openai-compatible" || (config.provider as string) === "openai") {
    return new OpenAICompatibleProvider(
      {
        model: config.model,
        baseURL: config.baseURL,
        apiKeyEnv: config.apiKeyEnv || "FAST_MODEL_API_KEY",
        apiKey: config.apiKey,
        headers: config.headers,
      },
      logger
    );
  }

  return new UnconfiguredFastProvider();
}

export function createAgentModelProvider(
  client: OpenCodeClient,
  logger: Logger
): AgentModelProvider {
  return new OpenCodeProvider(client, logger);
}
