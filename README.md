# Bytebase MCP

[![npm](https://img.shields.io/npm/v/@bytebase/bytebase-mcp)](https://www.npmjs.com/package/@bytebase/bytebase-mcp)

The official npm package for the [Bytebase](https://www.bytebase.com) MCP server. It lets AI assistants that can only run MCP servers as local commands use the MCP server built into your Bytebase instance: query data, inspect schemas, and propose database changes, all under Bytebase's approvals, access control, data masking, and audit logging.

```
  AI assistant  --stdio-->  bytebase-mcp  --HTTPS + OAuth-->  <your Bytebase>/mcp  -->  your databases
```

The package contains no Bytebase logic and no copy of Bytebase's tools. It reads the tool list from your instance's public catalog (`<your Bytebase URL>/mcp/catalog`) and forwards every call to the instance, where permissions, the workspace MCP access policy, approvals and audit apply exactly as in the console. Nothing is stored locally except the OAuth token.

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

The first tool call opens your browser on Bytebase's authorization page. Sign in, review what the session may do, and click **Allow**. Bytebase shows your AI client by name there, and each client application signs in once per instance. The token is stored under `~/.config/bytebase-mcp/` with owner-only permissions and refreshed automatically; several sessions share it safely. Set `BYTEBASE_MCP_NO_BROWSER=1` to print the sign-in URL instead of opening a browser.

### Commands

| Command | What it does |
| --- | --- |
| `bytebase-mcp` | Serve MCP over stdio (what your client runs) |
| `bytebase-mcp status` | Show the instance, its tool list and the stored sign-ins, without signing in |
| `bytebase-mcp logout` | Forget every sign-in stored for the instance |

Every command takes `--url <bytebase-url>` in place of `BYTEBASE_URL`.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `BYTEBASE_URL` | – | External URL of the instance. Required to call tools. |
| `BYTEBASE_MCP_HOME` | `~/.config/bytebase-mcp` | Where token files live, one per instance host |
| `BYTEBASE_MCP_CALLBACK_PORT` | `51789` | Loopback port that receives the OAuth redirect |
| `BYTEBASE_MCP_NO_BROWSER` | unset | Set to `1` to print the sign-in URL instead of opening a browser |
| `BYTEBASE_MCP_PUBLIC_CATALOG_URL` | Bytebase Cloud's | The catalog listed when `BYTEBASE_URL` is unset; for tests |

## Tools

The tools are Bytebase's, read from your instance at startup, so you always see the ones your Bytebase release has. See the [MCP integration docs](https://docs.bytebase.com/integrations/mcp) for what each does.

What each session may do is set on the instance: the signed-in user's permissions, narrowed by the workspace [MCP access policy](https://docs.bytebase.com/integrations/mcp#access-policy) (Disabled, Read-only, Read-write). Actions that need confirmation (approving an issue, granting a masking exemption) show a confirmation form in clients that support MCP elicitation; the package forwards the form to your client.

## How it works

1. On start, the server reads `<BYTEBASE_URL>/mcp/catalog`, the tool list and instructions every Bytebase instance serves without sign-in, and answers `initialize` and `tools/list` from it. With no `BYTEBASE_URL` it reads Bytebase Cloud's catalog instead, so MCP directories can list the tools, and every tool call says to set `BYTEBASE_URL`.
2. On the first `tools/call`, it connects to `<BYTEBASE_URL>/mcp` over Streamable HTTP. With no valid token it runs the OAuth authorization-code flow with PKCE: discovery through `/.well-known/oauth-protected-resource/mcp`, dynamic client registration, browser sign-in, loopback redirect.
3. Tool calls, results and confirmation forms pass through unchanged. Once a session is open, the tool list comes from it.

An instance older than the catalog route lists its tools only after you sign in. The design, with every state the server can be in, is in [docs/DESIGN.md](docs/DESIGN.md).

## Development

Design notes for reviewers and maintainers: [docs/DESIGN.md](docs/DESIGN.md).

```bash
npm install
npm run build
npm test                 # tests against a fake Bytebase; no instance needed
```

### Releasing

```bash
npm version patch        # bumps package.json and server.json together
git push origin main --follow-tags
```

A push to `main` that changes `package.json` runs [`npm-publish.yml`](.github/workflows/npm-publish.yml): it publishes to npm with OIDC provenance, then registers the version in the [MCP Registry](https://registry.modelcontextprotocol.io) with `mcp-publisher`. No tokens are stored in the repository.

## License

MIT. Bytebase itself is licensed separately; see [bytebase/bytebase](https://github.com/bytebase/bytebase).
