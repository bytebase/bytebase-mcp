import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  InitializeRequestSchema,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type ClientCapabilities,
  type InitializeRequest,
  type InitializeResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.js";
import { log } from "./log.js";
import { probeInstance, type InstanceProbe } from "./probe.js";
import { loadBundledTools } from "./tools.js";
import { Upstream, describe } from "./upstream.js";
import { PACKAGE_VERSION } from "./version.js";

/** How long initialize waits for a stored sign-in or the instance probe (docs/DESIGN.md, D4). */
const INITIALIZE_BOUND_MS = 5000;
const RETRY_FIRST_MS = 1000;
/** How long tools/list waits to reopen a dropped session before answering with an error. */
const LIST_BOUND_MS = 10_000;

async function withinBound<T>(work: Promise<T>, ms: number, reason: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(reason)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
const RETRY_CAP_MS = 5 * 60 * 1000;

/** Network errors: the instance gave no answer at all. */
function isUnreachable(err: unknown): boolean {
  return /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|fetch failed/i.test(describe(err));
}

const NO_INSTANCE_NOTE =
  "No Bytebase instance is connected, so these tools cannot run yet. Set BYTEBASE_URL to your Bytebase external URL (for example https://bytebase.example.com) in the MCP server's environment and restart the server. See https://docs.bytebase.com/integrations/mcp";

/** The package's version of the instance's form paragraph, for states where that text cannot be read. */
const FORM_SENTENCE =
  "This client cannot show Bytebase's confirmation form, so before you run a statement that may write, show it to the user and ask them to confirm.";

/** The instance's own rule (declaresFormElicitation in Bytebase's tool_resolve.go). */
function declaresForm(capabilities: ClientCapabilities | undefined): boolean {
  const elicitation = capabilities?.elicitation;
  if (!elicitation) return false;
  return Boolean(elicitation.form) || !elicitation.url;
}

/** S3 and S4: the package's paragraph for a configured proxy with no session. */
function signedOutInstructions(instance: string, probe: InstanceProbe, capabilities: ClientCapabilities | undefined): string {
  const text =
    probe.kind === "bytebase"
      ? `Sign in to Bytebase at ${instance} in the browser window this server opens. Its tools appear once you have signed in.`
      : probe.kind === "unreachable"
        ? `The Bytebase instance at ${instance} could not be reached (${probe.detail}). Its tools appear once it can be reached and you have signed in.`
        : `${instance} does not answer as a Bytebase instance (${probe.detail}). Check that BYTEBASE_URL is the instance's external URL (Settings > General > External URL).`;
  return declaresForm(capabilities) ? text : `${text}\n\n${FORM_SENTENCE}`;
}

/**
 * Builds the stdio MCP server. Without a URL it lists the bundled snapshot,
 * for directory listings, and runs nothing; with one it lists only what the
 * instance serves once a session is open (docs/DESIGN.md, D2).
 */
export function createServer(config: Config): { server: Server; upstream: () => Upstream | undefined } {
  const server = new Server(
    { name: "bytebase", title: "Bytebase", version: PACKAGE_VERSION },
    { capabilities: { tools: { listChanged: true } } },
  );
  let initialized = false;

  // Created at initialize: a sign-in belongs to the client application (D6).
  let upstream: Upstream | undefined;
  const upstreamFor = (url: URL): Upstream => {
    upstream ??= new Upstream({ ...config, url }, server.getClientVersion(), {
      clientCapabilities: () => server.getClientCapabilities() ?? {},
      onElicit: (params) => server.elicitInput(params),
      onToolListChanged: () => void server.sendToolListChanged().catch(() => undefined),
    });
    return upstream;
  };

  /** Opens the session, then tells the client its tool list changed from empty. */
  async function openAndAnnounce(url: URL, interactive: boolean): Promise<void> {
    const target = upstreamFor(url);
    const hadSession = Boolean(target.session);
    await target.open({ interactive, waitForLock: true });
    if (!hadSession && initialized) await server.sendToolListChanged();
  }

  // Decorates the SDK's own initialize answer, which also records the client's
  // capabilities, with instructions for the state the proxy is in.
  const sdkInitialize = (server as unknown as { _oninitialize(request: InitializeRequest): Promise<InitializeResult> })._oninitialize.bind(server);
  server.setRequestHandler(InitializeRequestSchema, async (request) => {
    const result = await sdkInitialize(request);
    if (!config.url) {
      const snapshot = loadBundledTools();
      return { ...result, instructions: [NO_INSTANCE_NOTE, snapshot.instructions].filter((part) => part.trim().length > 0).join("\n\n") };
    }
    const target = upstreamFor(config.url);
    // Both run within the bound: the probe decides the signed-out text if no session opens.
    const probing = probeInstance(config.url, AbortSignal.timeout(INITIALIZE_BOUND_MS));
    // S2: a stored sign-in opens the session without waiting for the lock or asking the user.
    if (target.provider.hasStoredSignIn()) {
      const opening = target.open({ interactive: false, waitForLock: false });
      const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), INITIALIZE_BOUND_MS).unref());
      const session = await Promise.race([opening.catch((err) => log(`starting signed out: ${describe(err)}`)), timeout]);
      if (session) return { ...result, instructions: session.getInstructions() ?? "" };
    }
    const probe = await probing;
    return { ...result, instructions: signedOutInstructions(config.url.toString().replace(/\/$/, ""), probe, request.params.capabilities) };
  });

  server.oninitialized = () => {
    initialized = true;
    // A configured proxy without a session has no tools to offer, so it signs in now (D5).
    if (!config.url || upstream?.session) return;
    void signInWhenReachable(config.url);
  };

  /**
   * D5: an unreachable instance is retried with backoff, and the browser opens
   * only once it answers. A sign-in that fails or times out is not restarted.
   */
  async function signInWhenReachable(url: URL): Promise<void> {
    for (let delay = RETRY_FIRST_MS; ; delay = Math.min(delay * 2, RETRY_CAP_MS)) {
      try {
        await openAndAnnounce(url, true);
        return;
      } catch (err) {
        if (!isUnreachable(err)) {
          log(`sign-in failed: ${describe(err)}`);
          return;
        }
        log(`${url.toString().replace(/\/$/, "")} cannot be reached (${describe(err)}); retrying in ${Math.round(delay / 1000)}s`);
        await new Promise((resolve) => setTimeout(resolve, delay).unref());
      }
    }
  }

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    if (!config.url) return { tools: loadBundledTools().tools };
    // Without a session there is nothing to list yet (D2), and tools/list never
    // waits on a sign-in: the tools are announced when the session opens. With
    // a stored sign-in and no sign-in under way, a session dropped by an outage
    // is reopened here (D5), within a bound.
    const target = upstreamFor(config.url);
    if (!target.session && (target.signingIn || !target.provider.hasStoredSignIn())) return { tools: [] };
    try {
      return await withinBound(target.listTools(request.params?.cursor), LIST_BOUND_MS, `still connecting to ${config.url.toString().replace(/\/$/, "")}`);
    } catch (err) {
      if (err instanceof McpError) throw err;
      // tools/list has no error result, so the reason goes in a JSON-RPC error (rule 4).
      throw new McpError(ErrorCode.InternalError, `Bytebase MCP: ${describe(err)}`);
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    if (!config.url) {
      return { isError: true, content: [{ type: "text", text: NO_INSTANCE_NOTE }] };
    }
    try {
      const hadSession = Boolean(upstream?.session);
      const result = await upstreamFor(config.url).callTool(request.params, extra.signal);
      if (!hadSession && initialized) void server.sendToolListChanged().catch(() => undefined);
      return result;
    } catch (err) {
      if (err instanceof McpError) throw err;
      return { isError: true, content: [{ type: "text", text: `Bytebase MCP: ${describe(err)}` }] };
    }
  });

  return { server, upstream: () => upstream };
}

export async function serveStdio(config: Config): Promise<void> {
  const { server, upstream } = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(config.url ? `forwarding to ${config.url.toString().replace(/\/$/, "")}/mcp` : "BYTEBASE_URL is not set: listing the bundled snapshot; tool calls fail until it is set");
  const shutdown = () => {
    upstream()?.reset();
    // A pending sign-in or a stalled close must not keep the process alive once the client left.
    setTimeout(() => process.exit(0), 1000).unref();
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);
}
