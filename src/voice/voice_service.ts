/**
 * JARVIS Decoupled Voice Architecture
 * 
 * Provides:
 * - Decoupled STT and TTS interfaces
 * - Push-to-Talk and Wake-Word architectures
 * - Sleep / Awake state management
 * - Instant speech interruption and stop speaking control
 * - Pluggable wake-word detection ("Hey Jarvis", "wake up", "go to sleep")
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { Logger } from "../logger.ts";

const execAsync = promisify(exec);

export type VoiceState = "awake" | "sleeping";
export type VoiceInputMode = "push_to_talk" | "wake_word" | "disabled";

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
  speak(text: string, signal?: AbortSignal): Promise<void>;
  stop?(): Promise<void>;
}

export interface WakeWordDetector {
  name: string;
  wakeWords: string[];
  sleepWords: string[];
  evaluateText(text: string): { type: "wake" | "sleep" | "none"; matchedWord?: string };
}

/**
 * Built-in Rule-Based Wake Word Detector.
 */
export class DefaultWakeWordDetector implements WakeWordDetector {
  public name = "DefaultWakeWordDetector";
  public wakeWords = ["wake up jarvis", "wake up", "hey jarvis", "jarvis"];
  public sleepWords = ["go to sleep", "sleep jarvis", "stand by jarvis", "stand by", "mute voice"];

  public evaluateText(text: string): { type: "wake" | "sleep" | "none"; matchedWord?: string } {
    const lower = text.toLowerCase().trim();

    // Prioritize longer phrases first
    const sortedSleep = [...this.sleepWords].sort((a, b) => b.length - a.length);
    for (const w of sortedSleep) {
      if (lower === w || lower.startsWith(w + " ") || lower.endsWith(" " + w) || lower.includes(w)) {
        return { type: "sleep", matchedWord: w };
      }
    }

    const sortedWake = [...this.wakeWords].sort((a, b) => b.length - a.length);
    for (const w of sortedWake) {
      if (lower === w || lower.startsWith(w + " ") || lower.endsWith(" " + w) || lower.includes(w)) {
        return { type: "wake", matchedWord: w };
      }
    }

    return { type: "none" };
  }
}

/**
 * In-Memory Mock Text-To-Speech Provider for offline testing and fast unit tests.
 */
export class MockTTSProvider implements TextToSpeechProvider {
  public name = "MockTTSProvider";
  public spokenHistory: string[] = [];
  public isCurrentlySpeaking = false;
  private abortController: AbortController | null = null;

  public async speak(text: string, signal?: AbortSignal): Promise<void> {
    this.abortController = new AbortController();
    this.isCurrentlySpeaking = true;
    this.spokenHistory.push(text);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.isCurrentlySpeaking = false;
        resolve();
      }, 50);

      const cancel = () => {
        clearTimeout(timer);
        this.isCurrentlySpeaking = false;
        resolve();
      };

      if (signal) signal.addEventListener("abort", cancel);
      this.abortController?.signal.addEventListener("abort", cancel);
    });
  }

  public async stop(): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.isCurrentlySpeaking = false;
  }
}

/**
 * Native Windows SAPI Speech Provider.
 */
export class WindowsSapiTTS implements TextToSpeechProvider {
  public name = "WindowsSAPI";
  private logger: Logger;
  private currentChild: any = null;

  constructor(logger: Logger) {
    this.logger = logger.forComponent("WindowsSapiTTS");
  }

  public async speak(text: string, signal?: AbortSignal): Promise<void> {
    const safeText = text.replace(/["'`$\\]/g, " ").replace(/\s+/g, " ").trim();
    if (!safeText) return;

    try {
      await execAsync(
        `powershell -NoProfile -Command "(New-Object -ComObject SAPI.SpVoice).Speak('${safeText}')"`,
        { signal }
      );
    } catch (err: any) {
      if (err.name !== "AbortError") {
        this.logger.warn("Windows SAPI TTS failed:", { error: err.message });
      }
    }
  }

  public async stop(): Promise<void> {
    try {
      await execAsync(`powershell -NoProfile -Command "Stop-Process -Name powershell -ErrorAction SilentlyContinue"`);
    } catch {}
  }
}

/**
 * Central Voice Service Orchestrator
 */
export class VoiceService {
  private ttsProvider: TextToSpeechProvider;
  private sttProvider?: SpeechToTextProvider;
  private wakeDetector: WakeWordDetector;
  private logger: Logger;

  private state: VoiceState = "awake";
  private mode: VoiceInputMode = "push_to_talk";
  private isPushToTalkActive = false;
  private activeAbortController: AbortController | null = null;

  constructor(
    logger: Logger,
    options?: {
      tts?: TextToSpeechProvider;
      stt?: SpeechToTextProvider;
      wakeDetector?: WakeWordDetector;
      initialState?: VoiceState;
    }
  ) {
    this.logger = logger.forComponent("VoiceService");
    this.ttsProvider = options?.tts || (process.env.NODE_ENV === "test" ? new MockTTSProvider() : new WindowsSapiTTS(logger));
    this.sttProvider = options?.stt;
    this.wakeDetector = options?.wakeDetector || new DefaultWakeWordDetector();
    this.state = options?.initialState || "awake";
  }

  public getState(): VoiceState {
    return this.state;
  }

  public setSleepState(state: VoiceState): void {
    const old = this.state;
    this.state = state;
    this.logger.info(`Voice state transitioned: ${old} -> ${state}`);
  }

  public wake(): void {
    this.setSleepState("awake");
  }

  public sleep(): void {
    this.interrupt();
    this.setSleepState("sleeping");
  }

  public startPushToTalk(): void {
    this.isPushToTalkActive = true;
    this.wake();
    this.logger.debug("Push-to-talk activated");
  }

  public endPushToTalk(): void {
    this.isPushToTalkActive = false;
    this.logger.debug("Push-to-talk deactivated");
  }

  /**
   * Process incoming speech transcript through wake/sleep state machine.
   * Returns whether it was consumed or should proceed to core execution.
   */
  public processTranscript(transcript: string): {
    proceed: boolean;
    state: VoiceState;
    prompt?: string;
    action?: "wake" | "sleep" | "none";
  } {
    const trimmed = transcript.trim();
    if (!trimmed) {
      return { proceed: false, state: this.state, action: "none" };
    }

    const evalResult = this.wakeDetector.evaluateText(trimmed);

    // Case 1: Sleep command received
    if (evalResult.type === "sleep") {
      this.sleep();
      return { proceed: false, state: "sleeping", action: "sleep" };
    }

    // Case 2: In sleeping state
    if (this.state === "sleeping") {
      if (evalResult.type === "wake") {
        this.wake();
        let cleanPrompt = trimmed.replace(/^(?:(?:hey|wake\s+up|ok|hello)\s+)?jarvis[\s,]*/i, "").trim();
        if (evalResult.matchedWord && cleanPrompt === trimmed) {
          cleanPrompt = cleanPrompt.replace(new RegExp(`^${evalResult.matchedWord}[\\s,]*`, "i"), "").trim();
        }
        if (cleanPrompt.length === 0) {
          return { proceed: true, state: "awake", action: "wake", prompt: "Hello Jarvis" };
        }
        return { proceed: true, state: "awake", action: "wake", prompt: cleanPrompt };
      }

      // Ignore all other speech while sleeping
      return { proceed: false, state: "sleeping", action: "none" };
    }

    // Case 3: Awake state - strip optional wake word prefix if user said "Jarvis, what time is it?"
    let userPrompt = trimmed.replace(/^(?:(?:hey|wake\s+up|ok|hello)\s+)?jarvis[\s,]*/i, "").trim();
    if (evalResult.matchedWord && userPrompt === trimmed) {
      userPrompt = userPrompt.replace(new RegExp(`^${evalResult.matchedWord}[\\s,]*`, "i"), "").trim();
    }

    return {
      proceed: true,
      state: "awake",
      prompt: userPrompt || trimmed,
      action: "none",
    };
  }

  /**
   * Speak response using configured TTS provider.
   */
  public async speak(text: string): Promise<void> {
    if (this.state === "sleeping") return;

    this.interrupt();
    this.activeAbortController = new AbortController();

    this.logger.debug(`Speaking: "${text.substring(0, 40)}..."`);
    try {
      await this.ttsProvider.speak(text, this.activeAbortController.signal);
    } finally {
      this.activeAbortController = null;
    }
  }

  /**
   * Interrupt active speech and immediately silence TTS.
   */
  public interrupt(): void {
    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }
    if (this.ttsProvider.stop) {
      this.ttsProvider.stop().catch(() => {});
    }
    this.logger.debug("Speech interrupted and silenced");
  }

  public getStatus() {
    return {
      state: this.state,
      mode: this.mode,
      isPushToTalkActive: this.isPushToTalkActive,
      ttsProvider: this.ttsProvider.name,
      sttProvider: this.sttProvider ? this.sttProvider.name : "BrowserWebSpeech",
      wakeDetector: this.wakeDetector.name,
    };
  }
}
