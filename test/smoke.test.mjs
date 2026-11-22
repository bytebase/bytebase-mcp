// The proxy's states without a session (docs/DESIGN.md, States), driven the way
// an MCP client drives it: spawn the built server over stdio, against a fake
// Bytebase.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { CATALOG, startFakeBytebase } from "./fake-upstream.mjs";

const entry = path.join(import.meta.dirname, "..", "dist", "index.js");

async function connect(env, { form = false } = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("BYTEBASE_"))),
      BYTEBASE_MCP_HOME: path.join(import.meta.dirname, ".tmp-home"),
      BYTEBASE_MCP_NO_BROWSER: "1",
      ...env,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "smoke", version: "0.0.0" }, { capabilities: form ? { elicitation: { form: {} } } : {} });
  await client.connect(transport);
  return client;
}

test("S1: with no URL, lists the public catalog and says no instance is connected", async (t) => {
  const cloud = await startFakeBytebase();
  t.after(() => cloud.close());
  const client = await connect({ BYTEBASE_MCP_PUBLIC_CATALOG_URL: `${cloud.url}/mcp/catalog` });
  t.after(() => client.close());

  const instructions = client.getInstructions() ?? "";
  assert.match(instructions, /BYTEBASE_URL/);
  assert.ok(instructions.indexOf("BYTEBASE_URL") < instructions.indexOf(CATALOG.instructions), "the note comes first");
  assert.ok(instructions.includes(CATALOG.instructionsWithoutForm), "a client without forms gets the form paragraph");

  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name),
    CATALOG.tools.map((tool) => tool.name),
  );

  const result = await client.callTool({ name: "get_schema", arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /BYTEBASE_URL/);
  assert.deepEqual(cloud.requests, ["GET /mcp/catalog"], "the unconfigured proxy reads the catalog and nothing else");
});

test("S1: with no URL and Cloud unreadable, lists nothing and shows the note alone", async (t) => {
  const client = await connect({ BYTEBASE_MCP_PUBLIC_CATALOG_URL: "http://127.0.0.1:9/mcp/catalog" });
  t.after(() => client.close());
  const instructions = client.getInstructions() ?? "";
  assert.match(instructions, /BYTEBASE_URL/);
  assert.ok(!instructions.includes("confirmation form"), "no tool can run, so no form sentence");
  assert.deepEqual((await client.listTools()).tools, []);
});

test("S2: a configured instance with a catalog lists it, and never contacts the public catalog", async (t) => {
  const instance = await startFakeBytebase();
  const cloud = await startFakeBytebase();
  t.after(() => Promise.all([instance.close(), cloud.close()]));
  const env = { BYTEBASE_URL: instance.url, BYTEBASE_MCP_PUBLIC_CATALOG_URL: `${cloud.url}/mcp/catalog` };

  const formless = await connect(env);
  t.after(() => formless.close());
  assert.equal(formless.getInstructions(), `${CATALOG.instructions}\n\n${CATALOG.instructionsWithoutForm}`);
  assert.deepEqual(
    (await formless.listTools()).tools.map((tool) => tool.name),
    CATALOG.tools.map((tool) => tool.name),
  );

  const withForm = await connect(env, { form: true });
  t.after(() => withForm.close());
  assert.equal(withForm.getInstructions(), CATALOG.instructions, "a client with the form gets no form paragraph");
  assert.deepEqual(cloud.requests, []);
});

test("S4: a Bytebase instance without the catalog route lists nothing and says why", async (t) => {
  const instance = await startFakeBytebase({ catalog: "html" });
  t.after(() => instance.close());
  const client = await connect({ BYTEBASE_URL: instance.url });
  t.after(() => client.close());
  const instructions = client.getInstructions() ?? "";
  assert.match(instructions, /does not serve its public tool list/);
  assert.match(instructions, /confirmation form/, "a client without forms gets the package's form sentence");
  assert.deepEqual((await client.listTools()).tools, []);
});

test("S5: an unreachable instance and a server that is not Bytebase each say so", async (t) => {
  const unreachable = await connect({ BYTEBASE_URL: "http://127.0.0.1:9" });
  t.after(() => unreachable.close());
  assert.match(unreachable.getInstructions() ?? "", /could not be reached/);
  assert.deepEqual((await unreachable.listTools()).tools, []);

  const other = await startFakeBytebase({ catalog: "html", resourceMetadata: false });
  t.after(() => other.close());
  const notBytebase = await connect({ BYTEBASE_URL: other.url }, { form: true });
  t.after(() => notBytebase.close());
  const instructions = notBytebase.getInstructions() ?? "";
  assert.match(instructions, /does not answer as a Bytebase instance/);
  assert.match(instructions, /external URL/);
  assert.ok(!instructions.includes("confirmation form"), "a client with the form gets no form sentence");
});

test("rule 3: a catalog that appears after startup is listed and announced", async (t) => {
  const instance = await startFakeBytebase({ catalog: "none" });
  t.after(() => instance.close());
  const client = await connect({ BYTEBASE_URL: instance.url });
  t.after(() => client.close());
  assert.deepEqual((await client.listTools()).tools, []);

  const announced = new Promise((resolve) => client.setNotificationHandler(ToolListChangedNotificationSchema, resolve));
  instance.setCatalog("json");
  await announced;
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name),
    CATALOG.tools.map((tool) => tool.name),
  );
});
