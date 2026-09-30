# JARVIS - Personal AI Assistant

JARVIS is an intelligent personal AI assistant architecture designed for seamless workstation control, factual web search, low-latency conversational interaction, and deep coding/reasoning.

---

## 1. Unified Gateway Architecture

```text
User (Web UI / Voice / REST API)
        │
        ▼
   JARVIS Core
        │
        ├── DIRECT ────► Deterministic local PC tools (zero LLM overhead)
        │
        ├── SEARCH ────► Web search & source extraction (zero LLM initially)
        │
        └── OPENCODE ──► Local OpenCode Daemon (Sole Normal LLM Gateway)
             │
             ├── FAST  ──► Lightweight OpenCode model (e.g. opencode/mimo-v2.6-flash-free)
             └── AGENT ──► Stronger OpenCode model & primary agent (e.g. build / plan)
                  │
                  ▼
         Local OpenCode Server (http://127.0.0.1:49374)
                  │
                  ▼
         OpenCode Providers / Zen / Configured Models
```

### Core Architectural Principle
**JARVIS itself does NOT directly call OpenAI, Anthropic, Groq, OpenRouter, or other external cloud providers for normal LLM execution.**

The local OpenCode daemon is the single unified LLM gateway. OpenCode handles model discovery, provider credentials, free-tier access, tool execution, and server-side model routing. JARVIS communicates with the local OpenCode server as a client using standard OpenCode endpoints (`/api/session`, `/api/model`, `/api/event`).

No `FAST_MODEL_API_KEY` or `OPENAI_API_KEY` is required for standard operation.

---

## 2. Responsibilities & Ownership Matrix

| System Component | Owner | Responsibilities |
|---|---|---|
| **Model Catalog & Availability** | **OpenCode** | Discovering available models across providers, managing free tier, validating provider auth. |
| **Model Execution & Inference** | **OpenCode** | Sending prompts to underlying providers, streaming deltas, tool invocation, reasoning steps. |
| **Primary Agents & Tools** | **OpenCode** | Managing agents (`build`, `plan`), registering workspace tools, executing file/terminal actions. |
| **Security & Permissions** | **OpenCode** | Emitting permission requests, enforcing project security policies. |
| **Intent Classification & Routing** | **JARVIS** | Classifying user intent into `DIRECT`, `SEARCH`, `FAST`, or `AGENT` without LLM overhead. |
| **User Experience & Web UI** | **JARVIS** | Rendering the holographic HUD visualizer, real-time chat, model picker, and permission dialogs. |
| **Context & Memory Management** | **JARVIS** | Managing multi-turn conversation history, project context, and long-term user directives. |
| **Session Mapping** | **JARVIS** | Persisting JARVIS session IDs and mapping them 1-to-1 with OpenCode session IDs. |
| **Confirmation UX** | **JARVIS** | Catching `permission_request` events, prompting user for approval (`once`, `always`, `reject`). |

---

## 3. Daemon Lifecycle & Bootstrap

JARVIS manages connection to the OpenCode service cleanly via `ensureDaemonRunning()` and `resolveService()`:

```text
spawnIfDown = true:
  1. Attempt connection to existing daemon via resolveService()
  2. If unavailable, start OpenCode service (via `opencode service start` / `cliPath service start`)
  3. Wait for service registration to appear
  4. Verify endpoint health via HTTP GET /api/info
  5. Invalidate cached info if unhealthy

spawnIfDown = false:
  1. Never spawn any process
  2. Only attempt connection to existing service
  3. Fail immediately with human-readable error if daemon is not running
```

### Service Discovery Order (`resolveService`)
1. Explicit configured service file (`config.opencode.serviceFile`), if reachable and healthy.
2. Standard OpenCode shared service registration (`~/.local/state/opencode/service.json`).
3. Fallback candidate paths (`~/.config/opencode/service.json`, Windows AppData paths).
4. Revalidation of discovered endpoint via `/api/info`. If unhealthy, cached info is invalidated.

---

## 4. Configuration

To customize model selections, daemon ports, or weights, create `jarvis.config.json` (or copy from `jarvis.config.example.json`):

```json
{
  "port": 31415,
  "host": "127.0.0.1",
  "opencode": {
    "serviceFile": "",
    "spawnIfDown": true,
    "connectTimeoutMs": 5000
  },
  "models": {
    "fast": {
      "providerID": "opencode",
      "modelID": "mimo-v2.6-flash-free",
      "variant": "default"
    },
    "agent": {
      "providerID": "opencode",
      "modelID": "mimo-v2.6-flash-free",
      "variant": "default",
      "agentID": "build"
    },
    "creativityWeight": 0.7,
    "agentWeight": 0.5
  },
  "personality": {
    "name": "JARVIS",
    "userTitle": "Sir",
    "conciseByDefault": true
  }
}
```

### Model Weight Terminology
- **Creativity Weight (Temperature)**: Sets the sampling temperature for generation where supported by the active provider/variant.
- **Agent Routing Bias**: Adjusts the router's classification threshold for directing ambiguous prompts to the AGENT path instead of FAST. It does **not** change model parameters.

---

## 5. Model & Agent Discovery and Dynamic Switching

### Model Discovery (`GET /api/model`)
JARVIS normalizes models from OpenCode preserving:
- Canonical identity: `providerID + modelID` (e.g. `opencode/mimo-v2.6-flash-free`)
- Name, family, capabilities, and variants
- Pricing metadata (free vs paid)

### Agent Discovery (`GET /api/agents`)
JARVIS discovers usable primary agents from OpenCode, filtering out hidden, disabled, or subagent-only helpers. Usable primary agents include `build` and `plan`.

### Dynamic Switching (`POST /api/session/:id/model` & `POST /api/session/:id/agent`)
- When switching a model or agent, JARVIS first validates against the active OpenCode catalog.
- Executes `POST /api/session/:id/model` or `POST /api/session/:id/agent` on the live daemon.
- Requires strict HTTP 204 success response. If OpenCode rejects, JARVIS aborts execution and throws a typed `OpenCodeError` detailing provider, model, variant, and HTTP status.
- The UI retains previous selection on failure and displays the exact error message.

---

## 6. Security-Hardened Permission Confirmation Flow

JARVIS strictly enforces user consent and **never silently grants `always` permissions**.

```text
OpenCode emits permission request
        │
        ▼
JARVIS catches event & halts execution
        │
        ├── Emits `confirm_required` event with unique requestId
        │
        ▼
Web UI displays Permission Confirmation Modal
        │
        ├── [Deny (Reject)] ─────────────► Sends reply: "reject" to OpenCode
        ├── [Approve Once] ──────────────► Sends reply: "once" to OpenCode
        └── [Always Allow (Durable)] ────► Sends reply: "always" to OpenCode (explicit user click only)
```

- **Approval**: Default approval sends `reply: "once"`, granting single-execution access.
- **Denial**: User denial sends `reply: "reject"`.
- **Timeout**: Bounded permission timeout sends `reply: "reject"`.
- **Durable Approval**: Only the dedicated "Always Allow" button in the UI sends `reply: "always"`.
- Expired or unknown request IDs return HTTP 404 and cannot approve subsequent requests.

---

## 7. Execution Routes

| Route | Trigger | Description | LLM Used |
|---|---|---|---|
| **DIRECT** | PC control, calculator, time, volume, apps, files | Deterministic OS operations | None |
| **SEARCH** | "search", "who is", "latest news", "weather" | Web search & factual extraction | None (initially) |
| **FAST** | "hi", "how are you", definitions, quick advice | Conversational streaming response | OpenCode FAST model |
| **AGENT** | "code", "refactor", "build", "debug", "audit" | Deep multi-step task execution with tools | OpenCode AGENT model |

---

## 8. Optional Fallback Provider (Opt-In Only)

For isolated testing environments where OpenCode is unavailable:
```json
{
  "fallbackProvider": {
    "enabled": false,
    "provider": "openai-compatible",
    "model": "gpt-4o-mini",
    "baseURL": "https://api.openai.com/v1",
    "apiKeyEnv": "FAST_MODEL_API_KEY"
  }
}
```
*Note: The fallback provider is disabled by default. Normal operation uses OpenCode exclusively.*

---

## 9. Troubleshooting & Diagnostics

Startup failures provide explicit human-readable remediation paths:

| Error State | Cause | Remediation |
|---|---|---|
| **OpenCode not installed** | CLI executable not found in PATH or standard paths | Install OpenCode CLI or specify `opencode.cliPath` in `jarvis.config.json`. |
| **Daemon failed to start** | `spawnIfDown` was true but service start command timed out | Run `opencode service start` manually to check for service errors. |
| **Health check failed** | OpenCode daemon running but `/api/info` returned unhealthy | Check OpenCode daemon logs or run `opencode service restart`. |
| **Model unavailable** | Configured `providerID/modelID` not in OpenCode catalog | Check available models via `GET /api/models` or adjust `models.fast` / `models.agent`. |
| **Agent unavailable** | Configured `agentID` is not a usable primary agent | Ensure the agent is visible and primary (e.g. `build` or `plan`). |

---

## 10. Running Tests

The test runner categorizes tests across four strict verification tiers:

```bash
# Run all verification suites (Unit, Mock Integration, Live OpenCode, Smoke)
npm test

# Run only live OpenCode gateway integration tests
npm run test:gateway

# Run only smoke acceptance scenarios
npm run test:smoke
```

Test runner outputs exact counts:
```text
UNIT: PASS (XX/XX tests)
MOCK: PASS (YY/YY tests)
LIVE OPENCODE: PASS (15/15 tests)
SMOKE: PASS (13/13 tests)
```
*If OpenCode is offline, the live gateway suite reports `LIVE OPENCODE: SKIPPED` and the runner never prints "ALL TESTS PASSED".*
