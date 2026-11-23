#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { log } from "./log.js";
import { serveStdio } from "./server.js";
import { describe } from "./upstream.js";
import { instanceDir } from "./auth.js";
import { probeInstance } from "./probe.js";
import { discoverOAuthServerInfo } from "@modelcontextprotocol/sdk/client/auth.js";
import { FileLock } from "./lock.js";
import { mcpEndpoint } from "./config.js";
import fs from "node:fs";
import path from "node:path";
import { PACKAGE_VERSION } from "./version.js";

const HELP = `bytebase-mcp ${PACKAGE_VERSION}

MCP server for Bytebase. Reads the tool list from your Bytebase instance and forwards tool calls to its OAuth-protected /mcp endpoint.

Usage:
  bytebase-mcp [--url <bytebase-url>]   Serve MCP over stdio (default); signs in when the server starts
  bytebase-mcp logout [--url <url>]     Forget every sign-in stored for the instance
  bytebase-mcp status [--url <url>]     Show the instance and the stored sign-ins

Environment:
  BYTEBASE_URL                 External URL of the Bytebase instance (required to call tools)
  BYTEBASE_MCP_HOME            Sign-in directory (default ~/.bytebase-mcp)
  BYTEBASE_MCP_CALLBACK_PORT   Loopback port for the OAuth redirect (default 51789)
  BYTEBASE_MCP_NO_BROWSER=1    Print the sign-in URL instead of opening a browser

Docs: https://docs.bytebase.com/integrations/mcp
`;

function parseArgs(argv: string[]): { command: string; url?: string } {
  let command = "serve";
  let url: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--url" || arg === "-u") {
      url = argv[++i];
      if (!url) throw new Error("--url needs a value");
    } else if (arg.startsWith("--url=")) {
      url = arg.slice("--url=".length);
    } else if (arg === "--help" || arg === "-h") {
      command = "help";
    } else if (arg === "--version" || arg === "-v") {
      command = "version";
    } else if (!arg.startsWith("-") && command === "serve") {
      command = arg;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  return { command, url };
}

async function main(): Promise<void> {
  const { command, url } = parseArgs(process.argv.slice(2));
  if (command === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (command === "version") {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    return;
  }

  const config = loadConfig(process.env, url);

  if (command === "serve") {
    await serveStdio(config);
    return;
  }

  if (!config.url) {
    throw new Error(`${command} needs a Bytebase URL: pass --url or set BYTEBASE_URL`);
  }
  const dir = instanceDir(config.home, config.url);
  switch (command) {
    case "logout":
      await logout(config.url, dir);
      return;
    case "status": {
      const probe = await probeInstance(config.url, AbortSignal.timeout(5000));
      // A file left by an interrupted sign-in holds a registration but no tokens.
      const signIns = fs.existsSync(dir)
        ? fs
            .readdirSync(dir)
            .filter((name) => name.endsWith(".json") && hasTokens(path.join(dir, name)))
            .map((name) => name.slice(0, -".json".length))
        : [];
      process.stdout.write(
        `${JSON.stringify(
          {
            url: config.url.toString(),
            bytebase: probe.kind === "bytebase" ? true : { answer: probe.kind, detail: probe.detail },
            signIns,
            signInDirectory: dir,
          },
          null,
          2,
        )}\n`,
      );
      return;
    }
    default:
      throw new Error(`unknown command ${command}\n\n${HELP}`);
  }
}

main().catch((err) => {
  log(describe(err));
  process.exit(1);
});

function hasTokens(file: string): boolean {
  try {
    return Boolean((JSON.parse(fs.readFileSync(file, "utf8")) as { tokens?: unknown }).tokens);
  } catch {
    return false;
  }
}

/** How long logout waits on the instance for each request; the sign-ins are deleted either way. */
const REVOKE_BOUND_MS = 5000;

/**
 * Forgets every sign-in stored for the instance. Each refresh token is revoked
 * at the instance first, so a copy of the file stops working too; a sign-in is
 * removed under its own lock, so it never races a refresh.
 */
async function logout(instanceUrl: URL, dir: string): Promise<void> {
  const instance = instanceUrl.toString().replace(/\/$/, "");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith(".json")) : [];
  let revocationEndpoint: string | undefined;
  try {
    const info = await discoverOAuthServerInfo(mcpEndpoint(instanceUrl), {
      fetchFn: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(REVOKE_BOUND_MS) }),
    });
    revocationEndpoint = (info.authorizationServerMetadata as { revocation_endpoint?: string } | undefined)?.revocation_endpoint;
  } catch (err) {
    log(`cannot reach ${instance} to revoke (${describe(err)}); the stored sign-ins are deleted and expire there on their own`);
  }
  for (const name of files) {
    const file = path.join(dir, name);
    const release = await new FileLock(file).acquire({ wait: true });
    try {
      const stored = readStored(file);
      const token = stored.tokens?.refresh_token;
      const clientId = stored.clientInformation?.client_id;
      if (revocationEndpoint && token && clientId) {
        const response = await fetch(revocationEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token, token_type_hint: "refresh_token", client_id: clientId }),
          signal: AbortSignal.timeout(REVOKE_BOUND_MS),
        }).catch((err: unknown) => err as Error);
        if (response instanceof Error || !response.ok) {
          log(`could not revoke ${name.slice(0, -".json".length)} at ${instance}; it expires there on its own`);
        }
      }
      fs.rmSync(file, { force: true });
    } finally {
      release?.();
    }
  }
  log(`removed ${files.length} sign-in(s) for ${instance} (${dir})`);
}

function readStored(file: string): { tokens?: { refresh_token?: string }; clientInformation?: { client_id?: string } } {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as ReturnType<typeof readStored>;
  } catch {
    return {};
  }
}
