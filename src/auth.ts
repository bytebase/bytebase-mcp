import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { log } from "./log.js";

interface StoredState {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}

export interface FileOAuthClientProviderOptions {
  /** Directory that holds one token file per instance host. */
  home: string;
  /** Loopback port the authorization redirect comes back on. */
  callbackPort: number;
  /** Open the authorization URL in the default browser. The URL is printed to stderr either way. */
  openBrowser: boolean;
  /** How long to wait for the user to finish signing in. */
  signInTimeoutMs?: number;
}

/**
 * Keeps the OAuth client registration, tokens and PKCE verifier for one
 * Bytebase instance in a 0600 file under `home`, and runs the browser leg of
 * the authorization-code flow on a loopback listener.
 *
 * The MCP SDK drives the rest: discovery through the instance's
 * `/.well-known/oauth-protected-resource/mcp`, dynamic client registration,
 * PKCE, token exchange and refresh.
 */
export class FileOAuthClientProvider implements OAuthClientProvider {
  private readonly file: string;
  private readonly options: Required<FileOAuthClientProviderOptions>;
  private state_: StoredState;
  private pendingState?: string;
  private pendingCode?: Promise<string>;

  constructor(instanceUrl: URL, options: FileOAuthClientProviderOptions) {
    this.options = { signInTimeoutMs: 5 * 60 * 1000, ...options };
    const hostKey = `${instanceUrl.hostname}${instanceUrl.port ? `_${instanceUrl.port}` : ""}`.replace(/[^A-Za-z0-9._-]/g, "_");
    this.file = path.join(options.home, `${hostKey}.json`);
    this.state_ = this.read();
  }

  get tokenFile(): string {
    return this.file;
  }

  get redirectUrl(): string {
    return `http://127.0.0.1:${this.options.callbackPort}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Bytebase MCP (npm)",
      client_uri: "https://github.com/bytebase/bytebase-mcp",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    this.pendingState = randomBytes(16).toString("hex");
    return this.pendingState;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.state_.clientInformation;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    this.state_.clientInformation = clientInformation;
    this.write();
  }

  tokens(): OAuthTokens | undefined {
    // Re-read: another bytebase-mcp process (MCP clients start one per session)
    // may have refreshed the single-use refresh token since we last looked.
    this.state_ = this.read();
    return this.state_.tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.state_.tokens = tokens;
    this.write();
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.state_.codeVerifier = codeVerifier;
    this.write();
  }

  codeVerifier(): string {
    const verifier = this.state_.codeVerifier;
    if (!verifier) {
      throw new Error("No PKCE code verifier saved; restart the sign-in");
    }
    return verifier;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    switch (scope) {
      case "all":
        this.state_ = {};
        break;
      case "client":
        delete this.state_.clientInformation;
        break;
      case "tokens":
        delete this.state_.tokens;
        break;
      case "verifier":
        delete this.state_.codeVerifier;
        break;
      case "discovery":
        break;
    }
    this.write();
  }

  /** Forgets everything stored for this instance. */
  clear(): void {
    this.state_ = {};
    if (fs.existsSync(this.file)) {
      fs.unlinkSync(this.file);
    }
  }

  /**
   * Called by the SDK when a sign-in is needed. Starts the loopback listener,
   * then hands the URL to the browser. The SDK throws UnauthorizedError right
   * after; the caller then awaits {@link waitForAuthorizationCode}.
   */
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    const expectedState = this.pendingState;
    this.pendingCode = this.listenForCode(expectedState);
    log(`Sign in to Bytebase to continue:\n  ${authorizationUrl.toString()}`);
    if (this.options.openBrowser) {
      openInBrowser(authorizationUrl.toString());
    }
  }

  /** Resolves with the authorization code once the browser redirects back. */
  async waitForAuthorizationCode(): Promise<string> {
    if (!this.pendingCode) {
      throw new Error("No sign-in in progress");
    }
    try {
      return await this.pendingCode;
    } finally {
      this.pendingCode = undefined;
    }
  }

  private listenForCode(expectedState: string | undefined): Promise<string> {
    return new Promise<string>((resolve, reject) => {
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
          finish(new Error(`authorization refused: ${error}${url.searchParams.get("error_description") ? ` (${url.searchParams.get("error_description")})` : ""}`));
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

      const timer = setTimeout(() => {
        finish(new Error(`sign-in timed out after ${Math.round(this.options.signInTimeoutMs / 1000)}s`));
      }, this.options.signInTimeoutMs);

      let done = false;
      const finish = (err: Error | undefined, code?: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        // Let the response flush before closing.
        setTimeout(() => server.close(), 100);
        if (err) reject(err);
        else resolve(code as string);
      };

      server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          finish(new Error(`port ${this.options.callbackPort} is in use; set BYTEBASE_MCP_CALLBACK_PORT to a free port (the redirect URL registered with Bytebase must match, so clear ~/.config/bytebase-mcp if you change it)`));
        } else {
          finish(err);
        }
      });
      server.listen(this.options.callbackPort, "127.0.0.1");
    });
  }

  private read(): StoredState {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8")) as StoredState;
    } catch {
      return {};
    }
  }

  private write(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state_, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
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
    child.on("error", () => {
      /* the URL is already printed; nothing else to do */
    });
    child.unref();
  } catch {
    /* ignore: the URL is printed to stderr */
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
