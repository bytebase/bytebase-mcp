import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Implementation } from "@modelcontextprotocol/sdk/types.js";
import { FileLock } from "./lock.js";
import { log } from "./log.js";

interface StoredState {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
}

/** Bytebase rejects a longer client_name (backend/api/oauth2/register.go). */
const MAX_CLIENT_NAME = 200;

/** The client application a sign-in belongs to (docs/DESIGN.md, D6). */
export interface ClientIdentity {
  /** File name for its sign-in. */
  key: string;
  /** What Bytebase shows on the consent page. */
  clientName: string;
}

export function clientIdentity(info: Implementation | undefined): ClientIdentity {
  const name = info?.name?.trim() || "unknown-client";
  const label = info?.title?.trim() || name;
  return {
    key: name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100),
    clientName: `${label} via Bytebase MCP`.slice(0, MAX_CLIENT_NAME),
  };
}

/** Directory holding an instance's sign-ins: host, port and path, so instances under different paths do not collide. */
export function instanceDir(home: string, instanceUrl: URL): string {
  const key = `${instanceUrl.hostname}${instanceUrl.port ? `_${instanceUrl.port}` : ""}${instanceUrl.pathname.replace(/\/+$/, "")}`;
  return path.join(home, key.replace(/[^A-Za-z0-9._-]/g, "_"));
}

/** A sign-in was needed where the proxy may not start one (docs/DESIGN.md, D7). */
export class SignInRequiredError extends Error {
  constructor(message = "sign-in needed") {
    super(message);
    this.name = "SignInRequiredError";
  }
}

export interface FileOAuthClientProviderOptions {
  home: string;
  callbackPort: number;
  openBrowser: boolean;
  signInTimeoutMs?: number;
}

/**
 * Marks work done while this async chain holds a sign-in's lock, so it does not
 * wait on itself. Work the holder starts can outlive it (the SDK's event stream
 * does), so the mark counts only while `active` is true.
 */
const lockHeld = new AsyncLocalStorage<{ file: string; active: boolean }>();

/**
 * One session opening that may start a browser sign-in (D7), and the state of
 * that sign-in. The state lives here, not on the shared provider, so nothing
 * outside the opening (a retired session's own OAuth attempt) can overwrite
 * it. A session the opening starts can outlive it, so this counts only while
 * `active` is true.
 */
export interface SignInPermit {
  active: boolean;
  state?: string;
  verifier?: string;
  pendingCode?: Promise<string>;
}

export const signInPermitted = new AsyncLocalStorage<SignInPermit>();

/** The permit of the opening this work belongs to, if it is still in progress. */
function activePermit(): SignInPermit | undefined {
  const permit = signInPermitted.getStore();
  return permit?.active ? permit : undefined;
}

/**
 * Keeps one client application's sign-in to one Bytebase instance in a 0600
 * file, under the rules of docs/DESIGN.md D7: the file is written only while
 * holding its lock; signing in and refreshing each run under it; the PKCE
 * verifier stays in memory; a refused credential is deleted only if the file
 * still holds what this process sent.
 */
export class FileOAuthClientProvider implements OAuthClientProvider {
  readonly file: string;
  private readonly lock: FileLock;
  private readonly options: Required<FileOAuthClientProviderOptions>;
  private readonly identity: ClientIdentity;
  private lastSentRefreshToken?: string;
  /** The access token the instance last refused, to tell newer tokens on disk from the rejected ones. */
  private lastRejectedAccessToken?: string;

  constructor(instanceUrl: URL, identity: ClientIdentity, options: FileOAuthClientProviderOptions) {
    this.options = { signInTimeoutMs: 5 * 60 * 1000, ...options };
    this.identity = identity;
    this.file = path.join(instanceDir(options.home, instanceUrl), `${identity.key}.json`);
    this.lock = new FileLock(this.file);
  }

  get redirectUrl(): string {
    return `http://127.0.0.1:${this.options.callbackPort}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.identity.clientName,
      client_uri: "https://github.com/bytebase/bytebase-mcp",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  /** Whether the file holds tokens, without opening anything. */
  hasStoredSignIn(): boolean {
    return Boolean(this.read().tokens);
  }

  /**
   * Runs fn while holding the sign-in's lock. With `wait: false` it returns
   * undefined at once when another holder has the lock.
   */
  async withLock<T>(fn: () => Promise<T>, { wait }: { wait: boolean }): Promise<{ value: T } | undefined> {
    const held = lockHeld.getStore();
    if (held?.active && held.file === this.file) return { value: await fn() };
    const release = await this.lock.acquire({ wait });
    if (!release) return undefined;
    const mark = { file: this.file, active: true };
    try {
      return { value: await lockHeld.run(mark, fn) };
    } finally {
      mark.active = false;
      release();
    }
  }

  state(): string {
    const value = randomBytes(16).toString("hex");
    const permit = activePermit();
    if (permit) permit.state = value;
    return value;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.read().clientInformation;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await this.writeUnderLock((state) => {
      state.clientInformation = clientInformation;
    });
  }

  tokens(): OAuthTokens | undefined {
    return this.read().tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.writeUnderLock((state) => {
      // The fetch wrapper already wrote a refresh's result; only the SDK's issuer stamp may be new.
      if (state.tokens?.access_token === tokens.access_token) {
        state.tokens = { ...state.tokens, ...tokens };
        return;
      }
      state.tokens = tokens;
    });
  }

  saveCodeVerifier(codeVerifier: string): void {
    const permit = activePermit();
    if (permit) permit.verifier = codeVerifier;
  }

  codeVerifier(): string {
    const verifier = activePermit()?.verifier;
    if (!verifier) throw new Error("No PKCE code verifier for this sign-in; restart the sign-in");
    return verifier;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "verifier") {
      const permit = activePermit();
      if (permit) permit.verifier = undefined;
      return;
    }
    if (scope === "discovery") return;
    const sent = this.lastSentRefreshToken;
    await this.writeUnderLock((state) => {
      // Another process may have replaced what this one sent; leave its credentials alone.
      if (state.tokens && sent && state.tokens.refresh_token !== sent) return;
      if (scope === "tokens" || scope === "all") delete state.tokens;
      if (scope === "client" || scope === "all") delete state.clientInformation;
    });
  }

  /** Forgets this sign-in. */
  async clear(): Promise<void> {
    await this.withLock(async () => fs.rmSync(this.file, { force: true }), { wait: true });
  }

  /**
   * The fetch the SDK transport sends through. A refresh runs under the lock
   * from the request until its result is on disk; the SDK built the request
   * from tokens it read earlier, so a request whose refresh token is no longer
   * on disk is answered with the tokens on disk instead of being sent.
   */
  readonly fetch: FetchLike = async (input, init) => {
    const sent = refreshTokenIn(init);
    if (!sent) {
      const response = await fetch(input, init);
      if (response.status === 401) this.lastRejectedAccessToken = bearerIn(init) ?? this.lastRejectedAccessToken;
      return response;
    }
    this.lastSentRefreshToken = sent;
    const held = await this.withLock(
      async () => {
        const onDisk = this.read().tokens;
        const newerOnDisk =
          onDisk?.refresh_token !== undefined &&
          (onDisk.refresh_token !== sent || (this.lastRejectedAccessToken !== undefined && onDisk.access_token !== this.lastRejectedAccessToken));
        if (onDisk && newerOnDisk) {
          this.lastSentRefreshToken = onDisk.refresh_token;
          const { issuer: _issuer, ...body } = onDisk as OAuthTokens & { issuer?: string };
          return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        const response = await fetch(input, init);
        if (response.ok) {
          const tokens = (await response.clone().json()) as OAuthTokens;
          this.write({ ...this.read(), tokens });
        }
        return response;
      },
      { wait: true },
    );
    return held!.value;
  };

  /**
   * Called by the SDK when a sign-in is needed. Refused unless a session is
   * being opened for a tool call or S4; otherwise starts the loopback listener,
   * under the machine-wide lock on the callback port, and hands the URL to the
   * browser.
   */
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    const permit = activePermit();
    if (!permit) throw new SignInRequiredError();
    const expectedState = permit.state;
    const portLock = new FileLock(path.join(this.options.home, `callback-${this.options.callbackPort}`));
    const release = await portLock.acquire({ wait: true });
    const { listening, code } = this.listenForCode(expectedState);
    permit.pendingCode = code.finally(() => release?.());
    // The URL is printed only once the callback can be received.
    await listening;
    log(`Sign in to Bytebase to continue:\n  ${authorizationUrl.toString()}`);
    if (this.options.openBrowser) openInBrowser(authorizationUrl.toString());
  }

  async waitForAuthorizationCode(): Promise<string> {
    const permit = activePermit();
    if (!permit?.pendingCode) throw new Error("No sign-in in progress");
    try {
      return await permit.pendingCode;
    } finally {
      permit.pendingCode = undefined;
    }
  }

  private async writeUnderLock(change: (state: StoredState) => void): Promise<void> {
    await this.withLock(
      async () => {
        const state = this.read();
        change(state);
        this.write(state);
      },
      { wait: true },
    );
  }

  private listenForCode(expectedState: string | undefined): { listening: Promise<void>; code: Promise<string> } {
    let onListening!: () => void;
    let onListenFailed!: (err: Error) => void;
    const listening = new Promise<void>((resolve, reject) => {
      onListening = resolve;
      onListenFailed = reject;
    });
    const code = new Promise<string>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.options.callbackPort}`);
        if (url.pathname !== "/callback") {
          res.writeHead(404).end("Not found");
          return;
        }
        const error = url.searchParams.get("error");
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (error) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end(page("Sign-in failed", `Bytebase answered: ${escapeHtml(error)}. You can close this tab.`));
          finish(new Error(`authorization refused: ${error}`));
          return;
        }
        if (!code) {
          res.writeHead(400).end("Missing code");
          return;
        }
        if (expectedState && state !== expectedState) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end(page("Sign-in failed", "The state parameter did not match. Start the sign-in again."));
          finish(new Error("authorization state mismatch"));
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page("Signed in", "Bytebase MCP is connected. You can close this tab and return to your AI assistant."));
        finish(undefined, code);
      });
      const timer = setTimeout(() => finish(new Error(`sign-in timed out after ${Math.round(this.options.signInTimeoutMs / 1000)}s`)), this.options.signInTimeoutMs);
      let done = false;
      const finish = (err: Error | undefined, code?: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        setTimeout(() => server.close(), 100);
        if (err) reject(err);
        else resolve(code as string);
      };
      server.on("error", (err: NodeJS.ErrnoException) => {
        const failure = err.code === "EADDRINUSE" ? new Error(`port ${this.options.callbackPort} is in use; set BYTEBASE_MCP_CALLBACK_PORT to a free port and run \`bytebase-mcp logout\` so the new redirect URL is registered`) : err;
        onListenFailed(failure);
        finish(failure);
      });
      server.listen(this.options.callbackPort, "127.0.0.1", () => onListening());
    });
    // A listen failure rejects both; the caller awaits `listening` first.
    code.catch(() => undefined);
    return { listening, code };
  }

  private read(): StoredState {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8")) as StoredState;
    } catch {
      return {};
    }
  }

  private write(state: StoredState): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

function bearerIn(init: RequestInit | undefined): string | undefined {
  const header = new Headers(init?.headers).get("authorization");
  return header?.toLowerCase().startsWith("bearer ") ? header.slice("bearer ".length) : undefined;
}

function refreshTokenIn(init: RequestInit | undefined): string | undefined {
  if (!init || (init.method ?? "GET").toUpperCase() !== "POST" || !init.body) return undefined;
  const body = init.body instanceof URLSearchParams ? init.body : typeof init.body === "string" ? new URLSearchParams(init.body) : undefined;
  if (!body || body.get("grant_type") !== "refresh_token") return undefined;
  return body.get("refresh_token") ?? undefined;
}

function openInBrowser(url: string): void {
  let command: string;
  let args: string[];
  switch (process.platform) {
    case "darwin":
      command = "open";
      args = [url];
      break;
    case "win32":
      command = "cmd";
      args = ["/c", "start", "", url.replace(/&/g, "^&")];
      break;
    default:
      command = "xdg-open";
      args = [url];
  }
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    /* the URL is printed to stderr */
  }
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)} - Bytebase MCP</title>
<style>body{font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#1f2937}h1{font-size:1.5rem}</style></head>
<body><h1>${escapeHtml(title)}</h1><p>${body}</p></body></html>`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}
