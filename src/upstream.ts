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
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import { FileOAuthClientProvider } from "./auth.js";
import { mcpEndpoint, type Config } from "./config.js";
import { log } from "./log.js";
import { PACKAGE_VERSION } from "./version.js";

export interface UpstreamHooks {
  /** Capabilities to declare to Bytebase: the ones the downstream client declared to us. */
  clientCapabilities: () => ClientCapabilities;
  /** Forward an elicitation (confirmation form) from Bytebase to the downstream client. */
  onElicit?: (params: ElicitRequest["params"]) => Promise<ElicitResult>;
  /** Bytebase changed its tool list. */
  onToolListChanged?: () => void;
}

/**
 * One connection to a Bytebase instance's /mcp endpoint, opened lazily and
 * re-opened after it drops. Sign-in runs through {@link FileOAuthClientProvider}.
 */
export class Upstream {
  private readonly endpoint: URL;
  private readonly provider: FileOAuthClientProvider;
  private client?: Client;
  private connecting?: Promise<Client>;

  constructor(private readonly config: Config & { url: URL }, private readonly hooks: UpstreamHooks) {
    this.endpoint = mcpEndpoint(config.url);
    this.provider = new FileOAuthClientProvider(config.url, {
      home: config.home,
      callbackPort: config.callbackPort,
      openBrowser: config.openBrowser,
    });
  }

  get tokenFile(): string {
    return this.provider.tokenFile;
  }

  /** Returns the connected client, signing in and connecting when needed. */
  async get(): Promise<Client> {
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = this.connect().finally(() => {
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

  /** Forgets the stored sign-in for this instance. */
  signOut(): void {
    this.reset();
    this.provider.clear();
  }

  async listTools(): Promise<ListToolsResult> {
    return this.withRetry((client) => client.request({ method: "tools/list", params: {} }, ListToolsResultSchema));
  }

  async callTool(params: CallToolRequest["params"]): Promise<CallToolResult> {
    // Raw request rather than client.callTool(): the latter validates
    // structuredContent against a tool list it may not have fetched, and this
    // package passes results through untouched.
    return this.withRetry((client) => client.request({ method: "tools/call", params }, CallToolResultSchema));
  }

  /** Runs fn once; if the session dropped underneath it, reconnects and runs it once more. */
  private async withRetry<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const client = await this.get();
    try {
      return await fn(client);
    } catch (err) {
      if (!isConnectionLoss(err)) throw err;
      log(`connection to ${this.endpoint} dropped (${describe(err)}); reconnecting`);
      this.reset();
      return fn(await this.get());
    }
  }

  private async connect(): Promise<Client> {
    const capabilities = this.hooks.clientCapabilities();
    const forwardsElicitation = Boolean(capabilities.elicitation) && Boolean(this.hooks.onElicit);

    for (let attempt = 1; ; attempt++) {
      const transport = new StreamableHTTPClientTransport(this.endpoint, { authProvider: this.provider });
      const client = new Client(
        { name: "bytebase-mcp", title: "Bytebase MCP (npm)", version: PACKAGE_VERSION },
        {
          capabilities: {
            ...(forwardsElicitation ? { elicitation: capabilities.elicitation } : {}),
          },
        },
      );
      if (forwardsElicitation) {
        client.setRequestHandler(ElicitRequestSchema, async (request) => this.hooks.onElicit!(request.params));
      }
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        this.hooks.onToolListChanged?.();
      });
      client.onclose = () => {
        if (this.client === client) this.client = undefined;
      };
      client.onerror = (err) => {
        // Closing a session aborts its SSE stream; that is not an error worth a line.
        if (/AbortError|operation was aborted/.test(describe(err))) return;
        log(`upstream error: ${describe(err)}`);
      };

      try {
        await client.connect(transport);
        this.client = client;
        return client;
      } catch (err) {
        if (err instanceof UnauthorizedError && attempt === 1) {
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

function isConnectionLoss(err: unknown): boolean {
  const text = describe(err).toLowerCase();
  return (
    text.includes("not connected") ||
    text.includes("session not found") ||
    text.includes("econnreset") ||
    text.includes("econnrefused") ||
    text.includes("fetch failed") ||
    text.includes("terminated") ||
    text.includes("http 404") ||
    text.includes("http 401")
  );
}

/** A next step for the errors users hit most. */
function hint(err: unknown): string {
  const text = describe(err);
  if (/Protected resource .* does not match/i.test(text)) {
    return ". BYTEBASE_URL must be the instance's external URL (Settings > General > External URL), because Bytebase binds MCP tokens to it";
  }
  if (/sign-in timed out/i.test(text)) {
    return ". Run `bytebase-mcp login` to sign in again";
  }
  return "";
}

export function describe(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    return cause && cause !== err ? `${err.message} (${describe(cause)})` : err.message;
  }
  return String(err);
}
