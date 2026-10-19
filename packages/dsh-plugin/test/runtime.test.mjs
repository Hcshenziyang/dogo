import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  rm,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { Engine } from "./harness.mjs";
import { Store } from "../src/host/store.mjs";
import { readWorkspaceFile, listWorkspace } from "../src/workspace.mjs";

async function fixture(t, model) {
  const folder = await realpath(
    await mkdtemp(path.join(tmpdir(), "dogo-runtime-test-")),
  );
  const workspace = path.join(folder, "workspace");
  await mkdir(workspace);
  await writeFile(
    path.join(workspace, "hello.ts"),
    "export const answer = 42;",
  );
  const engine = new Engine(path.join(folder, "data"), () => {}, model);
  t.after(async () => {
    await engine.close();
    await rm(folder, { recursive: true, force: true });
  });
  return { folder, workspace, engine };
}
async function settled(engine, id) {
  const entry = engine.active.get(id);
  if (entry) await entry.done;
  return engine.store.get(id);
}
function config(engine, endpoint = "http://127.0.0.1:8000/v1") {
  engine.configure({
    ...engine.store.settings(),
    endpoint,
    model: "test-model",
  });
}

test('shutdown warns when native activity is unknown instead of assuming idle', async t => {
  const { engine } = await fixture(t);
  assert.deepEqual(await engine.executionStatus(), { active: 0, unknown: false });
  engine.dsh.state = 'ready';
  engine.dsh.request = async () => { throw new Error('fixture unavailable'); };
  assert.deepEqual(await engine.executionStatus(), { active: 0, unknown: true });
});

test("directory check requires an explicit grant and saves a real result", async (t) => {
  const { engine, workspace } = await fixture(t);
  assert.throws(
    () => engine.create({ kind: "inspect", prompt: "check" }),
    /选择/,
  );
  assert.throws(
    () =>
      engine.create({
        kind: "inspect",
        prompt: "check",
        workspaceId: "invented",
      }),
    /授权/,
  );
  const grant = await engine.authorizeWorkspace(workspace);
  const result = await settled(
    engine,
    engine.create({ kind: "inspect", prompt: "check", workspaceId: grant.id }),
  );
  assert.equal(result.status, "succeeded");
  assert.match(result.output, /hello.ts/);
  assert.doesNotMatch(result.output, /answer = 42/);
});
test("file reader rejects traversal, hidden files, secrets, symlinks, large and binary files", async (t) => {
  const { workspace, folder } = await fixture(t);
  await writeFile(path.join(folder, "outside.ts"), "private");
  await symlink(
    path.join(folder, "outside.ts"),
    path.join(workspace, "link.ts"),
  );
  await writeFile(path.join(workspace, ".env"), "token");
  await writeFile(path.join(workspace, "credentials.json"), "token");
  await writeFile(path.join(workspace, "big.ts"), "x".repeat(65537));
  await writeFile(path.join(workspace, "binary.ts"), Buffer.from([0, 1, 2]));
  for (const item of [
    "../outside.ts",
    "/etc/passwd",
    ".env",
    "credentials.json",
    "link.ts",
    "big.ts",
    "binary.ts",
  ])
    await assert.rejects(readWorkspaceFile(workspace, item));
  assert.equal(
    await readWorkspaceFile(workspace, "hello.ts"),
    "export const answer = 42;",
  );
  const tree = await listWorkspace(workspace);
  assert(!tree.files.includes("link.ts"));
  assert(!tree.files.includes(".env"));
});
test("settings reject external providers, credentials and invalid limits", async (t) => {
  const { engine } = await fixture(t);
  for (const endpoint of [
    "https://api.example.com/v1",
    "http://127.0.0.1.evil.test/v1",
    "http://user:pass@localhost/v1",
    "file:///tmp/a",
    "http://localhost/v1?token=abc",
  ])
    assert.throws(() => config(engine, endpoint));
  assert.throws(() =>
    engine.configure({
      ...engine.store.settings(),
      maxTokens: 32768,
      contextWindow: 32768,
    }),
  );
  assert.throws(
    () => engine.create({ kind: "analysis", prompt: "hello" }),
    /模型/,
  );
});
test("streaming, sequential execution and cancellation are durable", async (t) => {
  const { engine } = await fixture(t, async ({ signal, delta }) => {
    delta("partial");
    await new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Error("aborted"));
      signal.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true,
      });
    });
  });
  config(engine);
  const id = engine.create({ kind: "analysis", prompt: "hello" });
  assert.throws(
    () => engine.create({ kind: "analysis", prompt: "duplicate" }),
    /已有任务/,
  );
  assert.throws(() => config(engine), /结束后/);
  await engine.cancel(id);
  const task = engine.store.get(id);
  assert.equal(task.status, "cancelled");
  assert.equal(task.output, "partial");
});
test("failures are not reported as successes", async (t) => {
  const { engine } = await fixture(t, async () => {
    throw new Error("connection refused");
  });
  config(engine);
  const task = await settled(
    engine,
    engine.create({ kind: "analysis", prompt: "hello" }),
  );
  assert.equal(task.status, "failed");
  assert.match(task.error, /connection refused/);
});
test("restart preserves results, marks interrupted work and does not restore grants", async (t) => {
  const { engine, folder } = await fixture(t);
  const now = new Date().toISOString();
  engine.store.save({
    id: "interrupted",
    status: "running",
    updatedAt: now,
    output: "partial",
  });
  const other = new Store(path.join(folder, "data"));
  assert.equal(other.get("interrupted").status, "interrupted");
  other.close();
  assert.equal(engine.workspaces.size, 0);
});
test("follow-up preserves previous output and needs reauthorization after restart", async (t) => {
  const { engine, workspace } = await fixture(t, async ({ delta }) =>
    delta("result"),
  );
  config(engine);
  const grant = await engine.authorizeWorkspace(workspace);
  const id = engine.create({
    kind: "analysis",
    prompt: "first",
    workspaceId: grant.id,
  });
  await settled(engine, id);
  engine.workspaces.clear();
  assert.throws(() => engine.followup(id, "second"), /授权/);
  await engine.authorizeWorkspace(workspace);
  engine.followup(id, "second");
  const task = await settled(engine, id);
  assert.equal(task.turns.length, 1);
  assert.equal(task.turns[0].output, "result");
  assert.equal(task.prompt, "second");
});

test('legacy Pi history is retained but cannot silently resume in DSH', async (t) => {
  const { engine } = await fixture(t, async ({ delta }) => delta('old answer'));
  config(engine);
  const id = engine.create({ kind: 'analysis', prompt: 'legacy fixture' });
  await settled(engine, id);
  engine.store.save({ ...engine.store.get(id), sessionFile: '/synthetic/old-session.jsonl', engine: undefined });
  assert.throws(() => engine.followup(id, 'continue'), /旧 Pi/);
  assert.equal(engine.store.get(id).output, 'old answer');
});

test(
  "real DSH backend calls a mock OpenAI server, reads only the scoped tool, persists and resumes the session",
  { timeout: 90000 },
  async (t) => {
    const requests = [];
    const server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const value = JSON.parse(body);
      requests.push(value);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta, finish_reason = null) =>
        res.write(
          `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      if (requests.length === 1) {
        send({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "read-1",
              type: "function",
              function: {
                name: "read_workspace_file",
                arguments: '{"path":"hello.ts"}',
              },
            },
          ],
        });
        send({}, "tool_calls");
      } else {
        send({ role: "assistant", content: "The answer is 42." });
        send({}, "stop");
      }
      res.end("data: [DONE]\n\n");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const { engine, workspace } = await fixture(t);
    config(engine, `http://127.0.0.1:${server.address().port}/v1`);
    const grant = await engine.authorizeWorkspace(workspace);
    const id = engine.create({
      kind: "analysis",
      prompt: "Read hello.ts",
      workspaceId: grant.id,
    });
    const result = await settled(engine, id);
    assert.equal(result.status, "succeeded", result.error);
    assert.match(result.output, /42/);
    assert(result.dshSessionId);
    const health = await engine.dsh.request('/health');
    assert.deepEqual(health.plugins, { codex: true, memory: true });
    assert.equal((await fetch(engine.dsh.url + '/dogo/health')).status, 403);
    assert.equal((await fetch(engine.dsh.url + '/dogo/health', {
      headers: { Authorization: `Bearer ${engine.dsh.token}`, Origin: 'https://evil.example' },
    })).status, 403);
    assert(!JSON.stringify(engine.snapshot()).includes(engine.dsh.token));
    assert.deepEqual(
      requests[0].tools.map((tool) => tool.function.name),
      ["read_workspace_file"],
    );
    assert(
      requests.some((r) => r.messages.some((m) => m.role === 'tool' && JSON.stringify(m.content).includes('answer = 42'))),
      'DSH must send the real tool result, not merely generate a plausible answer',
    );
    assert(requests[0].max_tokens <= 4096);
    await engine.dsh.stop();
    engine.workspaces.clear();
    assert.throws(() => engine.followup(id, 'What was the answer?'), /授权/);
    await engine.authorizeWorkspace(workspace);
    engine.followup(id, "What was the answer?");
    const next = await settled(engine, id);
    assert.equal(next.status, "succeeded", next.error);
    assert(
      requests
        .at(-1)
        .messages.some(
          (m) =>
            m.role === "assistant" && JSON.stringify(m.content).includes("42"),
        ),
    );
    const backendProcess = engine.dsh.child;
    const backendExit = once(backendProcess, 'exit');
    backendProcess.stdin.end();
    await backendExit;
    assert.equal(engine.dsh.snapshot().state, 'failed');
  },
);

test('DSH automatically compacts synthetic multi-turn context through its native preset', { timeout: 90000 }, async (t) => {
  let requests = 0;
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) {}
    requests++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [delta, finish_reason] of [[{ role: 'assistant', content: 'Synthetic summary or answer; no files read.' }, null], [{}, 'stop']])
      res.write(`data: ${JSON.stringify({ id: 'compact-fixture', object: 'chat.completion.chunk', model: 'test-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { engine } = await fixture(t);
  engine.configure({ ...engine.store.settings(), endpoint: `http://127.0.0.1:${server.address().port}/v1`, model: 'test-model', contextWindow: 4096, maxTokens: 512 });
  const prompt = 'Synthetic context only. '.repeat(250);
  const id = engine.create({ kind: 'analysis', prompt });
  for (let turn = 0; turn < 8; turn++) {
    const task = await settled(engine, id);
    assert.equal(task.status, 'succeeded', task.error);
    if (task.logs.some((log) => log.message === 'DSH 会话上下文已压缩')) {
      assert(requests > turn + 1);
      return;
    }
    engine.followup(id, prompt);
  }
  assert.fail('Native DSH compaction did not complete under synthetic context pressure');
});

test(
  "DSH error and output-limit responses remain failures, never successful results",
  { timeout: 90000 },
  async (t) => {
    for (const mode of ["error", "length"])
      await t.test(mode, async (child) => {
        const server = http.createServer(async (req, res) => {
          for await (const _chunk of req) {
            /* drain the request */
          }
          if (mode === "error") {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(
              JSON.stringify({ error: { message: "mock model unavailable" } }),
            );
            return;
          }
          res.writeHead(200, { "content-type": "text/event-stream" });
          for (const [delta, finish_reason] of [
            [{ role: "assistant", content: "partial answer" }, null],
            [{}, "length"],
          ])
            res.write(
              `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
            );
          res.end("data: [DONE]\n\n");
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        child.after(() => {
          server.closeAllConnections();
          server.close();
        });
        const { engine } = await fixture(child);
        config(engine, `http://127.0.0.1:${server.address().port}/v1`);
        const result = await settled(
          engine,
          engine.create({ kind: "analysis", prompt: "hello" }),
        );
        assert.equal(result.status, "failed");
        assert(result.error);
        if (mode === "length") assert.match(result.output, /partial/);
      });
  },
);

test(
  "cancelling a real DSH request aborts a stalled model stream",
  { timeout: 90000 },
  async (t) => {
    let started;
    const ready = new Promise((resolve) => {
      started = resolve;
    });
    const server = http.createServer(async (req, res) => {
      for await (const _chunk of req) {
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      started();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const { engine } = await fixture(t);
    config(engine, `http://127.0.0.1:${server.address().port}/v1`);
    const id = engine.create({ kind: "analysis", prompt: "hello" });
    await ready;
    await engine.cancel(id);
    assert.equal(engine.store.get(id).status, "cancelled");
    assert.equal(engine.active.size, 0);
  },
);
