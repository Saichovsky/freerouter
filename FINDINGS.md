# Ponytail Audit — FreeRouter

## Findings (ranked biggest cut first)

### Dead code (delete)

**15 dead test files referencing non-existent modules** — the entire `test/` directory imports `./src/proxy.js`, `./src/balance.js`, `./src/retry.js`, `./src/errors.js`, `BLOCKRUN_MODELS`, `OPENCLAW_MODELS`, `PaymentCache`, `RequestDeduplicator`, `InsufficientFundsError`, `EmptyWalletError` — none of which exist in `src/`. These are leftovers from the original x402/BlockRun ClawRouter fork. The real source tree has zero corresponding modules.

Affected files (3,728 lines total):
- `test/e2e-tool-id-sanitization.ts` (272 lines) — imports `./src/proxy.js`
- `test/e2e.ts` (458 lines) — imports `../src/proxy.js`, `BLOCKRUN_MODELS`
- `test/fallback.ts` (288 lines) — imports `./src/proxy.js`
- `test/google-messages.ts` (273 lines) — imports `./src/proxy.js`
- `test/proxy-reuse.ts` (214 lines) — imports `./src/proxy.js`, `viem/accounts`
- `test/resilience-errors.ts` (349 lines) — imports `../src/proxy.js`
- `test/resilience-lifecycle.ts` (260 lines) — imports `../src/proxy.js`
- `test/resilience-stability.ts` (290 lines) — imports `../src/proxy.js`
- `test/test-balance-integration.ts` (193 lines) — imports `./src/proxy.js`, `./src/errors.js`
- `test/test-balance.ts` (299 lines) — imports `./src/balance.js`, `./src/errors.js`
- `test/test-e2e.mjs` (205 lines) — imports `./dist/index.js` (startProxy, etc.)
- `test/test-e2e.ts` (297 lines) — imports `./src/proxy.js`
- `test/test-retry.ts` (297 lines) — imports `./src/retry.js`
- `test/test-clawrouter.mjs` (697 lines) — imports `BLOCKRUN_MODELS`, `OPENCLAW_MODELS`, `startProxy`, `PaymentCache`, `RequestDeduplicator`, error classes from `../dist/index.js`
- `test/Dockerfile.test`, `test/Dockerfile.windows`, `test/run-docker-test.sh`, `test/run-docker-test-windows.ps1` — Docker test infrastructure for old BlockRun proxy

**Dead package.json test script** — `"test": "npx tsx test/test-router.ts"` points to a file that does not exist.

**Stale shell test scripts** — `tests/test-proxy.sh` (162 lines), `tests/test-proxy-extended.sh` (204 lines), `tests/run-all.sh` (442 lines), `tests/test-plan.md` (86 lines) — all describe the old x402 proxy behavior (port 18800, `blockrun/auto` model, old model IDs like `deepseek/deepseek-chat`, `grok-4-fast-reasoning`).

**tsup.config.ts** (11 lines) — entry point `src/cli.ts` does not exist. Config is dead.

**openclaw.plugin.json + openclaw.security.json** (54 lines) — describe x402 payment layer that was "removed entirely" per README. Reference `BLOCKRUN_WALLET_KEY`, wallet signing, USDC payments. Not applicable to Direct API fork.

**freerouter.service** (36 lines) — points to `dist/server.js` (should be `dist/src/server.js`) and `freemodels.config.json`. Either fix or move to docs.

**test/test-model-selection.sh + .ps1** (300 lines) — test OpenClaw plugin installation (`openclaw plugins install @blockrun/clawrouter@latest`), unrelated to Direct API self-hosted router.

### YAGNI (abstractions with one implementation)

**`agenticTiers` in `src/router/config.ts`** — identical to regular `tiers` (lines 186-203 vs 166-183). Every tier config is an exact copy. The `useAgenticTiers` path in `src/router/index.ts:48-49` produces identical results. Remove the entire `agenticTiers` field and the `isAutoAgentic`/`isExplicitAgentic` branching. Also removes `scoreAgenticTask()`'s dual return value.

**`ClassifierConfig` type in `src/router/types.ts`** (`llmModel`, `llmMaxTokens`, `llmTemperature`, `promptTruncationChars`, `cacheTtlMs`) — all describe an LLM classifier fallback path. The `method` field in `RoutingDecision` is hardcoded to `"rules"` in `router/index.ts:71`. The LLM classifier was never ported. Dead config surface.

**`version` field in `RoutingConfig`** (`router/config.ts:19` = `"2.0-direct"`) — never read anywhere in the codebase.

**`toInternalApiType()` in `src/config.ts:226-228`** — converts `"anthropic" | "openai"` → `"anthropic-messages" | "openai-completions"`. Used in exactly one place. Inline the string literal.

### Stdlib / dead helpers

**`resolvePath()` in `src/config.ts:86-91`** — hand-rolled `~/` expansion, never called (auth.ts does its own inline resolution at line 40).

**`resolveEnvVars()` in `src/config.ts:96-99`** — defined but never called. Config values from JSON are never env-var-resolved.

**Shadowed import in `src/provider.ts`** — `configSupportsAdaptiveThinking` is imported from `config.ts` (line 8) but never used. The file defines its own local `supportsAdaptiveThinking()` (line 111) that shadows it.

### Shrink (duplicate / reducible logic)

**Duplicate cost calculation in `src/router/selector.ts`** — `selectModel()` (lines 33-57) and `calculateModelCost()` (lines 72-96) contain identical ~25-line blocks for pricing/baseline/savings computation. Extract a shared `computeCost()` helper.

**Redundant variable in `src/router/rules.ts`** — line 133-134: `const text = prompt.toLowerCase()` and `const userText = prompt.toLowerCase()` are identical. `userText` is only used for the reasoning-override check (line 244-246); can use `text` directly.

**Hardcoded model name `"anthropic/claude-opus-4-6"`** — appears as baseline in `selector.ts:40,86` and as fallback default in `server.ts:212`. Should be a named constant.

---

## Summary

| Category | Files | Lines |
|----------|-------|-------|
| Dead test files | 15 files | 3,728 |
| Stale shell scripts | 4 files | 832 |
| Dead config/build files | 4 files | 221 |
| YAGNI abstractions (src) | 2 items | N/A |
| Dead helper functions (src) | 2 items | ~15 lines |
| Duplicate logic (src) | 2 items | ~50 lines |
| **Total dead/reducible** | **~25 files** | **~4,900 lines** |

The core routing engine (`rules.ts`, `selector.ts`, `router/index.ts`, `provider.ts`, `auth.ts`, `logger.ts`, `server.ts`) is tight and well-structured. The bloat is entirely in the dead test suite and orphaned config from the x402 fork that was never cleaned up after the Direct API fork.

**Highest-leverage action:** `rm -rf test/ tests/` and delete `openclaw.plugin.json`, `openclaw.security.json`, `tsup.config.ts`.

**net: -4,900 lines, -3 stale shell test suites, -2 dead config files, -2 dead helper functions, ~65 lines of reducible source logic possible.**
