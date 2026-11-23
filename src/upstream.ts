import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  CallToolResultSchema,
  ElicitRequestSchema,
  ListToolsResultSchema,
  ToolListChangedNotificationSchema,
  type CallToolRequest,
  type CallToolResult,
  type ClientCapabilities,
  type ElicitRequest,
  type ElicitResult,
  type Implementation,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import { FileOAuthClientProvider, SignInRequiredError, clientIdentity, signInPermitted } from "./auth.js";
import { mcpEndpoint, type Config } from "./config.js";
import { log } from "./log.js";

/**
 * The proxy adds no deadline to a forwarded request, in either direction
 * (docs/DESIGN.md, D5); the SDK would otherwise give each one 60 seconds.
 */
export const NO_TIMEOUT_MS = 2 ** 31 - 1;

export interface UpstreamHooks {
  /** Capabilities to declare to Bytebase: the elicitation the downstream client declared. */
  clientCapabilities: () => ClientCapabilities;
  /**
   * Forward an elicitation (confirmation form) from Bytebase to the downstream
   * client; `signal` aborts when Bytebase withdraws it.
   */
  onElicit?: (params: ElicitRequest["params"], signal: AbortSignal) => Promise<ElicitResult>;
  /** Bytebase changed its tool list. */
  onToolListChanged?: () => void;
}

export interface OpenOptions {
  /** Whether a browser sign-in may start. */
  interactive: boolean;
  /** Whether to wait for another holder of the sign-in's lock. */
  waitForLock: boolean;
}

/**
 * One connection to a Bytebase instance's /mcp endpoint for one client
 * application, opened under the sign-in's lock (docs/DESIGN.md, D7).
 */
export class Upstream {
  private readonly endpoint: URL;
  readonly provider: FileOAuthClientProvider;
  private client?: Client;
  private readonly inFlight = new WeakMap<Client, number>();
  private readonly retiring = new Set<Client>();
  private connecting?: Promise<Client>;
  private connectingInteractive = false;

  constructor(
    private readonly config: Config & { url: URL },
    private readonly clientInfo: Implementation | undefined,
    private readonly hooks: UpstreamHooks,
  ) {
    this.endpoint = mcpEndpoint(config.url);
    this.provider = new FileOAuthClientProvider(config.url, clientIdentity(clientInfo), {
      home: config.home,
      callbackPort: config.callbackPort,
      openBrowser: config.openBrowser,
    });
  }

  /** The open session, if any. */
  get session(): Client | undefined {
    return this.client;
  }

  /** Whether an opening that may sign in in the browser is in progress. */
  get signingIn(): boolean {
    return Boolean(this.connecting) && this.connectingInteractive;
  }

  /** Returns the session, opening it under the sign-in's lock when needed. */
  async open(options: OpenOptions): Promise<Client> {
    if (this.client) return this.client;
    // An opening that may not sign in (initialize's) is waited out, then a sign-in
    // starts if it did not open the session.
    if (this.connecting && options.interactive && !this.connectingInteractive) {
      await this.connecting.catch(() => undefined);
      if (this.client) return this.client;
    }
    if (!this.connecting) {
      this.connectingInteractive = options.interactive;
      this.connecting = this.openLocked(options).finally(() => {
        this.connecting = undefined;
      });
    }
    return this.connecting;
  }

  /** Closes the current session at once; for shutdown. */
  reset(): void {
    const client = this.client;
    this.client = undefined;
    void client?.close().catch(() => undefined);
  }

  /**
   * Stops sending to the current session so the next request reconnects. Calls
   * already in flight on it may have run on the instance, so it closes only once
   * the last of them settles and they still return their results.
   */
  private retire(client: Client): void {
    if (this.client === client) this.client = undefined;
    if ((this.inFlight.get(client) ?? 0) === 0) void client.close().catch(() => undefined);
    else this.retiring.add(client);
  }

  /** Counts a request on its session, closing a retired session after its last one. */
  private async track<T>(client: Client, request: Promise<T>): Promise<T> {
    this.inFlight.set(client, (this.inFlight.get(client) ?? 0) + 1);
    try {
      return await request;
    } finally {
      const left = (this.inFlight.get(client) ?? 1) - 1;
      this.inFlight.set(client, left);
      if (left === 0 && this.retiring.delete(client)) void client.close().catch(() => undefined);
    }
  }

  /**
   * Lists one page of the session's tools; the client's cursor goes to the
   * instance as is. After an error showing the instance never received the
   * request, such as a session it ended, it reopens with the stored sign-in and
   * asks once more.
   */
  async listTools(cursor?: string, signal?: AbortSignal): Promise<ListToolsResult> {
    let used: Client | undefined;
    const send = async () => {
      const client = (used = await this.open({ interactive: false, waitForLock: true }));
      // A caller that gave up while the session reopened does not send the request.
      signal?.throwIfAborted();
      return this.track(client, client.request({ method: "tools/list", params: cursor ? { cursor } : {} }, ListToolsResultSchema, { signal }));
    };
    try {
      return await send();
    } catch (err) {
      if (signal?.aborted || !neverReceived(err)) throw err;
      log(`the instance did not receive tools/list (${describe(err)}); reconnecting`);
      // Retire the session the request failed on, not one another call already reopened.
      if (used) this.retire(used);
      return send();
    }
  }

  /**
   * Forwards a tool call. It follows the client: a call cancelled before its
   * session opens is never sent, and it is resent only after an error showing
   * the instance never received it.
   */
  async callTool(params: CallToolRequest["params"], signal?: AbortSignal): Promise<CallToolResult> {
    let used: Client | undefined;
    const send = async () => {
      const client = (used = await this.open({ interactive: true, waitForLock: true }));
      signal?.throwIfAborted();
      // Raw request rather than client.callTool(): that validates structuredContent
      // against a tool list it may not have, and results pass through untouched.
      return this.track(client, client.request({ method: "tools/call", params }, CallToolResultSchema, { signal, timeout: NO_TIMEOUT_MS }));
    };
    try {
      return await send();
    } catch (err) {
      if (signal?.aborted || !neverReceived(err)) throw err;
      log(`the instance did not receive the call (${describe(err)}); reconnecting`);
      // Retire the session the request failed on, not one another call already reopened.
      if (used) this.retire(used);
      return send();
    }
  }

  private async openLocked(options: OpenOptions): Promise<Client> {
    const held = await this.provider.withLock(() => this.connect(options.interactive), { wait: options.waitForLock });
    if (!held) throw new SignInRequiredError("another process holds this sign-in");
    return held.value;
  }

  private async connect(interactive: boolean): Promise<Client> {
    const permit = { active: interactive };
    try {
      return await signInPermitted.run(permit, () => this.attemptConnect(interactive));
    } finally {
      permit.active = false;
    }
  }

  private async attemptConnect(interactive: boolean): Promise<Client> {
    const capabilities = this.hooks.clientCapabilities();
    const forwardsElicitation = Boolean(capabilities.elicitation) && Boolean(this.hooks.onElicit);
    {
      for (let attempt = 1; ; attempt++) {
        const transport = new StreamableHTTPClientTransport(this.endpoint, { authProvider: this.provider, fetch: this.provider.fetch });
        const client = new Client(this.clientInfo ?? { name: "bytebase-mcp", version: "0" }, {
          capabilities: forwardsElicitation ? { elicitation: capabilities.elicitation } : {},
        });
        if (forwardsElicitation) {
          client.setRequestHandler(ElicitRequestSchema, async (request, extra) => this.hooks.onElicit!(request.params, extra.signal));
        }
        client.setNotificationHandler(ToolListChangedNotificationSchema, () => this.hooks.onToolListChanged?.());
        client.onclose = () => {
          if (this.client === client) this.client = undefined;
        };
        client.onerror = (err) => {
          if (/AbortError|operation was aborted/.test(describe(err))) return;
          log(`upstream error: ${describe(err)}`);
        };
        try {
          await client.connect(transport);
          this.client = client;
          return client;
        } catch (err) {
          if (findSignInRequired(err)) throw findSignInRequired(err);
          if (err instanceof UnauthorizedError && interactive && attempt === 1) {
            const code = await this.provider.waitForAuthorizationCode();
            await transport.finishAuth(code);
            log("signed in; connecting");
            continue;
          }
          throw new Error(`cannot connect to ${this.endpoint}: ${describe(err)}${hint(err)}`, { cause: err });
        }
      }
    }
  }
}

function findSignInRequired(err: unknown): SignInRequiredError | undefined {
  for (let e: unknown = err; e; e = (e as { cause?: unknown }).cause) {
    if (e instanceof SignInRequiredError) return e;
  }
  return undefined;
}

/**
 * Errors that show the instance never received the request. A refused sign-in
 * in an open session counts: Bytebase answered 401 (a revoked grant, as after
 * reauthorize), so the request did not run.
 */
function neverReceived(err: unknown): boolean {
  if (findSignInRequired(err)) return true;
  const text = describe(err).toLowerCase();
  return text.includes("econnrefused") || text.includes("session not found") || text.includes("http 404") || text.includes("http 401") || text.includes("not connected");
}

function hint(err: unknown): string {
  const text = describe(err);
  if (/Protected resource .* does not match/i.test(text)) {
    return ". BYTEBASE_URL must be the instance's external URL (Settings > General > External URL), because Bytebase binds MCP tokens to it";
  }
  if (/sign-in timed out/i.test(text)) return ". Call a tool again to restart the sign-in";
  return "";
}

export function describe(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    return cause && cause !== err ? `${err.message} (${describe(cause)})` : err.message;
  }
  return String(err);
}
