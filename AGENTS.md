# LocalBase Agent Guide

This repository is the LocalBase framework. Treat it differently from a business instance.

## Scope

Applies to the entire `localbase.ai` repo unless a deeper `AGENTS.md` overrides it.

## Repo Roles

- Framework code lives in `app/`, `tools/`, `scripts/`, and shared connector base files.
- Business-instance work should usually happen in instance repos, not here.
- `projects/` contains experiments and workflows that may become framework patterns later.

## Multi-Instance Rules

- Do not hardcode one instance's paths, data, or branding into framework code.
- Prefer conventions that work for both the framework repo and synced instances.
- When changing bootstrap or sync behavior, keep those two paths aligned.
- Avoid deleting instance-local work during sync unless the framework explicitly owns it.

## Testing

- Run relevant tests after framework changes.
- If tests rely on localhost networking, note whether sandbox restrictions affected validation.

## Safety

- The server is local/trusted-network only by default and has no auth layer.
- Do not weaken local-only protections without being explicit about the risk.
- Never commit secrets from `env.local`, local databases, or personal credentials.
