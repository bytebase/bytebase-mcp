# Bytebase MCP

[![npm](https://img.shields.io/npm/v/@bytebase/bytebase-mcp)](https://www.npmjs.com/package/@bytebase/bytebase-mcp)

The official npm package for the [Bytebase](https://www.bytebase.com) MCP server. It lets AI assistants that can only run MCP servers as local commands use the MCP server built into your Bytebase instance: query data, inspect schemas, and propose database changes, all under Bytebase's approvals, access control, data masking, and audit logging.

```
  AI assistant  --stdio-->  bytebase-mcp  --HTTPS + OAuth-->  <your Bytebase>/mcp  -->  your databases
```

The package contains no Bytebase logic. Once you sign in, it lists your instance's own tools and forwards every call to the instance, where permissions, the workspace MCP access policy, approvals and audit apply exactly as in the console. Nothing is stored locally except the OAuth token.

> Most clients, including Claude Code, Claude Desktop, Cursor, Codex, Copilot CLI, Gemini CLI and VS Code, connect to remote MCP servers over HTTP. They do not need this package: point them straight at `<your Bytebase URL>/mcp`. See the [MCP integration docs](https://docs.bytebase.com/integrations/mcp). This package is for clients that only start local commands, and for MCP directories.

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

When the server first starts, it opens your browser on Bytebase's authorization page. Sign in, review what the session may do, and click **Allow**. Bytebase shows your AI client by name there, and each client application signs in once per instance. The token is stored under `~/.bytebase-mcp/` with owner-only permissions and refreshed automatically; several sessions share it safely. Set `BYTEBASE_MCP_NO_BROWSER=1` to print the sign-in URL instead of opening a browser.

### Commands

| Command | What it does |
| --- | --- |
| `bytebase-mcp` | Serve MCP over stdio (what your client runs) |
| `bytebase-mcp status` | Show the instance, its tool list and the stored sign-ins, without signing in |
| `bytebase-mcp logout` | Revoke and forget every sign-in stored for the instance (does not sign you out of the console). To switch accounts: log out, reconnect the server in your client, sign in as the other account |

Every command takes `--url <bytebase-url>` in place of `BYTEBASE_URL`.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `BYTEBASE_URL` | – | External URL of the instance. Required to call tools. |
| `BYTEBASE_MCP_HOME` | `~/.bytebase-mcp` | Where sign-ins live, one per instance and client app |
| `BYTEBASE_MCP_CALLBACK_PORT` | `51789` | Loopback port that receives the OAuth redirect |
| `BYTEBASE_MCP_NO_BROWSER` | unset | Set to `1` to print the sign-in URL instead of opening a browser |

## Tools

Once you sign in, the tools are the ones your instance serves, so an older or newer Bytebase shows its own. The table below is a snapshot, the list MCP directories see before any instance is configured:

<!-- tools:start -->
Generated from Bytebase main at 9daf6b307f (2026-11-22).

| Tool | Purpose |
| --- | --- |
| `administer_workspace` | Make a workspace administration change that the user confirms in this client first. |
| `call_api` | Execute a Bytebase API endpoint. |
| `decide_issue` | Approve or reject a Bytebase issue at its current approval step. |
| `get_gitops_workflow` | Return the workflow files that set up GitOps for a project. |
| `get_schema` | Inspect a Bytebase database's schema. |
| `grant_masking_exemption` | Exempt one member from data masking in a Bytebase project, for one database (optionally one schema, table, or columns of one table) or for every database in the project. |
| `propose_database_change` | Run DDL/DML changes (ALTER TABLE, CREATE TABLE, INSERT, UPDATE, migrations) against a Bytebase database. |
| `query_database` | Execute a SQL query against a Bytebase database. |
| `reauthorize` | Log out the current MCP OAuth connection so the client can run OAuth again. |
| `request_access_grant` | Request an access grant: time-boxed permission to run one read-only statement on one Bytebase database, optionally with results unmasked or exported. |
| `revoke_masking_exemption` | Remove one member's masking exemption in a Bytebase project. |
| `search_api` | Discover Bytebase API endpoints. |
| `set_just_in_time_access` | Turn just-in-time access on or off for one Bytebase project. |
<!-- tools:end -->

## How it works

1. With `BYTEBASE_URL` set, the server answers `initialize` at once. If you have signed in before, it opens a session first and passes on your instance's own instructions; otherwise it starts the browser sign-in, and announces your instance's tools with `tools/list_changed` once you have signed in.
2. It connects to `<BYTEBASE_URL>/mcp` over Streamable HTTP. With no valid token it runs the OAuth authorization-code flow with PKCE: discovery through `/.well-known/oauth-protected-resource/mcp`, dynamic client registration, browser sign-in, loopback redirect.
3. Tool lists, tool calls, results and confirmation forms pass through unchanged, paging included.
4. Without `BYTEBASE_URL`, the server lists the bundled snapshot so MCP directories can show Bytebase's tools, and every tool call says to set `BYTEBASE_URL`. A configured server never uses the snapshot.

The design, with every state the server can be in, is in [docs/DESIGN.md](docs/DESIGN.md).

## Development

Building, testing (against a local Bytebase and in a real client), keeping the tool snapshot current and releasing are covered in [CONTRIBUTING.md](CONTRIBUTING.md). The design is in [docs/DESIGN.md](docs/DESIGN.md).

## License

MIT. Bytebase itself is licensed separately; see [bytebase/bytebase](https://github.com/bytebase/bytebase).
