#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { log } from "./log.js";
import { serveStdio } from "./server.js";
import { Upstream, describe } from "./upstream.js";
import { PACKAGE_VERSION } from "./version.js";

const HELP = `bytebase-mcp ${PACKAGE_VERSION}

MCP server for Bytebase. Forwards tool calls to your Bytebase instance over its OAuth-protected /mcp endpoint.

Usage:
  bytebase-mcp [--url <bytebase-url>]   Serve MCP over stdio (default)
  bytebase-mcp login [--url <url>]      Sign in to the instance now and store the token
  bytebase-mcp logout [--url <url>]     Forget the stored sign-in for the instance
  bytebase-mcp whoami [--url <url>]     Show the instance, token file and tool count

Environment:
  BYTEBASE_URL                 External URL of the Bytebase instance (required to call tools)
  BYTEBASE_MCP_HOME            Token directory (default ~/.config/bytebase-mcp)
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
  const upstream = new Upstream({ ...config, url: config.url }, { clientCapabilities: () => ({}) });

  switch (command) {
    case "login": {
      const client = await upstream.get();
      const info = client.getServerVersion();
      log(`signed in to ${config.url} (Bytebase ${info?.version ?? "unknown"}); token stored at ${upstream.tokenFile}`);
      upstream.reset();
      return;
    }
    case "logout":
      upstream.signOut();
      log(`removed ${upstream.tokenFile}`);
      return;
    case "whoami": {
      const client = await upstream.get();
      const info = client.getServerVersion();
      const tools = await upstream.listTools();
      process.stdout.write(
        `${JSON.stringify(
          {
            url: config.url.toString(),
            bytebaseVersion: info?.version,
            tokenFile: upstream.tokenFile,
            tools: tools.tools.map((t) => t.name),
          },
          null,
          2,
        )}\n`,
      );
      upstream.reset();
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
