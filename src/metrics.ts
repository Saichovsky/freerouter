import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from "prom-client";

export const register = new Registry();

collectDefaultMetrics({ register });

export const requestsTotal = new Counter({
  name: "freerouter_requests_total",
  help: "Total number of chat completion requests",
  labelNames: ["tier", "model", "status"],
  registers: [register],
});

export const errorsTotal = new Counter({
  name: "freerouter_errors_total",
  help: "Total number of errors",
  labelNames: ["type"],
  registers: [register],
});

export const timeoutsTotal = new Counter({
  name: "freerouter_timeouts_total",
  help: "Total number of request timeouts",
  labelNames: ["model"],
  registers: [register],
});

export const tokensInputTotal = new Counter({
  name: "freerouter_tokens_input_total",
  help: "Total input tokens processed",
  labelNames: ["model", "provider"],
  registers: [register],
});

export const tokensOutputTotal = new Counter({
  name: "freerouter_tokens_output_total",
  help: "Total output tokens processed",
  labelNames: ["model", "provider"],
  registers: [register],
});

export const costEstimateUsd = new Gauge({
  name: "freerouter_cost_estimate_usd",
  help: "Current cost estimate in USD for the model",
  labelNames: ["model"],
  registers: [register],
});

export const requestDurationSeconds = new Histogram({
  name: "freerouter_request_duration_seconds",
  help: "Request duration in seconds",
  labelNames: ["tier", "model"],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120],
  registers: [register],
});

export const fallbacksTotal = new Counter({
  name: "freerouter_fallbacks_total",
  help: "Total number of fallback requests",
  labelNames: ["from_model", "to_model"],
  registers: [register],
});

export const up = new Gauge({
  name: "freerouter_up",
  help: "FreeRouter up status (1 = up)",
  registers: [register],
});

export function setUp(): void {
  up.set(1);
}

export function recordRequest(opts: { tier: string; model: string; status: "success" | "error"; durationSec: number }): void {
  requestsTotal.inc({ tier: opts.tier, model: opts.model, status: opts.status });
  requestDurationSeconds.observe({ tier: opts.tier, model: opts.model }, opts.durationSec);
}

export function recordError(type: string): void {
  errorsTotal.inc({ type });
}

export function recordTimeout(model: string): void {
  timeoutsTotal.inc({ model });
}

export function recordTokens(model: string, provider: string, inputTokens: number, outputTokens: number): void {
  if (inputTokens > 0) {
    tokensInputTotal.inc({ model, provider }, inputTokens);
  }
  if (outputTokens > 0) {
    tokensOutputTotal.inc({ model, provider }, outputTokens);
  }
}

export function recordCostEstimate(model: string, cost: number): void {
  costEstimateUsd.set({ model }, cost);
}

export function recordFallback(fromModel: string, toModel: string): void {
  fallbacksTotal.inc({ from_model: fromModel, to_model: toModel });
}