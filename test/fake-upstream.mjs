// A fake Bytebase for tests: the public catalog, the protected-resource document,
// an OAuth server (registration, a browser leg that redirects at once, single-use
// refresh tokens) and an MCP endpoint that requires its tokens. It records what
// the proxy sent.
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export const CATALOG = {
  instructions: "Fake Bytebase routing instructions.",
  instructionsWithoutForm: "Fake form paragraph: confirm writes in chat.",
  tools: [
    { name: "query_database", description: "Run a query.", inputSchema: { type: "object", properties: {} } },
    { name: "get_schema", description: "Read a schema.", inputSchema: { type: "object", properties: {} } },
  ],
};

/** What the fake's MCP endpoint says at initialize, as Bytebase does: an account line first. */
export const SESSION_INSTRUCTIONS = "In workspaces/ws-fake, this session acts as the Bytebase account dev@example.com.\n\nFake session instructions.";

/**
 * Starts the fake. `catalog` is what GET /mcp/catalog answers: "json" (CATALOG),
 * "html" (the console page an instance without the route serves), or "none" (404).
 */
export async function startFakeBytebase({ catalog = "json", resourceMetadata = true } = {}) {
  const requests = [];
  const state = { catalog, resourceMetadata };
  const registrations = [];
  const initializes = [];
  const toolCalls = [];
  let refreshes = 0;
  let counter = 0;
  const codes = new Set();
  const accessTokens = new Set();
  const refreshTokens = new Set();

  const issue = () => {
    const access = `at-${++counter}`;
    const refresh = `rt-${counter}`;
    accessTokens.add(access);
    refreshTokens.add(refresh);
    return { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 3600 };
  };
  const json = (res, status, body) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  const readBody = (req) =>
    new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => resolve(data));
    });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push(`${req.method} ${url.pathname}`);

    if (req.method === "GET" && url.pathname === "/mcp/catalog") {
      if (state.catalog === "json") json(res, 200, CATALOG);
      else if (state.catalog === "html") res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end("<!doctype html><html>console</html>");
      else res.writeHead(404).end();
      return;
    }
    if (req.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource/mcp" && state.resourceMetadata) {
      json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
      return;
    }
    if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
      json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/register") {
      const body = JSON.parse(await readBody(req));
      registrations.push(body);
      json(res, 201, { ...body, client_id: `client-${registrations.length}` });
      return;
    }
    if (req.method === "GET" && url.pathname === "/authorize") {
      const code = `code-${++counter}`;
      codes.add(code);
      const redirect = new URL(url.searchParams.get("redirect_uri"));
      redirect.searchParams.set("code", code);
      redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
      res.writeHead(302, { Location: redirect.toString() }).end();
      return;
    }
    if (req.method === "POST" && url.pathname === "/token") {
      const form = new URLSearchParams(await readBody(req));
      if (form.get("grant_type") === "authorization_code" && codes.delete(form.get("code"))) {
        json(res, 200, issue());
      } else if (form.get("grant_type") === "refresh_token") {
        refreshes++;
        if (refreshTokens.delete(form.get("refresh_token"))) json(res, 200, issue());
        else json(res, 400, { error: "invalid_grant", error_description: "refresh token reused" });
      } else {
        json(res, 400, { error: "invalid_grant" });
      }
      return;
    }
    if (url.pathname === "/mcp") {
      const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (!accessTokens.has(bearer)) {
        res
          .writeHead(401, { "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` })
          .end();
        return;
      }
      const raw = req.method === "POST" ? await readBody(req) : "";
      const body = raw ? JSON.parse(raw) : undefined;
      for (const message of Array.isArray(body) ? body : body ? [body] : []) {
        if (message.method === "initialize") initializes.push(message.params);
        if (message.method === "tools/call") toolCalls.push(message.params);
      }
      const mcp = new McpServer({ name: "fake-bytebase", version: "0.0.0" }, { instructions: SESSION_INSTRUCTIONS });
      for (const tool of CATALOG.tools) {
        mcp.registerTool(tool.name, { description: tool.description }, async () => ({ content: [{ type: "text", text: `ran ${tool.name}` }] }));
      }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    url: base,
    requests,
    registrations,
    initializes,
    toolCalls,
    get refreshes() {
      return refreshes;
    },
    /** Changes what the catalog route answers from now on. */
    setCatalog(next) {
      state.catalog = next;
    },
    /** Revokes every access token, so the next MCP request needs a refresh. */
    expireAccessTokens() {
      accessTokens.clear();
    },
    close: () => {
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Plays the browser: follows a sign-in URL to the proxy's loopback callback. */
export async function completeSignIn(authorizationUrl) {
  const first = await fetch(authorizationUrl, { redirect: "manual" });
  const callback = first.headers.get("location");
  if (!callback) throw new Error(`authorize did not redirect (HTTP ${first.status})`);
  const done = await fetch(callback);
  if (!done.ok) throw new Error(`callback answered HTTP ${done.status}`);
}
