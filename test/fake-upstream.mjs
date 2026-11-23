// A fake Bytebase for tests: the protected-resource document,
// an OAuth server (registration, a browser leg that redirects at once, single-use
// refresh tokens) and an MCP endpoint that requires its tokens. It records what
// the proxy sent.
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";

/** The tools the fake's MCP endpoint serves. */
export const FAKE_TOOLS = {
  tools: [
    { name: "query_database", description: "Run a query.", inputSchema: { type: "object", properties: {} } },
    { name: "get_schema", description: "Read a schema.", inputSchema: { type: "object", properties: {} } },
  ],
};

/** What the fake's MCP endpoint says at initialize, as Bytebase does: an account line first. */
export const SESSION_INSTRUCTIONS = "In workspaces/ws-fake, this session acts as the Bytebase account dev@example.com.\n\nFake session instructions.";

/**
 * Starts the fake. Without `resourceMetadata` it answers like a server that is
 * not Bytebase. `pageSize` makes tools/list page; `port` fixes the port.
 */
export async function startFakeBytebase({ resourceMetadata = true, pageSize = 0, port = 0 } = {}) {
  const sessions = new Map();
  const requests = [];
  const state = { resourceMetadata, refreshDelayMs: 0, listDelayMs: 0, callDelayMs: 0, revokeStalls: false };
  const registrations = [];
  const initializes = [];
  const toolCalls = [];
  const toolLists = [];
  const revocations = [];
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
        revocation_endpoint: `${base}/revoke`,
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
    if (req.method === "POST" && url.pathname === "/revoke" && state.revokeStalls) {
      return; // accepts the connection and never answers
    }
    if (req.method === "POST" && url.pathname === "/revoke") {
      const form = new URLSearchParams(await readBody(req));
      revocations.push({ token: form.get("token"), clientId: form.get("client_id") });
      refreshTokens.delete(form.get("token"));
      res.writeHead(200).end();
      return;
    }
    if (req.method === "POST" && url.pathname === "/token") {
      const form = new URLSearchParams(await readBody(req));
      if (form.get("grant_type") === "authorization_code" && codes.delete(form.get("code"))) {
        json(res, 200, issue());
      } else if (form.get("grant_type") === "refresh_token") {
        refreshes++;
        if (state.refreshDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.refreshDelayMs));
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
        if (message.method === "tools/call") {
          toolCalls.push(message.params);
          if (state.callDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.callDelayMs));
        }
        if (message.method === "tools/list") {
          toolLists.push(message.params);
          if (state.listDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.listDelayMs));
        }
      }
      const sessionId = req.headers["mcp-session-id"];
      if (sessionId) {
        const transport = sessions.get(sessionId);
        if (!transport) {
          json(res, 404, { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Session not found" } });
          return;
        }
        await transport.handleRequest(req, res, body);
        return;
      }
      const mcp = new McpServer({ name: "fake-bytebase", version: "0.0.0" }, { instructions: SESSION_INSTRUCTIONS });
      for (const tool of FAKE_TOOLS.tools) {
        mcp.registerTool(tool.name, { description: tool.description }, async () => ({ content: [{ type: "text", text: `ran ${tool.name}` }] }));
      }
      if (pageSize > 0) {
        // Pages the list like a server with a small page size; the cursor is an offset.
        mcp.server.setRequestHandler(ListToolsRequestSchema, async (request) => {
          const offset = Number(request.params?.cursor ?? 0);
          const tools = FAKE_TOOLS.tools.slice(offset, offset + pageSize).map((tool) => ({ ...tool }));
          const next = offset + pageSize;
          return next < FAKE_TOOLS.tools.length ? { tools, nextCursor: String(next) } : { tools };
        });
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => sessions.set(id, transport),
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    url: base,
    requests,
    registrations,
    initializes,
    toolCalls,
    toolLists,
    revocations,
    get refreshes() {
      return refreshes;
    },
    /** Revokes every access token, so the next MCP request needs a refresh. */
    expireAccessTokens() {
      accessTokens.clear();
    },
    /** Stops listening, like an outage: connections are refused; tokens survive. */
    goDown() {
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(resolve));
    },
    /** Listens again on the same port after goDown. */
    comeBack() {
      return new Promise((resolve) => server.listen(Number(new URL(base).port), "127.0.0.1", resolve));
    },
    /** Forgets every MCP session, as Bytebase does after an hour idle. */
    expireSessions() {
      sessions.clear();
    },
    /** Revokes every token, so the next MCP request needs a new sign-in. */
    revokeAllTokens() {
      accessTokens.clear();
      refreshTokens.clear();
    },
    /** Delays answers to tools/call, as a long-running tool would. */
    set callDelayMs(ms) {
      state.callDelayMs = ms;
    },
    /** Makes the revocation endpoint accept requests and never answer. */
    set revokeStalls(value) {
      state.revokeStalls = value;
    },
    /** Delays answers to tools/list, as a slow instance would. */
    set listDelayMs(ms) {
      state.listDelayMs = ms;
    },
    /** Delays answers to refresh requests, as a slow instance would. */
    set refreshDelayMs(ms) {
      state.refreshDelayMs = ms;
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
