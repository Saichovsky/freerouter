import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  route,
  getFallbackChain,
  getFallbackChainFiltered,
  calculateModelCost,
  DEFAULT_ROUTING_CONFIG,
} from "../src/router/index.js";
import { buildPricingMap, getContextWindow } from "../src/models.js";
import { parseModelId } from "../src/provider.js";

const pricing = buildPricingMap();

function decide(prompt: string) {
  return route(prompt, undefined, 4096, {
    config: DEFAULT_ROUTING_CONFIG,
    modelPricing: pricing,
  });
}

describe("route()", () => {
  it("routes a greeting to SIMPLE", () => {
    const d = decide("Hello!");
    assert.equal(d.tier, "SIMPLE");
    assert.equal(d.model, "kimi-coding/kimi-for-coding");
  });

  it("routes a formal proof to REASONING with high confidence", () => {
    const d = decide(
      "Prove that the square root of 2 is irrational. Show each step formally, step by step.",
    );
    assert.equal(d.tier, "REASONING");
    assert.equal(d.model, "anthropic/claude-opus-4-6");
    assert.ok(d.confidence > 0.5, `expected confidence > 0.5, got ${d.confidence}`);
  });

  it("upgrades structured-output requests to at least MEDIUM", () => {
    const plain = decide("What is 2+2?");
    const withJson = decide("What is 2+2? Reply in json.");
    assert.equal(plain.tier, "SIMPLE");
    assert.equal(withJson.tier, "MEDIUM");
  });

  it("forces COMPLEX for very large inputs", () => {
    const d = decide("a".repeat(400001));
    assert.equal(d.tier, "COMPLEX");
  });

  it("flags agentic tasks in the reasoning string", () => {
    const d = decide(
      "Read the file src/server.ts, fix the bug, and verify it works. Step 1: open the file. Step 2: edit it until it works.",
    );
    assert.ok(d.reasoning.includes("agentic"), `expected agentic flag, got: ${d.reasoning}`);
  });

  it("returns cost estimate, baseline, and savings", () => {
    const d = decide("Hello!");
    assert.ok(d.costEstimate >= 0);
    assert.ok(d.baselineCost >= d.costEstimate);
    assert.ok(d.savings >= 0 && d.savings <= 1);
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
});
