/**
 * JARVIS Voice Architecture
 * 
 * Provider-agnostic interface for Speech-To-Text (STT) and Text-To-Speech (TTS).
 * Supports browser Web Speech API for seamless push-to-talk and Windows SAPI fallback.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { Logger } from "../logger.ts";

const execAsync = promisify(exec);

export interface STTResult {
  text: string;
  confidence: number;
}

export interface SpeechToTextProvider {
  name: string;
  transcribe(audioBuffer: Buffer): Promise<STTResult>;
}

export interface TextToSpeechProvider {
  name: string;
  speak(text: string): Promise<void>;
}

/**
 * Windows SAPI Native Text-To-Speech Provider.
 * High-speed, offline, zero-dependency speech synthesis on Windows.
 */
export class WindowsSapiTTS implements TextToSpeechProvider {
  public name = "WindowsSAPI";
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.forComponent("WindowsSapiTTS");
  }

  public async speak(text: string): Promise<void> {
    // Sanitize text for PowerShell execution
    const safeText = text.replace(/["'`$\\]/g, " ").replace(/\s+/g, " ").trim();
    if (!safeText) return;

    try {
      await execAsync(
        `powershell -NoProfile -Command "(New-Object -ComObject SAPI.SpVoice).Speak('${safeText}')"`
      );
    } catch (err: any) {
      this.logger.warn("Windows SAPI TTS failed:", { error: err.message });
    }
  }
}

/**
 * Voice Service orchestrator managing STT and TTS states.
 */
export class VoiceService {
  private ttsProvider: TextToSpeechProvider;
  private logger: Logger;

  constructor(logger: Logger, customTts?: TextToSpeechProvider) {
    this.logger = logger.forComponent("VoiceService");
    this.ttsProvider = customTts || new WindowsSapiTTS(logger);
  }

  public async speak(text: string): Promise<void> {
    this.logger.debug(`Speaking text: "${text.substring(0, 40)}..."`);
    await this.ttsProvider.speak(text);
  }

  public getStatus() {
    return {
      ttsProvider: this.ttsProvider.name,
      pushToTalkAvailable: true,
      webSpeechSupported: true,
    };
  }
}
