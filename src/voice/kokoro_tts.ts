/**
 * Kokoro-82M Local Neural Text-to-Speech Provider
 * 
 * Target:
 * - Local inference without external API keys or cloud telemetry
 * - 82M parameter official Kokoro architecture
 * - English with British/UK-capable voices (bm_george, bm_lewis, bf_emma)
 * - Outputs 24kHz PCM/WAV buffer for Web Audio AnalyserNode integration
 * - Model files managed under ~/.jarvis/models/tts/kokoro or .jarvis_data/models/tts/kokoro
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Logger } from "../logger.ts";
import type { TTSProvider, TTSOptions, TTSAudioResult } from "./tts_provider.ts";

const execFileAsync = promisify(execFile);

export class KokoroTTSProvider implements TTSProvider {
  public readonly name = "Kokoro-82M (Neural)";
  public readonly isNeural = true;
  private logger: Logger;
  private modelDir: string;
  private pythonExe: string | null = null;
  private isChecking = false;
  private isCachedAvailable: boolean | null = null;

  constructor(logger: Logger, customModelDir?: string) {
    this.logger = logger.forComponent("KokoroTTS");
    this.modelDir = customModelDir || path.join(os.homedir(), ".jarvis", "models", "tts", "kokoro");
    this.detectRuntime();
  }

  public getModelDirectory(): string {
    return this.modelDir;
  }

  public detectRuntime(): { modelDir: string; installed: boolean; pythonPath: string | null } {
    // Check possible virtual environment locations
    const possibleEnvs = [
      path.join(this.modelDir, "venv", "Scripts", "python.exe"),
      path.join(this.modelDir, "venv", "bin", "python"),
      path.join(process.cwd(), ".jarvis_data", "models", "tts", "venv", "Scripts", "python.exe"),
      path.join(process.cwd(), ".jarvis_data", "models", "tts", "venv", "bin", "python"),
    ];

    for (const p of possibleEnvs) {
      if (fs.existsSync(p)) {
        this.pythonExe = p;
        break;
      }
    }

    const hasModelFiles = (
      fs.existsSync(path.join(this.modelDir, "kokoro-v0_19.onnx")) ||
      fs.existsSync(path.join(this.modelDir, "kokoro-v1_0.onnx")) ||
      fs.existsSync(path.join(this.modelDir, "model.bin"))
    );

    const installed = Boolean(this.pythonExe && hasModelFiles);
    this.isCachedAvailable = installed;
    return {
      modelDir: this.modelDir,
      installed,
      pythonPath: this.pythonExe,
    };
  }

  public async isAvailable(): Promise<boolean> {
    if (this.isCachedAvailable !== null) {
      return this.isCachedAvailable;
    }
    const { installed } = this.detectRuntime();
    return installed;
  }

  public async synthesize(text: string, options?: TTSOptions): Promise<TTSAudioResult> {
    const available = await this.isAvailable();
    if (!available || !this.pythonExe) {
      throw new Error("Kokoro-82M neural TTS is not installed. Please run 'npm run tts:setup' or use system voice fallback.");
    }

    const voice = options?.voice || "bm_george"; // British male default (calm and connected)
    const speed = options?.speed || 1.0;

    const synthScript = path.join(this.modelDir, "synthesize.py");
    if (!fs.existsSync(synthScript)) {
      throw new Error(`Synthesis script not found at: ${synthScript}`);
    }

    // Call isolated Python inference runner with JSON input
    const inputPayload = JSON.stringify({
      text,
      voice,
      speed,
      model_dir: this.modelDir,
    });
    const b64Payload = Buffer.from(inputPayload, "utf-8").toString("base64");

    try {
      const { stdout } = await execFileAsync(this.pythonExe, [synthScript, "--b64", b64Payload], {
        maxBuffer: 20 * 1024 * 1024,
        windowsHide: true,
      });

      const parsed = JSON.parse(stdout);
      if (parsed.error) {
        throw new Error(`Kokoro synthesis error: ${parsed.error}`);
      }

      const audioBuffer = Buffer.from(parsed.audioBase64, "base64");
      return {
        audioBuffer,
        format: "wav",
        sampleRate: parsed.sampleRate || 24000,
        durationSec: parsed.durationSec,
      };
    } catch (err: any) {
      this.logger.error("Kokoro synthesis execution failed:", { error: err.message });
      throw new Error(`Kokoro neural synthesis failed: ${err.message}`);
    }
  }

  public async speak(text: string, options?: TTSOptions, signal?: AbortSignal): Promise<void> {
    const { audioBuffer } = await this.synthesize(text, options);
    // On desktop, audio playback is typically handled by Web Audio in BrowserWindow/Renderer
    // Server-side direct playback can output to system or temp file if needed.
    this.logger.debug(`Synthesized ${audioBuffer.length} bytes of speech for: "${text.substring(0, 30)}..."`);
  }

  public async stop(): Promise<void> {
    // Cancellation
  }
}
