# Design: a proxy that gets Bytebase's tools from the instance

Status: proposal (revision 2) · 2026-11-22 · Linear BYT-10055

This package lets MCP directories and local-command clients use the MCP server built into every
Bytebase instance. **A configured proxy gets every tool and instruction from its Bytebase
instance, after sign-in. A snapshot of the tool list ships in the package for one purpose,
letting MCP directories list Bytebase when no instance is configured, and a configured proxy never
reads it.** This file replaces the first version's design notes (2026-11-16); the last sections
say what was kept and what changed.

## Problem

Bytebase serves MCP at `<external URL>/mcp` (Streamable HTTP, OAuth). It is not in any MCP
directory:

- Of the directories that matter, only Glama starts a package to read its tools. It builds the
  repository and starts the server with no configuration, then reads `tools/list`. The official
  MCP registry and awesome-mcp-servers list a package from its metadata and never start it.
- The built-in server runs only inside the Bytebase process, and `/mcp` answers every request
  without a valid bearer token with 401 (`authMiddleware` in `backend/api/mcp/server.go`).
- A third-party package holds the npm name `bytebase-mcp` and ranks first for "bytebase" on Glama.
  It reimplements its own tools on the Connect API and has not been maintained since 2026-09-14
  (Adela's notes, 2026-11-16).

The first version shipped `src/tools.json`, dumped from Bytebase 3.24.1, and answered every
client's `tools/list` from it until a live list arrived. Within a week it was stale: main dropped
`get_skill` and added `request_access_grant`, `administer_workspace` and `get_gitops_workflow`.
Users saw tools their instance did not have.

## Principle

> Users see only what their instance serves. The package adds transport, sign-in, the words for
> its own states, and a tool-list snapshot used only for directory listings. The one Bytebase rule
> it copies is when the form paragraph applies (D4).

## Approaches weighed

**A. One bundled list for everyone (first version).** Works offline, but every user sees a list
frozen at the last sync. Rejected for drift.

**B. Source in a subfolder of the main repository, with a mirror for directories.** A Go test
writes the list at each release. That narrows the drift without removing it (Cloud deploys between
releases; older instances get a newer list), and adds mirror machinery. Rejected.

**C. A public catalog route on the server.** `GET /mcp/catalog` answering without a token, read by
the package before sign-in. Built and reviewed in bytebase/bytebase#22184, then closed: its only
consumer is a directory scan of an unconfigured package, which does not justify an unauthenticated
route on every instance.

**D. No list before sign-in at all.** Simplest. Glama still lists the package, but with no tools
and no quality grade: sign-in-first bridges such as a fork of `mcp-remote` show "Not graded" there.

**E. Snapshot for directories, instance for users (chosen).** Directories get the snapshot; users
never do. Drift can only age the directory listing, and a release refreshes it.

Prior art for the user side is `mcp-remote` (geelen/mcp-remote): it signs in before it connects,
then passes `initialize`, `tools/list` and everything else through. Signing in before answering
`initialize` runs into client startup timeouts; that fork's README lists Claude's 60-second timeout
as an open problem. So this proxy answers `initialize` at once and signs in afterwards (D4, D5).

The package stays in its own repository, for the reasons the first version gave: Glama and the
awesome list index a repository root, the license is plain MIT, npm trusted publishing and the
registry's OIDC bind to one repository and workflow, and releases are independent (precedent:
`bytebase/dbhub`).

## Decisions

**D1 · The instance is named by `BYTEBASE_URL` or `--url`.** `--url` wins when both are set. The
value is the instance's external URL; `parseBytebaseUrl` accepts a bare host and strips a trailing
`/` or `/mcp`. This follows comparable packages (`GRAFANA_URL`, `JIRA_URL`, `mcp-remote <url>`).
Configuration is read once, at startup: a changed URL takes effect when the client restarts the
server, with a fresh `initialize`, so one process never changes state between unconfigured and
configured. Rejected: asking for the URL with form elicitation at first use. Few clients support it, and the
client config already has an `env` block. It can come later.

**D2 · Where `tools/list` comes from depends on configuration, not on sign-in.**

- No URL configured: the snapshot (D3), in one page.
- URL configured, session open: the session's `tools/list`. The client's `cursor` is passed to the
  instance and the instance's `nextCursor` back, so the instance pages its own list.
- URL configured, no session yet: an empty list. When a session opens, the proxy sends
  `tools/list_changed`; afterwards it forwards the instance's own.

Keying on sign-in instead would show the snapshot to a configured user before they sign in, which
is the drift this design removes.

**D3 · The snapshot is generated from an instance and used only when no URL is configured.**
`src/tools.json` holds `bytebaseVersion`, `generatedAt`, `instructions` and `tools`.
`npm run sync-tools` regenerates it before a release, against an instance on the latest Bytebase
release, never a development build, so a directory lists no tool that users cannot get yet:
it signs in as the package does, reads every page of `tools/list`, and strips the per-session parts
of the instructions (the account line, and the paragraph Bytebase adds for clients without forms).
The README's tools table is rendered from it and labeled as a snapshot. A stale snapshot only ages
the directory listing, so a manual sync per release is enough; nothing checks it in CI, because
that would need an instance.

**D4 · The initialize instructions are fixed when the client initializes.** MCP has no
notification for changed instructions, so the proxy decides once, from its state at `initialize`
(States below):

- No URL (S1): a one-line note that no instance is connected, then the snapshot's instructions.
- Signed in (S2): the instance's own initialize instructions, verbatim. The proxy opens the session
  inside the client's `initialize`, declaring elicitation exactly as the client declared it, so
  the instance writes the per-session account line and the form paragraph as for a direct
  connection.
- Configured, no session (S3, S4): one fixed paragraph from the package that names the state and
  what happens next. For a client whose elicitation capability is absent or names `url` without
  `form`, it ends with the package's one-sentence version of the form paragraph (before running a
  statement that may write, show it to the user and ask them to confirm), because the instance's
  text cannot be read before sign-in. The rule copies the instance's own
  (`declaresFormElicitation` in Bytebase's `tool_resolve.go`).

Opening the session and probing the instance are bounded at 5 seconds in total, so a client's
startup timeout is not hit.

**D5 · A configured proxy signs in right after the client initializes.** Without a session it
has no tools to offer, so the sign-in starts after the client's `initialized` notification, and a
tool call made before it finishes waits for it. A sign-in that fails or times out is not restarted
on its own, so a user who ignores it is not sent repeated browser tabs; a client restart starts it
again. When the instance cannot be reached (unreachable, as defined under States), opening the session is retried up to 10 times, waiting 1
second and doubling to at most 5 minutes (about 14 minutes in all), then stops until the client
restarts; the browser opens only once the instance answers.

A forwarded request belongs to whoever sent it: **the proxy adds no deadline and no cancellation
of its own, in either direction, and passes the sender's cancellation on.** The SDK gives every
request a 60-second default, so each forwarded request sets its own. Every request the proxy
forwards:

| Request | Direction | Proxy's timeout | Cancellation |
| --- | --- | --- | --- |
| `tools/call` | client → Bytebase | None | The client's is passed to Bytebase; a call cancelled before its session opens is never sent |
| `tools/list` | client → Bytebase | 10 seconds while reopening a session (D2's one exception), then a JSON-RPC error | The client's, and the bound's, abort it before it is sent |
| `elicitation/create` (a confirmation form) | Bytebase → client | None; Bytebase decides how long a form stays up (10 minutes, `confirmationLifetime` in `tool_confirm.go`) | Bytebase's is passed to the client, which takes the form down |
| `tools/list_changed` | Bytebase → client | — (a notification) | — |

Bytebase sends no other request or notification during a call, so the table is complete; a new one
is added here before it is forwarded. Any forwarded request, `tools/list` as well as `tools/call`,
is resent only after an error showing the instance never received it (connection refused, 401,
unknown session), on a session reopened with the stored sign-in; Bytebase ends a session after an
hour idle. Reopening never cuts off calls already in flight on the old session: they may have run,
so they finish and return their results, and the old session closes after them. The SDK drives OAuth:
protected-resource discovery, dynamic client registration, PKCE, token exchange. The package
handles the browser leg on the fixed loopback port 51789 (`BYTEBASE_MCP_CALLBACK_PORT`), and
prints the sign-in URL only once that port is listening. The URL comes from the instance's OAuth
metadata, so the proxy opens it in a browser only if it is http(s), and never through a shell (on
Windows, `rundll32 url.dll,FileProtocolHandler`, since `cmd` would run what a URL's `|` or `^`
introduces); otherwise the printed URL is all there is.

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
renamed. `home` is `BYTEBASE_MCP_HOME`, by default `~/.bytebase-mcp`: these are credentials, not
configuration, so not under `~/.config`, which people often sync or keep in dotfile repositories.
The instance key is host, port and path, so two instances on one host
under different paths do not collide; the client key is `clientInfo.name` with characters outside
`[A-Za-z0-9._-]` replaced. Bytebase refresh tokens are single-use (`ConsumeOAuth2RefreshToken` in
`backend/api/oauth2/token.go`), and clients start one proxy process per session, so several
processes share one sign-in. Rules:

- **The sign-in file is written only while holding its lock**: a directory `<file>.lock`, created
  by renaming one that already holds the owner's process ID, abandoned once that process is gone.
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
  sign-in it would need makes the state signed out (S3).

The SDK ends a sign-in at the browser redirect and exchanges the code in a later call, and saves
tokens only after a token request returns. So the proxy takes the lock itself, at two places:

- Around opening a session: from before the SDK reads the stored registration until the session
  is open or has failed. This spans registration, the browser leg and the code exchange.
- Around a refresh in an open session: in the `fetch` the proxy gives the SDK transport, from the
  token request until the result is on disk. The SDK builds the request from tokens it read
  earlier, so when the file holds newer tokens than the rejected ones, the `fetch` answers with
  those instead of sending the request.

The lock is reentrant only while the session opening that holds it is in progress, so a refresh
inside that opening does not wait on itself, and work the opening starts but outlives it (the SDK's
event stream) takes the lock like anyone else. Concurrent refreshes in one process wait for each
other as those of different processes do. A sign-in starts only while a session is being opened
for D5's sign-in or a tool call. If the SDK tries to start one anywhere else, as it does after a
refused refresh (a revoked grant, as after Bytebase's `reauthorize`), the provider refuses it; the
instance answered 401, so the request never ran, and a tool call reopens the session with a sign-in
under the lock and is then sent.

**D8 · Versioning is independent of Bytebase.** The package has its own semver and works with any
instance from 3.22, the first with MCP OAuth. The snapshot records the Bytebase version it was
read from (`bytebaseVersion`); that only describes the directory listing. `server.json` keeps
following `package.json` (`scripts/sync-version.mjs`).

**D9 · The commands are `serve`, `logout` and `status`.** `serve` (the default) is what clients
run. `logout` revokes each refresh token stored for the instance at its revocation endpoint, so a
copied file stops working too, then deletes the sign-in under its own lock; it is also how a user
switches accounts (log out, reconnect, sign in as the other account). It does not sign anyone out
of the Bytebase console. `status` prints the instance, whether
it answers as Bytebase, and the stored sign-ins by client, without signing in. `login` goes (D6); `whoami` becomes `status`, which needs no session.

## States

A configured proxy decides its state at startup from two facts: whether a stored sign-in opens a
session within the initialize bound without asking the user, and what
`GET <base>/.well-known/oauth-protected-resource/mcp` returns. A JSON document whose `resource` is
`<base>/mcp` means Bytebase. No answer within the bound, or HTTP 502, 503 or 504 (a gateway
answering for a Bytebase that is down or restarting), means unreachable, here and in D5's retry.
Any other answer means not Bytebase.

| State | Instructions at initialize | `tools/list` | `tools/call` |
| --- | --- | --- | --- |
| **S1** No URL configured | A one-line note (no Bytebase instance is connected; set `BYTEBASE_URL` to the instance's external URL in the client's config and restart), then the snapshot's instructions. | The snapshot's tools. | Error result with the same fix. Nothing is sent anywhere. |
| **S2** Signed in | The instance's own, verbatim. | The session's, cursors passed through. | Forwarded. |
| **S3** Bytebase, no session | Fixed: names the instance; tools appear after signing in to Bytebase in the browser. Plus the form sentence (D4). | Empty until the session opens, then the session's, announced with `tools/list_changed`. | Waits for the sign-in, then forwards. |
| **S4** Unreachable, or not Bytebase | Fixed: names the URL and the reason. Unreachable gives the network error or the gateway's status; not Bytebase says to check that the value is the instance's external URL. Plus the form sentence (D4). | Empty; when a retried opening succeeds, as in S3. | Tries to open a session; on failure, an error result with the reason. |

Rules that hold in every state:

1. A configured proxy describes only tools it read from its instance in this process; the
   snapshot is read only when no URL is configured.
2. A proxy with a URL contacts only that instance. A proxy without one contacts nothing.
3. Readers take every page: `sync-tools` and the proxy's own reads follow `nextCursor` to the end.
4. Tool results, errors and elicitation requests from the instance pass through unchanged. The
   package's own errors on `tools/call` (S1, S4, failed sign-in) are tool results with `isError`,
   never JSON-RPC errors, so the model can read the fix. A `tools/list` the proxy cannot answer
   from a reopened session gets a JSON-RPC error carrying the reason. The one addition to a
   forwarded result: after a successful `reauthorize` (Bytebase's account-switch tool), the proxy
   appends a note to reconnect this server and sign in as the account wanted. Instructions do not
   change until the client reinitializes (D4), so reconnecting is what replaces any that named the
   old account. The note claims nothing about what the client's instructions say: the proxy cannot
   know whether they named an account (older Bytebase releases send none).
5. Elicitation is declared to the instance only if the client declared it; requests are forwarded
   with `server.elicitInput`.
6. Diagnostics go to stderr; stdout is the transport.

If sign-in fails because the instance's protected-resource document names another URL, the error
says that `BYTEBASE_URL` must be the instance's external URL, which is what tokens are bound to.

## Scope

This pull request first carried revision 1 (a public catalog route): its design commit, a slice
that read the catalog, and a slice that built sessions, sign-in, the token lock, identity,
cancellation and the `status` and `logout` commands. That session code already does most of what
D5–D7 and D9 describe, and its tests (`test/sessions.test.mjs`) stay green throughout. Revision 2
lands as two more commit series on top, each green on its own, so `npm test` passes after each.
Tests drive the built server over stdio against a fake Bytebase: a local HTTP server with the
protected-resource document, an OAuth server and an MCP endpoint built with the SDK's server.

1. **States and the snapshot.** Delivers D1–D4, D8, the states' instructions and lists (S1, S3,
   S4; S2 keeps the existing session code), D5's sign-in after `initialized` for every configured
   proxy without a session, rules 1–2, and the README. Removes `src/catalog.ts` and the catalog
   paths in `src/server.ts` and `src/index.ts` (`status` stops reporting a catalog). Restores
   `src/tools.ts`, `scripts/sync-tools.mjs` and `scripts/render-readme.mjs`, adds the build step
   that copies the snapshot into `dist/`, and seeds `src/tools.json` from the latest Bytebase
   release with `sync-tools`, so S1 carries current instructions. Tests: `test/smoke.test.mjs` by state,
   and the existing `test/sessions.test.mjs` updated where a state's name or `status`'s output
   changed.
2. **Pages and recovery.** Delivers the rest of D2 and D5 and rule 3: cursors passed through to the
   session, every reader taking every page (`sync-tools` and the proxy's own reads), opening
   retries with backoff when the instance cannot be reached, resending `tools/list` on a reopened
   session, and the JSON-RPC error for a `tools/list` that cannot be answered. Files:
   `src/upstream.ts`, `src/server.ts`, `scripts/sync-tools.mjs`, and `test/sessions.test.mjs`
   (paging through a fake that pages, an expired session, an unreachable first start). Depends on
   slice 1.

## Not in this change

- Publishing to npm or the MCP registry, making the repository public, claiming the Glama listing.
- Tool annotations on the server, which Glama's score and vendor preflights read. That is server
  work, and whether `query_database` gets static or mode-aware hints is still open.
- Checking which clients honor `tools/list_changed`. On a configured user's first run the tools
  arrive with it after sign-in; a client that ignores it shows them only after a restart, when the
  stored sign-in makes S2 immediate. Verify Cursor and Claude Desktop before 1.0.
- Asking for the URL with elicitation (D1); headless sign-in (the loopback redirect cannot reach a
  headless machine anyway).
- An npm snippet on the console's MCP page, and the client application's name in the audit table.
  Both are work in the main repository.
- Windows has never been run, so the README says so; a manual run comes before 1.0.

## Kept from the first version

- No tool logic in the package; results pass through untouched.
- The bundled `tools.json`, `sync-tools` and the README tools table, now for directory listings only.
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
| Every client got the bundled list until a live list arrived | Only an unconfigured proxy uses the snapshot; a configured one lists only its instance's tools | Users never see drift (D2) |
| Live list read once, first page only | Session's list with cursors passed through; every reader takes every page | Long lists and paging (D2, rule 3) |
| Instructions from the bundle, or fallback text in the package | Signed in: the instance's own; otherwise package text for the state | D4 |
| Background sign-in after the first `tools/list` | Sign-in after `initialized`, not restarted on its own after a failure | D5 |
| One OAuth client, "Bytebase MCP (npm)" | One per (instance, client app) | Consent and audit show the real client (D6) |
| Token file per host, no lock | Per (instance, client); every write under one lock | Single-use refresh tokens, several processes (D7) |
| Cancelled calls forwarded; replays on ambiguous errors | Never sent once cancelled; resent only when never received | D5 |
| `login`, `whoami` | `status` | A sign-in needs a client (D6, D9) |
| README calls Cursor and Claude Desktop local-command-only | Both connect to remote `/mcp`; the package is for directories and local-command clients | Correctness |

## References

- bytebase `backend/api/mcp/server.go`: `authMiddleware`, `registerTools`, `askInChatWithoutForm`,
  `nameSignedInAccount`, `legacyProtocolCeiling`.
- bytebase/bytebase#22184 (closed): the public catalog route of approach C.
- `mcp-remote` (geelen/mcp-remote) `src/proxy.ts`: sign in, then connect and pass through.
- Glama listings of sign-in-first bridges (`abluva/mcp-remote` and others): listed, "Not graded"
  quality, no tools.
