/**
 * JARVIS TTS Provider Interface
 * 
 * Provides a clean, decoupled abstraction for speech synthesis:
 * - Local Neural TTS (Kokoro-82M primary)
 * - System Speech Synthesis (Fallback)
 * - Audio analysis & streaming compatibility
 */

export interface TTSOptions {
  voice?: string;
  speed?: number; // 0.5 - 2.0 (default 1.0)
  pitch?: number; // 0.5 - 1.5
  volume?: number; // 0.0 - 1.0
  lang?: string;
}

export interface TTSAudioResult {
  audioBuffer: Buffer;
  format: "wav" | "mp3" | "pcm";
  sampleRate: number;
  durationSec?: number;
  alignment?: Array<{ word: string; startMs: number; endMs: number }>;
}

export interface TTSProvider {
  readonly name: string;
  readonly isNeural: boolean;
  synthesize(text: string, options?: TTSOptions): Promise<TTSAudioResult>;
  speak(text: string, options?: TTSOptions, signal?: AbortSignal): Promise<void>;
  stop(): Promise<void>;
  pause?(): Promise<void>;
  resume?(): Promise<void>;
  isAvailable(): Promise<boolean>;
}
