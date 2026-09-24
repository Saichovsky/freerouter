# FreeRouter — Free, Self-Hosted AI Model Router

<p align="center">
  <img src="assets/logo.png" width="200" alt="FreeRouter Logo"/>
</p>

**Stop overpaying for AI. Route every request to the right model — automatically, with your own API keys. No middleman, no markup.**

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## Why FreeRouter?

**You already have API keys. Why pay someone else to use them?**

| Pain | How FreeRouter Fixes It |
|------|------------------------|
| 💸 **Middleman markup** — OpenRouter and similar services charge on top of provider prices | **Zero markup.** Self-hosted, runs locally. You pay providers directly. |
| 🔥 **Every message hits your expensive model** — Opus at $75/M output tokens for "hello"? | **14-dimension classifier** routes simple messages to cheap models automatically. Save 60-80%. |
| 🎰 **No control over routing** — auto-classifiers get it wrong sometimes | **Mode overrides.** Prefix `/max` or `[simple]` to force a tier when you know better. |
| ⏳ **Proxies that hang** — upstream is slow, your app freezes | **Request timeouts + auto-fallback.** Times out → retries with fallback model. |
| 🔧 **Hardcoded configs** — want to change a model? Edit source code, recompile, restart | **External config file.** Edit JSON, hit `/reload-config`. No restart needed. |

## Features

- **Smart routing** — 14-dimension weighted classifier scores every request and picks the best model
- **Mode overrides** *(new in v1.3.0)* — force a tier with `/max`, `/simple`, `[complex]`, `deep mode:` etc.
- **Zero cost** — no subscription, no per-token fees, no payment layer
- **External config** — `freerouter.config.json` for providers, tiers, boundaries, auth
- **Request timeouts** — per-tier timeouts with automatic fallback to secondary model
- **Tool call translation** — bidirectional Anthropic ↔ OpenAI format translation
- **OpenAI-compatible API** — drop-in replacement; works with any client that speaks `/v1/chat/completions`
- **Prometheus metrics** — `GET /metrics` exposes token usage, request counts, latency, cost estimates, and errors per model

## How It Works

```
Your App → FreeRouter (:18800) → Classifier → Best Model (per freerouter.config.json)
                                    ├── SIMPLE    → qwen2.5-coder:1.5b  (near-zero cost)
                                    ├── MEDIUM    → qwen2.5-coder:7b    (balanced)
                                    ├── COMPLEX   → qwen3.6:27b         (powerful)
                                    └── REASONING → qwen3-coder:30b     (max thinking)
```

The classifier scores each message on 14 dimensions (vocabulary complexity, reasoning depth, code complexity, domain specificity, etc.) and routes to the cheapest model that can handle it. Context-aware — includes last 3 messages in scoring. Tier → model mappings are fully configurable (the diagram above shows the shipped `freerouter.config.json`, which targets local Ollama models).

## Mode Overrides *(v1.3.0)*

Sometimes you know better than the classifier. Prefix your prompt to force a tier:

### Slash Prefix
```
/simple What's 2+2?
/max Analyze this distributed system architecture for race conditions
/reasoning Prove that P(A|B) = P(B|A)P(A)/P(B)
```

### Bracket Prefix
```
[complex] Refactor this module to use dependency injection
[simple] Translate "hello" to French
```

### Word Prefix
```
deep mode: Why does this recursive CTE produce duplicates?
basic mode, What time is it in Tokyo?
```

### Alias Table

| Aliases | Routes to |
|---------|-----------|
| `simple`, `basic`, `cheap` | SIMPLE — cheapest model |
| `medium`, `balanced` | MEDIUM — general purpose |
| `complex`, `advanced` | COMPLEX — powerful model |
| `max`, `reasoning`, `think`, `deep` | REASONING — maximum thinking |

The prefix is **stripped** before forwarding — the LLM never sees it. When no prefix is detected, normal classification runs.

## Quick Start

### 1. Clone & Build

```bash
git clone https://github.com/Saichovsky/freerouter.git
cd freerouter
npm install
npm run build
```

### 2. Configure

Copy and edit the config file:

```bash
cp freerouter.config.json ~/.config/freerouter/config.json
# Edit providers, API keys, tier mappings
```

Or set API keys via environment variables. See [Configuration](#configuration) below.

### 3. Run

```bash
node dist/server.js
# Listening on http://localhost:18800
```

### 4. Use

Point any OpenAI-compatible client at `http://localhost:18800/v1/chat/completions`.

```bash
# Health check
curl http://localhost:18800/health

# Chat
curl http://localhost:18800/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello!"}]}'
```

## Configuration

FreeRouter looks for config in this order:
1. `FREEROUTER_CONFIG` environment variable
2. `./freerouter.config.json` (working directory)
3. `~/.config/freerouter/config.json`

If no config file exists, built-in defaults apply.

### Config File Structure

```json
{
  "port": 18800,
  "host": "127.0.0.1",
  "providers": {
    "local-ollama": {
      "baseUrl": "http://127.0.0.1:11434/v1",
      "api": "openai",
      "auth": { "type": "env", "key": "OPENAI_API_KEY" }
    }
  },
  "tiers": {
    "SIMPLE":    { "primary": "local-ollama/qwen2.5-coder:1.5b-fast", "fallback": ["local-ollama/qwen2.5-coder:7b-fast"] },
    "MEDIUM":    { "primary": "local-ollama/qwen2.5-coder:7b-fast",   "fallback": ["local-ollama/qwen3.6:27b-fast"] },
    "COMPLEX":   { "primary": "local-ollama/qwen3.6:27b-fast",        "fallback": ["local-ollama/qwen3-coder:30b-fast"] },
    "REASONING": { "primary": "local-ollama/qwen3-coder:30b-fast",    "fallback": ["local-ollama/qwen3.6:27b-fast"] }
  },
  "tierBoundaries": { "simpleMedium": 0.05, "mediumComplex": 0.25, "complexReasoning": 0.50 }
}
```

Provider `api` is `"anthropic"` (Messages API) or `"openai"` (OpenAI-compatible). Auth can come from OpenClaw `auth-profiles.json`, an env var (`"auth": { "type": "env", "key": "VAR_NAME" }`), and more — see `src/auth.ts` and `docs/configuration.md`.

Reload without restart: `curl http://localhost:18800/reload-config`

## OpenClaw Integration

Add to your `openclaw.json`:

```json
{
  "providers": {
    "freerouter": {
      "baseUrl": "http://localhost:18800",
      "api": "openai-completions",
      "models": [{ "id": "auto" }]
    }
  },
  "agents": {
    "defaults": { "model": "freerouter/auto" }
  }
}
```

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /v1/chat/completions` | Main chat endpoint (OpenAI-compatible) |
| `GET /health` | Health check with uptime and request stats |
| `GET /stats` | Request statistics by tier and model |
| `GET /metrics` | Prometheus metrics (token usage, latency, errors, cost) |
| `GET /v1/models` | List available models |
| `GET /config` | View current config (secrets redacted) |
| `POST /reload` | Reload auth keys |
| `POST /reload-config` | Reload config file |

## Monitoring (Prometheus)

`GET /metrics` exposes Prometheus-format metrics, plus standard Node.js runtime metrics. Scrape it directly or point Prometheus at it:

```yaml
scrape_configs:
  - job_name: freerouter
    static_configs:
      - targets: ["localhost:18800"]
```

| Metric | Type | Labels | Notes |
|--------|------|--------|-------|
| `freerouter_requests_total` | Counter | `tier`, `model`, `status` | `status` is `success` or `error` |
| `freerouter_errors_total` | Counter | `type` | `parse_error`, `bad_request`, `upstream_error`, … |
| `freerouter_timeouts_total` | Counter | `model` | Upstream timeouts (triggers fallback) |
| `freerouter_tokens_input_total` | Counter | `model`, `provider` | From provider `usage` in the response |
| `freerouter_tokens_output_total` | Counter | `model`, `provider` | From provider `usage` in the response |
| `freerouter_cost_estimate_usd` | Gauge | `model` | Routing-time estimate; `0` for models with no pricing in `src/models.ts` |
| `freerouter_request_duration_seconds` | Histogram | `tier`, `model` | Buckets: 0.1s–120s |
| `freerouter_fallbacks_total` | Counter | `from_model`, `to_model` | Each fallback hop |
| `freerouter_up` | Gauge | — | Always `1` when serving |

Streaming token counts are best-effort (not all providers report `usage` on streams); non-streaming counts are exact.

## The 14-Dimension Classifier

Each message is scored across 14 dimensions:

| Dimension | What It Measures |
|-----------|-----------------|
| Token count | Message length |
| Vocabulary complexity | Rare/technical words |
| Syntax complexity | Nested clauses, conditionals |
| Domain specificity | Specialized knowledge needed |
| Ambiguity | How open-ended the request is |
| Context dependency | Needs prior conversation |
| Reasoning depth | Logical steps required |
| Creativity level | Original generation needed |
| Emotional complexity | Nuance in tone/sentiment |
| Multimodality | References to images/files |
| Instruction complexity | Multi-step instructions |
| Knowledge recency | Needs current information |
| Code complexity | Programming difficulty |
| Mathematical complexity | Formal math/proofs |

Scores are weighted and combined. Tier boundaries are configurable.

## Cost Impact

| Scenario | Estimated Daily Cost |
|----------|---------------------|
| All top-tier (no routing) | ~$50/day |
| With FreeRouter | ~$10-15/day |
| **Savings** | **60-80%** |

Most messages are simple. Those route to the cheapest tier model. Only complex work hits the expensive models. (Illustrative hosted-API figures — the shipped config targets local Ollama models, where inference cost is compute rather than per-token spend. Per-model pricing lives in `src/models.ts` and feeds the `freerouter_cost_estimate_usd` metric.)

## Project Structure

```
freerouter/
├── src/
│   ├── server.ts          # HTTP server + mode override detection + metrics recording
│   ├── provider.ts        # Multi-provider forwarding + SSE translation + token capture
│   ├── metrics.ts         # Prometheus metrics (prom-client registry + helpers)
│   ├── auth.ts            # API key management (OpenClaw profiles, env, file)
│   ├── config.ts          # External config loader
│   ├── models.ts          # Model definitions + per-1M-token pricing
│   ├── logger.ts          # Request logging
│   ├── index.ts           # Library entry (router exports)
│   └── router/
│       ├── index.ts       # 14-dimension classifier entry
│       ├── config.ts      # Tier mappings + scoring weights
│       ├── rules.ts       # Keyword-based scoring rules
│       ├── selector.ts    # Tier → model selection + cost estimates
│       └── types.ts       # Tier, RoutingDecision, config types
├── docs/                  # Architecture, configuration, troubleshooting guides
├── scripts/               # Install/uninstall helpers
├── freerouter.config.json # Shipped config (local Ollama tiers)
├── tsconfig.json
└── package.json
```

## Credits

Forked from [BlockRunAI/ClawRouter](https://github.com/BlockRunAI/ClawRouter) (MIT License). Routing engine preserved; x402 payment protocol removed entirely. Credit to BlockRunAI for the original classifier design.

## License

[MIT](LICENSE)
