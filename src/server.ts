import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  InitializeRequestSchema,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type ClientCapabilities,
  type InitializeRequest,
  type InitializeResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { catalogUrl, fetchCatalog, namesItselfAsBytebase, type Catalog } from "./catalog.js";
import type { Config } from "./config.js";
import { log } from "./log.js";
import { Upstream, describe } from "./upstream.js";
import { PACKAGE_VERSION } from "./version.js";

/** How long initialize waits for the catalog (docs/DESIGN.md, D4). */
const INITIALIZE_BOUND_MS = 5000;
const RETRY_FIRST_MS = 1000;
const RETRY_CAP_MS = 5 * 60 * 1000;

const NO_INSTANCE_NOTE =
  "No Bytebase instance is connected, so these tools cannot run yet. Set BYTEBASE_URL to your Bytebase external URL (for example https://bytebase.example.com) in the MCP server's environment and restart the server. See https://docs.bytebase.com/integrations/mcp";

/** The package's version of the instance's form paragraph, for states where that text cannot be read. */
const FORM_SENTENCE =
  "This client cannot show Bytebase's confirmation form, so before you run a statement that may write, show it to the user and ask them to confirm.";

/** The state decided at startup (docs/DESIGN.md, States). Sessions (S3) come with sign-in. */
type Startup =
  | { state: "S1"; catalog?: Catalog }
  | { state: "S2"; catalog: Catalog }
  | { state: "S4" }
  | { state: "S5"; reason: "unreachable" | "not-bytebase"; detail: string };

async function classify(config: Config): Promise<Startup> {
  const signal = AbortSignal.timeout(INITIALIZE_BOUND_MS);
  if (!config.url) {
    const probe = await fetchCatalog(config.publicCatalogUrl, signal);
    return probe.kind === "catalog" ? { state: "S1", catalog: probe.catalog } : { state: "S1" };
  }
  const probe = await fetchCatalog(catalogUrl(config.url), signal);
  if (probe.kind === "catalog") return { state: "S2", catalog: probe.catalog };
  if (probe.kind === "unreachable") return { state: "S5", reason: "unreachable", detail: probe.detail };
  if (await namesItselfAsBytebase(config.url, signal)) return { state: "S4" };
  return { state: "S5", reason: "not-bytebase", detail: probe.detail };
}

/** The instance's own rule (declaresFormElicitation in Bytebase's tool_resolve.go). */
function declaresForm(capabilities: ClientCapabilities | undefined): boolean {
  const elicitation = capabilities?.elicitation;
  if (!elicitation) return false;
  return Boolean(elicitation.form) || !elicitation.url;
}

function instructionsFor(startup: Startup, config: Config, capabilities: ClientCapabilities | undefined): string {
  const form = declaresForm(capabilities);
  const fromCatalog = (catalog: Catalog) =>
    [catalog.instructions, form ? "" : catalog.instructionsWithoutForm].filter((part) => part.length > 0).join("\n\n");
  const instance = config.url?.toString().replace(/\/$/, "") ?? "";
  switch (startup.state) {
    case "S1":
      return startup.catalog ? `${NO_INSTANCE_NOTE}\n\n${fromCatalog(startup.catalog)}` : NO_INSTANCE_NOTE;
    case "S2":
      return fromCatalog(startup.catalog);
    case "S4":
      return withFormSentence(
        `The Bytebase instance at ${instance} does not serve its public tool list at this URL: it runs a release from before the list, or a reverse proxy forwards only /mcp. Its tools appear after you sign in to Bytebase.`,
        form,
      );
    case "S5":
      return withFormSentence(
        startup.reason === "unreachable"
          ? `The Bytebase instance at ${instance} could not be reached (${startup.detail}). Its tools appear once it can be reached.`
          : `${instance} does not answer as a Bytebase instance (${startup.detail}). Check that BYTEBASE_URL is the instance's external URL (Settings > General > External URL).`,
        form,
      );
  }
}

function withFormSentence(text: string, form: boolean): string {
  return form ? text : `${text}\n\n${FORM_SENTENCE}`;
}

/**
 * Builds the stdio MCP server. Every tool and instruction it describes comes
 * from a Bytebase server read in this process; with no instance configured it
 * reads Bytebase Cloud's public catalog and runs nothing.
 */
export function createServer(config: Config): { server: Server; upstream?: Upstream } {
  const server = new Server(
    { name: "bytebase", title: "Bytebase", version: PACKAGE_VERSION },
    { capabilities: { tools: { listChanged: true } } },
  );

  let catalog: Catalog | undefined;
  let sessionTools: Tool[] | undefined;
  let initialized = false;

  const startup = classify(config).then((result) => {
    catalog = "catalog" in result ? result.catalog : undefined;
    if (!catalog) void retryCatalog();
    return result;
  });

  /** Retries the catalog with backoff while there is no tool list (docs/DESIGN.md, rule 3). */
  async function retryCatalog(): Promise<void> {
    const url = config.url ? catalogUrl(config.url) : config.publicCatalogUrl;
    for (let delay = RETRY_FIRST_MS; !catalog && !sessionTools; delay = Math.min(delay * 2, RETRY_CAP_MS)) {
      await new Promise((resolve) => setTimeout(resolve, delay).unref());
      const probe = await fetchCatalog(url, AbortSignal.timeout(INITIALIZE_BOUND_MS));
      if (probe.kind === "catalog" && !catalog && !sessionTools) {
        catalog = probe.catalog;
        if (initialized) await server.sendToolListChanged();
      }
    }
  }

  let upstream: Upstream | undefined;
  if (config.url) {
    upstream = new Upstream(
      { ...config, url: config.url },
      {
        clientCapabilities: () => server.getClientCapabilities() ?? {},
        onElicit: (params) => server.elicitInput(params),
        onToolListChanged: () => void refreshSessionTools(),
      },
    );
  }

  /** Reads the open session's tool list, and tells the client when it differs from what it has. */
  async function refreshSessionTools(): Promise<void> {
    if (!upstream) return;
    try {
      const fresh = (await upstream.listTools()).tools;
      const changed = JSON.stringify(fresh) !== JSON.stringify(sessionTools ?? catalog?.tools ?? []);
      sessionTools = fresh;
      if (changed && initialized) await server.sendToolListChanged();
    } catch (err) {
      log(`could not read the session's tool list: ${describe(err)}`);
    }
  }

  // Decorates the SDK's own initialize answer, which also records the client's
  // capabilities, with instructions for the state the proxy is in.
  const sdkInitialize = (server as unknown as { _oninitialize(request: InitializeRequest): Promise<InitializeResult> })._oninitialize.bind(server);
  server.setRequestHandler(InitializeRequestSchema, async (request) => {
    const result = await sdkInitialize(request);
    const instructions = instructionsFor(await startup, config, request.params.capabilities);
    return { ...result, instructions };
  });
  server.oninitialized = () => {
    initialized = true;
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await startup;
    return { tools: sessionTools ?? catalog?.tools ?? [] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    if (!upstream) {
      return { isError: true, content: [{ type: "text", text: NO_INSTANCE_NOTE }] };
    }
    try {
      const result = await upstream.callTool(request.params);
      if (!sessionTools) void refreshSessionTools();
      return result;
    } catch (err) {
      if (err instanceof McpError) throw err;
      return { isError: true, content: [{ type: "text", text: `Bytebase MCP: ${describe(err)}` }] };
    }
  });

  return { server, upstream };
}

export async function serveStdio(config: Config): Promise<void> {
  const { server, upstream } = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(config.url ? `forwarding to ${config.url.toString().replace(/\/$/, "")}/mcp` : "BYTEBASE_URL is not set: listing the public catalog; tool calls fail until it is set");
  const shutdown = () => {
    upstream?.reset();
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);
}
