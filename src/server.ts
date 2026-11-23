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
import { startupRetryDelaysMs } from "./retry.js";
import { loadBundledTools } from "./tools.js";
import { NO_TIMEOUT_MS, Upstream, describe } from "./upstream.js";
import { PACKAGE_VERSION } from "./version.js";

/** How long initialize waits for a stored sign-in or the instance probe (docs/DESIGN.md, D4). */
const INITIALIZE_BOUND_MS = 5000;
/** How long tools/list waits to reopen a dropped session before answering with an error. */
const LIST_BOUND_MS = 10_000;

/**
 * Runs work with a deadline; on expiry it aborts the work's signal, calls
 * onExpiry and rejects with reason.
 */
async function withinBound<T>(work: (signal: AbortSignal) => Promise<T>, ms: number, onExpiry: () => void, reason: string): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      onExpiry();
      reject(new Error(reason));
    }, ms);
  });
  const running = work(controller.signal);
  running.catch(() => undefined);
  try {
    return await Promise.race([running, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Network errors: the instance gave no answer at all. */
function isUnreachable(err: unknown): boolean {
  return /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|fetch failed/i.test(describe(err));
}

const NO_INSTANCE_NOTE =
  "No Bytebase instance is connected, so these tools cannot run yet. Set BYTEBASE_URL to your Bytebase external URL (for example https://bytebase.example.com) in the MCP server's environment and restart the server. See https://docs.bytebase.com/integrations/mcp";

const REAUTHORIZE_NOTE = "Through bytebase-mcp, reconnect this MCP server in your client and sign in as the account you want.";

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
  // Requests to the client are numbered from 1: the SDK numbers from 0, and its
  // own cancellation handler ignores request ID 0 (`if (!requestId) return`), so a
  // client on this SDK would keep the first withdrawn form up (D5).
  (server as unknown as { _requestMessageId: number })._requestMessageId = 1;
  let initialized = false;

  // Created at initialize: a sign-in belongs to the client application (D6).
  let upstream: Upstream | undefined;
  const upstreamFor = (url: URL): Upstream => {
    upstream ??= new Upstream({ ...config, url }, server.getClientVersion(), {
      clientCapabilities: () => server.getClientCapabilities() ?? {},
      // Bytebase decides how long a form stays up, and may withdraw it (D5).
      onElicit: (params, signal) => server.elicitInput(params, { signal, timeout: NO_TIMEOUT_MS }),
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

  let announcing = false;
  /** After a tools/list gave up waiting, announces the list once the reopen it started opens. */
  function announceWhenOpen(target: Upstream): void {
    if (announcing) return;
    announcing = true;
    target
      .open({ interactive: false, waitForLock: true })
      .then(() => server.sendToolListChanged())
      .catch((err) => log(`the session did not reopen: ${describe(err)}`))
      .finally(() => {
        announcing = false;
      });
  }

  /**
   * D5: an unreachable instance is retried on a fixed schedule, and the browser
   * opens only once it answers. A sign-in that fails or times out is not
   * restarted, and after the last retry the proxy stops until a client restart.
   */
  async function signInWhenReachable(url: URL): Promise<void> {
    const instance = url.toString().replace(/\/$/, "");
    const waits = startupRetryDelaysMs();
    for (let attempt = 0; ; attempt++) {
      try {
        await openAndAnnounce(url, true);
        return;
      } catch (err) {
        if (!isUnreachable(err)) {
          log(`sign-in failed: ${describe(err)}`);
          return;
        }
        const wait = waits[attempt];
        if (wait === undefined) {
          log(`${instance} still cannot be reached after ${waits.length} retries; restart the client to try again`);
          return;
        }
        log(`${instance} cannot be reached (${describe(err)}); retrying in ${Math.round(wait / 1000)}s`);
        await new Promise((resolve) => setTimeout(resolve, wait).unref());
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
    // Only a wait spent reopening a dropped session ends in an announcement; a
    // slow answer on an open session changes nothing the client holds.
    const reopening = !target.session;
    try {
      return await withinBound((signal) => target.listTools(request.params?.cursor, signal), LIST_BOUND_MS,
        // The reconnect carries on; when it opens, the client is told to list again.
        () => {
          if (reopening) announceWhenOpen(target);
        }, `still connecting to ${config.url.toString().replace(/\/$/, "")}`);
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
      // The one addition to a forwarded result (rule 4): the client keeps
      // instructions naming the old account until it reinitializes.
      if (request.params.name === "reauthorize" && !result.isError) {
        return { ...result, content: [...result.content, { type: "text", text: REAUTHORIZE_NOTE }] };
      }
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
