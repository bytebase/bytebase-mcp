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
import { FileOAuthClientProvider, SignInRequiredError, clientIdentity } from "./auth.js";
import { mcpEndpoint, type Config } from "./config.js";
import { log } from "./log.js";

/** The proxy sets no timeout of its own on a forwarded call (docs/DESIGN.md, D5). */
const NO_TIMEOUT_MS = 2 ** 31 - 1;

export interface UpstreamHooks {
  /** Capabilities to declare to Bytebase: the elicitation the downstream client declared. */
  clientCapabilities: () => ClientCapabilities;
  /** Forward an elicitation (confirmation form) from Bytebase to the downstream client. */
  onElicit?: (params: ElicitRequest["params"]) => Promise<ElicitResult>;
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

  /** Forgets the current session so the next call reconnects. */
  reset(): void {
    const client = this.client;
    this.client = undefined;
    void client?.close().catch(() => undefined);
  }

  /**
   * Lists one page of the session's tools; the client's cursor goes to the
   * instance as is. After an error showing the instance never received the
   * request, such as a session it ended, it reopens with the stored sign-in and
   * asks once more.
   */
  async listTools(cursor?: string): Promise<ListToolsResult> {
    const send = async () => {
      const client = await this.open({ interactive: false, waitForLock: true });
      return client.request({ method: "tools/list", params: cursor ? { cursor } : {} }, ListToolsResultSchema);
    };
    try {
      return await send();
    } catch (err) {
      if (!neverReceived(err)) throw err;
      log(`the instance did not receive tools/list (${describe(err)}); reconnecting`);
      this.reset();
      return send();
    }
  }

  /**
   * Forwards a tool call. It follows the client: a call cancelled before its
   * session opens is never sent, and it is resent only after an error showing
   * the instance never received it.
   */
  async callTool(params: CallToolRequest["params"], signal?: AbortSignal): Promise<CallToolResult> {
    const send = async () => {
      const client = await this.open({ interactive: true, waitForLock: true });
      signal?.throwIfAborted();
      // Raw request rather than client.callTool(): that validates structuredContent
      // against a tool list it may not have, and results pass through untouched.
      return client.request({ method: "tools/call", params }, CallToolResultSchema, { signal, timeout: NO_TIMEOUT_MS });
    };
    try {
      return await send();
    } catch (err) {
      if (signal?.aborted || !neverReceived(err)) throw err;
      log(`the instance did not receive the call (${describe(err)}); reconnecting`);
      this.reset();
      return send();
    }
  }

  private async openLocked(options: OpenOptions): Promise<Client> {
    const held = await this.provider.withLock(() => this.connect(options.interactive), { wait: options.waitForLock });
    if (!held) throw new SignInRequiredError("another process holds this sign-in");
    return held.value;
  }

  private async connect(interactive: boolean): Promise<Client> {
    const capabilities = this.hooks.clientCapabilities();
    const forwardsElicitation = Boolean(capabilities.elicitation) && Boolean(this.hooks.onElicit);
    this.provider.interactive = interactive;
    try {
      for (let attempt = 1; ; attempt++) {
        const transport = new StreamableHTTPClientTransport(this.endpoint, { authProvider: this.provider, fetch: this.provider.fetch });
        const client = new Client(this.clientInfo ?? { name: "bytebase-mcp", version: "0" }, {
          capabilities: forwardsElicitation ? { elicitation: capabilities.elicitation } : {},
        });
        if (forwardsElicitation) {
          client.setRequestHandler(ElicitRequestSchema, async (request) => this.hooks.onElicit!(request.params));
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
    } finally {
      this.provider.interactive = false;
    }
  }
}

function findSignInRequired(err: unknown): SignInRequiredError | undefined {
  for (let e: unknown = err; e; e = (e as { cause?: unknown }).cause) {
    if (e instanceof SignInRequiredError) return e;
  }
  return undefined;
}

/** Errors that show the instance never received the request. */
function neverReceived(err: unknown): boolean {
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
