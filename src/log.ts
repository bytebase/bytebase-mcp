/** All diagnostics go to stderr: stdout is the MCP stdio transport. */
export function log(message: string): void {
  process.stderr.write(`[bytebase-mcp] ${message}\n`);
}
