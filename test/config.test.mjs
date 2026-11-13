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
