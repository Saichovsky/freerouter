import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getThinkingConfig } from "../src/provider.js";
import { reloadConfig } from "../src/config.js";

const prevConfigPath = process.env.FREEROUTER_CONFIG;
const fixturePath = join(tmpdir(), `freerouter-thinking-${process.pid}.json`);

function useFixture(config: unknown) {
  writeFileSync(fixturePath, JSON.stringify(config));
  process.env.FREEROUTER_CONFIG = fixturePath;
  reloadConfig();
}

after(() => {
  if (prevConfigPath === undefined) delete process.env.FREEROUTER_CONFIG;
  else process.env.FREEROUTER_CONFIG = prevConfigPath;
  reloadConfig();
});

describe("getThinkingConfig() with a thinking block", () => {
  before(() => {
    useFixture({
      thinking: {
        adaptive: ["qwen3.6:27b-fast"],
        enabled: { models: ["qwen3-coder:30b-fast"], budget: 2048 },
      },
    });
  });

  it("returns adaptive for a listed model on COMPLEX", () => {
    assert.deepEqual(getThinkingConfig("COMPLEX", "local-ollama/qwen3.6:27b-fast"), {
      type: "adaptive",
    });
  });

  it("returns adaptive for a listed model on REASONING", () => {
    assert.deepEqual(getThinkingConfig("REASONING", "local-ollama/qwen3.6:27b-fast"), {
      type: "adaptive",
    });
  });

  it("returns undefined for an unlisted model on COMPLEX", () => {
    assert.equal(getThinkingConfig("COMPLEX", "test-backend/plain-model"), undefined);
  });

  it("returns the configured budget for a listed model on MEDIUM", () => {
    assert.deepEqual(getThinkingConfig("MEDIUM", "local-ollama/qwen3-coder:30b-fast"), {
      type: "enabled",
      budget_tokens: 2048,
    });
  });

  it("returns undefined for an unlisted model on MEDIUM", () => {
    assert.equal(getThinkingConfig("MEDIUM", "test-backend/plain-model"), undefined);
  });

  it("returns undefined on SIMPLE regardless of model", () => {
    assert.equal(getThinkingConfig("SIMPLE", "local-ollama/qwen3.6:27b-fast"), undefined);
  });
});

describe("getThinkingConfig() without a thinking block", () => {
  before(() => {
    useFixture({});
  });

  it("falls back to opus defaults for adaptive", () => {
    assert.deepEqual(getThinkingConfig("COMPLEX", "anthropic/claude-opus-4-6"), {
      type: "adaptive",
    });
  });

  it("returns undefined on MEDIUM with no enabled list", () => {
    assert.equal(getThinkingConfig("MEDIUM", "anthropic/claude-sonnet-4-5"), undefined);
  });
});
