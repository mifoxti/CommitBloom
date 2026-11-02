import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { resolve } from "node:path";
import { createApp } from "../server.mjs";

const repository = resolve("fixture-repository");
const head = "a".repeat(40);
const remoteHead = "b".repeat(40);
const selected = "c".repeat(40);

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function fixture(
  t,
  overrides = {},
  picker = async () => ({ path: repository }),
) {
  const calls = { inspect: [], commit: [], refresh: [], plan: [], apply: [] };
  const state = {
    path: repository,
    currentBranch: "feature/one",
    head,
    remote: "origin",
    commits: [],
  };
  const engine = {
    async inspectRepository(input) {
      calls.inspect.push(input);
      return state;
    },
    async getCommit(input) {
      calls.commit.push(input);
      return { oid: input.oid, message: "Original subject\n\nOriginal body\n" };
    },
    async refreshRemote(input) {
      calls.refresh.push(input);
      return { ...state, remoteCheckedAt: "2026-11-02T09:00:00.000Z", remoteBranchExists: true };
    },
    async planChange(input) {
      calls.plan.push(input);
      return {
        expectedHead: head,
        expectedRemoteHead: remoteHead,
        affectedCount: 1,
        changed: true,
        push: input.push,
      };
    },
    async applyChange(input) {
      calls.apply.push(input);
      return {
        oldOid: input.oid,
        newOid: selected,
        head: selected,
        backupRef: "refs/commit-bloom/backups/example",
        pushed: input.push,
      };
    },
    ...overrides,
  };
  const { server, token } = createApp({
    defaultPath: repository,
    engine,
    picker,
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolveClose) => server.close(resolveClose));
  });
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;

  async function request(
    path,
    {
      method = "GET",
      data,
      raw,
      headers = {},
      authorized = true,
      withOrigin = true,
    } = {},
  ) {
    const body =
      raw === undefined
        ? data === undefined
          ? undefined
          : JSON.stringify(data)
        : raw;
    const requestHeaders = {};
    if (method === "POST") {
      if (authorized) requestHeaders["X-CommitBloom-Token"] = token;
      if (withOrigin) requestHeaders.Origin = origin;
      requestHeaders["Content-Type"] = "application/json";
    }
    if (body !== undefined)
      requestHeaders["Content-Length"] = Buffer.byteLength(body);
    Object.assign(requestHeaders, headers);
    return new Promise((resolveResponse, reject) => {
      const outgoing = httpRequest(
        { hostname: "127.0.0.1", port, path, method, headers: requestHeaders },
        (incoming) => {
          const chunks = [];
          incoming.on("data", (chunk) => chunks.push(chunk));
          incoming.on("error", reject);
          incoming.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            const json =
              String(incoming.headers["content-type"]).includes(
                "application/json",
              ) && text
                ? JSON.parse(text)
                : undefined;
            resolveResponse({
              status: incoming.statusCode,
              headers: incoming.headers,
              text,
              json,
            });
          });
        },
      );
      outgoing.on("error", reject);
      if (body !== undefined) outgoing.write(body);
      outgoing.end();
    });
  }
  const preview = (extra = {}) =>
    request("/api/preview", {
      method: "POST",
      data: {
        path: repository,
        branch: "feature/one",
        remote: "origin",
        oid: selected,
        message: "Reviewed message",
        useCurrentDate: true,
        push: false,
        ...extra,
      },
    });
  return { request, preview, calls, state, token, port, origin };
}

test("serves local session and static UI with restrictive browser headers", async (t) => {
  const app = await fixture(t);
  const session = await app.request("/api/session");
  assert.equal(session.status, 200);
  assert.equal(session.json.defaultPath, repository);
  assert.equal(session.json.token, app.token);
  assert.match(session.json.token, /^[a-f0-9]{64}$/);
  assert.equal(session.headers["cache-control"], "no-store");
  assert.equal(session.headers["x-frame-options"], "DENY");
  assert.match(
    session.headers["content-security-policy"],
    /connect-src 'self'/,
  );
  assert.equal(session.headers["access-control-allow-origin"], undefined);
  for (const [path, mime] of [
    ["/", "text/html"],
    ["/styles.css", "text/css"],
    ["/app.js", "text/javascript"],
  ]) {
    const response = await app.request(path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers["content-type"], new RegExp(mime));
    assert.ok(response.text.length > 10);
  }
  assert.equal((await app.request("/favicon.ico")).status, 204);
});

test("rejects missing or wrong token and missing or foreign Origin before engine calls", async (t) => {
  const app = await fixture(t);
  const data = { path: repository };
  for (const options of [
    { authorized: false },
    { headers: { "X-CommitBloom-Token": "wrong" } },
    { withOrigin: false },
    { headers: { Origin: "https://untrusted.example" } },
  ]) {
    const response = await app.request("/api/repository", {
      method: "POST",
      data,
      ...options,
    });
    assert.equal(response.status, 403);
  }
  assert.equal(app.calls.inspect.length, 0);
  assert.equal(
    (
      await app.request("/api/session", {
        headers: { Origin: "https://untrusted.example" },
      })
    ).status,
    403,
  );
});

test("rejects Host rebinding and unsupported methods or non-allowlisted static files", async (t) => {
  const app = await fixture(t);
  assert.equal(
    (
      await app.request("/api/session", {
        headers: { Host: `attacker.example:${app.port}` },
      })
    ).status,
    403,
  );
  assert.equal(
    (await app.request("/api/session", { method: "OPTIONS" })).status,
    405,
  );
  assert.equal(
    (await app.request("/api/session", { method: "DELETE" })).status,
    405,
  );
  for (const path of [
    "/server.mjs",
    "/../server.mjs",
    "/%2e%2e/server.mjs",
    "/.git/config",
    "/missing",
  ]) {
    assert.equal((await app.request(path)).status, 404, path);
  }
  assert.equal(
    (await app.request("/api/unknown", { method: "POST", data: {} })).status,
    404,
  );
});

test("rejects malformed payloads, unsupported content type, and non-absolute repository path", async (t) => {
  const app = await fixture(t);
  for (const raw of ["{invalid", "null", "[]", '"text"', "12"]) {
    assert.equal(
      (await app.request("/api/repository", { method: "POST", raw })).status,
      400,
      raw,
    );
  }
  assert.equal(
    (
      await app.request("/api/repository", {
        method: "POST",
        data: {},
        headers: { "Content-Type": "text/plain" },
      })
    ).status,
    415,
  );
  for (const path of ["", "relative/folder", null, 42]) {
    assert.equal(
      (await app.request("/api/repository", { method: "POST", data: { path } }))
        .status,
      400,
    );
  }
  assert.equal(app.calls.inspect.length, 0);
});

test("forwards repository details, refresh, and native folder picker only on requested routes", async (t) => {
  const picked = [];
  const app = await fixture(t, {}, async (initialPath) => {
    picked.push(initialPath);
    return { path: repository };
  });
  assert.equal(
    (
      await app.request("/api/repository", {
        method: "POST",
        data: { path: `  ${repository}  `, remote: "origin" },
      })
    ).status,
    200,
  );
  assert.deepEqual(app.calls.inspect[0], {
    path: repository,
    remote: "origin",
  });
  await app.request("/api/commit", {
    method: "POST",
    data: { path: repository, oid: selected },
  });
  assert.deepEqual(app.calls.commit[0], { path: repository, oid: selected });
  const refreshed = await app.request("/api/refresh", {
    method: "POST",
    data: { path: repository, remote: "origin" },
  });
  assert.deepEqual(app.calls.refresh[0], {
    path: repository,
    remote: "origin",
  });
  assert.equal(refreshed.json.remoteCheckedAt, "2026-11-02T09:00:00.000Z");
  assert.equal(refreshed.json.remoteBranchExists, true);
  const response = await app.request("/api/pick-folder", {
    method: "POST",
    data: {},
  });
  assert.deepEqual(response.json, { path: repository });
  assert.deepEqual(picked, [repository]);
});

test("rejects a request body larger than 128 KiB before engine execution", async (t) => {
  const app = await fixture(t);
  const response = await app.request("/api/repository", {
    method: "POST",
    data: { path: repository, padding: "x".repeat(129 * 1024) },
  });
  assert.equal(response.status, 413);
  assert.equal(app.calls.inspect.length, 0);
});

test("apply uses the reviewed immutable request and server snapshots instead of client overrides", async (t) => {
  const app = await fixture(t);
  const preview = await app.preview();
  assert.equal(preview.status, 200);
  const result = await app.request("/api/apply", {
    method: "POST",
    data: {
      planId: preview.json.planId,
      path: "Z:\\spoofed",
      branch: "other",
      remote: "attacker",
      oid: "d".repeat(40),
      message: "Unreviewed",
      useCurrentDate: false,
      push: true,
      expectedHead: "e".repeat(40),
      expectedRemoteHead: "f".repeat(40),
      allowPublishedRewrite: true,
    },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(app.calls.apply[0], {
    path: repository,
    branch: "feature/one",
    remote: "origin",
    oid: selected,
    message: "Reviewed message",
    useCurrentDate: true,
    push: false,
    expectedHead: head,
    expectedRemoteHead: remoteHead,
    allowPublishedRewrite: true,
  });
  assert.equal(result.json.result.newOid, selected);
  assert.deepEqual(result.json.state, app.state);
});

test("apply preserves the reviewed custom date even if the client overrides it", async (t) => {
  const app = await fixture(t);
  const customDate = "2024-02-29T15:16:17+03:00";
  const preview = await app.preview({ useCurrentDate: false, customDate });
  assert.equal(preview.status, 200);
  assert.equal(app.calls.plan[0].customDate, customDate);
  const response = await app.request("/api/apply", {
    method: "POST",
    data: { planId: preview.json.planId, customDate: "2030-01-01T00:00:00Z", useCurrentDate: true },
  });
  assert.equal(response.status, 200);
  assert.equal(app.calls.apply[0].customDate, customDate);
  assert.equal(app.calls.apply[0].useCurrentDate, false);
});

test("push-only preview ignores unsaved message and date edits", async (t) => {
  const app = await fixture(t);
  const response = await app.preview({
    mode: "push",
    message: "Do not save this",
    useCurrentDate: true,
    customDate: "invalid unsaved date",
    push: false,
  });
  assert.equal(response.status, 200);
  assert.equal(
    app.calls.plan[0].message,
    "Original subject\n\nOriginal body\n",
  );
  assert.equal(app.calls.plan[0].useCurrentDate, false);
  assert.equal(app.calls.plan[0].customDate, undefined);
  assert.equal(app.calls.plan[0].push, true);
  assert.deepEqual(app.calls.commit[0], { path: repository, oid: selected });
});

test("rejects missing, expired, and consumed plans without applying twice", async (t) => {
  const app = await fixture(t);
  assert.equal(
    (
      await app.request("/api/apply", {
        method: "POST",
        data: { planId: "missing" },
      })
    ).status,
    409,
  );
  const first = (await app.preview()).json;
  assert.equal(
    (
      await app.request("/api/apply", {
        method: "POST",
        data: { planId: first.planId },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await app.request("/api/apply", {
        method: "POST",
        data: { planId: first.planId },
      })
    ).status,
    409,
  );
  const second = (await app.preview()).json;
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 11 * 60_000);
  assert.equal(
    (
      await app.request("/api/apply", {
        method: "POST",
        data: { planId: second.planId },
      })
    ).status,
    409,
  );
  assert.equal(app.calls.apply.length, 1);
});

test("serializes apply requests while a rewrite or push is running", async (t) => {
  const gate = deferred();
  const started = deferred();
  let count = 0;
  const app = await fixture(t, {
    async applyChange() {
      count += 1;
      started.resolve();
      await gate.promise;
      return { pushed: true };
    },
  });
  const first = (await app.preview()).json;
  const second = (await app.preview()).json;
  const ongoing = app.request("/api/apply", {
    method: "POST",
    data: { planId: first.planId },
  });
  await started.promise;
  const blocked = await app.request("/api/apply", {
    method: "POST",
    data: { planId: second.planId },
  });
  assert.equal(blocked.status, 409);
  assert.equal(count, 1);
  gate.resolve();
  assert.equal((await ongoing).status, 200);
  assert.equal(
    (
      await app.request("/api/apply", {
        method: "POST",
        data: { planId: second.planId },
      })
    ).status,
    200,
  );
  assert.equal(count, 2);
});

test("prevents multiple native picker windows until the first one closes", async (t) => {
  const gate = deferred();
  const opened = deferred();
  let count = 0;
  const app = await fixture(t, {}, async () => {
    count += 1;
    opened.resolve();
    await gate.promise;
    return { cancelled: true };
  });
  const pending = app.request("/api/pick-folder", { method: "POST", data: {} });
  await opened.promise;
  assert.equal(
    (await app.request("/api/pick-folder", { method: "POST", data: {} }))
      .status,
    409,
  );
  assert.equal(count, 1);
  gate.resolve();
  assert.deepEqual((await pending).json, { cancelled: true });
});

test("redacts remote URL credentials from engine errors", async (t) => {
  const app = await fixture(t, {
    async inspectRepository() {
      throw new Error(
        "Could not access https://user:super-secret@git.example/team/repo.git or https://access-token@git.example/repo",
      );
    },
  });
  const response = await app.request("/api/repository", {
    method: "POST",
    data: { path: repository },
  });
  assert.equal(response.status, 400);
  assert.match(response.json.error, /https:\/\/\*\*\*@git\.example/);
  assert.doesNotMatch(response.text, /super-secret|access-token|user:/);
});

test("returns the successful mutation result even if subsequent state refresh fails", async (t) => {
  const app = await fixture(t, {
    async inspectRepository() {
      throw new Error("State reload unavailable");
    },
  });
  const plan = (await app.preview()).json;
  const response = await app.request("/api/apply", {
    method: "POST",
    data: { planId: plan.planId },
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.result.newOid, selected);
  assert.equal(response.json.stateError, "State reload unavailable");
  assert.equal(response.json.state, undefined);
  assert.equal(app.calls.apply.length, 1);
});
