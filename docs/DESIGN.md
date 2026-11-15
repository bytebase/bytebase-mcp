# Design notes

Context for reviewers and maintainers. Written 2026-11-16 by Adela (with Claude) when the
package was first built, so nobody has to redo the research. Linear: BYT-10055.

## 1. Problem

Bytebase ships an MCP server inside the product at `<external URL>/mcp` (Streamable HTTP,
OAuth-protected; code in `backend/api/mcp/`). It works, but it cannot be listed in any MCP
directory:

- Directories (Glama, the official MCP Registry, awesome-mcp-servers) list servers they can
  **start themselves** and read `tools/list` from, **without signing in**. The built-in server
  only runs inside the Bytebase process and refuses everything before OAuth.
- Result: Bytebase is absent from every directory. AI-visibility data (W43) ranks us 3rd on
  the MCP topic, but none of the top-6 cited sources is ours; all six are standalone server
  repos.
- A third party filled the gap: `ahmedbally/bytebase-mcp` holds the npm name `bytebase-mcp`
  and ranks first for "bytebase" on Glama. It reimplements 14 tools of its own on top of the
  Connect-RPC API, does its own read/write gating, and has not been maintained since
  2026-09-14.

## 2. What this package is

A stdio MCP server (what every directory and local-only client can start) that does two
things and nothing else:

1. **Ships the built-in server's tool definitions** (`src/tools.json`) so `initialize` and
   `tools/list` work with no instance. This is what makes the directory cold start pass.
2. **Forwards `tools/call` and elicitation to `<BYTEBASE_URL>/mcp`**, signing in with the
   instance's own OAuth. Results pass through untouched. Permissions, the workspace MCP
   access policy, approvals, masking and audit stay on the instance.

It deliberately contains **no tool logic of its own**. The third-party package is a parallel
implementation that drifts from the product; this one cannot drift because it has nothing to
drift.

```
AI client --stdio--> bytebase-mcp --Streamable HTTP + OAuth--> <Bytebase>/mcp --> databases
```

Users whose client speaks remote MCP (Claude Code, Codex, Copilot CLI, Gemini CLI, VS Code,
Claude Desktop connectors) do not need this package and should keep pointing at `/mcp`
directly. The package is for (a) directories and (b) clients that only start local commands
(Cursor, Windsurf, older clients).

## 3. How the pieces fit

| File | Role |
| --- | --- |
| `src/index.ts` | CLI: `serve` (default), `login`, `logout`, `whoami`, `--url` |
| `src/server.ts` | Downstream stdio `Server`. Answers `tools/list` from the bundle at once, never blocking on sign-in; kicks off a background live fetch and sends `tools/list_changed` if the live list differs. `tools/call` goes to the upstream. Elicitation requests from Bytebase are forwarded with `server.elicitInput`. |
| `src/upstream.ts` | One lazy `Client` to `<url>/mcp` over `StreamableHTTPClientTransport` with an `authProvider`. Reconnects once on connection loss. Declares `elicitation` to Bytebase only if the downstream client declared it to us. |
| `src/auth.ts` | `OAuthClientProvider` backed by one 0600 JSON file per instance host under `~/.config/bytebase-mcp/`. The SDK does discovery (`/.well-known/oauth-protected-resource/mcp`), dynamic client registration, PKCE, token exchange and refresh. This file adds the browser leg: loopback listener on `127.0.0.1:51789/callback`, opens the browser, verifies `state`. |
| `src/tools.json` | Generated. `bytebaseVersion`, `instructions`, `tools[]` as served by that release. |
| `scripts/sync-tools.mjs` | Connects like the package does, dumps `tools/list` + initialize instructions, strips the per-session account line, rewrites `src/tools.json` and the README tools table, prints the diff. |
| `scripts/check-live.mjs` | Manual end-to-end: start `dist/index.js` as a client would, call `search_api` and `call_api` through it. |
| `server.json`, `glama.json`, `.github/workflows/npm-publish.yml` | Copied from `bytebase/dbhub`: MCP Registry metadata, Glama maintainer claim, npm OIDC publish → `mcp-publisher publish`. |

Dependency: `@modelcontextprotocol/sdk` 1.x only (1.32.2 at time of writing). It negotiates
protocol 2025-11-25, which is also the ceiling the Go server answers with
(`legacyProtocolCeiling`), so the newer 2026-07-28 `InputRequests`/`RequestState` multi
round-trip shape never comes up; confirmations arrive as in-call `elicitation/create` requests
and are forwarded as such.

## 4. Decisions and why

- **Why ship tool definitions instead of a pure proxy.** Glama starts the server with no
  instance. A pure proxy would answer `tools/list` with a connection error and fail the scan.
  (Adela's Nov 6 note on BYT-10055.)
- **Why `tools/list` never waits for sign-in.** Claude Code and others call `tools/list` at
  startup. Blocking it on a browser round trip would stall the client for minutes on first
  run. So: answer from the bundle, fetch live in the background, announce `list_changed`.
- **Why the live list wins when connected.** A user on 3.22 or 3.26 should see their
  instance's tools, not the bundle's. The bundle is only the no-instance fallback.
- **Why OAuth and not a service-account token.** The `/mcp` route accepts only its own OAuth
  tokens (bound to the external URL); API tokens are refused there. Also keeps the package
  free of any Bytebase credential handling.
- **Why a fixed loopback port (51789).** Dynamic client registration stores the redirect URI
  with the client; a random port would break every later sign-in. Overridable via
  `BYTEBASE_MCP_CALLBACK_PORT`, with a hint to clear the token dir if changed.
- **Why re-read the token file before every refresh.** Bytebase refresh tokens are single-use
  and MCP clients start one process per session; a sibling process may have rotated the
  token. Writes are atomic (tmp + rename). There is **no cross-process lock** yet; see §7.
- **Why `client.request` instead of `client.callTool`.** `callTool` validates
  `structuredContent` against a tool list it may not have fetched. Raw request = pass-through.
- **Fallback instructions.** 3.24.1 sends no initialize `instructions` (the server-side text
  landed on main later). The package carries a short routing paragraph used only when the
  bundle's `instructions` is empty.
- **License MIT**, matching DBHub. Flagged, not confirmed by anyone else.

## 5. What was verified (2026-11-13, local Bytebase 3.24.1 via its ngrok external URL)

- Unit tests + cold-start smoke tests pass (`npm test`), Node 20 and 22 in CI.
- Cold start with no `BYTEBASE_URL`: initialize + `tools/list` return the 11 bundled tools;
  `tools/call` returns `isError` with a clear "set BYTEBASE_URL" message.
- Unreachable instance: bundle still served, call errors are readable.
- Live: OAuth flow end to end (registration, browser, callback, token stored), then
  `search_api(service="ProjectService")` and `call_api(ProjectService/ListProjects)` through
  the stdio server returned 200 from the instance. Live `tools/list` matched the bundle.
- `npm pack` → install in an empty project → `npx bytebase-mcp` cold start lists 11 tools.
  Tarball is 20 KB.

## 6. What was NOT verified

- **Elicitation forwarding** (confirmation forms for `decide_issue`, masking exemptions,
  `set_just_in_time_access`). Implemented, not exercised: needs a Read-write policy and a
  client with form elicitation. Worth one manual run from Claude Code before 1.0.
- Token refresh after expiry, and the two-process refresh race.
- Windows (`cmd /c start` for the browser is untested).

## 7. Known gaps / asks

1. **Tool-definition sync depends on a running instance and a browser login.** A
   `bytebase` CLI subcommand (or `go run`) that dumps the registered MCP tools as JSON would
   let CI regenerate `tools.json` on every release with no human. Suggested home: the
   bytebase repo, next to `backend/api/mcp/server.go` (`registerTools`).
2. **No cross-process refresh lock.** The third-party package uses an atomic `mkdir` lock
   and re-reads after acquiring it. If users report `invalid_grant` with several clients
   open, add the same.
3. **Bundle is behind main.** 3.24.1 has 11 tools; main also registers
   `request_access_grant` and `administer_workspace`. Re-run `sync-tools` on the next release.
4. **npm trusted publisher not configured.** The publish workflow stops at `ENEEDAUTH` until
   `@bytebase/bytebase-mcp` has a trusted publisher (org `bytebase`, repo `bytebase-mcp`,
   workflow `npm-publish.yml`). Needs an npm org owner. Registry side needs nothing:
   `mcp-publisher login github-oidc` proves `io.github.bytebase/*` through the repo.

## 8. Release checklist

1. `npm run build && BYTEBASE_URL=<instance on the target release> npm run sync-tools`
2. Review the printed added/removed/changed tools; commit `src/tools.json` + README.
3. `npm version <patch|minor>` (also stamps `server.json`), push `main` with tags.
4. The push runs `npm-publish.yml`: npm publish with provenance → wait for npm →
   `mcp-publisher publish`. Re-running the job is safe; both steps skip what already exists.
5. After the first publish: claim on Glama (`glama.json` names `adela-bytebase`), open the
   awesome-mcp-servers PR, update the MCP directory tracker sheet.

## 9. References

- Linear BYT-10055 (problem statement, Nov 6 update on directory constraints)
- `bytebase/dbhub`: `server.json`, `glama.json`, `.github/workflows/npm-publish.yml` (templates)
- `bytebase/bytebase` `backend/api/mcp/`: `server.go` (protocol ceiling, instructions,
  `registerTools`), `tool_confirm.go` (elicitation shape), `tool_call.go`
- docs: https://docs.bytebase.com/integrations/mcp
- Third-party package: https://github.com/ahmedbally/bytebase-mcp
