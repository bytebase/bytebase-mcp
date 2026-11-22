# Design: a pure proxy for Bytebase's built-in MCP server

Status: proposal · 2026-11-22 · Linear BYT-10055 · server companion:
[bytebase `docs/design/mcp-public-catalog.md`](https://github.com/bytebase/bytebase/blob/main/docs/design/mcp-public-catalog.md)

This package lets MCP directories and local-command clients use the MCP server built into every
Bytebase instance. The first version (2026-11-16) shipped a copy of that server's tool list. This
version keeps no tool list. **The package reads the tool list from a Bytebase server and forwards
tool calls to the instance named by `BYTEBASE_URL`; with no instance named it reads the list from
Bytebase Cloud and runs nothing.** The server side of this, an unauthenticated
`GET /mcp/catalog` route, is specified in the companion doc. This file replaces the design sections
of the first version's notes; the last two sections say what was kept and what changed.

## Problem

Bytebase serves MCP at `<external URL>/mcp` (Streamable HTTP, OAuth). It is not in any MCP
directory:

- Directories list servers they can start themselves, then read `tools/list` without signing in.
  Glama builds the repository and starts the server with no configuration. The built-in server runs
  only inside the Bytebase process, and `/mcp` answers every request without a bearer token with
  401 (`authMiddleware` and `mcpauth.RequireBearerToken` in `backend/api/mcp/server.go`).
- A third-party package holds the npm name `bytebase-mcp` and ranks first for "bytebase" on Glama.
  It reimplements its own tools on the Connect API and has not been maintained since 2026-09-14
  (Adela's notes, 2026-11-16).

The first version answered `tools/list` from `src/tools.json`, dumped from Bytebase 3.24.1. Within
a week it was stale: main dropped `get_skill` and added `request_access_grant`,
`administer_workspace` and `get_gitops_workflow`. Bytebase Cloud deploys continuously, and every
self-hosted instance runs its own release, so no single copy is right for everyone.

## Principle

> The package holds no Bytebase behavior. Every tool name, schema, description and instruction
> comes from a Bytebase server at run time; the package adds only transport, sign-in, and the
> words for its own states. The one Bytebase rule it copies is the form paragraph: when it
> applies, and its substance where the instance's text cannot be read (D4).

## Approaches weighed

**A. Bundle plus a sync script (first version).** Works with no network. But the bundle drifts,
regenerating it needs a running instance and a browser sign-in, and every tool change needs a
package release. Rejected for drift.

**B. Source in a subfolder of the main repository, plus a mirror.** A Go test writes `tools.json`
as a checked golden file, the main release workflow publishes npm and the registry, and a
read-only mirror feeds Glama and the awesome list (both key a listing to a whole repository).
This removes the manual step, but the copy is still frozen at each release: Cloud runs between
releases, and an older instance gets a newer list. It also adds mirror machinery. Rejected: it
narrows drift without removing it.

**C. Pure proxy with a public catalog route (chosen).** The server publishes its own tool list
without a token, and the package reads it. Nothing is copied, so nothing drifts, and tool changes
need no package release. Costs, each accepted:

- A server change: one unauthenticated read-only route (companion doc).
- The directory cold start needs the network. Glama's scan can reach it: its listing of
  `evalstate/mcp-hfspace` shows a tool that server only learns by connecting to Hugging Face at
  startup. Glama flags traffic to hosts not named in the source, so the Cloud URL is a literal in
  the source (D3).
- Instances older than the route cannot list tools before sign-in (state S4).

The package stays in its own repository, for the reasons the first version gave: Glama and the
awesome list index a repository root, the license is plain MIT, npm trusted publishing and the
registry's OIDC bind to one repository and workflow, and releases are independent (precedent:
`bytebase/dbhub`). Approach C removes the drift that was the cost of that choice.

## Decisions

**D1 · The instance is named by `BYTEBASE_URL` or `--url`.** `--url` wins when both are set. The
value is the instance's external URL; `parseBytebaseUrl` accepts a bare host and strips a trailing
`/` or `/mcp`. This follows comparable packages (`GRAFANA_URL`, `JIRA_URL`, `mcp-remote <url>`).
Rejected: asking for the URL with form elicitation at first use. Few clients support it, and the
client config already has an `env` block. It can come later.

**D2 · The tool list comes from `GET <base>/mcp/catalog`.** The response is
`{instructions, instructionsWithoutForm, tools}` (companion doc). A response counts as a catalog
only if it is `200`, `application/json`, and has a `tools` array; anything else means "no
catalog". This matters because an instance without the route answers `200 text/html` with the
console's page (the frontend's HTML5 fallback serves it for unknown paths; Cloud answers that way
today), so a status check alone would misread it. Before a session is open, `tools/list` answers
from the catalog. Once a session is open, it answers from the session, sends `tools/list_changed`
if the session's list differs from the catalog's, and forwards the instance's
`tools/list_changed`.

**D3 · Bytebase Cloud is the public source, and only for the unconfigured proxy.** With no URL,
the package reads `https://cloud.bytebase.com/mcp/catalog`, a literal in the source.
`BYTEBASE_MCP_PUBLIC_CATALOG_URL` replaces it for tests. A proxy with a URL never contacts Cloud,
not even as a fallback when its instance is old or unreachable. Contacting Cloud would tell
Bytebase about a self-hosted user's activity, and Cloud's list would describe tools the instance
may not have. Tool calls and sign-in never go to Cloud by default; a Cloud user names Cloud as
their instance like anyone else.

**D4 · The initialize instructions are fixed when the client initializes.** MCP has no
notification for changed instructions, so the proxy decides once, from the state it is in at
`initialize` (States below):

- Signed in: the instance's own initialize instructions, verbatim. The proxy opens the session
  inside the client's `initialize`, declaring elicitation exactly as the client declared it, so
  the instance writes the per-session account line and the form paragraph exactly as for a
  direct connection.
- Signed out, catalog read: `instructions`, plus `instructionsWithoutForm` when the client's
  elicitation capability is absent or names `url` without `form`. This copies the instance's own
  rule (`declaresFormElicitation` in `tool_resolve.go`, applied by `askInChatWithoutForm` in
  `server.go`), with both texts from the instance. The account line is absent: nobody has signed
  in yet. With no URL configured (S1), the catalog is Cloud's, and a one-line note that no
  instance is connected comes first.
- Every other state: one fixed paragraph from the package that names the state and the fix. In
  S4 and S5, where tools can appear later, for a client the form rule above applies to, it ends
  with the package's one-sentence version of the
  form paragraph (before running a statement that may write, show it to the user and ask them to
  confirm), because the instance's text cannot be read before sign-in and instructions cannot
  change afterwards.

Waiting for the catalog or the session is bounded at 5 seconds in total, so a client's startup
timeout is not hit. Rejected: answering `initialize` only after sign-in. A browser sign-in takes
minutes, and clients give up on servers that do not start.

**D5 · Sign-in starts when a tool needs it.** The first `tools/call` without a session opens the
session, and with it the browser sign-in, then forwards the call. One exception, set by the states
table: an instance without a catalog (S4) starts sign-in right after the client's `initialized`
notification, because otherwise it cannot list tools at all. A forwarded call follows the client:
one cancelled before its session opens is never sent, a cancellation after that is forwarded, the
proxy sets no timeout of its own, and it resends a call only after an error showing the instance
never received it (connection refused, 401, unknown session). The SDK still drives OAuth:
protected-resource discovery, dynamic client registration, PKCE, token exchange. The package
handles the browser leg on the fixed loopback port 51789 (`BYTEBASE_MCP_CALLBACK_PORT`).

**D6 · The real client's identity reaches the instance.** A sign-in belongs to one client
application on one instance. The proxy registers one OAuth client per `(instance, client)`, named
`<clientInfo.title or clientInfo.name> via Bytebase MCP`. It forwards the client's `clientInfo`
unchanged in its own `initialize` to the instance. The instance shows the registration's
`client_name` on the consent page (`handleGetClient`, `backend/api/oauth2/oauth2.go`) and records
the OAuth client ID in the MCP delegation of its audit rows (`backend/api/v1/audit.go`,
`backend/api/mcp/connection_audit.go`). So each client application gets its own consent and its
own client ID in audit; the audit table shows that ID, not the name (Not in this change). The
first version registered every session as one "Bytebase MCP (npm)" client. Consequence: each
client application signs in once per instance, as it would over a direct connection, and the
`login` command goes away, since it has no client to sign in as.

**D7 · Tokens are stored per sign-in, and one lock guards every write.** One file per sign-in at
`<home>/<instance key>/<client key>.json` (mode 0600, directory 0700), written to a temp file and
renamed. `home` is `BYTEBASE_MCP_HOME`, by default `$XDG_CONFIG_HOME/bytebase-mcp` or
`~/.config/bytebase-mcp`. The instance key is host, port and path, so two instances on one host
under different paths do not collide; the client key is `clientInfo.name` with characters outside
`[A-Za-z0-9._-]` replaced. Bytebase refresh tokens are single-use (`ConsumeOAuth2RefreshToken` in
`backend/api/oauth2/token.go`), and clients start one proxy process per session, so several
processes share one sign-in. Rules:

- **The sign-in file is written only while holding its lock**: an atomic `mkdir` of
  `<file>.lock` that records the holder's process ID, abandoned once that process is gone.
- Signing in (registration through saved tokens) and refreshing (token request through saved
  tokens) each run under the lock. A process that gets the lock re-reads the file and skips what
  it shows done: it reuses a stored registration, and uses tokens newer than its own instead of
  refreshing.
- The PKCE verifier and `state` stay in the memory of the process that started the sign-in.
- A process deletes tokens or a registration the instance refused only if the file still holds
  what it sent.
- The browser leg also holds a machine-wide lock on the callback port, which every sign-in on the
  machine shares.
- Nothing waits for a lock inside `initialize`. There the proxy uses what the file holds, and a
  sign-in it would need makes the state signed out (S2, S4).

The SDK ends a sign-in at the browser redirect and exchanges the code in a later call, and saves
tokens only after a token request returns. So the proxy takes the lock itself, at two places:

- Around opening a session: from before the SDK reads the stored registration until the session
  is open or has failed. This spans registration, the browser leg and the code exchange.
- Around a refresh in an open session: in the `fetch` the proxy gives the SDK transport, from the
  token request until the provider has saved or discarded the result. The SDK builds the request
  from the tokens it read before, so when the request's refresh token is no longer the one on
  disk, the `fetch` answers it with the tokens on disk instead of sending it.

The lock is reentrant only for the session opening that holds it, so a refresh inside that
opening does not wait on itself. Concurrent refreshes in one process wait for each other as those
of different processes do. Inside `initialize` the proxy opens a session only if it gets the lock without waiting,
and refuses any sign-in there; otherwise the state is signed out. A sign-in starts only while a
session is being opened for a tool call or for S4's background sign-in. If the SDK tries to start
one anywhere else, as it does after a refused refresh, the provider refuses it. The call then
fails with a sign-in-needed error, and the next tool call opens the session under the lock.

**D8 · Versioning is independent of Bytebase.** The package has its own semver. It works with any
instance from 3.22, the first with MCP OAuth, and lists tools before sign-in on instances from the
release that adds the catalog route. The package records no Bytebase version, because it holds
nothing from one. `server.json` keeps following `package.json` (`scripts/sync-version.mjs`).

**D9 · The commands are `serve`, `logout` and `status`.** `serve` (the default) is what clients
run. `logout` deletes every sign-in stored for the instance. `status` prints the instance, whether
it serves a catalog and how many tools it lists, and the stored sign-ins by client, without
signing in. `login` goes (D6). `whoami` becomes `status`, which needs no session.

## States

A state is decided at startup from three facts: whether a URL is configured; what the catalog
request returned; and whether a stored sign-in opens a session within the initialize bound without
asking the user. When the catalog request gets an HTTP answer that is not a catalog, the proxy
asks `GET <base>/.well-known/oauth-protected-resource/mcp`: a JSON document whose `resource` is
`<base>/mcp` means Bytebase without a catalog at this URL (S4); anything else means not Bytebase
(S5). A catalog request with no answer within the initialize bound is unreachable (S5).

| State | Instructions at initialize | `tools/list` | `tools/call` |
| --- | --- | --- | --- |
| **S1** No URL configured | A fixed note (no Bytebase instance is connected; set `BYTEBASE_URL` to the instance's external URL in the client's config and restart), then Cloud catalog's instructions as in S2. The note alone if Cloud cannot be read. | Cloud catalog's tools. Empty if Cloud cannot be read. | Error result with the same fix. Nothing is sent anywhere. |
| **S2** Catalog read, signed out | Catalog `instructions`, plus `instructionsWithoutForm` for a client without form elicitation. | The catalog's tools; the session's after the first call opens one. | Opens a session (browser sign-in), then forwards. |
| **S3** Signed in | The instance's own, verbatim. | The session's. | Forwarded. |
| **S4** Bytebase, no catalog at this URL, signed out | Fixed: names the instance; it does not serve the public tool list here (a release before it, or a reverse proxy that forwards only `/mcp`); tools appear after the sign-in that opens in the browser. | Empty until the session opens, then the session's, announced with `tools/list_changed`. | Opens a session, then forwards. |
| **S5** Unreachable, or not Bytebase | Fixed: names the URL and the reason. Unreachable gives the network error; not Bytebase says to check that the value is the instance's external URL. | Empty. | Tries to open a session; on failure, an error result with the reason. |

Rules that hold in every state:

1. Nothing the package sends a client describes a Bytebase tool unless it was read from a Bytebase
   server in this process.
2. A proxy with a URL contacts only that instance. A proxy without one contacts only Cloud's
   catalog URL.
3. While the proxy has no tool list (S1 when Cloud failed, S4, S5), it retries the catalog with
   backoff, capped at 5 minutes, and sends `tools/list_changed` when it gets one. In S4 the session
   that opens ends the retries.
4. Tool results, errors and elicitation requests from the instance pass through unchanged. The
   package's own errors (S1, S5, failed sign-in) are tool results with `isError`, never JSON-RPC
   errors, so the model can read the fix.
5. Elicitation is declared to the instance only if the client declared it; requests are forwarded
   with `server.elicitInput`.
6. Diagnostics go to stderr; stdout is the transport.

The resource-mismatch hint from the first version stays. If sign-in fails because the instance's
protected-resource document names another URL, the error says that `BYTEBASE_URL` must be the
instance's external URL, which is what tokens are bound to.

## What gets deleted

- `src/tools.json` and `src/tools.ts`: the bundle and its loader.
- `scripts/sync-tools.mjs` and `scripts/render-readme.mjs`: the dump and the README tools table.
  The README lists no tools; it links to Bytebase's MCP docs.
- The copy of `tools.json` in `scripts/copy-assets.mjs`. The build still marks `dist/index.js`
  executable.
- `FALLBACK_INSTRUCTIONS` in `src/server.ts`: instructions come from Bytebase, apart from the package's state texts and its form sentence (D4).
- The `login` and `whoami` commands (D6, D9).
- The README's claim that Cursor and Claude Desktop only run local commands. Both connect to a
  remote `/mcp` directly. The README says the package is for directories and for clients that only
  start local commands, and tells everyone else to use `<external URL>/mcp`.

## Scope

Two slices, in order, both in the pull request that carries this doc: each slice is its own commit
series, reviewed and green before the next starts. Tests run against a fake upstream: a local HTTP
server that serves a catalog, the protected-resource document, OAuth endpoints and an MCP
endpoint built with the SDK's server. They do not use Cloud, which will not serve the route until
the server change deploys.

1. **Catalog and states.** Delivers D1–D4 for the states that need no session (S1, S2's
   instructions and list, S4's and S5's classification and texts), rules 1–4, D8, and the
   deletions. Files: `src/catalog.ts` (new: fetch, validate, classify, retry), `src/server.ts`,
   `src/config.ts`, `src/index.ts`, the files deleted above, `README.md`, `server.json`,
   `package.json`, and tests in `test/` named by state. Depends on nothing in this repository; the
   proxy is not published until Cloud serves the route.
2. **Sessions.** Delivers S3 (session at initialize, instructions verbatim), S4's background
   sign-in, D5, D6, D7 and D9. Files: `src/upstream.ts`, `src/auth.ts`, `src/index.ts`, tests for
   each D7 rule (two processes refreshing, against a fake token endpoint that refuses a reused
   refresh token; two processes signing in for the first time), D5's cancellation and resend
   rules, identity (the registered `client_name` and the forwarded `clientInfo`), and the S3/S4 rows.
   Depends on slice 1.

## Not in this change

- Publishing to npm or the MCP registry, making the repository public, claiming the Glama
  listing. The first publish waits until Cloud serves `/mcp/catalog`; before that, S1 lists no
  tools and a directory would score zero.
- Tool annotations on the server, which Glama's score and vendor preflights read. That is server
  work, and whether `query_database` gets static or mode-aware hints is still open.
- Asking for the URL with elicitation (D1); a printed sign-in URL in tool results for headless
  machines (the loopback redirect cannot reach a headless machine anyway).
- An npm snippet on the console's MCP page, so users never type the URL. That is console work in
  the main repository.
- Showing the client application's name, not only its OAuth client ID, in the audit table. That
  is server and console work in the main repository.
- Windows, elicitation forwarding and refresh after expiry were never exercised. Slice 2 tests
  refresh against the fake upstream; a manual Windows and elicitation run comes before 1.0.

## Kept from the first version

- No tool logic in the package; results pass through untouched.
- OAuth, not a service-account token: `/mcp` accepts only its own OAuth tokens, bound to the
  external URL.
- A fixed loopback port, because dynamic client registration stores the redirect URI with the
  client.
- `client.request` rather than `client.callTool`, which would validate `structuredContent` against
  a tool list it may not have fetched.
- Atomic token writes, and re-reading the file before use.
- `@modelcontextprotocol/sdk` 1.x, which negotiates protocol 2025-11-25, the ceiling the Go server
  answers with (`legacyProtocolCeiling`). Confirmations stay in-call `elicitation/create`
  requests.
- `server.json`, `glama.json` and the publish workflow from `bytebase/dbhub`. The npm trusted
  publisher still needs an npm org owner.

## What changed

| First version | This version | Why |
| --- | --- | --- |
| Bundled `tools.json` from 3.24.1 | No tool list; read from the instance's or Cloud's catalog | Drift (Problem) |
| `tools/list` from the bundle, live list in the background | Catalog before a session, session after | One source per moment, both from Bytebase |
| Fallback instructions in the package | Instructions from Bytebase; package text only for its own states and the copied form sentence | Principle |
| One OAuth client, "Bytebase MCP (npm)" | One per (instance, client app) | Consent and audit show the real client (D6) |
| Token file per host | Per (instance, client); every write under one lock | Path-based instances; single-use refresh tokens (D7) |
| `login`, `whoami` | `status` | A sign-in needs a client (D6, D9) |
| Release checklist ran `sync-tools` | Release is version bump and push | Nothing to sync (D8) |

## References

- Companion doc: bytebase `docs/design/mcp-public-catalog.md`.
- bytebase `backend/api/mcp/server.go`: `RegisterRoutes`, `authMiddleware`, `registerTools`,
  `serverInstructions`, `askInChatInstructions`, `nameSignedInAccount`, `legacyProtocolCeiling`.
- bytebase `backend/server/server_frontend_routes.go`: the HTML5 fallback behind D2's validity
  check.
- MCP Server Cards (SEP-2127, extension `modelcontextprotocol/ext-server-card`): reserves
  `<streamable-http-url>/server-card` and leaves tool lists out, so a card cannot replace the
  catalog.
