/**
 * JARVIS Persistent Kokoro Worker Manager
 * 
 * Manages a long-lived Python worker process running Kokoro-82M in memory:
 * - Spawns Python worker once and keeps weights resident
 * - Correlates concurrent or sequential synthesis requests via request ID
 * - Dispatches newline-delimited JSON across stdin/stdout
 * - Automatically recovers and restarts worker upon unexpected crash
 * - Timeouts slow requests and cleanly rejects pending queue on termination
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { Logger } from "../logger.ts";
import type { TTSOptions, TTSAudioResult } from "./tts_provider.ts";

interface PendingRequest {
  resolve: (res: TTSAudioResult) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class KokoroWorkerManager {
  private logger: Logger;
  private modelDir: string;
  private pythonExe: string | null = null;
  private workerProcess: ChildProcess | null = null;
  private stdoutBuffer = "";
  private pendingRequests = new Map<string, PendingRequest>();
  private reqCounter = 0;
  private isStarting = false;
  private isShuttingDown = false;
  private startPromise: Promise<void> | null = null;

  constructor(logger: Logger, customModelDir?: string) {
    this.logger = logger.forComponent("KokoroWorkerManager");
    this.modelDir = customModelDir || path.join(os.homedir(), ".jarvis", "models", "tts", "kokoro");
    this.detectPython();
  }

  public getModelDirectory(): string {
    return this.modelDir;
  }

  public detectPython(): string | null {
    const candidates = [
      path.join(this.modelDir, "venv", "Scripts", "python.exe"),
      path.join(this.modelDir, "venv", "bin", "python"),
      path.join(process.cwd(), ".jarvis_data", "models", "tts", "venv", "Scripts", "python.exe"),
      path.join(process.cwd(), ".jarvis_data", "models", "tts", "venv", "bin", "python"),
    ];

    for (const p of candidates) {
      if (fs.existsSync(p)) {
        this.pythonExe = p;
        return p;
      }
    }
    return null;
  }

  public isInstalled(): boolean {
    const hasPython = Boolean(this.detectPython());
    const hasModel = (
      fs.existsSync(path.join(this.modelDir, "kokoro-v0_19.onnx")) ||
      fs.existsSync(path.join(this.modelDir, "kokoro-v1_0.onnx"))
    );
    const hasVoices = (
      fs.existsSync(path.join(this.modelDir, "voices.bin")) ||
      fs.existsSync(path.join(this.modelDir, "voices.json"))
    );
    return hasPython && hasModel && hasVoices;
  }

  public async ensureWorkerRunning(): Promise<void> {
    if (this.workerProcess && !this.workerProcess.killed) {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.startWorker();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async startWorker(): Promise<void> {
    const py = this.detectPython();
    if (!py || !this.isInstalled()) {
      throw new Error(`Kokoro model runtime not installed in ${this.modelDir}. Run 'npm run tts:setup'.`);
    }

    const candidateScript1 = typeof import.meta.dirname === "string"
      ? path.resolve(import.meta.dirname, "../../scripts/kokoro_worker.py")
      : "";
    const candidateScript2 = path.resolve(process.cwd(), "scripts", "kokoro_worker.py");
    const workerScript = (candidateScript1 && fs.existsSync(candidateScript1)) ? candidateScript1 : candidateScript2;
    if (!fs.existsSync(workerScript)) {
      throw new Error(`Worker script not found: ${workerScript}`);
    }

    this.logger.info(`Starting persistent Kokoro worker: ${py} ${workerScript}`);

    return new Promise<void>((resolve, reject) => {
      let resolved = false;

      const child = spawn(py, [workerScript, this.modelDir], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });

      this.workerProcess = child;
      this.stdoutBuffer = "";

      const startupTimer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.logger.warn("Worker startup ready message timed out, proceeding anyway.");
          resolve();
        }
      }, 10000);

      child.stdout.on("data", (chunk: Buffer) => {
        this.stdoutBuffer += chunk.toString("utf-8");
        this.processStdoutLines(() => {
          if (!resolved) {
            resolved = true;
            clearTimeout(startupTimer);
            resolve();
          }
        });
      });

      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf-8").trim();
        if (text) {
          this.logger.debug(`[Python Worker stderr] ${text}`);
        }
      });

      child.on("error", (err) => {
        this.logger.error("Failed to spawn Kokoro worker:", { error: err.message });
        if (!resolved) {
          resolved = true;
          clearTimeout(startupTimer);
          reject(err);
        }
      });

      child.on("exit", (code, signal) => {
        this.logger.info(`Kokoro worker exited (code=${code}, signal=${signal})`);
        this.workerProcess = null;

        // Reject all pending requests
        for (const [id, req] of this.pendingRequests.entries()) {
          clearTimeout(req.timer);
          req.reject(new Error(`Kokoro worker terminated unexpectedly (code: ${code}).`));
        }
        this.pendingRequests.clear();

        if (!resolved) {
          resolved = true;
          clearTimeout(startupTimer);
          reject(new Error(`Worker exited during startup with code ${code}`));
        }
      });
    });
  }

  private processStdoutLines(onReady?: () => void): void {
    const lines = this.stdoutBuffer.split("\n");
    // Keep incomplete trailing line in buffer
    this.stdoutBuffer = lines.pop() || "";

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;

      try {
        const msg = JSON.parse(line);
        if (msg.type === "ready") {
          this.logger.info(`Kokoro worker ready (model: ${msg.model || "loaded"})`);
          if (onReady) onReady();
          continue;
        }

        if (msg.id && this.pendingRequests.has(msg.id)) {
          const req = this.pendingRequests.get(msg.id)!;
          this.pendingRequests.delete(msg.id);
          clearTimeout(req.timer);

          if (msg.success) {
            const buffer = Buffer.from(msg.audioBase64, "base64");
            req.resolve({
              audioBuffer: buffer,
              format: "wav",
              sampleRate: msg.sampleRate || 24000,
              durationSec: msg.durationSec || 0,
            });
          } else {
            req.reject(new Error(msg.error || "Synthesis failed in worker."));
          }
        }
      } catch (err: any) {
        this.logger.warn(`Failed to parse worker stdout JSON: "${line}"`, { error: err.message });
      }
    }
  }

  public async synthesize(text: string, options?: TTSOptions): Promise<TTSAudioResult> {
    await this.ensureWorkerRunning();

    if (!this.workerProcess || !this.workerProcess.stdin) {
      throw new Error("Kokoro worker is not active.");
    }

    const id = `synth_${Date.now()}_${++this.reqCounter}`;
    const payload = {
      id,
      text: text.trim(),
      voice: options?.voice || "bm_george",
      speed: options?.speed ?? 1.0,
    };

    return new Promise<TTSAudioResult>((resolve, reject) => {
      const timeoutMs = options?.timeoutMs || 15000;
      const timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Synthesis request ${id} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });

      try {
        this.workerProcess!.stdin!.write(JSON.stringify(payload) + "\n");
      } catch (err: any) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(new Error(`Failed writing to Kokoro worker stdin: ${err.message}`));
      }
    });
  }

  public async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    if (this.workerProcess) {
      try {
        this.workerProcess.stdin?.write(JSON.stringify({ type: "shutdown" }) + "\n");
      } catch {}

      const proc = this.workerProcess;
      this.workerProcess = null;

      await new Promise<void>((resolve) => {
        const killTimer = setTimeout(() => {
          try { proc.kill("SIGKILL"); } catch {}
          resolve();
        }, 1200);

        proc.once("exit", () => {
          clearTimeout(killTimer);
          resolve();
        });
      });
    }
  }
}
