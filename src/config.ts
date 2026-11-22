import os from "node:os";
import path from "node:path";
import { PUBLIC_CATALOG_URL } from "./catalog.js";

export interface Config {
  /** Base URL of the Bytebase instance, or undefined when none is configured. */
  url?: URL;
  /** The public catalog an unconfigured proxy lists (Bytebase Cloud's unless overridden for tests). */
  publicCatalogUrl: URL;
  /** Directory holding the OAuth token files. */
  home: string;
  /** Loopback port that receives the OAuth redirect. */
  callbackPort: number;
  /** Whether to open the sign-in URL in a browser (otherwise print it). */
  openBrowser: boolean;
}

export const DEFAULT_CALLBACK_PORT = 51789;

export function defaultHome(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "bytebase-mcp");
}

/** Normalizes a user-supplied Bytebase URL: trims, drops a trailing slash and a trailing /mcp. */
export function parseBytebaseUrl(raw: string): URL {
  let text = raw.trim();
  if (!/^https?:\/\//i.test(text)) {
    text = `https://${text}`;
  }
  const url = new URL(text);
  url.hash = "";
  url.search = "";
  let pathname = url.pathname.replace(/\/+$/, "");
  if (pathname.endsWith("/mcp")) {
    pathname = pathname.slice(0, -"/mcp".length);
  }
  url.pathname = pathname;
  return url;
}

/** The MCP endpoint of an instance: its external URL followed by /mcp. */
export function mcpEndpoint(url: URL): URL {
  const endpoint = new URL(url.toString());
  endpoint.pathname = `${url.pathname.replace(/\/+$/, "")}/mcp`;
  return endpoint;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, urlOverride?: string): Config {
  const raw = urlOverride ?? env.BYTEBASE_URL;
  const url = raw && raw.trim().length > 0 ? parseBytebaseUrl(raw) : undefined;
  const home = env.BYTEBASE_MCP_HOME && env.BYTEBASE_MCP_HOME.length > 0 ? env.BYTEBASE_MCP_HOME : defaultHome();
  const portText = env.BYTEBASE_MCP_CALLBACK_PORT;
  let callbackPort = DEFAULT_CALLBACK_PORT;
  if (portText && portText.length > 0) {
    const parsed = Number.parseInt(portText, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      throw new Error(`BYTEBASE_MCP_CALLBACK_PORT must be a port number, got "${portText}"`);
    }
    callbackPort = parsed;
  }
  const noBrowser = env.BYTEBASE_MCP_NO_BROWSER;
  const openBrowser = !(noBrowser && noBrowser !== "0" && noBrowser.toLowerCase() !== "false");
  const publicCatalogUrl = new URL(env.BYTEBASE_MCP_PUBLIC_CATALOG_URL || PUBLIC_CATALOG_URL);
  return { url, publicCatalogUrl, home, callbackPort, openBrowser };
}
