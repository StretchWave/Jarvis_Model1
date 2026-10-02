/**
 * Kokoro-82M Local Neural Text-to-Speech Provider
 * 
 * Target:
 * - Local inference without external API keys or cloud telemetry
 * - 82M parameter official Kokoro architecture
 * - Persistent in-memory worker process (zero per-request process startup / reload latency)
 * - British/UK voices (bm_george, bm_lewis, bf_emma) and US voices (af_bella, am_adam)
 * - Outputs 24kHz PCM/WAV buffer for Web Audio AnalyserNode integration
 * - Managed under ~/.jarvis/models/tts/kokoro
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Logger } from "../logger.ts";
import type { TTSProvider, TTSOptions, TTSAudioResult } from "./tts_provider.ts";
import { KokoroWorkerManager } from "./kokoro_worker_manager.ts";

export class KokoroTTSProvider implements TTSProvider {
  public readonly name = "Kokoro-82M (Neural)";
  public readonly isNeural = true;
  private logger: Logger;
  private modelDir: string;
  private workerManager: KokoroWorkerManager;

  constructor(logger: Logger, customModelDir?: string) {
    this.logger = logger.forComponent("KokoroTTS");
    this.modelDir = customModelDir || path.join(os.homedir(), ".jarvis", "models", "tts", "kokoro");
    this.workerManager = new KokoroWorkerManager(logger, this.modelDir);
  }

  public getModelDirectory(): string {
    return this.modelDir;
  }

  public getWorkerManager(): KokoroWorkerManager {
    return this.workerManager;
  }

  public detectRuntime(): { modelDir: string; installed: boolean; pythonPath: string | null } {
    const pythonPath = this.workerManager.detectPython();
    const installed = this.workerManager.isInstalled();
    return {
      modelDir: this.modelDir,
      installed,
      pythonPath,
    };
  }

  public async isAvailable(): Promise<boolean> {
    return this.workerManager.isInstalled();
  }

  public async synthesize(text: string, options?: TTSOptions): Promise<TTSAudioResult> {
    const available = await this.isAvailable();
    if (!available) {
      throw new Error("Kokoro-82M neural TTS is not installed. Please run 'npm run tts:setup' or use system voice fallback.");
    }

    const voice = options?.voice || "bm_george"; // British male default (calm and focused)
    const speed = options?.speed ?? 1.0;

    try {
      return await this.workerManager.synthesize(text, {
        voice,
        speed,
        timeoutMs: options?.timeoutMs || 20000,
      });
    } catch (err: any) {
      this.logger.error("Kokoro persistent synthesis failed:", { error: err.message });
      throw new Error(`Kokoro neural synthesis failed: ${err.message}`);
    }
  }

  public async speak(text: string, options?: TTSOptions, signal?: AbortSignal): Promise<void> {
    const { audioBuffer } = await this.synthesize(text, options);
    this.logger.debug(`Synthesized ${audioBuffer.length} bytes of speech for: "${text.substring(0, 30)}..."`);
  }

  public async stop(): Promise<void> {
    // Interruption
  }

  public async shutdown(): Promise<void> {
    await this.workerManager.shutdown();
  }
}
