/**
 * JARVIS Desktop Web UI Server
 * 
 * High-performance, zero-dependency HTTP server:
 * - Serves rich dashboard UI
 * - Server-Sent Events (SSE) streaming API for real-time tokens & progress
 * - Push-to-talk voice support
 * - Session and permission management
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { JarvisCore } from "../core.ts";
import { Logger } from "../logger.ts";

export class JarvisServer {
  private core: JarvisCore;
  private logger: Logger;
  private server: http.Server | null = null;
  private port: number;
  private host: string;

  constructor(core: JarvisCore, port = 31415, host = "127.0.0.1") {
    this.core = core;
    this.port = port;
    this.host = host;
    this.logger = core.logger.forComponent("JarvisServer");
  }

  public start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        const url = new URL(req.url || "/", `http://${req.headers.host}`);

        // CORS headers
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");

        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        // Static files: / or /index.html
        if (url.pathname === "/" || url.pathname === "/index.html") {
          const htmlPath = path.join(process.cwd(), "public", "index.html");
          if (fs.existsSync(htmlPath)) {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            fs.createReadStream(htmlPath).pipe(res);
            return;
          }
        }

        // GET /api/status
        if (url.pathname === "/api/status" && req.method === "GET") {
          const ocHealth = await this.core.opencode.health();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            status: "online",
            version: this.core.config.version,
            opencode: ocHealth,
            uptimeSec: process.uptime(),
          }));
          return;
        }

        // GET /api/sessions
        if (url.pathname === "/api/sessions" && req.method === "GET") {
          const sessions = this.core.db.listSessions("active");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ sessions }));
          return;
        }

        // POST /api/confirm
        if (url.pathname === "/api/confirm" && req.method === "POST") {
          let body = "";
          req.on("data", chunk => body += chunk);
          req.on("end", () => {
            try {
              const { requestId, approved } = JSON.parse(body);
              const ok = this.core.confirmAction(requestId, Boolean(approved));
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ success: ok }));
            } catch {
              res.writeHead(400);
              res.end();
            }
          });
          return;
        }

        // POST /api/chat/stream
        if (url.pathname === "/api/chat/stream" && req.method === "POST") {
          let body = "";
          req.on("data", chunk => body += chunk);
          req.on("end", async () => {
            try {
              const { prompt, sessionId, projectId } = JSON.parse(body);
              if (!prompt) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Missing prompt" }));
                return;
              }

              res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
              });

              for await (const event of this.core.processInput(prompt, sessionId, projectId)) {
                res.write(`data: ${JSON.stringify(event)}\n\n`);
              }

              res.end();
            } catch (err: any) {
              res.write(`data: ${JSON.stringify({ type: "error", error: err.message })}\n\n`);
              res.end();
            }
          });
          return;
        }

        // 404 Not Found
        res.writeHead(404);
        res.end("Not Found");
      });

      this.server.listen(this.port, this.host, () => {
        this.logger.info(`JARVIS Desktop Web UI live at http://${this.host}:${this.port}`);
        resolve();
      });

      this.server.on("error", (err) => {
        this.logger.error("Server error:", { error: err.message });
        reject(err);
      });
    });
  }

  public stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}

// Auto-start server if executed directly
const isDirectRun = Boolean(
  process.argv[1] &&
  (process.argv[1].endsWith("server.ts") || process.argv[1].endsWith("server.js"))
);

if (isDirectRun) {
  const core = new JarvisCore();
  core.initialize().then(async () => {
    const server = new JarvisServer(core, core.config.port, core.config.host);
    await server.start();
    console.log("\n===============================================================");
    console.log("            JARVIS Personal AI Assistant is ONLINE             ");
    console.log(`            Dashboard: http://${core.config.host}:${core.config.port}            `);
    console.log("===============================================================\n");
  }).catch((err) => {
    console.error("Failed to start Jarvis server:", err);
    process.exit(1);
  });
}
