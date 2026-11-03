import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROXY_PORT = 18902;
const BASE = `http://127.0.0.1:${PROXY_PORT}`;

type ForwardedChat = {
  model: string;
  messages: Array<{ role: string; content: string }>;
};

const forwarded: ForwardedChat[] = [];
let backend: Server | null = null;
let child: ChildProcess | null = null;

function lastForwarded(): ForwardedChat {
  const body = forwarded.at(-1);
  assert.ok(body, "backend did not receive a request");
  return body;
}

async function postChat(body: unknown): Promise<Response> {
  return fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
}

before(async () => {
  // Live OpenAI-compatible backend that records what the proxy forwards.
  backend = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as ForwardedChat;
      forwarded.push(body);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }));
    });
  });

  await new Promise<void>((resolve) => backend!.listen(0, "127.0.0.1", resolve));
  const backendPort = (backend!.address() as { port: number }).port;

  const fixture = {
    port: PROXY_PORT,
    host: "127.0.0.1",
    providers: {
      mock: {
        baseUrl: `http://127.0.0.1:${backendPort}/v1`,
        api: "openai",
        auth: { type: "env", key: "FREEROUTER_MOCK_API_KEY" },
      },
    },
    tiers: {
      SIMPLE: { primary: "mock/test-model", fallback: [] },
      MEDIUM: { primary: "mock/test-model", fallback: [] },
      COMPLEX: { primary: "mock/test-model", fallback: [] },
      REASONING: { primary: "mock/test-model", fallback: [] },
    },
    agenticTiers: {
      SIMPLE: { primary: "mock/test-model", fallback: [] },
      MEDIUM: { primary: "mock/test-model", fallback: [] },
      COMPLEX: { primary: "mock/test-model", fallback: [] },
      REASONING: { primary: "mock/test-model", fallback: [] },
    },
  };

  const fixturePath = join(tmpdir(), `freerouter-mode-override-${process.pid}.json`);
  writeFileSync(fixturePath, JSON.stringify(fixture));

  child = spawn("node", ["dist/server.js"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CLAWROUTER_PORT: String(PROXY_PORT),
      CLAWROUTER_HOST: "127.0.0.1",
      FREEROUTER_CONFIG: fixturePath,
      FREEROUTER_MOCK_API_KEY: "test-key",
    },
    stdio: "ignore",
  });

  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1000) });
      if (res.status === 200) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error("test server did not start in time");
    await new Promise((resolve) => setTimeout(resolve, 250));
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
  if (backend) {
    await new Promise<void>((resolve) => backend!.close(() => resolve()));
  }
});

describe("mode override forwarding", () => {
  it("strips the directive from the message sent to the backend", async () => {
    const res = await postChat({
      model: "auto",
      messages: [{ role: "user", content: "/medium Hi! Please reply with a short greeting." }],
      stream: false,
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-clawrouter-tier"), "MEDIUM");
    assert.equal(lastForwarded().messages.at(-1)?.content, "Hi! Please reply with a short greeting.");
  });

  it("detects and strips the directive in a multi-turn conversation", async () => {
    const res = await postChat({
      model: "auto",
      messages: [
        { role: "user", content: "Earlier question about nothing in particular." },
        { role: "assistant", content: "Earlier answer." },
        { role: "user", content: "/complex Explain this stack trace." },
      ],
      stream: false,
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-clawrouter-tier"), "COMPLEX");
    assert.equal(lastForwarded().messages.at(-1)?.content, "Explain this stack trace.");
  });
});
