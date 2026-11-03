/**
 * LLM-Based Classifier (Laya Integration)
 *
 * Calls Laya, a self-hosted decision model, to classify prompts
 * that the rule-based scorer marked ambiguous (confidence < threshold).
 *
 * Laya is a native decision model served via llama.cpp's `/v1/systemone`
 * endpoint (System One API). It returns structured decisions with
 * probabilities rather than free-form text generation.
 *
 * Graceful degradation: returns `null` on timeout, network error,
 * parse failure, or invalid response — the caller falls back to
 * `ambiguousDefaultTier`. Zero external dependencies; uses native fetch.
 */

import type { Tier, ScoringResult, LayaClassifierConfig } from "./types.js";
import type { Counter, Histogram } from "prom-client";
import { logger } from "../logger.js";

// Metrics - lazily initialized by registerLayaMetrics()
let _layaCalls: Counter<string> | null = null;
let _layaDuration: Histogram<string> | null = null;

export function registerLayaMetrics(calls: Counter<string>, duration: Histogram<string>): void {
  _layaCalls = calls;
  _layaDuration = duration;
}

const VALID_TIERS: ReadonlySet<string> = new Set(["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"]);

type LayaResult = "success" | "failure" | "timeout" | "parse_error" | "invalid";

// Default tier criteria for the System One API
const DEFAULT_TIER_CRITERIA: Record<string, string> = {
  SIMPLE: "basic questions, simple definitions, greetings, simple translations",
  MEDIUM: "moderate coding tasks, explanations, medium complexity problems",
  COMPLEX: "advanced algorithms, system design, complex multi-step tasks",
  REASONING: "mathematical proofs, logical reasoning, step-by-step derivations, formal analysis",
};

/**
 * Truncate prompt text to fit within the model's context window.
 * Uses a simple char-to-token approximation (1 token ≈ 4 chars).
 */
function truncatePrompt(prompt: string, maxTokens: number | undefined): string {
  const limit = maxTokens ?? 2048;
  const maxChars = limit * 4;
  if (prompt.length <= maxChars) return prompt;
  return prompt.slice(0, Math.max(0, maxChars - 400)) + "...\n";
}

/**
 * Build the System One request body for tier classification.
 */
function buildSystemOneRequestBody(
  prompt: string,
  systemPrompt: string | undefined,
  classifier: LayaClassifierConfig,
): Record<string, unknown> {
  const state = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
  const criteria = classifier.classCriteria ?? DEFAULT_TIER_CRITERIA;

  return {
    model: classifier.model,
    state,
    questions: {
      tier: {
        type: "choice",
        instructions: classifier.promptTemplate,
        criteria: Object.fromEntries(
          Object.entries(criteria).filter(([tier]) => VALID_TIERS.has(tier)),
        ),
      },
    },
  };
}

/**
 * Parse a System One API response into a ScoringResult.
 */
function parseSystemOneResponse(data: Record<string, unknown>): {
  result: LayaResult;
  scoringResult: ScoringResult | null;
} {
  const answers = data.answers as Record<string, unknown> | undefined;
  if (!answers) return { result: "parse_error", scoringResult: null };

  const tierAnswer = answers.tier as Record<string, unknown> | undefined;
  if (!tierAnswer) return { result: "parse_error", scoringResult: null };

  const choice = tierAnswer.choice as string | undefined;
  const confidence = tierAnswer.confidence as number | undefined;
  const probabilities = tierAnswer.probabilities as Record<string, number> | undefined;

  if (!choice || !VALID_TIERS.has(choice)) {
    logger.warn(`Laya returned invalid tier choice: ${choice ?? "undefined"}`);
    return { result: "invalid", scoringResult: null };
  }

  if (typeof confidence !== "number" || Number.isNaN(confidence) || confidence < 0 || confidence > 1) {
    logger.warn(`Laya returned invalid confidence: ${confidence}`);
    return { result: "invalid", scoringResult: null };
  }

  const probStr = probabilities
    ? Object.entries(probabilities)
        .map(([k, v]) => `${k}=${(v * 100).toFixed(1)}%`)
        .join(", ")
    : `tier=${choice}, confidence=${confidence.toFixed(2)}`;

  return {
    result: "success",
    scoringResult: {
      score: 0,
      tier: choice as Tier,
      confidence,
      signals: ["laya"],
      agenticScore: 0,
      reasoning: probStr,
    },
  };
}

/**
 * Send a prompt to Laya for tier classification via the System One API.
 *
 * @returns ScoringResult with a validated tier, or `null` if Laya
 *          fails, times out, or returns an unparseable response.
 */
export async function classifyByLlm(
  prompt: string,
  systemPrompt: string | undefined,
  classifier: LayaClassifierConfig,
): Promise<ScoringResult | null> {
  const apiKey = classifier.apiKeyEnv
    ? process.env[classifier.apiKeyEnv]
    : undefined;

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), classifier.timeoutMs);

  const classifyStart = Date.now();
  let result: LayaResult = "failure";
  let resolved: ScoringResult | null = null;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };

  const truncatedPrompt = truncatePrompt(prompt, classifier.maxPromptTokens);
  const requestBody = buildSystemOneRequestBody(truncatedPrompt, systemPrompt, classifier);

  try {
    const response = await fetch(`${classifier.baseUrl}/v1/systemone`, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: abortController.signal,
    });

    if (response.ok) {
      const data = (await response.json()) as Record<string, unknown>;
      const { result: parseResult, scoringResult } = parseSystemOneResponse(data);
      result = parseResult;
      resolved = scoringResult;
    }
  } catch (err: unknown) {
    if ((err as { name?: string }).name === "AbortError") {
      result = "timeout";
    } else {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn(`Laya classifier error: ${errMsg}`);
      result = "failure";
    }
  } finally {
    clearTimeout(timeoutId);
  }

  _layaCalls?.inc({ result });
  _layaDuration?.observe({}, (Date.now() - classifyStart) / 1000);

  return resolved;
}
