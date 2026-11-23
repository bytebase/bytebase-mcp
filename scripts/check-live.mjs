// Manual end-to-end check against a real instance: starts dist/index.js the way
// an MCP client would, lists tools, and runs two read-only calls through it.
// Signed out, the first list is empty and the first call opens the browser
// sign-in; with a stored sign-in the instance's tools are listed at once.
//   BYTEBASE_URL=https://your-bytebase node scripts/check-live.mjs
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

if (!process.env.BYTEBASE_URL) {
  console.error("set BYTEBASE_URL");
  process.exit(2);
}
const entry = path.join(import.meta.dirname, "..", "dist", "index.js");
const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env: { ...process.env }, stderr: "inherit" });
const client = new Client({ name: "check-live", version: "0" }, { capabilities: { elicitation: { form: {} } } });
await client.connect(transport);
console.log("instructions:", JSON.stringify((client.getInstructions() ?? "").slice(0, 100)));
const first = await client.listTools();
console.log(`tools/list at start: ${first.tools.length} (0 while signed out)`);
const search = await client.callTool({ name: "search_api", arguments: { service: "ProjectService" } });
console.log(`search_api: isError=${search.isError ?? false}`, search.content[0].text.slice(0, 160).replace(/\n/g, " | "));
const call = await client.callTool({ name: "call_api", arguments: { operationId: "ProjectService/ListProjects", body: { pageSize: 3 } } });
console.log(`call_api: isError=${call.isError ?? false}`, call.content[0].text.slice(0, 300).replace(/\n/g, " | "));
await new Promise((r) => setTimeout(r, 1000));
const second = await client.listTools();
console.log(`tools/list after the calls: ${second.tools.length} (the instance's tools)`);
await client.close();
