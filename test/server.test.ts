import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 18899;
const BASE = `http://127.0.0.1:${PORT}`;

// Backend that refuses connections instantly: exercises routing, fallback,
// error recording, and metrics without needing real API keys.
const FIXTURE_CONFIG = {
  port: PORT,
  host: "127.0.0.1",
  providers: {
    "test-backend": {
      baseUrl: "http://127.0.0.1:9/v1",
      api: "openai",
      auth: { type: "env", key: "FREEROUTER_TEST_API_KEY" },
    },
  },
  tiers: {
    SIMPLE: { primary: "test-backend/test-model", fallback: ["test-backend/test-fb"] },
    MEDIUM: { primary: "test-backend/test-model", fallback: ["test-backend/test-fb"] },
    COMPLEX: { primary: "test-backend/test-model", fallback: ["test-backend/test-fb"] },
    REASONING: { primary: "test-backend/test-model", fallback: ["test-backend/test-fb"] },
  },
  agenticTiers: {
    SIMPLE: { primary: "test-backend/test-model", fallback: [] },
    MEDIUM: { primary: "test-backend/test-model", fallback: [] },
    COMPLEX: { primary: "test-backend/test-model", fallback: [] },
    REASONING: { primary: "test-backend/test-model", fallback: [] },
  },
};

let child: ChildProcess | null = null;

async function get(path: string): Promise<Response> {
  return fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(10000) });
}

async function postChat(body: unknown): Promise<Response> {
  return fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
}

async function metricValue(metric: string, labels: string): Promise<number | null> {
  const text = await (await get("/metrics")).text();
  const match = text.match(new RegExp(`^${metric}\\{${labels}\\} ([0-9.e+-]+)$`, "m"));
  return match ? parseFloat(match[1]) : null;
}

before(async () => {
  const fixturePath = join(tmpdir(), `freerouter-test-${process.pid}.json`);
  writeFileSync(fixturePath, JSON.stringify(FIXTURE_CONFIG));

  child = spawn("node", ["dist/server.js"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CLAWROUTER_PORT: String(PORT),
      CLAWROUTER_HOST: "127.0.0.1",
      FREEROUTER_CONFIG: fixturePath,
      FREEROUTER_TEST_API_KEY: "test-key",
    },
    stdio: "ignore",
  });

  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const res = await get("/health");
      if (res.status === 200) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error("test server did not start in time");
    await new Promise((r) => setTimeout(r, 250));
  }
});

after(async () => {
  if (child && !child.killed) {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child?.kill("SIGKILL");
        resolve();
      }, 5000);
      child?.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
});

describe("server", () => {
  it("GET /health returns ok with stats", async () => {
    const res = await get("/health");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; stats: object };
    assert.equal(body.status, "ok");
    assert.ok(body.stats && typeof body.stats === "object");
  });

  it("GET /v1/models lists the auto model", async () => {
    const res = await get("/v1/models");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    assert.ok(body.data.some((m) => m.id === "auto"));
  });

  it("GET /metrics exposes Prometheus format with freerouter_up", async () => {
    const res = await get("/metrics");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/plain/);
    const text = await res.text();
    assert.match(text, /freerouter_up 1/);
  });

  it("rejects invalid JSON and records a parse_error", async () => {
    const res = await postChat("this is not json");
    assert.equal(res.status, 400);
    assert.equal(await metricValue("freerouter_errors_total", 'type="parse_error"'), 1);
  });

  it("rejects requests without a model", async () => {
    const res = await postChat({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { message: string } };
    assert.match(body.error.message, /model field is required/);
  });

  it("returns 502 with routing headers when the backend is unreachable", async () => {
    const res = await postChat({
      model: "auto",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    });
    assert.equal(res.status, 502);
    assert.equal(res.headers.get("x-clawrouter-tier"), "SIMPLE");
    assert.equal(
      await metricValue(
        "freerouter_requests_total",
        'tier="SIMPLE",model="test-backend/test-model",status="error"',
      ),
      1,
    );
    assert.equal(await metricValue("freerouter_errors_total", 'type="upstream_error"'), 1);
  });

  it("honors the /max mode override in the routing header", async () => {
    const res = await postChat({
      model: "auto",
      messages: [{ role: "user", content: "/max hello" }],
      stream: false,
    });
    assert.equal(res.status, 502);
    assert.equal(res.headers.get("x-clawrouter-tier"), "REASONING");
  });

  it("GET /stats still reports the legacy JSON counters", async () => {
    const res = await get("/stats");
    assert.equal(res.status, 200);
    const stats = (await res.json()) as { requests: number; errors: number };
    assert.ok(stats.requests >= 2, `expected >= 2 requests, got ${stats.requests}`);
    assert.ok(stats.errors >= 2, `expected >= 2 errors, got ${stats.errors}`);
  });
});
