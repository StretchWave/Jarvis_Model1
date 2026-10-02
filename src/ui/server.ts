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
import { OpenCodeError, modelSupportsVariant, getModelCostTier } from "../opencode_client.ts";

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
          try {
            const agents = await this.core.opencode.listAgents({ primaryOnly: true });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ agents }));
          } catch (err: any) {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: `Failed to retrieve OpenCode agents catalog: ${err.message}`, status: 502 }));
          }
          return;
        }

        // GET /api/sessions
        if (url.pathname === "/api/sessions" && req.method === "GET") {
          try {
            const sessions = this.core.db.listSessions("active");
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ sessions }));
          } catch (err: any) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          }
          return;
        }

        // GET /api/tasks
        if (url.pathname === "/api/tasks" && req.method === "GET") {
          const status = url.searchParams.get("status") as any;
          const projectId = url.searchParams.get("projectId") || undefined;
          const tasks = this.core.db.listTasks(status, projectId);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ tasks }));
          return;
        }

        // GET /api/projects
        if (url.pathname === "/api/projects" && req.method === "GET") {
          const projects = this.core.db.listProjects();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ projects }));
          return;
        }

        // GET /api/memories
        if (url.pathname === "/api/memories" && req.method === "GET") {
          const query = url.searchParams.get("q") || "";
          const projectId = url.searchParams.get("projectId") || undefined;
          const memories = this.core.db.getRelevantMemories(query, projectId, 50);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ memories }));
          return;
        }

        // POST /api/sessions
        if (url.pathname === "/api/sessions" && req.method === "POST") {
          let body = "";
          req.on("data", chunk => body += chunk);
          req.on("end", async () => {
            try {
              let parsed: any = {};
              try { parsed = JSON.parse(body); } catch {}
              const title = parsed.title || `Session ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
              const category = parsed.category || "general";
              const session = await this.core.sessionMgr.createSession({
                title,
                category,
                createOpenCodeSession: true,
              });
              res.writeHead(201, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ session }));
            } catch (err: any) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: err.message }));
            }
          });
          return;
        }

        // GET /api/session/:id - Query verified active session state
        const sessionDetailMatch = url.pathname.match(/^\/api\/session\/([^/]+)$/);
        if (sessionDetailMatch && req.method === "GET") {
          const sessionId = decodeURIComponent(sessionDetailMatch[1]);
          const session = this.core.db.getSession(sessionId);
          if (!session) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: `Session "${sessionId}" not found` }));
            return;
          }
          let ocSession: any = null;
          try {
            const ocSessionId = await this.core.sessionMgr.ensureOpenCodeSession(sessionId);
            ocSession = await this.core.opencode.getSession(ocSessionId);
          } catch (err: any) {
            this.logger.warn(`Could not fetch OpenCode session for ${sessionId}: ${err.message}`);
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            session,
            opencodeSession: ocSession,
            activeModel: ocSession?.model || ocSession?.data?.model || null,
            activeAgent: ocSession?.agent || ocSession?.data?.agent || null,
            configuredModels: this.core.config.models,
          }));
          return;
        }

        // GET /api/models
        if (url.pathname === "/api/models" && req.method === "GET") {
          try {
            const catalog = await this.core.opencode.listModels();
            const agents = await this.core.opencode.listAgents({ primaryOnly: true });
            const enrichedCatalog = catalog.map((m: any) => ({
              ...m,
              costTier: getModelCostTier(m),
            }));
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              configured: this.core.config.models,
              catalog: enrichedCatalog,
              agents,
            }));
          } catch (err: any) {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              error: `Failed to retrieve OpenCode model or agent catalog: ${err.message}`,
              status: 502,
            }));
          }
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

              const fast = parsed.fast || (parsed.providerID && parsed.modelID ? { providerID: parsed.providerID, modelID: parsed.modelID, variant: parsed.variant } : undefined);
              const agent = parsed.agent;
              const agentWeight = parsed.agentWeight;
              const persist = parsed.persist;
              const sessionId = parsed.sessionId || parsed.sessionID;

              // Validate against catalog without hiding failures (Requirement 12 & 13)
              let catalog: any[];
              try {
                catalog = await this.core.opencode.listModels();
              } catch (err: any) {
                res.writeHead(502, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: `Cannot validate models: OpenCode model catalog unavailable: ${err.message}` }));
                return;
              }

              if (fast) {
                const fastMatch = catalog.find(m => m.providerID === fast.providerID && (m.id === fast.modelID || m.modelID === fast.modelID));
                if (!fastMatch) {
                  res.writeHead(400, { "Content-Type": "application/json" });
                  res.end(JSON.stringify({ error: `Fast model "${fast.providerID}/${fast.modelID}" not found in OpenCode catalog` }));
                  return;
                }
                if (!modelSupportsVariant(fastMatch, fast.variant)) {
                  res.writeHead(400, { "Content-Type": "application/json" });
                  res.end(JSON.stringify({ error: `Variant "${fast.variant}" is not supported for fast model "${fast.providerID}/${fast.modelID}"` }));
                  return;
                }
              }

              if (agent) {
                const agentMatch = catalog.find(m => m.providerID === agent.providerID && (m.id === agent.modelID || m.modelID === agent.modelID));
                if (!agentMatch) {
                  res.writeHead(400, { "Content-Type": "application/json" });
                  res.end(JSON.stringify({ error: `Agent model "${agent.providerID}/${agent.modelID}" not found in OpenCode catalog` }));
                  return;
                }
                if (!modelSupportsVariant(agentMatch, agent.variant)) {
                  res.writeHead(400, { "Content-Type": "application/json" });
                  res.end(JSON.stringify({ error: `Variant "${agent.variant}" is not supported for agent model "${agent.providerID}/${agent.modelID}"` }));
                  return;
                }
              }

              if (agent && agent.agentID) {
                let agents: any[];
                try {
                  agents = await this.core.opencode.listAgents({ primaryOnly: true });
                } catch (err: any) {
                  res.writeHead(502, { "Content-Type": "application/json" });
                  res.end(JSON.stringify({ error: `Cannot validate agent: OpenCode agents catalog unavailable: ${err.message}` }));
                  return;
                }
                if (!agents.some(a => a.id === agent.agentID)) {
                  res.writeHead(400, { "Content-Type": "application/json" });
                  res.end(JSON.stringify({ error: `Agent "${agent.agentID}" is not an available primary agent` }));
                  return;
                }
              }

              // Switch active session immediately if sessionId is provided (Part 1 Req 1)
              let sessionData: any = null;
              if (sessionId) {
                const session = this.core.db.getSession(sessionId);
                if (session) {
                  if (fast) {
                    await this.core.switchSessionModel(sessionId, {
                      providerID: fast.providerID,
                      id: fast.modelID,
                      variant: fast.variant || "default",
                    });
                  }
                  if (agent?.agentID) {
                    await this.core.switchSessionAgent(sessionId, agent.agentID);
                  }
                  const ocSesId = await this.core.sessionMgr.ensureOpenCodeSession(sessionId);
                  sessionData = await this.core.opencode.getSession(ocSesId);
                }
              }

              const shouldPersist = persist !== false;
              if (shouldPersist) {
                this.core.updateModels({ fast, agent, agentWeight }, true);
              }
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({
                success: true,
                models: this.core.config.models,
                persisted: shouldPersist,
                session: sessionData,
              }));
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

              let catalog: any[];
              try {
                catalog = await this.core.opencode.listModels();
              } catch (err: any) {
                res.writeHead(502, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: `OpenCode model catalog unavailable: ${err.message}` }));
                return;
              }

              const match = catalog.find(m => m.providerID === providerID && (m.id === modelID || m.modelID === modelID));
              if (!match) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: `Model "${providerID}/${modelID}" not found in OpenCode catalog` }));
                return;
              }
              if (!modelSupportsVariant(match, variant)) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: `Variant "${variant}" not supported for model "${providerID}/${modelID}"` }));
                return;
              }

              try {
                await this.core.switchSessionModel(sessionId, { providerID, modelID, variant });
                const ocSessionId = await this.core.sessionMgr.ensureOpenCodeSession(sessionId);
                const sessionData = await this.core.opencode.getSession(ocSessionId);
                const resultingModel = sessionData?.model || sessionData?.data?.model || { providerID, modelID, variant };
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ success: true, sessionId, model: resultingModel, session: sessionData }));
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

              const agentID = parsed.agentID || parsed.agent;
              if (!agentID || typeof agentID !== "string") {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Missing or invalid 'agentID'" }));
                return;
              }

              let agents: any[];
              try {
                agents = await this.core.opencode.listAgents({ primaryOnly: true });
              } catch (err: any) {
                res.writeHead(502, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: `OpenCode agents catalog unavailable: ${err.message}` }));
                return;
              }

              if (!agents.some(a => a.id === agentID)) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: `Agent "${agentID}" is not an available primary agent` }));
                return;
              }

              try {
                await this.core.switchSessionAgent(sessionId, agentID);
                const ocSessionId = await this.core.sessionMgr.ensureOpenCodeSession(sessionId);
                const sessionData = await this.core.opencode.getSession(ocSessionId);
                const resultingAgent = sessionData?.agent || sessionData?.data?.agent || agentID;
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ success: true, sessionId, agentID: resultingAgent, session: sessionData }));
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

        // GET /api/voice/status
        if (url.pathname === "/api/voice/status" && req.method === "GET") {
          const health = await this.core.voice.getProviderHealth();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            neuralStatus: health.neuralStatus,
            activeProvider: health.activeProvider,
            isNeural: health.isNeural,
            modelDir: health.modelDir,
            voices: [
              { id: "bm_george", name: "George (British Male, Calm)", lang: "en-gb", gender: "male" },
              { id: "bm_lewis", name: "Lewis (British Male, Natural)", lang: "en-gb", gender: "male" },
              { id: "bf_emma", name: "Emma (British Female, Clear)", lang: "en-gb", gender: "female" },
              { id: "am_michael", name: "Michael (American Male)", lang: "en-us", gender: "male" },
            ],
          }));
          return;
        }

        // POST /api/voice/synthesize
        if (url.pathname === "/api/voice/synthesize" && req.method === "POST") {
          let body = "";
          req.on("data", chunk => body += chunk);
          req.on("end", async () => {
            try {
              let parsed: any = {};
              try { parsed = JSON.parse(body); } catch {}
              const text = parsed.text;
              if (!text || typeof text !== "string") {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Missing or invalid 'text' payload" }));
                return;
              }
              const voice = parsed.voice || "bm_george";
              const speed = typeof parsed.speed === "number" ? parsed.speed : 1.0;

              const audioResult = await this.core.voice.synthesize(text, { voice, speed });
              res.writeHead(200, {
                "Content-Type": "audio/wav",
                "Content-Length": audioResult.audioBuffer.length,
                "X-Audio-Sample-Rate": audioResult.sampleRate,
                "X-Audio-Duration": audioResult.durationSec || 0,
              });
              res.end(audioResult.audioBuffer);
            } catch (err: any) {
              res.writeHead(503, { "Content-Type": "application/json" });
              res.end(JSON.stringify({
                error: err.message,
                fallback: "system",
              }));
            }
          });
          return;
        }

        // POST /api/confirm
        if (url.pathname === "/api/confirm" && req.method === "POST") {
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

              const ok = await this.core.confirmAction(requestId, resolvedDecision);
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
