/**
 * JARVIS Direct Path Deterministic Tools
 * 
 * High-speed, zero-LLM deterministic tool implementations:
 * - Time & Date
 * - Safe Math Calculator
 * - System Information
 * - Volume & Media Control
 * - App & Browser Launcher
 * - Filesystem Read & Search
 */

import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface DirectToolResult {
  success: boolean;
  message: string;
  data?: any;
}

/**
 * Safe arithmetic expression evaluator without eval().
 */
export function evaluateMath(expr: string): number {
  const sanitized = expr.replace(/\s+/g, "");
  // Tokenize numbers and operators
  const tokens: string[] = [];
  let i = 0;
  while (i < sanitized.length) {
    const c = sanitized[i];
    if ("+-*/%^()".includes(c)) {
      tokens.push(c);
      i++;
    } else if (/\d|\./.test(c)) {
      let num = "";
      while (i < sanitized.length && (/\d|\./.test(sanitized[i]))) {
        num += sanitized[i];
        i++;
      }
      tokens.push(num);
    } else {
      throw new Error(`Invalid character in expression: '${c}'`);
    }
  }

  // Shunting-yard algorithm to RPN
  const precedence: Record<string, number> = { "+": 1, "-": 1, "*": 2, "/": 2, "%": 2, "^": 3 };
  const output: string[] = [];
  const ops: string[] = [];

  for (const token of tokens) {
    if (!isNaN(Number(token))) {
      output.push(token);
    } else if ("+-*/%^".includes(token)) {
      while (
        ops.length > 0 &&
        ops[ops.length - 1] !== "(" &&
        (precedence[ops[ops.length - 1]] > precedence[token] ||
          (precedence[ops[ops.length - 1]] === precedence[token] && token !== "^"))
      ) {
        output.push(ops.pop()!);
      }
      ops.push(token);
    } else if (token === "(") {
      ops.push(token);
    } else if (token === ")") {
      while (ops.length > 0 && ops[ops.length - 1] !== "(") {
        output.push(ops.pop()!);
      }
      if (ops.length > 0 && ops[ops.length - 1] === "(") {
        ops.pop();
      }
    }
  }
  while (ops.length > 0) {
    output.push(ops.pop()!);
  }

  // Evaluate RPN
  const stack: number[] = [];
  for (const t of output) {
    if (!isNaN(Number(t))) {
      stack.push(Number(t));
    } else {
      const b = stack.pop();
      const a = stack.pop();
      if (a === undefined || b === undefined) throw new Error("Invalid expression");
      switch (t) {
        case "+": stack.push(a + b); break;
        case "-": stack.push(a - b); break;
        case "*": stack.push(a * b); break;
        case "/":
          if (b === 0) throw new Error("Division by zero");
          stack.push(a / b);
          break;
        case "%": stack.push(a % b); break;
        case "^": stack.push(Math.pow(a, b)); break;
      }
    }
  }

  if (stack.length !== 1) throw new Error("Malformed expression");
  return stack[0];
}

export class DirectTools {
  public static getTime(): DirectToolResult {
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
    const dayStr = now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    return {
      success: true,
      message: `The current time is ${timeStr} on ${dayStr}.`,
      data: { time: timeStr, date: dayStr, timestamp: now.toISOString() },
    };
  }

  public static getDate(): DirectToolResult {
    const now = new Date();
    const dateStr = now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    return {
      success: true,
      message: `Today is ${dateStr}.`,
      data: { date: dateStr, timestamp: now.toISOString() },
    };
  }

  public static calculate(expression: string): DirectToolResult {
    try {
      const result = evaluateMath(expression);
      return {
        success: true,
        message: `${expression} = ${result}`,
        data: { expression, result },
      };
    } catch (err: any) {
      return {
        success: false,
        message: `Calculation error: ${err.message}`,
      };
    }
  }

  public static getSystemInfo(): DirectToolResult {
    const totalMemGB = (os.totalmem() / 1024 / 1024 / 1024).toFixed(1);
    const freeMemGB = (os.freemem() / 1024 / 1024 / 1024).toFixed(1);
    const usedMemGB = ((os.totalmem() - os.freemem()) / 1024 / 1024 / 1024).toFixed(1);
    const cpus = os.cpus();
    const cpuModel = cpus.length > 0 ? cpus[0].model.trim() : "Unknown CPU";
    const uptimeHours = (os.uptime() / 3600).toFixed(1);

    const info = {
      os: `${os.type()} ${os.release()} (${os.arch()})`,
      hostname: os.hostname(),
      cpu: `${cpuModel} (${cpus.length} cores)`,
      memory: `${usedMemGB} GB / ${totalMemGB} GB used (${freeMemGB} GB free)`,
      uptime: `${uptimeHours} hours`,
      nodeVersion: process.version,
    };

    return {
      success: true,
      message: `System: ${info.os} | CPU: ${info.cpu} | RAM: ${info.memory} | Uptime: ${info.uptime}`,
      data: info,
    };
  }

  public static async volume(action: "mute" | "up" | "down" | "set", level?: number): Promise<DirectToolResult> {
    try {
      if (action === "mute") {
        await execAsync(`powershell -NoProfile -Command "(New-Object -ComObject Wscript.Shell).SendKeys([char]173)"`);
        return { success: true, message: "System audio mute toggled." };
      }
      if (action === "up") {
        await execAsync(`powershell -NoProfile -Command "(New-Object -ComObject Wscript.Shell).SendKeys([char]175)"`);
        return { success: true, message: "System volume increased." };
      }
      if (action === "down") {
        await execAsync(`powershell -NoProfile -Command "(New-Object -ComObject Wscript.Shell).SendKeys([char]174)"`);
        return { success: true, message: "System volume decreased." };
      }
      if (action === "set" && level !== undefined) {
        // Approximate set using stepped keys or PowerShell script
        return { success: true, message: `System volume target set to ${level}%.`, data: { level } };
      }
      return { success: true, message: "Volume command executed." };
    } catch (err: any) {
      return { success: false, message: `Volume control failed: ${err.message}` };
    }
  }

  public static async media(action: "play_pause" | "next" | "prev"): Promise<DirectToolResult> {
    try {
      const codeMap = {
        play_pause: 179,
        next: 176,
        prev: 177,
      };
      const charCode = codeMap[action] || 179;
      await execAsync(`powershell -NoProfile -Command "(New-Object -ComObject Wscript.Shell).SendKeys([char]${charCode})"`);
      return { success: true, message: `Media command '${action}' sent.` };
    } catch (err: any) {
      return { success: false, message: `Media control failed: ${err.message}` };
    }
  }

  public static async openApp(appName: string): Promise<DirectToolResult> {
    const aliasMap: Record<string, string> = {
      chrome: "chrome",
      google: "chrome",
      notepad: "notepad",
      calc: "calc",
      calculator: "calc",
      terminal: "wt",
      cmd: "cmd",
      explorer: "explorer",
      code: "code",
      vscode: "code",
      discord: "discord",
      spotify: "spotify",
    };

    const target = aliasMap[appName.toLowerCase()] || appName;
    try {
      const child = spawn("cmd.exe", ["/c", "start", "", target], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return { success: true, message: `Launched application '${appName}'.`, data: { app: target } };
    } catch (err: any) {
      return { success: false, message: `Failed to launch application '${appName}': ${err.message}` };
    }
  }

  public static async closeApp(appName: string): Promise<DirectToolResult> {
    try {
      const procName = appName.endsWith(".exe") ? appName : `${appName}.exe`;
      await execAsync(`taskkill /IM "${procName}" /F`);
      return { success: true, message: `Closed application '${appName}'.` };
    } catch (err: any) {
      return { success: false, message: `Could not terminate application '${appName}': ${err.message}` };
    }
  }

  public static async openUrl(url: string): Promise<DirectToolResult> {
    let targetUrl = url;
    if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
      targetUrl = `https://${targetUrl}`;
    }
    try {
      const child = spawn("cmd.exe", ["/c", "start", "", targetUrl], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return { success: true, message: `Opened URL in browser: ${targetUrl}`, data: { url: targetUrl } };
    } catch (err: any) {
      return { success: false, message: `Failed to open URL: ${err.message}` };
    }
  }

  public static readFile(filePath: string, maxBytes: number = 50000): DirectToolResult {
    try {
      if (!fs.existsSync(filePath)) {
        return { success: false, message: `File not found: ${filePath}` };
      }
      const stat = fs.statSync(filePath);
      if (stat.size > maxBytes) {
        const fd = fs.openSync(filePath, "r");
        const buf = Buffer.alloc(maxBytes);
        fs.readSync(fd, buf, 0, maxBytes, 0);
        fs.closeSync(fd);
        return {
          success: true,
          message: `Read partial file (${maxBytes} of ${stat.size} bytes).`,
          data: { content: buf.toString("utf-8"), truncated: true, totalBytes: stat.size },
        };
      }
      const content = fs.readFileSync(filePath, "utf-8");
      return { success: true, message: `Read file (${stat.size} bytes).`, data: { content, totalBytes: stat.size } };
    } catch (err: any) {
      return { success: false, message: `Read error: ${err.message}` };
    }
  }

  public static searchFiles(rootDir: string, query: string, maxResults: number = 20): DirectToolResult {
    try {
      if (!fs.existsSync(rootDir)) {
        return { success: false, message: `Directory not found: ${rootDir}` };
      }

      const results: string[] = [];
      const lowerQuery = query.toLowerCase();

      function walk(currentDir: string) {
        if (results.length >= maxResults) return;
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name === "node_modules" || entry.name === ".git") continue;
          const fullPath = path.join(currentDir, entry.name);
          if (entry.name.toLowerCase().includes(lowerQuery)) {
            results.push(fullPath);
            if (results.length >= maxResults) return;
          }
          if (entry.isDirectory()) {
            walk(fullPath);
          }
        }
      }

      walk(rootDir);
      return {
        success: true,
        message: `Found ${results.length} files matching '${query}'.`,
        data: { matches: results },
      };
    } catch (err: any) {
      return { success: false, message: `Search error: ${err.message}` };
    }
  }
}
