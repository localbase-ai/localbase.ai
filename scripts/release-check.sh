#!/bin/bash
# Release check: run before pushing a release snapshot to the public repo.
#
#   scripts/release-check.sh [release-ref]      (default: public-release)
#
# The pre-commit hook checks each commit. This checks the thing that actually
# gets published: the release commit, as a clean checkout of exactly its tree,
# plus the commit and tag messages that go public with it.
#
# Every step must pass; the script exits 1 on the first summary with failures.
# It pushes nothing.

set -uo pipefail

REF="${1:-public-release}"
REPO="$(git rev-parse --show-toplevel)"
cd "$REPO"

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; DIM='\033[2m'; NC='\033[0m'
FAILED=0
pass() { printf "${GREEN}✓${NC} %s\n" "$1"; }
fail() { printf "${RED}✗ %s${NC}\n" "$1"; FAILED=$((FAILED + 1)); }
step() { printf "\n${YELLOW}── %s${NC}\n" "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/localbase-release-check.XXXXXX")"
TREE="$WORK/tree"
cleanup() { git worktree remove --force "$TREE" >/dev/null 2>&1; rm -rf "$WORK"; }
trap cleanup EXIT

# ── What is being released ───────────────────────────────────────────────────
step "Release ref"
git fetch --quiet --prune origin || fail "could not fetch origin"
git rev-parse --verify --quiet "$REF^{commit}" >/dev/null || { fail "$REF is not a commit"; exit 1; }
REL="$(git rev-parse "$REF")"
printf "  %s %s\n" "${REL:0:8}" "$(git log -1 --format=%s "$REL")"

git merge-base --is-ancestor origin/main "$REL" \
  && pass "fast-forward from origin/main (no force-push needed)" \
  || fail "$REF does not build on origin/main — pushing would rewrite public history"

[ "$(git rev-parse "$REL^{tree}")" = "$(git rev-parse "main^{tree}")" ] \
  && pass "release tree is exactly local main" \
  || fail "release tree differs from main — rebuild the release from main"

TAG="$(git tag --points-at "$REL" --list 'v*' | head -n1)"
if [ -n "$TAG" ] && [ "$(git cat-file -t "$TAG")" = "tag" ]; then
  pass "annotated tag $TAG points at the release"
else
  fail "no annotated v* tag on the release (the installer installs the newest v* tag)"
fi

# ── Clean checkout of exactly the release tree ───────────────────────────────
step "Clean checkout"
git worktree add --quiet --detach "$TREE" "$REL" || { fail "could not create worktree"; exit 1; }
# The maintainer's private-term list is gitignored, so a clean checkout lacks
# it; copy it in so the name scan below actually has names to scan for.
[ -f scripts/lib/banned-terms.local.sh ] && cp scripts/lib/banned-terms.local.sh "$TREE/scripts/lib/"
for pkg in "" "app"; do
  (cd "$TREE/$pkg" && npm ci --no-audit --no-fund --loglevel=error >/dev/null 2>"$WORK/npm-ci.log") \
    && pass "npm ci ${pkg:-root} (exact lockfile)" \
    || { fail "npm ci ${pkg:-root} — see output below"; tail -5 "$WORK/npm-ci.log"; }
done

# ── Tests ────────────────────────────────────────────────────────────────────
step "Tests"
(cd "$TREE" && npm test >"$WORK/test.log" 2>&1) \
  && pass "unit + API tests ($(grep -E '^# pass' "$WORK/test.log" | awk '{s+=$3} END {print s}') passing)" \
  || { fail "unit + API tests"; grep -E "^not ok|^# fail" "$WORK/test.log" | head -10; }

(cd "$TREE/app" && npx vite build >"$WORK/build.log" 2>&1) \
  && pass "app builds" \
  || { fail "app build"; tail -5 "$WORK/build.log"; }

(cd "$TREE" && node scripts/attack-test.mjs >"$WORK/attack.log" 2>&1) \
  && pass "live attack suite ($(grep -oE 'all [0-9]+ checks' "$WORK/attack.log"))" \
  || { fail "live attack suite"; tail -15 "$WORK/attack.log"; }

(cd "$TREE" && node scripts/browser-smoke.js >"$WORK/smoke.log" 2>&1) \
  && pass "preview browser smoke test" \
  || { fail "preview browser smoke test"; tail -5 "$WORK/smoke.log"; }

# ── What goes public ─────────────────────────────────────────────────────────
step "Public content"
(cd "$TREE" && ./scripts/security-check.sh >"$WORK/security.log" 2>&1) \
  && pass "security-check.sh on the whole release tree" \
  || { fail "security-check.sh"; grep -E "FAIL|❌" "$WORK/security.log" | head -10; }

if command -v gitleaks >/dev/null 2>&1; then
  gitleaks git --log-opts="origin/main..$REL" --redact --no-banner . >"$WORK/gitleaks.log" 2>&1 \
    && pass "gitleaks on the commits being published" \
    || { fail "gitleaks found something"; tail -10 "$WORK/gitleaks.log"; }
else
  fail "gitleaks not installed (brew install gitleaks)"
fi

# Every added line, plus the commit and tag messages, through the same checker
# used for issue and PR text.
{ git diff origin/main "$REL" | grep '^+' | grep -v '^+++'
  git log --format=%B "origin/main..$REL"
  [ -n "$TAG" ] && git tag -l --format='%(contents)' "$TAG"
} >"$WORK/public-text.txt"
bash scripts/check-public-text.sh "$WORK/public-text.txt" >"$WORK/public-text.log" 2>&1 \
  && pass "added lines + release notes pass the public-text check" \
  || { fail "public-text check"; grep -E "FAIL|❌" -A3 "$WORK/public-text.log" | head -15; }

# Hosted endpoints don't belong in a self-hosted framework: every install would
# point at someone's server.
HOSTED="$(cd "$TREE" && git grep -nIE 'https?://[a-z0-9.-]+\.(netlify\.app|vercel\.app|surge\.sh|herokuapp\.com|ngrok(-free)?\.(app|io)|trycloudflare\.com|workers\.dev)' -- . ':!*.md' ':!package-lock.json' ':!app/package-lock.json' || true)"
[ -z "$HOSTED" ] \
  && pass "no hard-coded hosted endpoints" \
  || { fail "hard-coded hosted endpoints:"; echo "$HOSTED" | head -5; }

# ── Dependencies ─────────────────────────────────────────────────────────────
step "Dependencies"
for pkg in "" "app"; do
  (cd "$TREE/$pkg" && npm audit --omit=dev --audit-level=high >"$WORK/audit.log" 2>&1) \
    && pass "no high/critical advisories in ${pkg:-root} production deps" \
    || { fail "npm audit ${pkg:-root}"; grep -E "Severity|^[a-z@]" "$WORK/audit.log" | head -8; }
done

# ── Verdict ──────────────────────────────────────────────────────────────────
echo
if [ "$FAILED" -eq 0 ]; then
  printf "${GREEN}✅ Release check passed${NC} ${DIM}— %s is ready. Publish with:${NC}\n" "${TAG:-$REF}"
  printf "   git push origin %s:main && git push origin %s\n" "$REF" "${TAG:-<tag>}"
  exit 0
fi
printf "${RED}❌ Release check failed: %d problem(s). Do not publish.${NC}\n" "$FAILED"
exit 1
