// A fake Bytebase for tests: serves the public catalog and the protected-resource
// document the proxy classifies an instance with, and records every request.
import http from "node:http";

export const CATALOG = {
  instructions: "Fake Bytebase routing instructions.",
  instructionsWithoutForm: "Fake form paragraph: confirm writes in chat.",
  tools: [
    { name: "query_database", description: "Run a query.", inputSchema: { type: "object", properties: {} } },
    { name: "get_schema", description: "Read a schema.", inputSchema: { type: "object", properties: {} } },
  ],
};

/**
 * Starts the fake. `catalog` is what GET /mcp/catalog answers: "json" (CATALOG),
 * "html" (the console page an instance without the route serves), or "none" (404).
 * `resourceMetadata` makes /.well-known/oauth-protected-resource/mcp name this
 * server's /mcp, the way a Bytebase instance does.
 */
export async function startFakeBytebase({ catalog = "json", resourceMetadata = true } = {}) {
  const requests = [];
  const state = { catalog, resourceMetadata };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push(`${req.method} ${url.pathname}`);
    if (req.method === "GET" && url.pathname === "/mcp/catalog") {
      if (state.catalog === "json") {
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(CATALOG));
      } else if (state.catalog === "html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end("<!doctype html><html>console</html>");
      } else {
        res.writeHead(404).end();
      }
      return;
    }
    if (req.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource/mcp" && state.resourceMetadata) {
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({ resource: `${base}/mcp`, authorization_servers: [base] }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    url: base,
    requests,
    /** Changes what the catalog route answers from now on. */
    setCatalog(next) {
      state.catalog = next;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
