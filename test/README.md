# LocalBase Tests

159 tests across 37 suites, all passing.

```bash
npm test          # full suite via scripts/run-tests.sh
npm run test:watch  # watch mode
npm run test:browser # build the UI and exercise preview login/logout in Chromium
```

The browser smoke test starts an isolated authenticated preview on localhost,
then verifies the branded login screen, successful sign-in, authenticated UI,
and icon-only sign-out control. Install its browser once with
`npx playwright install chromium`.

Tests run **in-process** against the Express app via `light-my-request` (see `test/setup.js`). No localhost socket needed; safe in sandboxes.

## What each file covers

| File | What it tests | Surface |
|---|---|---|
| `api.test.js` | Core endpoints: health, workspace info/list/stats/switch/framework-stats/node-modules-breakdown, tools, connectors list, datasources, db/query (SELECT-only enforcement, CTE support) | Foundational API |
| `connectors.test.js` | Connector listing, install (rejects bad ids + missing templates), env save, datasources, logo endpoint (svg serving, 404 for missing, 400/403 for path traversal) | `/api/connectors/*` |
| `router.test.js` | Frontend router (parsing routes, matching parameters) | Frontend |
| `viz.test.js` | Viz registry: file serving, registry CRUD, "current viz" file ops | `/viz/*`, `/api/viz/*` |
| `security.test.js` | SQL injection in db/query, command injection in signals/refresh, CORS restrictions, CSRF Origin/Referer enforcement, XSS escaping, deletion endpoints requiring auth | Defense-in-depth |
| `security-utils.unit.test.js` | `sanitizePath`, `isWithinDirectory`, `isAllowedReadOnlySqlQuery` | Util layer |

## What's tested *well*

- **SQL injection** — parameterized queries throughout; `db/query` rejects non-SELECT (4+ tests)
- **Path traversal** — `sanitizePath` + `isWithinDirectory` covered at unit and integration level
- **Command injection** — `signals/refresh` uses `execFileSync` with array args; 3 tests verify shell metachars don't execute
- **CORS** — localhost allowed, arbitrary origins rejected
- **Input limits** — body size (1MB)
- **Auth on mutations** — DELETE on workspaces requires path within `$LOCALBASE_ROOT`

## Known gaps (acceptable for current scope)

- **`/api/metrics/:metricId`** — exists but undocumented; no tests. Worth investigating what it does before adding tests.
- **No load/perf tests** — local-first product, single user. Add when hosted tier appears.
- **No fuzz tests** — would be valuable for the public flow submission endpoint when traffic justifies it.

## Adding a test

1. Pick the file by topic, or create a new one if it's a new surface.
2. Use `request()` from `setup.js` — handles JSON serialization and in-process injection.
3. Assert both `status` and `data.success` where applicable.
4. Run `npm test` and watch for the new count.

## When tests fail

- `# fail 0` → green.
- Failures print a `not ok N` line with file:line, plus the assertion error. The `failureType: 'testCodeFailure'` means the assertion threw, not the framework.
- Tests share the running Express app instance — no DB cleanup between tests. Use unique IDs (`Date.now()`) for any test data you create.

## Security review checklist

Before any commit:

```bash
npm test                       # all 109 tests pass
./scripts/security-check.sh    # 11-step git-hygiene scan
```

The security check covers git hygiene (no committed secrets/PII/IPs/large files); the test suite covers runtime correctness. **Both are required** — one without the other misses entire failure modes.
