# Bytebase MCP

[![npm](https://img.shields.io/npm/v/@bytebase/bytebase-mcp)](https://www.npmjs.com/package/@bytebase/bytebase-mcp)
[![Bytebase MCP server](https://glama.ai/mcp/servers/bytebase/bytebase-mcp/badges/score.svg)](https://glama.ai/mcp/servers/bytebase/bytebase-mcp)

**Let AI assistants work with your databases under the same review, access control and audit as your team.**

[Docs](https://docs.bytebase.com/integrations/mcp) · [npm](https://www.npmjs.com/package/@bytebase/bytebase-mcp) · [Bytebase](https://github.com/bytebase/bytebase) · [Install Bytebase](https://docs.bytebase.com/get-started/self-host-vs-cloud)

> [!NOTE]
> Bytebase MCP needs a running [Bytebase](https://github.com/bytebase/bytebase) instance, either Bytebase Cloud or self-hosted. It does nothing without one. If you want a standalone database MCP server that connects straight to a database, see [DBHub](https://github.com/bytebase/dbhub).

The official npm package for the MCP server built into [Bytebase](https://github.com/bytebase/bytebase), the open-source database governance platform. AI assistants query data, inspect schemas and propose database changes through your Bytebase instance, under its approvals, access control, data masking and audit logging.

![Two ways into the MCP server built into Bytebase: a client connects straight to it or runs this package locally, and Bytebase applies approval, access control, masking and audit in front of your databases](https://raw.githubusercontent.com/bytebase/bytebase-mcp/main/docs/images/architecture.svg)

The package contains no Bytebase logic. Once you sign in, it lists your instance's own tools and forwards every call to the instance, where permissions, the workspace MCP access policy, approvals and audit apply exactly as in the console. Nothing is stored locally except the OAuth token.

## Two ways to connect

Bytebase serves MCP over HTTP at `<your Bytebase URL>/mcp`. A client can connect to it directly, or run this package on your machine and let it forward. Both reach the same server, with the same tools and the same permissions.

| | Connect directly | Use this package |
| --- | --- | --- |
| How | Add `<your Bytebase URL>/mcp` as a remote MCP server. See the [MCP integration docs](https://docs.bytebase.com/integrations/mcp). | Add the `npx` command under [Setup](#setup). |
| Works with | Clients that connect to remote MCP servers over HTTP. Claude Code, Claude Desktop, Cursor, Codex, Copilot CLI, Gemini CLI and VS Code all do. | Any client that can start an MCP server as a local command |
| On your machine | Nothing to install | Node.js, and a small local process that signs in through your browser |

Connecting directly is the shorter path when it works. Use this package when:

- **Your client only starts local MCP servers.**
- **Your client connects from the cloud and your instance is private.** Claude Desktop and claude.ai reach remote servers [from Anthropic's cloud](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp), so an instance on `localhost` or behind a VPN or firewall is out of their reach. A client that connects from your machine, such as Claude Code, does not have this limit.
- **The client cannot complete the sign-in with your instance.**
- **You are installing from an MCP directory** that lists servers by package.

## What you can do

Two things bound what the assistant can do: the MCP access policy an admin sets for the workspace, and your own Bytebase permissions. This is what each policy allows in Bytebase 3.25, condensed from the list the console shows on its MCP Integration page.

| Policy | Capability | Includes |
| --- | --- | --- |
| Read-only | Read schemas and metadata | Schemas, databases and instances, projects, changelogs, SQL review configs |
| Read-only | Read data by running queries | Read-only queries, as far as the engine can show a statement is a read. Masked columns come back masked |
| Read-only | Read the change workflow | Issues, plans and plan checks, rollouts and their logs, releases |
| Read-only | Read members, roles and policies | Roles and groups, masking rules and exemptions, approval rules, access grants |
| Read-write | Propose changes | Create plans and issues and run plan checks. The project's approval policy decides whether a change needs approval |
| Read-write | Request just-in-time access | A time-boxed grant to run one specific read statement. It starts only once approved, and ends on its own |
| Read-write | Grant or revoke masking exemptions | For a database, a schema, a table or a column, with an optional expiry |
| Read-write | Approve or reject issues | The approval rules and the project's self-approval setting apply, as in the console |
| Read-write | Run rollouts and tasks | Create a rollout, then run, skip or cancel its tasks, under the project's approval policy |
| Read-write | Run DML and DDL statements | Through queries, as far as the engine and your own permissions allow. Where your client supports confirmations, you confirm each one first |
| Read-write | Export query results | Export results as files |
| Read-write | Administer the workspace | Add a PostgreSQL instance to a project, create a CI identity for GitOps, manage approval rules for database changes, set masking rules |

Read-write includes everything under Read-only. Approvals, masking exemptions and administration changes are each confirmed in your MCP client before they are made.

**Never, in any mode:** raise this policy, create a service account key, change a person's password, email or MFA, show a stored secret, open an Admin mode session, or read anyone else's query history.

## Why go through Bytebase

The assistant works inside the same rules as everyone else on the instance:

- **Change management**: a change it proposes becomes a plan and an issue, with plan checks, approval and rollout under the project's policy.
- **Access control**: it signs in as you and never holds a database password. It can do only what your account can, masked data stays masked, and it requests time-boxed access instead of holding standing permissions.
- **Compliance**: what it does is recorded in Bytebase's audit log.

Bytebase supports PostgreSQL, MySQL, SQL Server, Oracle, MongoDB and [more](https://docs.bytebase.com/introduction/supported-databases).

## Requirements

- A running [Bytebase](https://github.com/bytebase/bytebase) instance, 3.22 or later, on Bytebase Cloud or self-hosted. No instance yet? See [self-host or cloud](https://docs.bytebase.com/get-started/self-host-vs-cloud) to start one. The instance needs its [external URL](https://docs.bytebase.com/get-started/self-host/external-url) configured and the workspace MCP access policy not set to **Disabled**.
- Node.js 20 or later, on macOS or Linux. Windows has not been tested yet. If your browser does not open at sign-in there, find the sign-in URL in the server's output (your client's MCP log) and open it yourself.
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
| `bytebase-mcp status` | Show the instance and the stored sign-ins, without signing in |
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
Generated from Bytebase 3.25.0.

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
