import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.js";
import { log } from "./log.js";
import { loadBundledTools } from "./tools.js";
import { Upstream, describe } from "./upstream.js";
import { PACKAGE_VERSION } from "./version.js";

/**
 * Used when the Bytebase release the bundle was read from sent no initialize
 * instructions (releases before the server shipped them). Newer dumps carry
 * Bytebase's own text, which wins.
 */
const FALLBACK_INSTRUCTIONS = `Bytebase governs access to databases and changes to them. Every call is also limited by the signed-in account's permissions and the workspace's MCP access policy.

Choose the tool by task:
- Read data: query_database. Before you write SQL for a database, read its schema with get_schema.
- Inspect a schema: get_schema.
- Change a database: propose_database_change. It creates the plan and the issue and runs the plan checks; approval and rollout follow the project's policy.
- Anything else: search_api to find the operation and its request schema, then call_api.

When Bytebase refuses a call, the error states the reason and may name a next step.`;

const NO_INSTANCE_MESSAGE =
  "No Bytebase instance is configured. Set BYTEBASE_URL to your Bytebase external URL (for example https://bytebase.example.com) in the MCP server's environment and restart the server. See https://docs.bytebase.com/integrations/mcp";

/**
 * Builds the stdio MCP server. It answers initialize and tools/list on its own
 * from the bundled definitions, so a directory can read them without an
 * instance, and forwards tools/call (and the confirmation forms Bytebase sends
 * back) to the configured instance.
 */
export function createServer(config: Config): { server: Server; upstream?: Upstream } {
  const bundled = loadBundledTools();

  const server = new Server(
    { name: "bytebase", title: "Bytebase", version: PACKAGE_VERSION },
    {
      capabilities: { tools: { listChanged: true } },
      instructions: bundled.instructions.trim().length > 0 ? bundled.instructions : FALLBACK_INSTRUCTIONS,
    },
  );

  let upstream: Upstream | undefined;
  let liveTools: ListToolsResult | undefined;

  if (config.url) {
    upstream = new Upstream(
      { ...config, url: config.url },
      {
        clientCapabilities: () => server.getClientCapabilities() ?? {},
        onElicit: (params) => server.elicitInput(params),
        onToolListChanged: () => {
          liveTools = undefined;
          void refreshLiveTools();
        },
      },
    );
  }

  /** Fetches the live tool list in the background and tells the client when it differs from what it has. */
  async function refreshLiveTools(): Promise<void> {
    if (!upstream) return;
    try {
      const fresh = await upstream.listTools();
      const changed = JSON.stringify(fresh.tools) !== JSON.stringify((liveTools ?? bundled).tools);
      liveTools = fresh;
      if (changed) {
        await server.sendToolListChanged();
      }
    } catch (err) {
      log(`could not read the live tool list, serving the bundled one (Bytebase ${bundled.bytebaseVersion}): ${describe(err)}`);
    }
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (liveTools) return liveTools;
    if (upstream) {
      // Never block the client's first tools/list on a sign-in: answer from the
      // bundle and announce the live list once it arrives.
      void refreshLiveTools();
    }
    return { tools: bundled.tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    if (!upstream) {
      return { isError: true, content: [{ type: "text", text: NO_INSTANCE_MESSAGE }] };
    }
    try {
      return await upstream.callTool(request.params);
    } catch (err) {
      if (err instanceof McpError) throw err;
      return {
        isError: true,
        content: [{ type: "text", text: `Bytebase MCP: ${describe(err)}` }],
      };
    }
  });

  return { server, upstream };
}

export async function serveStdio(config: Config): Promise<void> {
  const { server, upstream } = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  if (config.url) {
    log(`forwarding to ${config.url.toString().replace(/\/$/, "")}/mcp`);
  } else {
    log("BYTEBASE_URL is not set: serving the bundled tool list only; tool calls will fail until it is set");
  }
  const shutdown = () => {
    upstream?.reset();
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);
}
