// Sessions, sign-in and the token lock (docs/DESIGN.md D5–D7, D9, S3, S4),
// driven over stdio against a fake Bytebase. The test plays the browser by
// following the sign-in URL the proxy prints.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { completeSignIn, startFakeBytebase, SESSION_INSTRUCTIONS } from "./fake-upstream.mjs";

const entry = path.join(import.meta.dirname, "..", "dist", "index.js");
let nextPort = 52100 + Math.floor(Math.random() * 500);

function freshHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bytebase-mcp-test-"));
}

/** Starts a proxy as `clientName` and collects the sign-in URLs it prints. */
async function connect({ url, home, port, clientName = "sessions-client", title }) {
  // Anything not given is a fresh client of a fresh fake instance.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("BYTEBASE_"))),
      BYTEBASE_URL: url,
      BYTEBASE_MCP_HOME: home,
      BYTEBASE_MCP_CALLBACK_PORT: String(port),
      BYTEBASE_MCP_NO_BROWSER: "1",
    },
    stderr: "pipe",
  });
  const signIns = [];
  const waiters = [];
  const client = new Client({ name: clientName, title, version: "1.2.3" }, { capabilities: {} });
  const started = client.connect(transport);
  transport.stderr.setEncoding("utf8");
  transport.stderr.on("data", (text) => {
    for (const match of text.matchAll(/https?:\/\/\S+\/authorize\?\S+/g)) {
      const waiter = waiters.shift();
      if (waiter) waiter(match[0]);
      else signIns.push(match[0]);
    }
  });
  await started;
  return {
    client,
    signIns,
    /** Resolves with the next sign-in URL the proxy prints. */
    nextSignIn: () => (signIns.length > 0 ? Promise.resolve(signIns.shift()) : new Promise((resolve) => waiters.push(resolve))),
  };
}

test("D5/D6: the first tool call signs in as the real client, then runs", async (t) => {
  const bytebase = await startFakeBytebase();
  t.after(() => bytebase.close());
  const proxy = await connect({ url: bytebase.url, home: freshHome(), port: nextPort++, title: "Sessions Client" });
  t.after(() => proxy.client.close());

  const call = proxy.client.callTool({ name: "query_database", arguments: {} });
  await completeSignIn(await proxy.nextSignIn());
  const result = await call;
  assert.equal(result.content[0].text, "ran query_database");

  assert.deepEqual(
    bytebase.registrations.map((r) => r.client_name),
    ["Sessions Client via Bytebase MCP"],
  );
  assert.equal(bytebase.initializes.at(-1).clientInfo.name, "sessions-client", "the client's own clientInfo reaches the instance");
});

/** Signs one proxy in and closes it, leaving a stored sign-in for the client in `home`. */
async function signInOnce(bytebase, home, port) {
  const proxy = await connect({ url: bytebase.url, home, port });
  const call = proxy.client.callTool({ name: "get_schema", arguments: {} });
  await completeSignIn(await proxy.nextSignIn());
  await call;
  await proxy.client.close();
}

test("S2: a stored sign-in opens the session at initialize and passes its instructions through", async (t) => {
  const bytebase = await startFakeBytebase();
  t.after(() => bytebase.close());
  const home = freshHome();
  const port = nextPort++;
  await signInOnce(bytebase, home, port);

  const proxy = await connect({ url: bytebase.url, home, port });
  t.after(() => proxy.client.close());
  assert.equal(proxy.client.getInstructions(), SESSION_INSTRUCTIONS, "the instance's own text, account line included");
  const result = await proxy.client.callTool({ name: "query_database", arguments: {} });
  assert.equal(result.content[0].text, "ran query_database");
  assert.equal(bytebase.registrations.length, 1, "the stored registration is reused");
  assert.equal(proxy.signIns.length, 0);
});

test("D7: two processes refreshing at once send one refresh", async (t) => {
  const bytebase = await startFakeBytebase();
  t.after(() => bytebase.close());
  const home = freshHome();
  const port = nextPort++;
  await signInOnce(bytebase, home, port);

  const first = await connect({ url: bytebase.url, home, port });
  const second = await connect({ url: bytebase.url, home, port });
  t.after(() => Promise.all([first.client.close(), second.client.close()]));
  bytebase.expireAccessTokens();
  const results = await Promise.all([
    first.client.callTool({ name: "query_database", arguments: {} }),
    second.client.callTool({ name: "query_database", arguments: {} }),
  ]);
  assert.deepEqual(
    results.map((r) => r.content[0].text),
    ["ran query_database", "ran query_database"],
  );
  assert.equal(bytebase.refreshes, 1, "the second process used the tokens the first one saved");
});

test("D7: two processes signing in for the first time register once and sign in once", async (t) => {
  const bytebase = await startFakeBytebase();
  t.after(() => bytebase.close());
  const home = freshHome();
  const port = nextPort++;
  const first = await connect({ url: bytebase.url, home, port });
  const second = await connect({ url: bytebase.url, home, port });
  t.after(() => Promise.all([first.client.close(), second.client.close()]));

  const calls = [first, second].map((proxy) => proxy.client.callTool({ name: "query_database", arguments: {} }));
  const url = await Promise.race([first.nextSignIn(), second.nextSignIn()]);
  await completeSignIn(url);
  const results = await Promise.all(calls);
  assert.deepEqual(
    results.map((r) => r.content[0].text),
    ["ran query_database", "ran query_database"],
  );
  assert.equal(bytebase.registrations.length, 1);
  assert.equal(first.signIns.length + second.signIns.length, 0, "no sign-in URL was printed besides the one used");
});

test("S3: a configured proxy signs in after initialize and announces its instance's tools", async (t) => {
  const bytebase = await startFakeBytebase();
  t.after(() => bytebase.close());
  const proxy = await connect({ url: bytebase.url, home: freshHome(), port: nextPort++ });
  t.after(() => proxy.client.close());
  assert.deepEqual((await proxy.client.listTools()).tools, []);

  const announced = new Promise((resolve) => proxy.client.setNotificationHandler(ToolListChangedNotificationSchema, resolve));
  await completeSignIn(await proxy.nextSignIn());
  await announced;
  assert.deepEqual(
    (await proxy.client.listTools()).tools.map((tool) => tool.name),
    ["query_database", "get_schema"],
  );
});

test("D5: a call cancelled while sign-in is pending is never sent", async (t) => {
  const bytebase = await startFakeBytebase();
  t.after(() => bytebase.close());
  const proxy = await connect({ url: bytebase.url, home: freshHome(), port: nextPort++ });
  t.after(() => proxy.client.close());

  const cancel = new AbortController();
  const call = proxy.client.callTool({ name: "query_database", arguments: {} }, undefined, { signal: cancel.signal });
  const url = await proxy.nextSignIn();
  cancel.abort();
  await assert.rejects(call);
  await completeSignIn(url);
  const later = await proxy.client.callTool({ name: "get_schema", arguments: {} });
  assert.equal(later.content[0].text, "ran get_schema");
  assert.deepEqual(
    bytebase.toolCalls.map((c) => c.name),
    ["get_schema"],
    "the cancelled query_database never reached the instance",
  );
});

test("D9: status shows the stored sign-ins without signing in, and logout forgets them", async (t) => {
  const bytebase = await startFakeBytebase();
  t.after(() => bytebase.close());
  const home = freshHome();
  await signInOnce(bytebase, home, nextPort++);
  const run = async (command) => {
    const { execFile } = await import("node:child_process");
    return new Promise((resolve, reject) =>
      execFile(process.execPath, [entry, command, "--url", bytebase.url], { env: { ...process.env, BYTEBASE_MCP_HOME: home } }, (err, stdout) =>
        err ? reject(err) : resolve(stdout),
      ),
    );
  };
  const status = JSON.parse(await run("status"));
  assert.deepEqual(status.signIns, ["sessions-client"]);
  assert.equal(status.bytebase, true);
  const stored = JSON.parse(fs.readFileSync(path.join(status.signInDirectory, "sessions-client.json"), "utf8"));
  await run("logout");
  assert.deepEqual(JSON.parse(await run("status")).signIns, []);
  assert.deepEqual(
    bytebase.revocations,
    [{ token: stored.tokens.refresh_token, clientId: stored.clientInformation.client_id }],
    "logout revokes the refresh token at Bytebase before deleting it",
  );
});

test("D5: a stored sign-in refused after the initialize bound still leads to a browser sign-in", async (t) => {
  const bytebase = await startFakeBytebase();
  t.after(() => bytebase.close());
  const home = freshHome();
  const port = nextPort++;
  await signInOnce(bytebase, home, port);
  bytebase.revokeAllTokens();
  bytebase.refreshDelayMs = 6000;

  const proxy = await connect({ url: bytebase.url, home, port });
  t.after(() => proxy.client.close());
  assert.match(proxy.client.getInstructions() ?? "", /sign in/i, "initialize did not wait past its bound");
  const announced = new Promise((resolve) => proxy.client.setNotificationHandler(ToolListChangedNotificationSchema, resolve));
  await completeSignIn(await proxy.nextSignIn());
  await announced;
  assert.deepEqual(
    (await proxy.client.listTools()).tools.map((tool) => tool.name),
    ["query_database", "get_schema"],
  );
});

/** Lists every tool, following the proxy's cursors. */
async function listAll(client) {
  const names = [];
  let cursor;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    names.push(...page.tools.map((tool) => tool.name));
    cursor = page.nextCursor;
  } while (cursor);
  return names;
}

test("D2: the session's pages reach the client, cursors passed through", async (t) => {
  const bytebase = await startFakeBytebase({ pageSize: 1 });
  t.after(() => bytebase.close());
  const home = freshHome();
  const port = nextPort++;
  await signInOnce(bytebase, home, port);

  const proxy = await connect({ url: bytebase.url, home, port });
  t.after(() => proxy.client.close());
  const first = await proxy.client.listTools();
  assert.equal(first.tools.length, 1, "the instance's page size, not the proxy's");
  assert.ok(first.nextCursor);
  assert.deepEqual(await listAll(proxy.client), ["query_database", "get_schema"]);
});

test("D5: tools/list after the instance ended the session reopens it with the stored sign-in", async (t) => {
  const bytebase = await startFakeBytebase();
  t.after(() => bytebase.close());
  const home = freshHome();
  const port = nextPort++;
  await signInOnce(bytebase, home, port);

  const proxy = await connect({ url: bytebase.url, home, port });
  t.after(() => proxy.client.close());
  assert.equal((await proxy.client.listTools()).tools.length, 2);
  bytebase.expireSessions();
  assert.deepEqual((await proxy.client.listTools()).tools.map((tool) => tool.name), ["query_database", "get_schema"]);
  assert.equal(proxy.signIns.length, 0, "no new sign-in");
});

test("rule 4: a tools/list the proxy cannot answer is a JSON-RPC error with the reason", async (t) => {
  const bytebase = await startFakeBytebase();
  const home = freshHome();
  const port = nextPort++;
  await signInOnce(bytebase, home, port);

  const proxy = await connect({ url: bytebase.url, home, port });
  t.after(() => proxy.client.close());
  assert.equal((await proxy.client.listTools()).tools.length, 2);
  await bytebase.close();
  await assert.rejects(proxy.client.listTools(), (err) => err.code !== undefined && /connect|reach|fetch/i.test(err.message));
});

test("D5: an instance unreachable at startup is retried, then signs in and announces its tools", async (t) => {
  const port = 53400 + Math.floor(Math.random() * 300);
  const url = `http://127.0.0.1:${port}`;
  const proxy = await connect({ url, home: freshHome(), port: nextPort++ });
  t.after(() => proxy.client.close());
  assert.match(proxy.client.getInstructions() ?? "", /could not be reached/);
  // Long enough for the first opening to fail, so the session comes from a retry.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const bytebase = await startFakeBytebase({ port });
  t.after(() => bytebase.close());
  const announced = new Promise((resolve) => proxy.client.setNotificationHandler(ToolListChangedNotificationSchema, resolve));
  await completeSignIn(await proxy.nextSignIn());
  await announced;
  assert.deepEqual((await proxy.client.listTools()).tools.map((tool) => tool.name), ["query_database", "get_schema"]);
});

test("D5: after an outage, tools/list reopens the session with the stored sign-in", async (t) => {
  const bytebase = await startFakeBytebase();
  t.after(() => bytebase.close());
  const home = freshHome();
  const port = nextPort++;
  await signInOnce(bytebase, home, port);

  const proxy = await connect({ url: bytebase.url, home, port });
  t.after(() => proxy.client.close());
  assert.equal((await proxy.client.listTools()).tools.length, 2);
  await bytebase.goDown();
  const failed = await proxy.client.callTool({ name: "query_database", arguments: {} });
  assert.equal(failed.isError, true, "a call during the outage fails and drops the session");
  await assert.rejects(proxy.client.listTools(), "during the outage the client gets an error, not an empty list");
  await bytebase.comeBack();
  assert.deepEqual((await proxy.client.listTools()).tools.map((tool) => tool.name), ["query_database", "get_schema"]);
  assert.equal(proxy.signIns.length, 0, "no new sign-in");
});

test("D2: tools/list never waits on a sign-in in progress", async (t) => {
  const bytebase = await startFakeBytebase();
  t.after(() => bytebase.close());
  const home = freshHome();
  const port = nextPort++;
  await signInOnce(bytebase, home, port);

  // Another live process holds this sign-in's lock, so the proxy's opening waits.
  const instance = new URL(bytebase.url);
  const lock = path.join(home, `${instance.hostname}_${instance.port}`, "sessions-client.json.lock");
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "pid"), String(process.pid));
  const proxy = await connect({ url: bytebase.url, home, port });
  t.after(() => proxy.client.close());

  const started = Date.now();
  assert.deepEqual((await proxy.client.listTools()).tools, [], "no session yet, so nothing to list");
  assert.ok(Date.now() - started < 3000, "answered without waiting for the opening");

  const announced = new Promise((resolve) => proxy.client.setNotificationHandler(ToolListChangedNotificationSchema, resolve));
  fs.rmSync(lock, { recursive: true, force: true });
  await announced;
  assert.equal((await proxy.client.listTools()).tools.length, 2);
});

test("D5: a reopen held up by another process's lock answers within the bound", async (t) => {
  const bytebase = await startFakeBytebase();
  t.after(() => bytebase.close());
  const home = freshHome();
  const port = nextPort++;
  await signInOnce(bytebase, home, port);
  const proxy = await connect({ url: bytebase.url, home, port });
  t.after(() => proxy.client.close());
  assert.equal((await proxy.client.listTools()).tools.length, 2);

  await bytebase.goDown();
  await proxy.client.callTool({ name: "query_database", arguments: {} });
  await bytebase.comeBack();
  const instance = new URL(bytebase.url);
  const lock = path.join(home, `${instance.hostname}_${instance.port}`, "sessions-client.json.lock");
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "pid"), String(process.pid));

  const started = Date.now();
  await assert.rejects(proxy.client.listTools(), /still connecting/);
  assert.ok(Date.now() - started < 15000, "bounded, not waiting on the lock");
  const listsBefore = bytebase.toolLists.length;
  const announced = new Promise((resolve) => proxy.client.setNotificationHandler(ToolListChangedNotificationSchema, resolve));
  fs.rmSync(lock, { recursive: true, force: true });
  await announced;
  assert.equal((await proxy.client.listTools()).tools.length, 2, "the client re-lists when told the reconnect finished");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(bytebase.toolLists.length - listsBefore, 1, "the timed-out request was never sent");
});

test("D2: a slow tools/list on an open session is not announced as a changed list", async (t) => {
  const bytebase = await startFakeBytebase();
  t.after(() => bytebase.close());
  const home = freshHome();
  const port = nextPort++;
  await signInOnce(bytebase, home, port);
  const proxy = await connect({ url: bytebase.url, home, port });
  t.after(() => proxy.client.close());
  assert.equal((await proxy.client.listTools()).tools.length, 2);

  let announcements = 0;
  proxy.client.setNotificationHandler(ToolListChangedNotificationSchema, () => announcements++);
  bytebase.listDelayMs = 11000;
  await assert.rejects(proxy.client.listTools(), /still connecting/);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(announcements, 0, "a slow answer on an open session changes nothing, so it is not announced");
});

test("D9: logout deletes the sign-ins even when revocation stalls", async (t) => {
  const bytebase = await startFakeBytebase();
  t.after(() => bytebase.close());
  const home = freshHome();
  await signInOnce(bytebase, home, nextPort++);
  bytebase.revokeStalls = true;
  const { execFile } = await import("node:child_process");
  const run = (command) =>
    new Promise((resolve, reject) =>
      execFile(process.execPath, [entry, command, "--url", bytebase.url], { env: { ...process.env, BYTEBASE_MCP_HOME: home }, timeout: 20000 }, (err, stdout) =>
        err ? reject(err) : resolve(stdout),
      ),
    );
  const started = Date.now();
  await run("logout");
  assert.ok(Date.now() - started < 15000, "logout did not wait on the stalled revocation");
  assert.deepEqual(JSON.parse(await run("status")).signIns, []);
});

test("D5: after the grant is revoked mid-session (reauthorize), the next call signs in again", async (t) => {
  const bytebase = await startFakeBytebase();
  t.after(() => bytebase.close());
  const home = freshHome();
  const port = nextPort++;
  await signInOnce(bytebase, home, port);
  const proxy = await connect({ url: bytebase.url, home, port });
  t.after(() => proxy.client.close());
  assert.equal((await proxy.client.callTool({ name: "get_schema", arguments: {} })).content[0].text, "ran get_schema");

  bytebase.revokeAllTokens();
  const call = proxy.client.callTool({ name: "query_database", arguments: {} });
  await completeSignIn(await proxy.nextSignIn());
  const result = await call;
  assert.equal(result.content[0].text, "ran query_database", "the call ran after the new sign-in");
});

test("D5: a call in flight when the session is replaced still returns its result", async (t) => {
  const bytebase = await startFakeBytebase();
  t.after(() => bytebase.close());
  const home = freshHome();
  const port = nextPort++;
  await signInOnce(bytebase, home, port);
  const proxy = await connect({ url: bytebase.url, home, port });
  t.after(() => proxy.client.close());
  assert.equal((await proxy.client.callTool({ name: "get_schema", arguments: {} })).content[0].text, "ran get_schema");

  bytebase.callDelayMs = 1500;
  const accepted = proxy.client.callTool({ name: "query_database", arguments: {} });
  await new Promise((resolve) => setTimeout(resolve, 300)); // Bytebase has accepted it
  bytebase.revokeAllTokens();
  const next = proxy.client.callTool({ name: "get_schema", arguments: {} });
  await completeSignIn(await proxy.nextSignIn());
  assert.equal((await next).content[0].text, "ran get_schema");
  const result = await accepted;
  assert.equal(result.isError, undefined, "the accepted call was not cut off");
  assert.equal(result.content[0].text, "ran query_database");
  assert.equal(bytebase.toolCalls.filter((c) => c.name === "query_database").length, 1, "and was not sent twice");
});
