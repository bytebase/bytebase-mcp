// The directory cold start: no BYTEBASE_URL, no instance. The server must
// still initialize and list its tools, and refuse calls with a clear message.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const entry = path.join(import.meta.dirname, "..", "dist", "index.js");

async function connect(env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("BYTEBASE_"))), ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

test("lists the bundled tools without an instance", async () => {
  const client = await connect({});
  try {
    const { tools } = await client.listTools();
    assert.ok(tools.length > 0, "bundle is empty: run `npm run sync-tools` against a Bytebase instance");
    for (const name of ["query_database", "get_schema", "propose_database_change", "search_api", "call_api"]) {
      assert.ok(tools.some((t) => t.name === name), `missing tool ${name}`);
    }
    for (const t of tools) {
      assert.equal(t.inputSchema?.type, "object", `${t.name} has no object inputSchema`);
      assert.ok(t.description && t.description.length > 0, `${t.name} has no description`);
    }
    assert.ok((client.getInstructions() ?? "").includes("Bytebase"), "instructions are missing");
  } finally {
    await client.close();
  }
});

test("refuses a tool call without an instance", async () => {
  const client = await connect({});
  try {
    const result = await client.callTool({ name: "get_schema", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /BYTEBASE_URL/);
  } finally {
    await client.close();
  }
});

test("lists the bundled tools when the instance is unreachable", async () => {
  const client = await connect({ BYTEBASE_URL: "http://127.0.0.1:9", BYTEBASE_MCP_HOME: path.join(import.meta.dirname, ".tmp-home"), BYTEBASE_MCP_NO_BROWSER: "1" });
  try {
    const { tools } = await client.listTools();
    assert.ok(tools.length > 0);
    const result = await client.callTool({ name: "get_schema", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /cannot connect/);
  } finally {
    await client.close();
  }
});
