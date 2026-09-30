# JARVIS - Personal AI Assistant

JARVIS is an intelligent personal AI assistant architecture designed for seamless workstation control, factual web search, low-latency conversational interaction, and deep coding/reasoning.

## Architecture Overview

```
User (Web UI / Voice / API)
        │
        ▼
   JARVIS Core
        │
        ├── DIRECT ────► Deterministic local PC tools (zero LLM overhead)
        │
        ├── SEARCH ────► Web search & source extraction (zero LLM initially)
        │
        └── OPENCODE ──► Local OpenCode Daemon (Unified LLM Gateway)
             │
             ├── FAST  ──► Lightweight OpenCode model (e.g. opencode/mimo-v2.6-flash-free)
             └── AGENT ──► Stronger OpenCode model / coding agent
                  │
                  ▼
         Local OpenCode Server (http://127.0.0.1:49374)
                  │
                  ▼
         OpenCode Providers / Zen / Configured Models
```

### Core Architectural Principle
**JARVIS itself does NOT directly call OpenAI, Groq, OpenRouter, DeepSeek, or other external cloud providers for normal LLM execution.**

The local OpenCode daemon is the single unified LLM gateway. OpenCode handles model discovery, provider credentials, free-tier access, and server-side model routing. JARVIS communicates with the local OpenCode server as a client using standard OpenCode endpoints (`/api/session`, `/api/model`, `/api/event`).

No `FAST_MODEL_API_KEY` or `OPENAI_API_KEY` is required for standard operation.

---

## Getting Started

### 1. Prerequisites
- **Node.js**: v20 or later (v24 recommended with `--experimental-strip-types`)
- **OpenCode**: Installed and running locally (e.g. OpenCode CLI or OpenCode Desktop)

### 2. Verify OpenCode Daemon
Ensure the OpenCode daemon is running. OpenCode automatically creates a service configuration at `~/.local/state/opencode/service.json` or `~/.config/opencode/service.json`.

JARVIS automatically discovers the active OpenCode daemon and authenticates via HTTP Basic auth.

### 3. Configuration
JARVIS works out of the box with default OpenCode profiles. To customize model selections or server ports, create `jarvis.config.json` (or copy from `jarvis.config.example.json`):

```json
{
  "port": 31415,
  "host": "127.0.0.1",
  "models": {
    "fast": {
      "providerID": "opencode",
      "modelID": "mimo-v2.6-flash-free",
      "variant": "default"
    },
    "agent": {
      "providerID": "opencode",
      "modelID": "mimo-v2.6-flash-free",
      "variant": "default"
    }
  },
  "personality": {
    "name": "JARVIS",
    "userTitle": "Sir",
    "conciseByDefault": true
  }
}
```

#### OpenCode Model Selection
At startup, JARVIS queries OpenCode (`GET /api/model`) and validates the configured models against OpenCode's active catalog.

- **FAST Profile**: Lightweight, low-latency model for casual conversation, explanations, and quick questions.
- **AGENT Profile**: High-capacity model or specialized agent for multi-step reasoning, coding, and file tasks.

### 4. Running JARVIS
```bash
# Start the JARVIS server
node --experimental-strip-types src/index.ts
```
Then open `http://127.0.0.1:31415` in your browser.

---

## Execution Routes

| Route | Trigger | Description | LLM Used |
|---|---|---|---|
| **DIRECT** | PC control, calculator, time, volume, apps, files | Deterministic OS operations | None |
| **SEARCH** | "search", "who is", "latest news", "weather" | DuckDuckGo web search & extraction | None (initially) |
| **FAST** | "hi", "how are you", definitions, advice | Conversational streaming response | OpenCode FAST model |
| **AGENT** | "code", "refactor", "build", "debug", "audit" | Deep multi-step task execution | OpenCode AGENT model |

---

## Optional Cloud Fallback (Opt-In Only)
For testing or off-grid environments where OpenCode is unavailable, an optional fallback provider can be enabled in `jarvis.config.json`:
```json
{
  "fallbackProvider": {
    "enabled": true,
    "provider": "openai-compatible",
    "model": "gpt-4o-mini",
    "baseURL": "https://api.openai.com/v1",
    "apiKeyEnv": "FAST_MODEL_API_KEY"
  }
}
```
This is strictly opt-in and disabled by default.
