export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  message: string;
  requestId?: string;
  latencyMs?: number;
  metadata?: Record<string, any>;
}

export function redactSecrets(text: string): string {
  if (typeof text !== "string") return text;
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9_\-\.]+/gi, "$1[REDACTED]")
    .replace(/(Basic\s+)[A-Za-z0-9+/=]+/gi, "$1[REDACTED]")
    .replace(/("?(?:password|token|apiKey|secret|access_token|refresh_token)"?\s*[:=]\s*")[^"]+(")/gi, "$1[REDACTED]$2")
    .replace(/(sk-[a-zA-Z0-9_\-]{16,})/gi, "[REDACTED]");
}

function sanitizeObject(obj: any): any {
  if (!obj) return obj;
  if (typeof obj === "string") return redactSecrets(obj);
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeObject);

  const res: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    const lk = k.toLowerCase();
    if (lk.includes("password") || lk.includes("token") || lk.includes("secret") || lk.includes("apikey")) {
      res[k] = "[REDACTED]";
    } else {
      res[k] = sanitizeObject(v);
    }
  }
  return res;
}

export class Logger {
  private minLevel: LogLevel;
  private format: "pretty" | "json";
  private component: string;

  constructor(component: string, minLevel: LogLevel = "info", format: "pretty" | "json" = "pretty") {
    this.component = component;
    this.minLevel = minLevel;
    this.format = format;
  }

  public forComponent(subComponent: string): Logger {
    return new Logger(`${this.component}:${subComponent}`, this.minLevel, this.format);
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[this.minLevel];
  }

  private emit(level: LogLevel, message: string, meta?: Record<string, any>, latencyMs?: number, reqId?: string) {
    if (!this.shouldLog(level)) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      component: this.component,
      message: redactSecrets(message),
      requestId: reqId,
      latencyMs,
      metadata: sanitizeObject(meta),
    };

    if (this.format === "json") {
      const line = JSON.stringify(entry);
      if (level === "error") process.stderr.write(line + "\n");
      else process.stdout.write(line + "\n");
    } else {
      const color = level === "error" ? "\x1b[31m" : level === "warn" ? "\x1b[33m" : level === "debug" ? "\x1b[90m" : "\x1b[36m";
      const reset = "\x1b[0m";
      const lat = latencyMs !== undefined ? ` \x1b[32m(${latencyMs.toFixed(1)}ms)${reset}` : "";
      const req = reqId ? ` [${reqId}]` : "";
      const metaStr = entry.metadata && Object.keys(entry.metadata).length > 0 ? " " + JSON.stringify(entry.metadata) : "";
      const formatted = `[${entry.timestamp.substring(11, 19)}] ${color}${level.toUpperCase().padEnd(5)}${reset} [${entry.component}]${req} ${entry.message}${lat}${metaStr}`;
      
      if (level === "error") console.error(formatted);
      else if (level === "warn") console.warn(formatted);
      else console.log(formatted);
    }
  }

  public debug(msg: string, meta?: Record<string, any>, lat?: number, reqId?: string) {
    this.emit("debug", msg, meta, lat, reqId);
  }

  public info(msg: string, meta?: Record<string, any>, lat?: number, reqId?: string) {
    this.emit("info", msg, meta, lat, reqId);
  }

  public warn(msg: string, meta?: Record<string, any>, lat?: number, reqId?: string) {
    this.emit("warn", msg, meta, lat, reqId);
  }

  public error(msg: string, meta?: Record<string, any>, lat?: number, reqId?: string) {
    this.emit("error", msg, meta, lat, reqId);
  }
}

export const rootLogger = new Logger("Jarvis");
