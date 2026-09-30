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
    "agentWeight": 0.5
  },
  "personality": {
    "name": "JARVIS",
    "userTitle": "Sir",
    "conciseByDefault": true
  }
}
```

### Model Governance & Agent Routing Bias
- **Agent Routing Bias (`agentWeight`)**: Adjusts the router's classification threshold for directing ambiguous prompts to the AGENT path instead of FAST. It does **not** change model parameters.
- **Sampling Parameters / Temperature**: Generic temperature sliders have been removed from the JARVIS UI because OpenCode governs model sampling parameters directly through model definitions and supported variant presets (e.g. `high`, `fast`, `thinking`). Unsupported UI controls that have no runtime effect are strictly disallowed.

---

## 5. Model & Agent Discovery and Dynamic Switching

### Dynamic Model Discovery (`GET /api/model`)
JARVIS queries the live OpenCode catalog and normalizes models:
- Canonical identity: `providerID + modelID` (e.g. `opencode/mimo-v2.6-flash-free`)
- Name, family, capabilities, and variants
- Pricing metadata (free vs paid)
- If the catalog is unreachable, JARVIS fails clearly rather than hiding errors or pretending the catalog is empty.

### Model Variant Validation
OpenCode models specify variants as either strings or structured objects (e.g. `{ id: "high", settings: {}, headers: {}, body: {} }`).
JARVIS enforces strict variant validation everywhere via `modelSupportsVariant(model, variant)`:
- Missing/empty variant defaults safely to "default".
- String variants match directly (`variants.includes(variant)`).
- Object variants match against `variant.id`.
- Unsupported variants are rejected immediately before execution or switching.

### Dynamic Agent Discovery (`GET /api/agents`)
JARVIS discovers usable primary agents from OpenCode:
- Accepts agents with `mode === "primary"` or `mode === "all"`.
- Strictly filters out hidden (`hidden: true`) and disabled (`disabled: true`) agents.

### Session Model & Agent Switching
- **Session Switching ("Switch")**: Immediately switches the active OpenCode session via `POST /api/session/:id/model` or `POST /api/session/:id/agent`.
- **Persistent Profiles ("Save & Switch")**: Atomically writes updated FAST/AGENT model and agent configurations to `jarvis.config.json` via safe temporary write and rename semantics, surviving server restarts.
- **Session State Audit**: After switching, JARVIS queries `GET /api/session/:id` to verify that OpenCode actually applied the requested model, provider, and agent, rather than blindly trusting HTTP 204.

---

## 6. OpenCode Protocol Specifications

### Canonical Prompt Request Payload
JARVIS strictly conforms to the OpenCode v2 prompt schema:
```json
{
  "prompt": {
    "text": "User instructions or contextual prompt",
    "files": [],
    "agents": []
  },
  "delivery": "steer",
  "resume": true
}
```
*Note: Top-level `text`, `files`, `agents`, `skills`, or `metadata` are unsupported by OpenCode and are never sent by JARVIS.*

### Canonical Permission Reply Payload
When replying to an OpenCode permission request:
```json
{
  "reply": "once" | "always" | "reject",
  "message": "Optional user or system explanation"
}
```
*Note: The deprecated `decision` field is never transmitted.*

### Deadlock-Free Permission Confirmation Flow
JARVIS strictly guarantees that permission requests unblock execution without deadlocks:

```text
OpenCode emits SSE permission request
        │
        ▼
JARVIS captures event & creates authoritative pending confirmation
        │
        ├── Emits UI `confirm_required` event with JARVIS requestId
        │
        ▼
Execution pauses awaiting resolution
        │
        ├── UI displays modal with action details and resources
        │
        ▼
User selects: [Approve Once] | [Always Allow] | [Deny]
        │
        ├── UI calls POST /api/confirm with requestId and decision
        │
        ▼
JARVIS core resolves pending promise & dispatches reply to OpenCode
        │
        ▼
OpenCode resumes execution & emits remaining stream events
```

- **Safety & Clean-up**: Bounded timeouts automatically dispatch `reject`.
- **Disconnection**: Socket disconnects or cancellations abort pending requests cleanly.
- **Verification**: End-to-end integration tests verify that execution is strictly blocked until user approval is received.

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
