# Spec: Laya Classifier Integration (Hybrid Approach)

## Status: Implemented & Verified

> **Branch**: `feat/laya-classifier-integration`
> **Verification**: 43 tests pass, tsc clean, ESLint clean, server starts, metrics exposed
> **Live test**: All three tier classifications verified against Laya at 192.168.10.8:8081 ✓

## Laya Exploration Findings

During exploration of Laya at `http://192.168.10.8:8081`, the following characteristics were discovered:

| Aspect | Finding |
|--------|---------|
| **Server** | `llama.cpp` (custom build `b1-ff5a233`) running at the URL |
| **Model** | `/opt/laya-router/models/Laya-Q8_0.gguf` (421M params, Q8_0 quantized) |
| **Model type** | `output_modalities: ["decisions"]` — a **native decision model**, NOT a text-generation model |
| **Standard endpoints** | `/v1/chat/completions` and `/v1/completions` fail with *"the current context does not support logits computation"* — the model lacks a language modeling (LM) head |
| **Correct endpoint** | `POST /v1/systemone` — llama.cpp's **System One API** for native decision models |
| **Health check** | `GET /health` → `{"status":"ok"}` |

### System One API (the correct API)

Native decision models like Laya use a structured request/response format instead of text generation:

**Request:**
```json
{
  "model": "/opt/laya-router/models/Laya-Q8_0.gguf",
  "state": "The prompt text to classify",
  "questions": {
    "tier": {
      "type": "choice",
      "instructions": "Classify into SIMPLE, MEDIUM, COMPLEX, or REASONING.",
      "criteria": {
        "SIMPLE": "basic questions, simple definitions, greetings, simple translations",
        "MEDIUM": "moderate coding tasks, explanations, medium complexity problems",
        "COMPLEX": "advanced algorithms, system design, complex multi-step tasks",
        "REASONING": "mathematical proofs, logical reasoning, step-by-step derivations, formal analysis"
      }
    }
  }
}
```

**Response:**
```json
{
  "model": "/opt/laya-router/models/Laya-Q8_0.gguf",
  "answers": {
    "tier": {
      "type": "choice",
      "choice": "MEDIUM",
      "probabilities": {"SIMPLE": 0.13, "MEDIUM": 0.66, "COMPLEX": 0.16, "REASONING": 0.04},
      "confidence": 0.55
    }
  },
  "usage": {"input_tokens": 105, "output_tokens": 0}
}
```

### API Strategy

The `classifyByLlm` function calls Laya via `POST /v1/systemone` — llama.cpp's System One API for native decision models. This is the **only API needed for Laya**. Laya returns structured `choice`, `probabilities`, and `confidence` values.

### Verified Classifications

| Prompt | Laya Result | Confidence |
|--------|-------------|------------|
| "Write a Python function to validate email addresses using regex." | **MEDIUM** | 0.55 |
| "Hello, how are you today?" | **SIMPLE** | 0.60 |
| "What is the formal method for demonstrating that a statement is universally true?" | **REASONING** | 0.27 |
| "Compare the tradeoffs between transformer and mamba architectures." | **MEDIUM** | 0.27 |

### `classCriteria` Configuration

The `classCriteria` field in `LayaClassifierConfig` allows customizing the tier descriptions sent to Laya's System One API. When omitted, built-in defaults are used.

## Problem

FreeRouter's rule-based classifier (`src/router/rules.ts`) handles 70–80% of requests in <1ms with zero cost. For the remaining ~20–30% of ambiguous requests (confidence below threshold), the system previously defaulted to `MEDIUM` tier with no disambiguation. The original design doc (`docs/plans/2026-02-03-smart-routing-design.md`) planned a "Step 2: LLM Classifier" but it was never implemented. This spec completes that design using Laya, a self-hosted decisioning model.

## Decision: Hybrid (not full replacement)

| | Rule-only today | Full Laya replacement | **Hybrid (this spec)** |
|---|---|---|---|
| Every request latency | <1ms | +50–500ms | <1ms for 70–80%, +latency only for ambiguous 20–30% |
| Classification cost | Zero | Per-call Laya tokens | Zero for 70–80%, Laya tokens only for ambiguous |
| Failure blast radius | None | All auto-routing fails | Only ambiguous requests degrade to MEDIUM |
| Backward compatibility | N/A | Breaking | **None — optional config** |

## Architecture

```
user prompt → [Step 1: Rule Classifier (<1ms, zero cost)]
                    ├── Confident (conf ≥ threshold) → route with method="rules"
                    └── Ambiguous (conf < threshold):
                        ├── Laya not configured → fallback to MEDIUM, method="rules"
                        └── Laya configured → POST /v1/systemone (System One API)
                            ├── Laya success → route with method="llm"
                            └── Laya failure/timeout → fallback to MEDIUM, method="rules"
```

Key properties:
- **Rules always run first** — the fast path is preserved.
- **Laya is optional** — when `classifier` is absent from config, behavior is identical to today.
- **Graceful degradation** — any Laya failure (timeout, network error, invalid JSON, invalid tier) returns `null` → the caller falls back to `ambiguousDefaultTier`.
- **Observability** — metrics tracked for every Laya invocation (success/failure/timeout/parse_error/invalid + latency).

## Config Schema

Add to `freerouter.config.json` (optional — absent means rules-only):

```json
{
  "classifier": {
    "baseUrl": "http://192.168.10.8:8081",
    "model": "/opt/laya-router/models/Laya-Q8_0.gguf",
    "timeoutMs": 2000,
    "promptTemplate": "Classify the user prompt into one of four complexity tiers: SIMPLE, MEDIUM, COMPLEX, or REASONING.",
    "maxPromptTokens": 2048
  }
}
```

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `baseUrl` | `string` | Yes | — | Laya API base URL (e.g., `http://192.168.10.8:8081`) |
| `model` | `string` | Yes | — | Model identifier path (e.g., `/opt/laya-router/models/Laya-Q8_0.gguf`) |
| `apiKeyEnv` | `string` | No | — | Env var name for `Authorization: Bearer` header |
| `timeoutMs` | `number` | Yes | — | Request timeout in milliseconds |
| `promptTemplate` | `string` | Yes | — | Instruction text sent as the `instructions` field in the System One API question |
| `maxPromptTokens` | `number` | No | `2048` | Maximum prompt tokens to send to Laya. Prompts exceeding this are truncated. |
| `classCriteria` | `Record<string, string>` | No | built-in defaults | Tier descriptions for the System One API `criteria` field. Only entries matching valid tiers (SIMPLE, MEDIUM, COMPLEX, REASONING) are sent. |

## File-by-File Changes

### 1. New file: `src/router/llm.ts`

LLM classifier module. Calls Laya via the `/v1/systemone` endpoint (System One API for decision models). Returns `ScoringResult` with a validated tier, or `null` on any failure.

Key design decisions:
- **No external dependencies** — uses native `fetch` + `AbortController` (same pattern as `provider.ts`).
- **System One API only** — single-phase strategy: `POST /v1/systemone`. No chat completions fallback (Laya is a decision model that lacks a text-generation LM head).
- **Structured response parsing** — extracts `choice`, `confidence`, and `probabilities` from `answers.{question}.` fields.
- **Prompt truncation** — truncates prompts to `maxPromptTokens` (default 2048) before sending, reducing token cost on long prompts.
- **Validation** — tier validated against `VALID_TIERS` set; confidence validated as number in [0, 1].
- **Metrics** — lazily registered via `registerLayaMetrics()` to avoid import cycles. Records counter (by result type) and histogram (latency).
- **Error handling** — failure modes: network error, timeout (AbortError), invalid response. All return `null`.

```typescript
// Key signature
export async function classifyByLlm(
  prompt: string,
  systemPrompt: string | undefined,
  classifier: LayaClassifierConfig,
): Promise<ScoringResult | null>
```

### 2. `src/router/types.ts` (modified)

- Added `LayaClassifierConfig` type with fields:
  - `maxPromptTokens?: number` — prompt truncation limit (default: 2048)
  - `classCriteria?: Record<string, string>` — tier descriptions for System One API
  - `apiPath?: string` — *(deprecated; no longer used)*
  - `apiKeyEnv?: string` — optional Bearer token env var
- Added `classifier?: LayaClassifierConfig` to `RoutingConfig`.
- Added `reasoning?: string` to `ScoringResult` (so Laya's explanation flows through).

### 3. `src/router/index.ts` (modified)

- `route()` is now `async`, returns `Promise<RoutingDecision>`.
- When `ruleResult.tier === null` (ambiguous) and `config.classifier` exists, calls `await classifyByLlm()`.
- If Laya returns a tier → `method: "llm"`, uses Laya's tier + confidence.
- If Laya returns `null` → falls back to `ambiguousDefaultTier`, `method: "rules"`, reasoning includes "laya unavailable".
- Exports `classifyByLlm` and `registerLayaMetrics`.

### 4. `src/router/config.ts` (modified)

- `getRoutingConfig()` passes through `classifier` from the external config file, same pattern as `tiers`, `agenticTiers`, and `tierBoundaries`.

### 5. `src/config.ts` (modified)

- Added `classifier?` field to `FreeRouterConfig` type with the same fields as `LayaClassifierConfig`.

### 6. `src/metrics.ts` (modified)

- Added `layaClassificationsTotal` Counter (label: `result`).
- Added `layaClassificationDurationSeconds` Histogram.
- Added `recordLayaClassification()` helper.

### 7. `src/server.ts` (modified)

- `await route(...)` (was synchronous).
- Registers Laya metrics via `registerLayaMetrics()`.
- Log line updated: `Classified (rules|llm): tier=... model=...`.

### 8. `src/index.ts` (modified)

- JSDoc example updated to `await route(...)`.
- Exports `classifyByLlm`, `registerLayaMetrics`, `LayaClassifierConfig`.

### 9. `test/router.test.ts` (modified)

- All `route()` tests made `async`/`await`.
- Added `method` assertions to existing tests.
- New tests:
  - "falls back to default tier when Laya is configured but endpoint is unreachable" — uses unreachable endpoint, verifies graceful fallback to MEDIUM with `method: "rules"` and "laya unavailable" in reasoning.
  - "falls back to default tier when no classifier is configured" — verifies pure rules path still works without classifier config.
  - "falls back to default tier when Laya is configured with a custom apiPath but endpoint is unreachable" — verifies graceful degradation when an unreachable endpoint is configured.
  - "verifies pure rules fallback when no classifier is configured" — verifies that a high confidenceThreshold + no classifier means rules-only fallback.
  - "does not define a classifier by default" — verifies `DEFAULT_ROUTING_CONFIG.classifier === undefined`.
  - "classifies prompts via Laya's System One API when server is available" — live integration test against `192.168.10.8:8081` (skips if unreachable). Verifies MEDIUM, SIMPLE, and REASONING classifications via Laya.

## Behavior Matrix

| Input scenario | Rules confidence | Laya configured? | Laya response | Final tier | Final method |
|---|---|---|---|---|---|
| "Hello!" → SIMPLE | ≥ threshold | No | N/A | SIMPLE | rules |
| "Hello!" → SIMPLE | ≥ threshold | Yes | (not called) | SIMPLE | rules |
| Ambiguous (score near boundary) | < threshold | No | N/A | MEDIUM (default) | rules |
| Ambiguous | < threshold | Yes | Success (System One) | Laya's tier | **llm** |
| Ambiguous | < threshold | Yes | Non-200 response | MEDIUM (default) | rules |
| Ambiguous | < threshold | Yes | Timeout | MEDIUM (default) | rules |
| Ambiguous | < threshold | Yes | Parse error | MEDIUM (default) | rules |
| Ambiguous | < threshold | Yes | Invalid tier | MEDIUM (default) | rules |
| Large input (>100K tokens) | Override | N/A | N/A | COMPLEX | rules |
| User mode override (`/max`) | N/A | N/A | N/A | REASONING | rules |

## Breaking Changes

- `route()` is now `async` — returns `Promise<RoutingDecision>` instead of `RoutingDecision`. All three call sites updated (`server.ts`, `index.ts` JSDoc, `router.test.ts`).
- `classifyByLlm()` signature simplified — `estimatedTokens` parameter removed (was unused).

## Future Enhancements

1. **In-memory cache** for Laya classifications (TTL 1h, max 1000 entries) — avoids re-classifying identical prompts.
2. **Adaptive boundaries** — adjust tier boundaries dynamically based on Laya's accuracy feedback.
