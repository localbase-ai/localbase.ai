# LocalBase Framework

LocalBase is a local-first analytics framework for building data connectors and visualizations.

## Directory Structure

```
localbase.ai/
├── app/              # Browser UI (Vite + React)
├── connectors/       # Data connector framework
│   ├── MCPAdapter.js   # Base class for MCP tools
│   ├── APIClient.js    # Base class for HTTP clients
│   └── example/        # Example connector
├── tools/            # Framework libraries
│   ├── server/         # Express API server
│   ├── mcp/            # MCP server for Claude
│   ├── viz/            # Visualization utilities
│   └── ocr/            # OCR utilities
├── viz/              # Visualization registry (runtime)
├── data/             # SQLite databases (runtime, gitignored)
├── scripts/          # Utility scripts
└── projects/         # Experimental projects (preserved on sync, gitignored)
```

## Commands

```bash
npm start        # Start Express API server (port 9220; see tools/ports.js)
npm run dev      # Start server + Vite dev server
npm run mcp      # Start MCP server (stdio)
npm test         # Run tests
```

## Multi-Instance Architecture

This is the **framework** repo. Business instances are separate repos that contain:
- Their own `connectors/` (business-specific)
- Their own `data/` (business-specific databases)
- Their own `env.local` (credentials)
- Their own `CLAUDE.md` (instance context)

Sync framework to an instance: `cd <instance-dir> && ./scripts/sync-framework.sh`

## Connector Framework

**MCPAdapter** - For exposing tools to Claude:
```javascript
import { BaseConnector } from '../MCPAdapter.js';
// Required: getTools(), canHandleTool(), handleTool()
```

**APIClient** - For HTTP clients with auth/retry:
```javascript
import { BaseConnector } from '../APIClient.js';
// Features: auth, rate limiting, pagination
```

## Connector Conventions

Each `connectors/<name>/` folder is self-contained:

- `index.js` — connector code (required)
- `logo.svg` or `logo.png` — brand logo, served by the app via `GET /api/connectors/:id/logo`
- `schema.json` — data schema (used by `/api/connectors` for discovery and `lastSync` detection)
- `README.md` — connector docs
- `package.json` — optional, surfaces `description` in the connector list

The runtime path for framework-shipped and instance-private connectors is identical — both live in `connectors/<name>/`. Privacy is controlled by gitignore, not by directory.

**Private/instance-specific connectors:** add a one-line `.gitignore` entry for the folder. Example:

```
connectors/clay/         # workspace IDs specific to this Clay org
```

The framework keeps a starter pack of generic, env-driven connectors. Instance- or user-specific connectors stay private via gitignore. A formal marketplace for installing third-party connectors is a future direction.

**Installing a connector into an instance: always install from the framework, never copy from another instance.** Instance copies accumulate business-specific extensions (cross-connector orchestration, custom rollups, hardcoded assumptions) that don't belong in a fresh install. If an instance has a connector the framework lacks, upstream the generic env-driven core here first, then install from the framework. Instance-specific extensions stay in that instance's copy.

## Security Notes

**Important:** LocalBase is designed for local/trusted network use only.

- The API has **no authentication** - all endpoints are reachable by anyone with network access to the server
- A localhost-only IP gate blocks remote requests by default; set `LOCALBASE_ALLOW_REMOTE=true` to override (not recommended without adding auth)
- CSRF protection: mutating methods reject cross-origin Origin/Referer headers
- SQL injection is prevented via parameterized queries and a read-only query guard on `/api/db/query`
- Do not expose the server to untrusted networks without adding authentication

## Public Repo — Commit Hygiene

**This repo is PUBLIC** (`github.com/localbase-ai/localbase.ai`). Anything committed and pushed becomes public on GitHub.

The framework lives in this public repo. Instance-specific data (prospect research, active negotiations, contract terms, third-party PII, internal HubSpot IDs, business strategy notes) belongs in **private instance repos**, not here.

**Default-private folders (gitignored):**
- `projects/` — instance-specific project work, jobs, SDR pipeline, etc.
- `viz/*.html` and `viz/visualizations.json` — instance-specific visualization registry
- `data/**/*.sqlite*`, `data/**/*.db*` — runtime database state

**Pre-commit checklist for ANY new file:**
1. **Is this repo public?** Run `gh repo view --json visibility` if unsure. If public, the next questions matter.
2. **Does the file contain third-party PII?** Names, emails, phone numbers of business contacts who haven't consented to public exposure.
3. **Does it contain financial/contract terms?** Active negotiations, deal values, commission structures, internal pricing.
4. **Does it contain internal IDs?** HubSpot IDs, Stripe IDs, internal record references.
5. **Does it contain strategic/competitive intelligence?** Internal strategy notes, prospect critique, capital-raise plans, etc.

If yes to any of #2-#5: do not commit to this repo. Move to a private instance repo or keep local-only (gitignored).

**Never commit:**
- `env.local`, `.env*` files (secrets)
- API tokens, OAuth credentials
- Customer/prospect data
- Active contract redlines or negotiation docs
- Personal email/phone/address data of third parties

## Development Guidelines

- Check existing tools before creating new ones
- Connector scripts go in `connectors/{name}/`
- Temporary scripts go in `/tmp/`
- Use `better-sqlite3` for database operations
- Load credentials from `env.local`
