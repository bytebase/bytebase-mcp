# Contributing

The design, with every state the server can be in, is in [docs/DESIGN.md](docs/DESIGN.md). This
file covers building, testing and releasing.

## Build and test

Node.js 20 or later.

```bash
npm install
npm run build
npm test
```

`npm test` drives the built server over stdio against a fake Bytebase (`test/fake-upstream.mjs`):
an OAuth server with PKCE and single-use refresh tokens, and an MCP endpoint. No instance or
browser is needed. It takes about two minutes; one test keeps a confirmation form open for longer
than a minute on purpose.

## Testing at four levels

Each level catches what the one before cannot.

1. **`npm test`**: every state, sign-in, the token lock, paging and recovery, against the fake.
2. **The directory view**: what an MCP directory sees with no instance configured. Open it in the
   MCP Inspector:

   ```bash
   npx @modelcontextprotocol/inspector node dist/index.js
   ```

   Or print the tool list without the UI:

   ```bash
   npx @modelcontextprotocol/inspector --cli node dist/index.js --method tools/list
   ```

   It lists the bundled snapshot (`src/tools.json`), and every tool call answers that
   `BYTEBASE_URL` is not set.
3. **A real instance**: `scripts/check-live.mjs` starts the server as a client would, lists tools,
   and runs two read-only calls. Signed out, the first list is empty and the first call opens the
   browser sign-in.

   ```bash
   BYTEBASE_URL=http://localhost:8080 BYTEBASE_MCP_HOME="$(mktemp -d)" node scripts/check-live.mjs
   ```

4. **A real client**, from a packed tarball, as users will run it (below).

## A Bytebase to sign in to

Sign-in goes through the instance's consent page: the authorize endpoint redirects the browser to
`/oauth2/consent` on the same host and port. So the instance must serve its console and its API
together:

- A backend built without the frontend answers that page with "This Bytebase build does not bundle
  frontend and backend together", so sign-in cannot finish.
- The frontend dev server does not forward `/mcp`, so a frontend dev server in front of a separate
  backend cannot complete sign-in either.

Build a bundled binary in the [bytebase](https://github.com/bytebase/bytebase) repository, as its
end-to-end tests do (`frontend/tests/e2e/README.md`), then run it with its external URL set, since
Bytebase binds MCP tokens to it:

```bash
(cd frontend && pnpm release)
bash frontend/tests/e2e/build-server.sh            # writes ./bytebase-build/bytebase
./bytebase-build/bytebase --port 8080 --external-url http://localhost:8080 --data "$(mktemp -d)"
```

Without `PG_URL` it starts on embedded PostgreSQL. Sign up the first account in the browser at
`http://localhost:8080`.

## Testing a packed tarball in a client

```bash
npm run build
npm pack                                           # writes bytebase-bytebase-mcp-<version>.tgz
```

Point the client at the tarball with `--package` and an absolute path:

```json
{
  "mcpServers": {
    "bytebase-local": {
      "command": "npx",
      "args": ["-y", "--package=/absolute/path/to/bytebase-bytebase-mcp-0.1.0.tgz", "bytebase-mcp"],
      "env": {
        "BYTEBASE_URL": "http://localhost:8080",
        "BYTEBASE_MCP_HOME": "/tmp/bytebase-mcp-test"
      }
    }
  }
}
```

In Claude Code:

```bash
claude mcp add bytebase-local -e BYTEBASE_URL=http://localhost:8080 -e BYTEBASE_MCP_HOME=/tmp/bytebase-mcp-test -- npx -y --package=/absolute/path/to/bytebase-bytebase-mcp-0.1.0.tgz bytebase-mcp
```

Two forms that look equivalent are not:

- `npx -y /absolute/path/to/x.tgz` fails with "Permission denied", and the client reports the
  connection closed. npx looks for a local program by joining its argument onto
  `node_modules/.bin`; an absolute path survives the join, the tarball exists, so npx tries to
  execute the tarball itself.
- `npx -y ./x.tgz` works, but only when started from that folder, and a client does not start
  there.

After re-packing, npx installs the new tarball even at the same path (checked with npm 11.6.1).
Its installs stay in the npx cache; find and remove them with:

```bash
grep -l bytebase-mcp ~/.npm/_npx/*/package.json   # remove each listed file's directory
```

## Keeping test sign-ins apart

Sign-ins live in `~/.bytebase-mcp` by default. Set `BYTEBASE_MCP_HOME` to a throwaway directory
while testing, so your own sign-ins are untouched. To see and clear them:

```bash
BYTEBASE_MCP_HOME=/tmp/bytebase-mcp-test node dist/index.js status --url http://localhost:8080
BYTEBASE_MCP_HOME=/tmp/bytebase-mcp-test node dist/index.js logout --url http://localhost:8080
```

`logout` revokes each refresh token at the instance, then deletes it.

## Manual checks before a release

The automated tests do not cover these:

- [ ] The browser consent page names the client (`<client> via Bytebase MCP`), and allowing it
      finishes the sign-in.
- [ ] On a first run, the tools appear after sign-in without restarting the client (the client
      must honor `tools/list_changed`).
- [ ] A confirmation form (for example approving an issue) left open for more than a minute can
      still be answered, and the answer reaches Bytebase.
- [ ] Clients not yet exercised: Cursor, Claude Desktop, Windsurf. Windows has never been run.

## Keeping the snapshot current

`src/tools.json` is the tool list MCP directories see before an instance is configured; a
configured server never reads it. Before a release, regenerate it from an instance on the target
Bytebase release:

```bash
npm run build
BYTEBASE_URL=https://your-bytebase npm run sync-tools
```

The script signs in like the package does, writes the snapshot and the README's tools table, and
prints what changed.

## Releasing

```bash
npm version patch        # bumps package.json and server.json together
git push origin main --follow-tags
```

A push to `main` that changes `package.json` runs
[`npm-publish.yml`](.github/workflows/npm-publish.yml): it publishes to npm with OIDC provenance,
then registers the version in the [MCP Registry](https://registry.modelcontextprotocol.io) with
`mcp-publisher`. No tokens are stored in the repository.
