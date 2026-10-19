import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  route,
  getFallbackChain,
  getFallbackChainFiltered,
  calculateModelCost,
  DEFAULT_ROUTING_CONFIG,
} from "../src/router/index.js";
import type { RoutingConfig } from "../src/router/types.js";
import { buildPricingMap, getContextWindow } from "../src/models.js";
import { parseModelId } from "../src/provider.js";

const pricing = buildPricingMap();

async function decide(prompt: string, config?: RoutingConfig) {
  return route(prompt, undefined, 4096, {
    config: config ?? DEFAULT_ROUTING_CONFIG,
    modelPricing: pricing,
  });
}

/**
 * Decide via Laya, retrying if Laya stalled and the router fell back to rules.
 * Laya is a network dependency that occasionally stalls for several seconds,
 * so a single timeout can flake a live integration test. Retrying keeps the
 * assertion meaningful without coupling the suite to Laya's tail latency.
 */
async function decideViaLaya(prompt: string, config: RoutingConfig, attempts = 3) {
  let decision = await decide(prompt, config);
  for (let i = 1; i < attempts && decision.method !== "llm"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    decision = await decide(prompt, config);
  }
  return decision;
}

describe("route()", () => {
  it("routes a greeting to SIMPLE", async () => {
    const d = await decide("Hello!");
    assert.equal(d.tier, "SIMPLE");
    assert.equal(d.model, "kimi-coding/kimi-for-coding");
    assert.equal(d.method, "rules");
  });

  it("routes a formal proof to REASONING with high confidence", async () => {
    const d = await decide(
      "Prove that the square root of 2 is irrational. Show each step formally, step by step.",
    );
    assert.equal(d.tier, "REASONING");
    assert.equal(d.model, "anthropic/claude-opus-4-6");
    assert.ok(d.confidence > 0.5, `expected confidence > 0.5, got ${d.confidence}`);
    assert.equal(d.method, "rules");
  });

  it("upgrades structured-output requests to at least MEDIUM", async () => {
    const plain = await decide("What is 2+2?");
    const withJson = await decide("What is 2+2? Reply in json.");
    assert.equal(plain.tier, "SIMPLE");
    assert.equal(withJson.tier, "MEDIUM");
  });

  it("forces COMPLEX for very large inputs", async () => {
    const d = await decide("a".repeat(400001));
    assert.equal(d.tier, "COMPLEX");
  });

  it("flags agentic tasks in the reasoning string", async () => {
    const d = await decide(
      "Read the file src/server.ts, fix the bug, and verify it works. Step 1: open the file. Step 2: edit it until it works.",
    );
    assert.ok(d.reasoning.includes("agentic"), `expected agentic flag, got: ${d.reasoning}`);
  });

  it("returns cost estimate, baseline, and savings", async () => {
    const d = await decide("Hello!");
    assert.ok(d.costEstimate >= 0);
    assert.ok(d.baselineCost >= d.costEstimate);
    assert.ok(d.savings >= 0 && d.savings <= 1);
  });

  // --- Laya integration tests ---

  it("falls back to default tier when Laya is configured but endpoint is unreachable", async () => {
    // Use a high confidenceThreshold so rules are always ambiguous,
    // then Laya will be tried (and fail fast on unreachable endpoint)
    const configWithLaya: RoutingConfig = {
      ...DEFAULT_ROUTING_CONFIG,
      scoring: {
        ...DEFAULT_ROUTING_CONFIG.scoring,
        confidenceThreshold: 0.99,  // everything is ambiguous → triggers Laya path
      },
      classifier: {
        baseUrl: "http://127.0.0.1:1", // nothing listening → fast ECONNREFUSED
        model: "laya",
        timeoutMs: 100,
        promptTemplate: "Classify into SIMPLE, MEDIUM, COMPLEX, or REASONING.",
      },
    };
    const d = await decide("Kanban board design for a startup", configWithLaya);
    // Laya failed → should fall back to ambiguousDefaultTier (MEDIUM)
    assert.equal(d.tier, "MEDIUM");
    assert.equal(d.method, "rules");
    assert.ok(d.reasoning.includes("laya unavailable"));
  });

  it("falls back to default tier when no classifier is configured", async () => {
    // High confidenceThreshold forces ambiguity; no classifier means pure rules fallback
    const configNoClassifier: RoutingConfig = {
      ...DEFAULT_ROUTING_CONFIG,
      scoring: {
        ...DEFAULT_ROUTING_CONFIG.scoring,
        confidenceThreshold: 0.99,  // everything is ambiguous
      },
      // No classifier field → pure rules fallback
    };
    const d = await decide("Kanban board design for a startup", configNoClassifier);
    assert.equal(d.tier, "MEDIUM");
    assert.equal(d.method, "rules");
    assert.ok(d.reasoning.includes("ambiguous"));
  });

  it("falls back to default tier when Laya is configured with classCriteria but endpoint is unreachable", async () => {
    // Optional classifier fields (classCriteria, maxPromptTokens) must not
    // disturb the graceful-degradation path.
    const configWithCriteria: RoutingConfig = {
      ...DEFAULT_ROUTING_CONFIG,
      scoring: {
        ...DEFAULT_ROUTING_CONFIG.scoring,
        confidenceThreshold: 0.99,
      },
      classifier: {
        baseUrl: "http://127.0.0.1:1",
        model: "laya",
        timeoutMs: 100,
        promptTemplate: "Classify into SIMPLE, MEDIUM, COMPLEX, or REASONING.",
        maxPromptTokens: 512,
        classCriteria: { SIMPLE: "basic", MEDIUM: "moderate", COMPLEX: "advanced", REASONING: "proofs" },
      },
    };
    const d = await decide("Some prompt", configWithCriteria);
    assert.equal(d.tier, "MEDIUM");
    assert.equal(d.method, "rules");
    assert.ok(d.reasoning.includes("laya unavailable"));
  });

  it("verifies pure rules fallback when no classifier is configured", async () => {
    // Verify that a high confidenceThreshold + no classifier means rules-only fallback
    const configNoClassifier: RoutingConfig = {
      ...DEFAULT_ROUTING_CONFIG,
      scoring: {
        ...DEFAULT_ROUTING_CONFIG.scoring,
        confidenceThreshold: 0.99,
      },
    };
    const d = await decide("Some prompt", configNoClassifier);
    assert.equal(d.tier, "MEDIUM");
    assert.equal(d.method, "rules");
  });

  it("classifies prompts via Laya's System One API when server is available", async () => {
    // Skip if the Laya server at 192.168.10.8:8081 is not reachable
    let layaAvailable = false;
    try {
      const healthRes = await fetch("http://192.168.10.8:8081/health", {
        signal: AbortSignal.timeout(2000),
      });
      layaAvailable = healthRes.ok;
    } catch {
      // Laya not reachable — skip this test
    }

    if (!layaAvailable) {
      console.log("  ℹ Skipping (Laya server not available)");
      return;
    }

    const configWithRealLaya: RoutingConfig = {
      ...DEFAULT_ROUTING_CONFIG,
      scoring: {
        ...DEFAULT_ROUTING_CONFIG.scoring,
        confidenceThreshold: 0.99,  // force Laya path
      },
      classifier: {
        baseUrl: "http://192.168.10.8:8081",
        model: "/opt/laya-router/models/Laya-Q8_0.gguf",
        timeoutMs: 10000,
        promptTemplate: "Classify into SIMPLE, MEDIUM, COMPLEX, or REASONING.",
        maxPromptTokens: 2048,
      },
    };

    // Test: coding task → should be MEDIUM
    const coding = await decideViaLaya(
      "Write a Python function to validate email addresses using regex.",
      configWithRealLaya,
    );
    assert.equal(coding.method, "llm");
    assert.equal(coding.tier, "MEDIUM");

    // Test: greeting → should be SIMPLE
    const greeting = await decideViaLaya("Hello, how are you today?", configWithRealLaya);
    assert.equal(greeting.method, "llm");
    assert.equal(greeting.tier, "SIMPLE");

    // Test: reasoning task → should be REASONING via LLM
    // Note: we avoid keywords like "prove"/"theorem"/"formally" so the
    // rule-based classifier stays ambiguous and triggers the LLM path.
    const reasoning = await decideViaLaya(
      "What is the formal method for demonstrating that a statement is universally true?",
      configWithRealLaya,
    );
    assert.equal(reasoning.method, "llm");
    assert.equal(reasoning.tier, "REASONING");
  });
});

describe("calculateModelCost()", () => {
  it("computes exact cost for 1M in / 1M out on kimi", () => {
    const { costEstimate } = calculateModelCost(
      "kimi-coding/kimi-for-coding",
      pricing,
      1_000_000,
      1_000_000,
    );
    assert.ok(Math.abs(costEstimate - 2.9) < 1e-9, `expected 2.9, got ${costEstimate}`);
  });

  it("reports savings against the opus baseline", () => {
    const { savings } = calculateModelCost("kimi-coding/kimi-for-coding", pricing, 10_000, 1_000);
    assert.ok(savings > 0.9, `expected large savings, got ${savings}`);
  });
});

describe("fallback chains", () => {
  it("returns primary then fallbacks for SIMPLE", () => {
    assert.deepEqual(getFallbackChain("SIMPLE", DEFAULT_ROUTING_CONFIG.tiers), [
      "kimi-coding/kimi-for-coding",
      "anthropic/claude-haiku-4-5",
    ]);
  });

  it("filters out models whose context window is too small", () => {
    // kimi context is 262144 < 300000 * 1.1; haiku has no known window so it passes through
    assert.deepEqual(
      getFallbackChainFiltered("SIMPLE", DEFAULT_ROUTING_CONFIG.tiers, 300_000, getContextWindow),
      ["anthropic/claude-haiku-4-5"],
    );
  });
});

describe("parseModelId()", () => {
  it("splits provider and model on slash", () => {
    assert.deepEqual(parseModelId("anthropic/claude-opus-4-6"), {
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
  });

  it("defaults to anthropic when there is no slash", () => {
    assert.deepEqual(parseModelId("claude-opus-4-6"), {
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
  });
});

describe("DEFAULT_ROUTING_CONFIG", () => {
  it("defines all four tiers", () => {
    assert.deepEqual(Object.keys(DEFAULT_ROUTING_CONFIG.tiers).sort(), [
      "COMPLEX",
      "MEDIUM",
      "REASONING",
      "SIMPLE",
    ]);
  });

  it("does not define a classifier by default", () => {
    assert.equal(DEFAULT_ROUTING_CONFIG.classifier, undefined);
  });
});
