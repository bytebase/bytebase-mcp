// The proxy's states without a session (docs/DESIGN.md, States), driven the way
// an MCP client drives it: spawn the built server over stdio.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startFakeBytebase } from "./fake-upstream.mjs";

const entry = path.join(import.meta.dirname, "..", "dist", "index.js");
const snapshot = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "src", "tools.json"), "utf8"));

async function connect(env, { form = false } = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("BYTEBASE_"))),
      BYTEBASE_MCP_HOME: fs.mkdtempSync(path.join(import.meta.dirname, ".tmp-home-")),
      BYTEBASE_MCP_NO_BROWSER: "1",
      BYTEBASE_MCP_CALLBACK_PORT: String(52700 + Math.floor(Math.random() * 500)),
      ...env,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "smoke", version: "0.0.0" }, { capabilities: form ? { elicitation: { form: {} } } : {} });
  await client.connect(transport);
  return client;
}

test("S1: with no URL, lists the snapshot, runs nothing, and says no instance is connected", async (t) => {
  const client = await connect({});
  t.after(() => client.close());

  const instructions = client.getInstructions() ?? "";
  assert.ok(instructions.startsWith("No Bytebase instance is connected"), instructions);
  assert.match(instructions, /BYTEBASE_URL/);
  if (snapshot.instructions) assert.ok(instructions.endsWith(snapshot.instructions), "the snapshot's instructions follow the note");

  const { tools } = await client.listTools();
  assert.ok(tools.length > 0);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    snapshot.tools.map((tool) => tool.name),
  );

  const result = await client.callTool({ name: tools[0].name, arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /BYTEBASE_URL/);
});

test("S3: a configured Bytebase instance without a session lists nothing and says to sign in", async (t) => {
  const bytebase = await startFakeBytebase();
  t.after(() => bytebase.close());

  const formless = await connect({ BYTEBASE_URL: bytebase.url });
  t.after(() => formless.close());
  const instructions = formless.getInstructions() ?? "";
  assert.match(instructions, /sign in/i);
  assert.match(instructions, /confirmation form/, "a client without forms gets the package's form sentence");
  assert.deepEqual((await formless.listTools()).tools, [], "a configured proxy never lists the snapshot");

  const withForm = await connect({ BYTEBASE_URL: bytebase.url }, { form: true });
  t.after(() => withForm.close());
  assert.ok(!(withForm.getInstructions() ?? "").includes("confirmation form"));
});

test("S4: an unreachable instance and a server that is not Bytebase each say so and list nothing", async (t) => {
  const unreachable = await connect({ BYTEBASE_URL: "http://127.0.0.1:9" });
  t.after(() => unreachable.close());
  assert.match(unreachable.getInstructions() ?? "", /could not be reached/);
  assert.deepEqual((await unreachable.listTools()).tools, []);

  const other = await startFakeBytebase({ resourceMetadata: false });
  t.after(() => other.close());
  const notBytebase = await connect({ BYTEBASE_URL: other.url }, { form: true });
  t.after(() => notBytebase.close());
  const instructions = notBytebase.getInstructions() ?? "";
  assert.match(instructions, /does not answer as a Bytebase instance/);
  assert.match(instructions, /external URL/);
  assert.deepEqual((await notBytebase.listTools()).tools, []);
});
