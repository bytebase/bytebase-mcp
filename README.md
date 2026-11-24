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
- **Your instance is on a private network, or on your own machine, and your client connects from the cloud.** A client that connects from your machine, such as Claude Code, reaches a local or private instance directly and does not need this. Claude Desktop and claude.ai do not: their custom connectors [connect from Anthropic's cloud](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp), so an instance on `localhost` or behind a VPN or firewall is out of their reach. This package runs on your machine and reaches whatever your machine can.
- **The client cannot complete the sign-in with your instance.**
- **You are installing from an MCP directory** that lists servers by package.

## What you can do

Two things bound what the assistant can do: the MCP access policy an admin sets for the workspace (**Read-only** or **Read-write**), and your own Bytebase permissions. Below are three flows in pictures, then the full list.

### Database change

Describe the change in the chat. Bytebase turns it into a plan and an issue and runs the plan checks. The project's approval policy decides whether it needs approval, the same as a change raised in the console. Needs the Read-write policy.

![You ask to add a phone column to the customer table. The assistant calls propose_database_change. Bytebase creates a plan and an issue, runs checks, and waits for approval before rollout.](https://raw.githubusercontent.com/bytebase/bytebase-mcp/main/docs/images/scenario-change.svg)

### Access control

The assistant signs in as you, through Bytebase, and never holds a database password. Two controls apply to what it reads.

**Dynamic data masking.** It reaches the databases your account can reach, and the columns your project masks come back masked.

![You ask which customers signed up last week. The assistant calls query_database. Bytebase checks access, masks the email column, logs the query and returns the rows.](https://raw.githubusercontent.com/bytebase/bytebase-mcp/main/docs/images/scenario-query.svg)

**Just-in-time access.** When it needs to read something your account cannot, it requests a time-boxed grant to run one specific read statement. The grant starts only once it is approved, and ends on its own. Needs the Read-write policy and a project that allows access grants.

![You ask to look at one order in production. The assistant calls request_access_grant. Once the request is approved, Bytebase allows that statement for a limited window, after which there is no access.](https://raw.githubusercontent.com/bytebase/bytebase-mcp/main/docs/images/scenario-access.svg)

The images illustrate the flow. What you see depends on your instance's policies.

### The full list

This is what each policy allows in Bytebase 3.25, in the product's own words. The MCP Integration page in your Bytebase console shows the list for your version.

**Read-only allows**

| Capability | Includes |
| --- | --- |
| Read schemas and metadata | Schemas, databases and instances, projects and database groups, changelogs, SQL review configs |
| Read data by running queries | Read-only queries, your own query history, saved queries you have access to |
| Read the change workflow | Issues and comments, plans and plan checks, rollouts and their logs, releases |
| Read members, roles and policies | Roles and groups, masking rules and exemptions, approval rules, access grants |

**Read-write adds**

| Capability | Includes |
| --- | --- |
| Propose changes | Create and edit plans and issues, run plan checks and reviews, generate schema diffs |
| Request access grants | A time-boxed grant to run a specific read statement, optionally with results unmasked or exported |
| Grant or revoke masking exemptions | For a database, a schema, a table or a column, with an optional expiry |
| Approve or reject issues | The approval rules and the project's self-approval setting apply, as in the console |
| Run rollouts and tasks | Create a rollout, then run, skip or cancel its tasks, under the project's approval policy |
| Run DML and DDL statements | Through queries, as far as the engine and your own permissions allow |
| Export query results | Export results as files |
| Administer the workspace | Add a PostgreSQL instance to a project, create a CI identity for GitOps, manage the approval rules for database changes, set masking rules |
| Housekeeping | Sync instances and databases, manage saved queries |

Approvals, masking exemptions and administration changes are each confirmed in your MCP client before they are made.

**Never, in any mode:** raise this policy, create a service account key, change a person's password, email or MFA, show a stored secret, open an Admin mode session, or read anyone else's query history.

The tools behind these are listed under [Tools](#tools).

## Why go through Bytebase

Bytebase sits between your users, people and AI agents alike, and your databases.

![Bytebase as one control plane between people, AI agents and applications on one side and your databases on the other](https://raw.githubusercontent.com/bytebase/bytebase/main/docs/assets/middleware.svg)

An assistant connected through this package works inside the same rules as everyone else on the instance:

- **Change management**: a change the assistant proposes becomes a plan and an issue in Bytebase. Plan checks run on it, and approval and rollout follow the project's policy.
- **Access control**: the assistant acts as the account that signed in and can do only what that account can. An admin sets the ceiling for every MCP session in the workspace: Disabled, Read-only or Read-write. Queries return data with the project's masking applied, and the assistant can request time-boxed access instead of holding standing permissions.
- **Compliance**: what the assistant does is recorded in Bytebase's audit log, as it is for the console.

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

## Bytebase MCP or DBHub?

| | Bytebase MCP | [DBHub](https://github.com/bytebase/dbhub) |
| --- | --- | --- |
| Connects to | Your Bytebase instance | Databases directly, with a connection string |
| Needs Bytebase | Yes | No |
| Sign-in | Your Bytebase account, through OAuth | Database credentials |
| Changes | Proposed as plans and issues under the project's approval policy. Direct writes only where the workspace policy and your permissions allow | Run on the database directly; a read-only mode is available |
| Best for | Teams that govern database access and changes | Local development and lightweight read access |

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
