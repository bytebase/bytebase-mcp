# Bytebase MCP

[![npm](https://img.shields.io/npm/v/@bytebase/bytebase-mcp)](https://www.npmjs.com/package/@bytebase/bytebase-mcp)

The official npm package for the [Bytebase](https://www.bytebase.com) MCP server. It lets AI assistants that run MCP servers as local commands (Claude Desktop, Cursor, Windsurf, and others) use the MCP server built into your Bytebase instance: query data, inspect schemas, and propose database changes, all under Bytebase's approvals, access control, data masking, and audit logging.

```
  AI assistant  --stdio-->  bytebase-mcp  --HTTPS + OAuth-->  <your Bytebase>/mcp  -->  your databases
```

The package contains no database logic of its own. It ships the tool definitions of Bytebase's built-in MCP server and forwards every call to your instance, where permissions, the workspace MCP access policy, approvals and audit apply exactly as in the console. Nothing is cached or executed locally except the OAuth token.

> If your client supports remote MCP servers over HTTP (Claude Code, Codex, Copilot CLI, Gemini CLI, VS Code, Claude Desktop connectors), you do not need this package: point the client straight at `<your Bytebase URL>/mcp`. See the [MCP integration docs](https://docs.bytebase.com/integrations/mcp).

## Requirements

- A Bytebase instance, 3.22 or later, with its [external URL](https://docs.bytebase.com/get-started/self-host/external-url) configured and the workspace MCP access policy not set to **Disabled**.
- Node.js 20 or later.
- A Bytebase account. The package signs you in through Bytebase's own OAuth; it never sees your password.

## Setup

Add the server to your MCP client with your instance's external URL:

```json
{
  "mcpServers": {
    "bytebase": {
      "command": "npx",
      "args": ["-y", "@bytebase/bytebase-mcp"],
      "env": {
        "BYTEBASE_URL": "https://bytebase.example.com"
      }
    }
  }
}
```

The first tool call opens your browser on Bytebase's authorization page. Sign in, review what the session may do, and click **Allow**. The token is stored under `~/.config/bytebase-mcp/` with owner-only permissions and refreshed automatically.

To sign in ahead of time, or on a machine without a browser:

```bash
BYTEBASE_URL=https://bytebase.example.com npx -y @bytebase/bytebase-mcp login
BYTEBASE_MCP_NO_BROWSER=1 BYTEBASE_URL=https://bytebase.example.com npx -y @bytebase/bytebase-mcp login   # prints the URL instead
```

### Commands

| Command | What it does |
| --- | --- |
| `bytebase-mcp` | Serve MCP over stdio (what your client runs) |
| `bytebase-mcp login` | Sign in now and store the token |
| `bytebase-mcp logout` | Forget the stored sign-in |
| `bytebase-mcp whoami` | Show the instance, token file, and the live tool list |

Every command takes `--url <bytebase-url>` in place of `BYTEBASE_URL`.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `BYTEBASE_URL` | – | External URL of the instance. Required to call tools. |
| `BYTEBASE_MCP_HOME` | `~/.config/bytebase-mcp` | Where token files live, one per instance host |
| `BYTEBASE_MCP_CALLBACK_PORT` | `51789` | Loopback port that receives the OAuth redirect |
| `BYTEBASE_MCP_NO_BROWSER` | unset | Set to `1` to print the sign-in URL instead of opening a browser |

## Tools

The tools are Bytebase's. The list below is generated from the release named in `src/tools.json`; a connected instance's live list replaces it, so an older or newer Bytebase shows its own tools.

<!-- tools:start -->
Generated from Bytebase 3.24.1.

| Tool | Purpose |
| --- | --- |
| `call_api` | Execute a Bytebase API endpoint. |
| `decide_issue` | Approve or reject a Bytebase issue at its current approval step. |
| `get_schema` | Inspect a Bytebase database's schema. |
| `get_skill` | Get step-by-step guides for Bytebase tasks. |
| `grant_masking_exemption` | Exempt one member from data masking in a Bytebase project, for one database (optionally one schema, table or column) or for every database in the project. |
| `propose_database_change` | Run DDL/DML changes (ALTER TABLE, CREATE TABLE, INSERT, UPDATE, migrations) against a Bytebase database. |
| `query_database` | Execute a SQL query against a Bytebase database. |
| `reauthorize` | Log out the current MCP OAuth connection so the client can run OAuth again. |
| `revoke_masking_exemption` | Remove one member's masking exemption in a Bytebase project. |
| `search_api` | Discover Bytebase API endpoints. |
| `set_just_in_time_access` | Turn just-in-time access on or off for one Bytebase project. |
<!-- tools:end -->

What each session may do is set on the instance: the signed-in user's permissions, narrowed by the workspace [MCP access policy](https://docs.bytebase.com/integrations/mcp#access-policy) (Disabled, Read-only, Read-write). Actions that need confirmation (approving an issue, granting a masking exemption) show a confirmation form in clients that support MCP elicitation; the package forwards the form to your client.

## How it works

1. On start, the server answers `initialize` and `tools/list` from the bundled definitions, so your client has the tool list at once, and so MCP directories can read it without an instance.
2. On the first `tools/call` (or in the background after `tools/list` when `BYTEBASE_URL` is set), it connects to `<BYTEBASE_URL>/mcp` over Streamable HTTP. If there is no valid token it runs the OAuth authorization-code flow with PKCE: discovery through `/.well-known/oauth-protected-resource/mcp`, dynamic client registration, browser sign-in, loopback redirect.
3. Tool calls, results and elicitation requests pass through unchanged. If the live tool list differs from the bundle, the server sends `tools/list_changed`.

Bytebase's refresh tokens are single-use and MCP clients start one process per session, so the token file is re-read before each refresh and written atomically.

## Development

Design notes for reviewers and maintainers: [docs/DESIGN.md](docs/DESIGN.md).

```bash
npm install
npm run build
npm test                 # unit + cold-start smoke tests, no instance needed
```

### Keeping the tool definitions in sync

`src/tools.json` is generated, never edited. Before each release, dump the tool list from an instance running the Bytebase version you want to ship with:

```bash
npm run build
BYTEBASE_URL=https://your-bytebase npm run sync-tools
```

The script signs in like the package does and prints what changed. Commit the result with the version bump.

### Releasing

```bash
npm version patch        # bumps package.json and server.json together
git push origin main --follow-tags
```

A push to `main` that changes `package.json` runs [`npm-publish.yml`](.github/workflows/npm-publish.yml): it publishes to npm with OIDC provenance, then registers the version in the [MCP Registry](https://registry.modelcontextprotocol.io) with `mcp-publisher`. No tokens are stored in the repository.

## License

MIT. Bytebase itself is licensed separately; see [bytebase/bytebase](https://github.com/bytebase/bytebase).
