# Changelog

## [1.4.0] — 2026-09-24

### 📊 Prometheus Metrics

- **New `GET /metrics` endpoint** — token counts, request counts/errors, latency histogram, cost estimates, and fallback counts per model/provider (+ `prom-client` dependency)
- Token usage captured from provider `usage` in both streaming and non-streaming paths
- README gains a Monitoring section with scrape config and a full metric table

### 🧠 Thinking Config Wired Up

- `thinking.adaptive` / `thinking.enabled` in `freerouter.config.json` are now honored (previously silently ignored); built-in opus defaults apply when unset
- 8 new fixture-driven tests pin listed/unlisted-model behavior and the opus fallback

### 🧹 Dead Code Removed

- `getAuthHeader()`, `ClassifierConfig` type + `version`/`classifier` config surface, `resolvePath()`/`resolveEnvVars()`, unused imports

### ✅ CI + Test Suite

- **37/37 tests passing** via `npm test` (`test/router`, `test/metrics`, `test/thinking`, `test/server` — node:test + tsx, zero new deps)
- CI runs lint, typecheck, build, test on PRs; docs-only PRs skip CI
- Prettier check removed; eslint deps pinned (`eslint`, `@eslint/js`, `typescript-eslint`)

### Fixed

- `/health` version now matches release (`1.4.0`)
- UTF-8 mojibake in `src/provider.ts` file header
- `npm start` path corrected to `dist/server.js`

---

## [1.3.0] — 2026-02-14

### 🎛️ Mode Overrides — Take Control When You Want It

#### Mode Override Prefixes
Users can now force a specific routing tier by prefixing their prompt. The directive is stripped before forwarding to the LLM.

**Three syntax styles supported:**
- **Slash:** `/simple`, `/medium`, `/complex`, `/max`, `/reasoning`, `/think`, `/deep`, `/basic`, `/cheap`, `/balanced`, `/advanced`
- **Word prefix:** `complex mode: ...`, `deep mode, ...`
- **Bracket:** `[reasoning] ...`, `[simple] ...`

When no prefix is detected, falls back to normal 14-dimension classification — fully backward compatible.

#### Alias Mapping
| Input | Routes to |
|-------|-----------|
| `/simple`, `/basic`, `/cheap` | SIMPLE |
| `/medium`, `/balanced` | MEDIUM |
| `/complex`, `/advanced` | COMPLEX |
| `/max`, `/reasoning`, `/think`, `/deep` | REASONING |

#### Tests
- 5 new mode override tests added
- **75/75 tests passing** (up from 70/70)

---

## [1.2.0] — 2026-02-14

### 🔧 External Config + Reliability Improvements

#### Config-Driven Architecture
- **New: `freerouter.config.json`** — all providers, tiers, boundaries, thinking, and auth are now configurable without editing source code
- **New: `src/config.ts`** — config loader with file search priority: `FREEROUTER_CONFIG` env → `./freerouter.config.json` → `~/.config/freerouter/config.json`
- Deep-merges file config over built-in defaults — fully backward compatible (works without config file)
- New `/config` endpoint — view current config with secrets redacted
- New `/reload-config` endpoint — reload config without restarting the proxy
- Auth types: `openclaw` (reads auth-profiles.json), `env` (environment variables), per-provider overrides

#### Reliability
- **Request timeouts** — `AbortSignal.timeout()` per tier: SIMPLE 30s, MEDIUM 60s, COMPLEX/REASONING 120s
- **Streaming stall detection** — aborts if no data received for 30s mid-stream
- **Auto-fallback on timeout** — if primary model times out, fallback model is tried automatically
- **Timeout counter** — visible in `/health` and `/stats` responses
- **`TimeoutError` class** — clean error identification for fallback logic

#### Smarter Classification
- **Token estimation fix** — complexity scoring now uses user prompt length only (not system+user). Long system prompts (AGENTS.md, SOUL.md) no longer inflate complexity scores. A "hello" with a 40K system prompt correctly routes to SIMPLE, not COMPLEX
- **Structured output fix** — detection now checks user prompt only. System prompts mentioning "json" no longer force tier upgrades
- Total token count still used for context window checks (large input → force COMPLEX)

#### Provider Configuration
- Providers defined in config with `baseUrl`, `api` type (`"anthropic"` or `"openai"`), optional `headers`
- Any OpenAI-compatible provider works out of the box — just add baseUrl + API key
- Anthropic gets automatic format translation (tool calls, streaming, thinking)
- Thinking config is now data-driven: specify which models support adaptive thinking and budget amounts

### Migration
No action needed — if no `freerouter.config.json` exists, all previous defaults apply. To customize:

```bash
cp freerouter.config.json ~/.config/freerouter/config.json
# Edit providers, tiers, boundaries to taste
curl http://localhost:18800/reload-config  # Apply without restart
```

---

## [1.0.0] — 2026-02-14

### 🚀 First Full Release — Proxy Server + Smart Routing

The first complete release of FreeRouter: a self-hosted, OpenAI-compatible proxy that classifies requests by complexity and routes them to the best model using your own API keys.

### Added

- **Proxy server** (`src/server.ts`) — zero-dependency HTTP server exposing OpenAI-compatible `/v1/chat/completions` endpoint
- **Provider translation** (`src/provider.ts`) — translates between Anthropic Messages API and OpenAI format:
  - `content_block` / `tool_use` → OpenAI `tool_calls` / `function` format
  - Streaming `input_json_delta` → streamed `arguments` chunks
  - Thinking block filtering (no XML/thinking leak to clients)
  - Non-streaming tool call support with proper `finish_reason: "tool_calls"`
- **Auth module** (`src/auth.ts`) — reads OpenClaw's `auth-profiles.json` for API keys
  - Supports Anthropic OAuth tokens (`sk-ant-oat*`) with Claude Code identity headers
  - Supports standard API keys for any provider
- **Logger** (`src/logger.ts`) — minimal, zero-dep request logging with configurable levels
- **Model definitions** (`src/models.ts`) — model catalog with pricing for cost estimation
- **14-dimension weighted classifier** (`src/router/`) — scores requests across:
  - Token count, code presence, reasoning markers, technical terms, creative markers
  - Simple indicators, multi-step patterns, question complexity, imperative verbs
  - Constraint count, output format, reference complexity, negation, domain specificity
  - Agentic task detection (auto-switches to agentic tier configs)
- **Tier-based routing**:
  - SIMPLE → Kimi K2.5 (near-zero cost)
  - MEDIUM → Claude Sonnet 4.5 (balanced)
  - COMPLEX → Claude Opus 4.6 (powerful)
  - REASONING → Claude Opus 4.6 (max thinking)
- **Fallback chains** — automatic retry with fallback model on failure
- **Adaptive thinking** — auto-configures thinking per model:
  - Sonnet: `{ type: "enabled", budget_tokens: 4096 }`
  - Opus: `{ type: "adaptive" }`
- **Context-aware classification** — includes last 3 conversation messages in scoring
- **Multilingual keyword support** — English, Chinese, Japanese, Russian, German
- **Test suites** — 70/70 tests passing:
  - `tests/test-proxy.sh` — 33 core tests (health, validation, routing, streaming, tools, concurrency)
  - `tests/test-proxy-extended.sh` — 37 extended tests (unicode, edge cases, stress, alternate endpoints)
- **Management endpoints**: `/health`, `/stats`, `/reload`, `/v1/models`
- **CORS support** for browser-based clients
- **Zero external dependencies** — only TypeScript + @types/node as dev deps

### Architecture

```
Client (OpenAI format) → FreeRouter (:18800) → 14-dim Classifier → Route to best model
                                                                     ├── Simple → Kimi K2.5
                                                                     ├── Medium → Sonnet 4.5
                                                                     ├── Complex → Opus 4.6
                                                                     └── Reasoning → Opus 4.6
```

### Credits

Forked from [BlockRunAI/ClawRouter](https://github.com/BlockRunAI/ClawRouter) (MIT License). Routing engine preserved; x402 payment protocol removed entirely.
