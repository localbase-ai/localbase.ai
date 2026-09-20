# Contributing to LocalBase

Thanks for taking a look. LocalBase is early and actively changing — issues, questions,
and pull requests are all welcome.

## Before you start

LocalBase is a **local-first** project. The server binds to loopback and there are no user
accounts; anything that would expose it to the network, or route your data through a
service you don't control, is outside what this project is for. If you're proposing
something in that direction, open an issue first so we can talk it through.

## Setting up

You'll need Node.js (see `.nvmrc`) and Git.

```bash
gh repo clone localbase-ai/localbase.ai
cd localbase.ai
npm install && (cd app && npm install)
npm run dev
```

The Express API runs on `:9220`, the Vite dev server on `:9221`. Open
`http://localhost:9221`. Set `LOCALBASE_API_PORT` / `LOCALBASE_APP_PORT` to move them.

Copy `env.local.example` to `env.local` for any credentials you need. `env.local` is
gitignored and must stay that way.

## Before you open a pull request

Run both gates — CI runs the same ones:

```bash
bash scripts/run-tests.sh        # unit + integration tests
bash scripts/security-check.sh   # secrets, tracked databases, env files, large files
```

Both must pass. The security check is not advisory: it's the thing standing between a
local credential and a public commit.

If you add a port, a URL, or a path, there are tests that specifically forbid hardcoding
them (`test/no-hardcoded-ports.test.js`, `test/ports.test.js`). Route it through
`tools/ports.js` instead.

## Writing connectors

Connectors live in `connectors/<name>/`. Each one owns its own sync logic and writes into
SQLite. A connector should:

- never write credentials to disk outside `env.local`
- be re-runnable — syncing twice should not duplicate rows
- fail loudly on auth errors rather than silently syncing nothing

## Pull requests

- One topic per PR. A PR that fixes a bug *and* renames things is two PRs.
- Say what breaks. If behavior changes for someone already running LocalBase, put that in
  the description.
- Tests for new behavior. Bug fixes should come with the test that would have caught it.

## Reporting security issues

Don't open a public issue. Use
[GitHub's private vulnerability reporting](https://github.com/localbase-ai/localbase.ai/security/advisories/new).
See [`.github/SECURITY.md`](.github/SECURITY.md).
