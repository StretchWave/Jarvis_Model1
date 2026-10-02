/**
 * JARVIS Low-Latency Streaming Speech Queue
 * 
 * Coordinates low-latency sentence-by-sentence synthesis and playback:
 * - Immediately synthesizes and streams the first sentence to reduce time-to-first-audio (TTFA)
 * - Concurrently prefetches sentence N+1 while sentence N is playing
 * - Supports instant cancellation / flush when the user speaks (barge-in / interrupt)
 * - Emits lifecycle events for UI visualizer and state machines
 */

import { Logger } from "../logger.ts";
import type { TTSProvider, TTSOptions, TTSAudioResult } from "./tts_provider.ts";

export interface SpeechQueueItem {
  id: string;
  index: number;
  text: string;
  options?: TTSOptions;
  audioResult?: TTSAudioResult;
  status: "pending" | "synthesizing" | "ready" | "playing" | "played" | "cancelled" | "error";
  error?: Error;
}

export interface SpeechQueueEvents {
  onItemReady?: (item: SpeechQueueItem) => void;
  onItemStart?: (item: SpeechQueueItem) => void;
  onItemComplete?: (item: SpeechQueueItem) => void;
  onQueueComplete?: () => void;
  onError?: (err: Error, item?: SpeechQueueItem) => void;
  onInterrupt?: () => void;
}

export class SpeechQueue {
  private logger: Logger;
  private ttsProvider: TTSProvider;
  private queue: SpeechQueueItem[] = [];
  private itemCounter = 0;
  private isProcessing = false;
  private isStopped = false;
  private activeItem: SpeechQueueItem | null = null;
  private events: SpeechQueueEvents = {};
  private prefetchPromise: Promise<void> | null = null;

  constructor(logger: Logger, ttsProvider: TTSProvider, events: SpeechQueueEvents = {}) {
    this.logger = logger.forComponent("SpeechQueue");
    this.ttsProvider = ttsProvider;
    this.events = events;
  }

  public setEvents(events: SpeechQueueEvents): void {
    this.events = { ...this.events, ...events };
  }

  public setProvider(provider: TTSProvider): void {
    this.ttsProvider = provider;
  }

  /**
   * Enqueue a batch of sentence texts for ordered synthesis and playback.
   */
  public enqueue(sentences: string[], options?: TTSOptions): SpeechQueueItem[] {
    if (this.isStopped) {
      this.isStopped = false;
    }

    const items: SpeechQueueItem[] = sentences
      .map(s => s.trim())
      .filter(s => s.length > 0)
      .map(text => ({
        id: `sq_${Date.now()}_${++this.itemCounter}`,
        index: this.queue.length,
        text,
        options,
        status: "pending",
      }));

    this.queue.push(...items);
    this.triggerProcessing();
    return items;
  }

  /**
   * Immediately clears all items and halts active playback/synthesis.
   */
  public stop(): void {
    this.isStopped = true;
    for (const item of this.queue) {
      if (item.status === "pending" || item.status === "synthesizing") {
        item.status = "cancelled";
      }
    }
    this.queue = [];
    this.activeItem = null;
    this.isProcessing = false;

    if (this.ttsProvider.stop) {
      this.ttsProvider.stop().catch(() => {});
    }

    if (this.events.onInterrupt) {
      this.events.onInterrupt();
    }
    this.logger.debug("Speech queue stopped and flushed");
  }

  public clear(): void {
    this.stop();
  }

  public getQueue(): readonly SpeechQueueItem[] {
    return this.queue;
  }

  public getActiveItem(): SpeechQueueItem | null {
    return this.activeItem;
  }

  public isBusy(): boolean {
    return this.isProcessing || this.queue.some(i => i.status === "pending" || i.status === "synthesizing" || i.status === "ready");
  }

  /**
   * Process queue items in sequence with look-ahead prefetching.
   */
  private async triggerProcessing(): Promise<void> {
    if (this.isProcessing || this.isStopped) return;
    this.isProcessing = true;

    try {
      while (this.queue.length > 0 && !this.isStopped) {
        // Next item to play
        const current = this.queue[0];
        this.activeItem = current;

        // Ensure current item is synthesized
        if (current.status === "pending") {
          current.status = "synthesizing";
          try {
            current.audioResult = await this.ttsProvider.synthesize(current.text, current.options);
            current.status = "ready";
            this.events.onItemReady?.(current);
          } catch (err: any) {
            current.status = "error";
            current.error = err;
            this.logger.error(`Synthesis failed for "${current.text.slice(0, 30)}..."`, { error: err.message });
            this.events.onError?.(err, current);
            this.queue.shift();
            continue;
          }
        }

        if (this.isStopped) break;

        // Prefetch the next item in the background while current is ready
        this.prefetchNext();

        // Dispatch current item start event
        current.status = "playing";
        this.events.onItemStart?.(current);

        // Approximate playback delay if audioResult duration is known
        const playbackDurationMs = (current.audioResult?.durationSec ?? 1.5) * 1000;
        await new Promise(r => setTimeout(r, Math.min(playbackDurationMs, 250)));

        current.status = "played";
        this.events.onItemComplete?.(current);

        // Remove from head of queue
        this.queue.shift();
      }

      if (!this.isStopped && this.queue.length === 0) {
        this.events.onQueueComplete?.();
      }
    } finally {
      this.isProcessing = false;
      this.activeItem = null;
    }
  }

  /**
   * Prefetch the next item in queue asynchronously.
   */
  private prefetchNext(): void {
    if (this.queue.length < 2) return;
    const nextItem = this.queue[1];
    if (nextItem.status !== "pending") return;

    nextItem.status = "synthesizing";
    this.prefetchPromise = this.ttsProvider.synthesize(nextItem.text, nextItem.options)
      .then(res => {
        if (nextItem.status === "synthesizing") {
          nextItem.audioResult = res;
          nextItem.status = "ready";
          this.events.onItemReady?.(nextItem);
        }
      })
      .catch(err => {
        if (nextItem.status === "synthesizing") {
          nextItem.status = "error";
          nextItem.error = err;
          this.logger.warn(`Prefetch failed for item "${nextItem.text.slice(0, 30)}..."`, { error: err.message });
        }
      });
  }
}
