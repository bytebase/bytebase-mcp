#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { log } from "./log.js";
import { serveStdio } from "./server.js";
import { describe } from "./upstream.js";
import { instanceDir } from "./auth.js";
import { catalogUrl, fetchCatalog } from "./catalog.js";
import fs from "node:fs";
import { PACKAGE_VERSION } from "./version.js";

const HELP = `bytebase-mcp ${PACKAGE_VERSION}

MCP server for Bytebase. Reads the tool list from your Bytebase instance and forwards tool calls to its OAuth-protected /mcp endpoint.

Usage:
  bytebase-mcp [--url <bytebase-url>]   Serve MCP over stdio (default); the first tool call signs in
  bytebase-mcp logout [--url <url>]     Forget every sign-in stored for the instance
  bytebase-mcp status [--url <url>]     Show the instance, its tool list and the stored sign-ins

Environment:
  BYTEBASE_URL                 External URL of the Bytebase instance (required to call tools)
  BYTEBASE_MCP_HOME            Sign-in directory (default ~/.config/bytebase-mcp)
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
      fs.rmSync(dir, { recursive: true, force: true });
      log(`removed the sign-ins for ${config.url.toString().replace(/\/$/, "")} (${dir})`);
      return;
    case "status": {
      const probe = await fetchCatalog(catalogUrl(config.url), AbortSignal.timeout(5000));
      const signIns = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length)) : [];
      process.stdout.write(
        `${JSON.stringify(
          {
            url: config.url.toString(),
            catalog: probe.kind === "catalog" ? { tools: probe.catalog.tools.map((tool) => tool.name) } : { unavailable: probe.detail },
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
