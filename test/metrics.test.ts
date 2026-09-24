import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  register,
  setUp,
  recordRequest,
  recordError,
  recordTimeout,
  recordTokens,
  recordCostEstimate,
  recordFallback,
} from "../src/metrics.js";

type Sample = { value: number; labels: Record<string, string> };

async function samples(metricName: string): Promise<Sample[]> {
  const all = await register.getMetricsAsJSON();
  const found = all.find((m) => m.name === metricName);
  return (found?.values ?? []) as Sample[];
}

function withLabels(all: Sample[], labels: Record<string, string>): Sample[] {
  return all.filter((s) => Object.entries(labels).every(([k, v]) => s.labels[k] === v));
}

describe("metrics", () => {
  it("setUp marks the service as up", async () => {
    setUp();
    const up = await samples("freerouter_up");
    assert.equal(up.length, 1);
    assert.equal(up[0].value, 1);
  });

  it("recordRequest counts by tier/model/status and observes duration", async () => {
    const labels = { tier: "SIMPLE", model: "test-model-req", status: "success" as const };
    recordRequest({ ...labels, durationSec: 1.5 });

    const total = withLabels(await samples("freerouter_requests_total"), labels);
    assert.equal(total.length, 1);
    assert.equal(total[0].value, 1);

    const durations = withLabels(await samples("freerouter_request_duration_seconds"), {
      tier: "SIMPLE",
      model: "test-model-req",
    });
    const count = durations.find((s) => Object.keys(s.labels).length === 2);
    assert.ok(count && count.value >= 1, "expected a duration observation");
  });

  it("recordError counts by type", async () => {
    recordError("test_parse_error");
    const errs = withLabels(await samples("freerouter_errors_total"), {
      type: "test_parse_error",
    });
    assert.equal(errs.length, 1);
    assert.equal(errs[0].value, 1);
  });

  it("recordTimeout counts by model", async () => {
    recordTimeout("test-model-timeout");
    const timeouts = withLabels(await samples("freerouter_timeouts_total"), {
      model: "test-model-timeout",
    });
    assert.equal(timeouts.length, 1);
    assert.equal(timeouts[0].value, 1);
  });

  it("recordTokens accumulates input and output by model/provider", async () => {
    recordTokens("test-model-tokens", "test-provider", 100, 25);
    recordTokens("test-model-tokens", "test-provider", 50, 5);

    const input = withLabels(await samples("freerouter_tokens_input_total"), {
      model: "test-model-tokens",
      provider: "test-provider",
    });
    const output = withLabels(await samples("freerouter_tokens_output_total"), {
      model: "test-model-tokens",
      provider: "test-provider",
    });
    assert.equal(input[0].value, 150);
    assert.equal(output[0].value, 30);
  });

  it("recordTokens ignores zero values", async () => {
    recordTokens("test-model-zero", "test-provider", 0, 0);
    assert.equal(
      withLabels(await samples("freerouter_tokens_input_total"), {
        model: "test-model-zero",
      }).length,
      0,
    );
    assert.equal(
      withLabels(await samples("freerouter_tokens_output_total"), {
        model: "test-model-zero",
      }).length,
      0,
    );
  });

  it("recordCostEstimate sets the gauge per model", async () => {
    recordCostEstimate("test-model-cost", 0.42);
    const costs = withLabels(await samples("freerouter_cost_estimate_usd"), {
      model: "test-model-cost",
    });
    assert.equal(costs[0].value, 0.42);
  });

  it("recordFallback counts from_model/to_model hops", async () => {
    recordFallback("test-model-from", "test-model-to");
    const fbs = withLabels(await samples("freerouter_fallbacks_total"), {
      from_model: "test-model-from",
      to_model: "test-model-to",
    });
    assert.equal(fbs.length, 1);
    assert.equal(fbs[0].value, 1);
  });
});
