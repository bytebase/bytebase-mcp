import fs from "node:fs";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * The tool definitions shipped with this package, dumped from a Bytebase
 * release's built-in MCP server by `npm run sync-tools`. They let a directory
 * (Glama, the MCP Registry, awesome lists) start the server and read its tool
 * list without a Bytebase instance; a connected instance's live list wins.
 */
export interface BundledTools {
  /** Bytebase version the definitions were read from. */
  bytebaseVersion: string;
  generatedAt: string;
  /** Initialize instructions of the built-in server, without the per-session account line. */
  instructions: string;
  tools: Tool[];
}

export function loadBundledTools(): BundledTools {
  const file = new URL("./tools.json", import.meta.url);
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as BundledTools;
  if (!Array.isArray(parsed.tools)) {
    throw new Error("tools.json is malformed: missing tools array");
  }
  return parsed;
}
