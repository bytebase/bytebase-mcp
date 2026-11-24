import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, mcpEndpoint, parseBytebaseUrl } from "../dist/config.js";

test("parseBytebaseUrl normalizes trailing slash and /mcp", () => {
  for (const raw of ["https://bb.example.com", "https://bb.example.com/", "https://bb.example.com/mcp", "https://bb.example.com/mcp/", "bb.example.com"]) {
    assert.equal(mcpEndpoint(parseBytebaseUrl(raw)).toString(), "https://bb.example.com/mcp", raw);
  }
  assert.equal(mcpEndpoint(parseBytebaseUrl("http://localhost:8080")).toString(), "http://localhost:8080/mcp");
  assert.equal(mcpEndpoint(parseBytebaseUrl("https://host/bytebase/")).toString(), "https://host/bytebase/mcp");
});

test("loadConfig reads the environment", () => {
  const cfg = loadConfig({ BYTEBASE_URL: "https://bb.example.com/", BYTEBASE_MCP_HOME: "/tmp/x", BYTEBASE_MCP_CALLBACK_PORT: "5000", BYTEBASE_MCP_NO_BROWSER: "1" });
  assert.equal(cfg.url?.toString(), "https://bb.example.com/");
  assert.equal(cfg.home, "/tmp/x");
  assert.equal(cfg.callbackPort, 5000);
  assert.equal(cfg.openBrowser, false);
  assert.equal(loadConfig({}).url, undefined);
  assert.equal(loadConfig({}).openBrowser, true);
  assert.throws(() => loadConfig({ BYTEBASE_MCP_CALLBACK_PORT: "abc" }));
});

test("startupRetryDelaysMs: ten waits, doubling from 1s to a 5-minute ceiling, about 14 minutes in all", async () => {
  const { startupRetryDelaysMs } = await import("../dist/retry.js");
  assert.deepEqual(startupRetryDelaysMs(), [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000]);
});

test("loadConfig keeps sign-ins in ~/.bytebase-mcp, not under XDG config", async () => {
  const os = await import("node:os");
  const path = await import("node:path");
  assert.equal(loadConfig({}).home, path.join(os.homedir(), ".bytebase-mcp"));
  assert.equal(loadConfig({ XDG_CONFIG_HOME: "/tmp/xdg" }).home, path.join(os.homedir(), ".bytebase-mcp"));
  assert.equal(loadConfig({ BYTEBASE_MCP_HOME: "/tmp/elsewhere" }).home, "/tmp/elsewhere");
});

test("server.json fits the MCP Registry schema's length limits", async () => {
  const { readFile } = await import("node:fs/promises");
  const server = JSON.parse(await readFile(new URL("../server.json", import.meta.url), "utf8"));
  // maxLength in https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json (ServerDetail).
  const limits = { name: 200, title: 100, description: 100, version: 255 };
  for (const [field, max] of Object.entries(limits)) {
    assert.ok(server[field].length <= max, `${field} is ${server[field].length} characters; the registry allows ${max}`);
  }
});
