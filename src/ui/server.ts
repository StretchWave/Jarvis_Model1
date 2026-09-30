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
import { OpenCodeError } from "../opencode_client.ts";

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

        // GET /api/config
        if (url.pathname === "/api/config" && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            name: this.core.config.personality.name,
            userTitle: this.core.config.personality.userTitle,
            models: this.core.config.models,
            version: this.core.config.version,
          }));
          return;
        }

        // GET /api/agents
        if (url.pathname === "/api/agents" && req.method === "GET") {
          const agents = await this.core.opencode.listAgents({ primaryOnly: true }).catch(() => []);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ agents }));
          return;
        }

        // GET /api/models
        if (url.pathname === "/api/models" && req.method === "GET") {
          const catalog = await this.core.opencode.listModels().catch(() => []);
          const agents = await this.core.opencode.listAgents({ primaryOnly: true }).catch(() => []);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            configured: this.core.config.models,
            catalog,
            agents,
          }));
          return;
        }

        // POST /api/models
        if (url.pathname === "/api/models" && req.method === "POST") {
          let body = "";
          req.on("data", chunk => body += chunk);
          req.on("end", async () => {
            try {
              let parsed: any;
              try {
                parsed = JSON.parse(body);
              } catch {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Malformed JSON payload" }));
                return;
              }

              const { fast, agent, agentWeight, creativityWeight } = parsed;

              // Validate against catalog if catalog is accessible
              const catalog = await this.core.opencode.listModels().catch(() => []);
              if (catalog.length > 0) {
                if (fast) {
                  const fastMatch = catalog.find(m => m.providerID === fast.providerID && m.modelID === fast.modelID);
                  if (!fastMatch) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: `Fast model "${fast.providerID}/${fast.modelID}" not found in OpenCode catalog` }));
                    return;
                  }
                  if (fast.variant && fastMatch.variants && fastMatch.variants.length > 0 && !fastMatch.variants.includes(fast.variant)) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: `Variant "${fast.variant}" is not supported for fast model "${fast.providerID}/${fast.modelID}"` }));
                    return;
                  }
                }
                if (agent) {
                  const agentMatch = catalog.find(m => m.providerID === agent.providerID && m.modelID === agent.modelID);
                  if (!agentMatch) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: `Agent model "${agent.providerID}/${agent.modelID}" not found in OpenCode catalog` }));
                    return;
                  }
                  if (agent.variant && agentMatch.variants && agentMatch.variants.length > 0 && !agentMatch.variants.includes(agent.variant)) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: `Variant "${agent.variant}" is not supported for agent model "${agent.providerID}/${agent.modelID}"` }));
                    return;
                  }
                }
              }

              if (agent && agent.agentID) {
                const agents = await this.core.opencode.listAgents({ primaryOnly: true }).catch(() => []);
                if (agents.length > 0 && !agents.some(a => a.id === agent.agentID)) {
                  res.writeHead(400, { "Content-Type": "application/json" });
                  res.end(JSON.stringify({ error: `Agent "${agent.agentID}" is not an available primary agent` }));
                  return;
                }
              }

              this.core.updateModels({ fast, agent, agentWeight, creativityWeight });
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ success: true, models: this.core.config.models }));
            } catch (err: any) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: err.message }));
            }
          });
          return;
        }

        // POST /api/session/:id/model
        const sessionModelMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/model$/);
        if (sessionModelMatch && req.method === "POST") {
          const sessionId = decodeURIComponent(sessionModelMatch[1]);
          const session = this.core.db.getSession(sessionId);
          if (!session) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: `Session "${sessionId}" not found` }));
            return;
          }

          let body = "";
          req.on("data", chunk => body += chunk);
          req.on("end", async () => {
            try {
              let parsed: any;
              try {
                parsed = JSON.parse(body);
              } catch {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Malformed JSON payload" }));
                return;
              }

              const { providerID, modelID, variant } = parsed;
              if (!providerID || !modelID || typeof providerID !== "string" || typeof modelID !== "string") {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Missing or invalid 'providerID' or 'modelID'" }));
                return;
              }

              const catalog = await this.core.opencode.listModels().catch(() => []);
              if (catalog.length > 0) {
                const match = catalog.find(m => m.providerID === providerID && m.modelID === modelID);
                if (!match) {
                  res.writeHead(400, { "Content-Type": "application/json" });
                  res.end(JSON.stringify({ error: `Model "${providerID}/${modelID}" not found in OpenCode catalog` }));
                  return;
                }
                if (variant && match.variants && match.variants.length > 0 && !match.variants.includes(variant)) {
                  res.writeHead(400, { "Content-Type": "application/json" });
                  res.end(JSON.stringify({ error: `Variant "${variant}" not supported for model "${providerID}/${modelID}"` }));
                  return;
                }
              }

              try {
                await this.core.switchSessionModel(sessionId, { providerID, modelID, variant });
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ success: true, sessionId, model: { providerID, modelID, variant } }));
              } catch (ocErr: any) {
                const status = (ocErr instanceof OpenCodeError && ocErr.status) ? ocErr.status : 502;
                res.writeHead(status, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: ocErr.message, details: ocErr.details, status }));
              }
            } catch (err: any) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: err.message }));
            }
          });
          return;
        }

        // POST /api/session/:id/agent
        const sessionAgentMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/agent$/);
        if (sessionAgentMatch && req.method === "POST") {
          const sessionId = decodeURIComponent(sessionAgentMatch[1]);
          const session = this.core.db.getSession(sessionId);
          if (!session) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: `Session "${sessionId}" not found` }));
            return;
          }

          let body = "";
          req.on("data", chunk => body += chunk);
          req.on("end", async () => {
            try {
              let parsed: any;
              try {
                parsed = JSON.parse(body);
              } catch {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Malformed JSON payload" }));
                return;
              }

              const { agentID } = parsed;
              if (!agentID || typeof agentID !== "string") {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Missing or invalid 'agentID'" }));
                return;
              }

              const agents = await this.core.opencode.listAgents({ primaryOnly: true }).catch(() => []);
              if (agents.length > 0 && !agents.some(a => a.id === agentID)) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: `Agent "${agentID}" is not an available primary agent` }));
                return;
              }

              try {
                await this.core.switchSessionAgent(sessionId, agentID);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ success: true, sessionId, agentID }));
              } catch (ocErr: any) {
                const status = (ocErr instanceof OpenCodeError && ocErr.status) ? ocErr.status : 502;
                res.writeHead(status, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: ocErr.message, details: ocErr.details, status }));
              }
            } catch (err: any) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: err.message }));
            }
          });
          return;
        }

        // POST /api/voice/stop
        if (url.pathname === "/api/voice/stop" && req.method === "POST") {
          this.core.voice.interrupt();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
          return;
        }

        // POST /api/confirm
        if (url.pathname === "/api/confirm" && req.method === "POST") {
          let body = "";
          req.on("data", chunk => body += chunk);
          req.on("end", () => {
            try {
              let parsed: any;
              try {
                parsed = JSON.parse(body);
              } catch {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Malformed JSON payload" }));
                return;
              }

              const { requestId, decision, approved } = parsed;
              if (!requestId) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Missing 'requestId'" }));
                return;
              }

              let resolvedDecision: "once" | "always" | "reject";
              if (decision === "once" || decision === "always" || decision === "reject") {
                resolvedDecision = decision;
              } else if (typeof approved === "boolean") {
                resolvedDecision = approved ? "once" : "reject";
              } else {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Invalid decision: must be 'once', 'always', or 'reject'" }));
                return;
              }

              const ok = this.core.confirmAction(requestId, resolvedDecision);
              if (!ok) {
                res.writeHead(404, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Permission request not found or expired" }));
                return;
              }

              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ success: true, requestId, decision: resolvedDecision }));
            } catch (err: any) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: err.message }));
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
