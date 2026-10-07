#!/bin/bash

# LocalBase.ai Security Check
# Comprehensive security scan before commits
# Exit code 1 = FAIL, 0 = PASS
#
# The public-exposure checks (research/ allowlist, email addresses) are skipped
# when nothing here can reach the public: the repo has no remote, or its remote
# is declared private. Gitleaks, secret patterns, env files, IPs, large files
# and the private-term scan still run either way.
#
# "Has a remote" is not "is public". An instance pushed to a private repo shared
# with its own team is the intended audience for the contact data in its vizzes,
# so failing on it is noise — and a scanner that is permanently red is one you
# stop reading. Declare such a repo with
#   LOCALBASE_REMOTE_PRIVATE=1
# in the gitignored scripts/lib/banned-terms.local.sh, which is sourced below.
# Never set it on a repo that is public, or that might be made public later.

set -e

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

# Shared banned-term lists (instance names, etc.)
. "$REPO_ROOT/scripts/lib/banned-terms.sh"

# Detect whether anything here can reach the public (see the note at the top).
if [ -z "$(git remote -v)" ]; then
  PRIVATE_LOCAL=1
  PRIVATE_REASON="no remote"
elif [ "$LOCALBASE_REMOTE_PRIVATE" = "1" ]; then
  PRIVATE_LOCAL=1
  PRIVATE_REASON="remote declared private"
else
  PRIVATE_LOCAL=0
fi

echo "🔒 LocalBase.ai Security Scanner"
if [ "$PRIVATE_LOCAL" = "1" ]; then
  echo "   (private mode — $PRIVATE_REASON — public-exposure checks relaxed)"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

FAILED=0

# 1. Run gitleaks if available (only scan tracked files)
echo "1️⃣  Running gitleaks scan..."
if command -v gitleaks &> /dev/null; then
  if gitleaks detect -v 2>&1 | grep -q "Finding:"; then
    echo "❌ FAIL: gitleaks found secrets in tracked files"
    gitleaks detect -v
    FAILED=1
  else
    echo "✅ PASS: gitleaks found no secrets"
  fi
else
  echo "⚠️  SKIP: gitleaks not installed (brew install gitleaks)"
fi
echo ""

# 2. Private terms check (list lives in the ignored maintainer file)
# A private ignored list is useful for maintainers who work across instances, but
# it is intentionally absent from a fresh public clone. The remaining checks are
# still enforced when no list is configured.
echo "2️⃣  Checking for business / instance names..."
if [ -z "$BANNED_PRIVATE_TERMS" ]; then
  echo "⏭️  SKIP: no private-term list configured"
else
  BUSINESS_REFS=$(git ls-files | xargs grep -iE "$BANNED_PRIVATE_TERMS_RE" 2>/dev/null | \
    grep -vE "$BANNED_TERMS_FILE_EXCLUDE" || true)
  if [ -n "$BUSINESS_REFS" ]; then
    echo "❌ FAIL: Found private-term references"
    echo "$BUSINESS_REFS" | head -20
    if [ $(echo "$BUSINESS_REFS" | wc -l) -gt 20 ]; then
      echo "  ... and more ($(echo "$BUSINESS_REFS" | wc -l) total matches)"
    fi
    echo "  Remove the terms or move the content to a private instance repo."
    echo "  Banned list: scripts/lib/banned-terms.sh"
    FAILED=1
  else
    echo "✅ PASS: No business / instance names found"
  fi
fi
echo ""

# 3. Hardcoded Paths Check (includes personal usernames)
echo "3️⃣  Checking for hardcoded paths..."
HARDCODED_PATHS=$(git ls-files | xargs grep -E "/(Work|Users|home)/[a-zA-Z]+/" 2>/dev/null | \
  grep -v "security-check.sh\|AGENTS.md\|RESEARCH_WORKFLOW.md\|README.md\|CLAUDE.md\|\.claude/commands/" || true)
if [ -n "$HARDCODED_PATHS" ]; then
  echo "❌ FAIL: Found hardcoded paths"
  echo "$HARDCODED_PATHS" | head -20
  if [ $(echo "$HARDCODED_PATHS" | wc -l) -gt 20 ]; then
    echo "  ... and more ($(echo "$HARDCODED_PATHS" | wc -l) total matches)"
  fi
  FAILED=1
else
  echo "✅ PASS: No hardcoded paths"
fi
echo ""

# 4. Data PII Check (phone numbers, addresses in data files)
echo "4️⃣  Checking for data PII in tracked files..."
# Look for phone number patterns in CSVs and data files.
# Require at least one separator (- . or space) to avoid matching long financial
# figures like total_assets_thousands which can appear as 10+ contiguous digits.
#
# North American toll-free prefixes are excluded. A toll-free number is a
# business line by definition and cannot identify a private individual, and
# parsed card statements are full of them — merchant descriptors carry the
# vendor's support number, so every statement file looked like a PII leak.
# Filtering is per line, then files are listed, so a file is only reported when
# it holds a number that is not toll-free.
DATA_PII=$(git ls-files "*.csv" "*.json" 2>/dev/null | \
  xargs grep -EH "\b[0-9]{3}[-. ][0-9]{3}[-. ][0-9]{4}\b|\([0-9]{3}\) ?[0-9]{3}[-. ][0-9]{4}" 2>/dev/null | \
  grep -vE "\b(800|833|844|855|866|877|888)[-. ][0-9]{3}[-. ][0-9]{4}\b|\((800|833|844|855|866|877|888)\) ?[0-9]{3}[-. ][0-9]{4}" | \
  grep -v "example\|test\|mock" | cut -d: -f1 | sort -u || true)
if [ -n "$DATA_PII" ]; then
  echo "❌ FAIL: Found potential PII (phone numbers) in data files"
  echo "$DATA_PII"
  echo "  These files may contain personal data - move to gitignored data/ folder"
  FAILED=1
else
  echo "✅ PASS: No data PII found"
fi
echo ""

# 5. Database Files Check
echo "5️⃣  Checking for database files..."
DB_FILES=$(git ls-files | grep -E "\.db$|\.sqlite$|\.sqlite3$" || true)
if [ -n "$DB_FILES" ]; then
  echo "❌ FAIL: Found database files in git"
  echo "$DB_FILES"
  FAILED=1
else
  echo "✅ PASS: No database files tracked"
fi
echo ""

# 6. Secrets Pattern Check
echo "6️⃣  Checking for secret patterns..."
SECRETS=$(git ls-files | xargs grep -iE "api[_-]?key\s*=\s*['\"][a-zA-Z0-9]{20,}|secret\s*=\s*['\"][a-zA-Z0-9]{20,}|password\s*=\s*['\"][^'\"]{8,}|token\s*=\s*['\"][a-zA-Z0-9]{20,}" 2>/dev/null | \
  grep -v "README\|CLAUDE\|example\|\.gitignore\|BaseConnector\|bootstrap" || true)
if [ -n "$SECRETS" ]; then
  echo "❌ FAIL: Found potential secrets (hardcoded values)"
  echo "$SECRETS"
  FAILED=1
else
  echo "✅ PASS: No hardcoded secrets found"
fi
echo ""

# 7. Env Files Check
echo "7️⃣  Checking for environment files..."
ENV_FILES=$(git ls-files | grep "^env\.local$\|^\.env$\|env\.production$" || true)
if [ -n "$ENV_FILES" ]; then
  echo "❌ FAIL: Found environment files in git"
  echo "$ENV_FILES"
  FAILED=1
else
  echo "✅ PASS: No env files tracked (env.local.example is OK)"
fi
echo ""

# 8. Email Addresses Check
echo "8️⃣  Checking for email addresses..."
if [ "$PRIVATE_LOCAL" = "1" ]; then
  echo "⏭️  SKIP: private repo ($PRIVATE_REASON)"
else
  EMAILS=$(git ls-files | xargs grep -iE "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}" 2>/dev/null | \
    grep -v "example@\|noreply@\|sam@sgratzl\|README\|CLAUDE\|AGENTS\|package.json\|package-lock.json\|author\|LIKE '%@\|security-check.sh\|test@example.com\|john@acme.com\|found@email.com\|\.claude/commands/" | \
    grep -viE "@example\.(com|org|net)|@[a-z0-9.-]+\.(test|invalid|localhost)" || true)
  if [ -n "$EMAILS" ]; then
    echo "❌ FAIL: Found email addresses"
    echo "$EMAILS"
    FAILED=1
  else
    echo "✅ PASS: No email addresses found"
  fi
fi
echo ""

# 9. IP Addresses Check
# Exclude .svg files — path data has paired decimal coords (e.g., ".316 .078 .79 .611")
# that get concatenated and falsely match the IP regex.
#
# Browser version strings are dotted quads too: a scraper's User-Agent carries
# "Chrome/120.0.0.0", which is not an IP address by any reading. Drop lines that
# are plainly a UA string rather than trying to out-clever the regex.
echo "9️⃣  Checking for IP addresses..."
IPS=$(git ls-files | grep -v '\.svg$' | xargs grep -E "\b([0-9]{1,3}\.){3}[0-9]{1,3}\b" 2>/dev/null | \
  grep -v "127.0.0.1\|0.0.0.0\|localhost\|README\|example" | \
  grep -viE "user-agent|mozilla/[0-9]|applewebkit|chrome/[0-9]+\.|safari/[0-9]" || true)
if [ -n "$IPS" ]; then
  echo "❌ FAIL: Found IP addresses"
  echo "$IPS"
  FAILED=1
else
  echo "✅ PASS: No IP addresses found"
fi
echo ""

# 9b. research/ allowlist check — any tracked research file outside the
# explicit allowlist is a fail. Belt-and-suspenders to the gitignore default-
# private rule. This is the check that would have caught the client-f redline
# near-miss in 2026-04-28.
echo "🔟  Checking research/ folder allowlist..."
if [ "$PRIVATE_LOCAL" = "1" ]; then
  echo "⏭️  SKIP: private repo ($PRIVATE_REASON)"
else
  RESEARCH_VIOLATIONS=$(git ls-files "research/*" 2>/dev/null | \
    grep -vE "^research/(kc-financial-institutions/|public/|\.gitkeep)" || true)
  if [ -n "$RESEARCH_VIOLATIONS" ]; then
    echo "❌ FAIL: Found tracked files in research/ outside the allowlist"
    echo "$RESEARCH_VIOLATIONS"
    echo "  research/ is default-private. Allowlist: kc-financial-institutions/, public/."
    FAILED=1
  else
    echo "✅ PASS: No research/ files outside allowlist"
  fi
fi
echo ""

# 10. Large Files Check
echo "1️⃣1️⃣  Checking for large files (>1MB)..."
LARGE_FILES=$(git ls-files | while read file; do
  size=$(wc -c < "$file" 2>/dev/null || echo 0)
  if [ $size -gt 1048576 ]; then
    echo "$file ($(($size / 1048576))MB)"
  fi
done)
if [ -n "$LARGE_FILES" ]; then
  echo "⚠️  WARNING: Found large files (consider if they should be tracked)"
  echo "$LARGE_FILES"
  # Don't fail, just warn
else
  echo "✅ PASS: No large files"
fi
echo ""

# Final result
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ $FAILED -eq 1 ]; then
  echo "❌ SECURITY CHECK FAILED"
  echo ""
  echo "Fix the issues above before committing."
  echo ""
  exit 1
else
  echo "✅ SECURITY CHECK PASSED"
  echo ""
  echo "Repository is clean and safe to commit."
  echo ""
  exit 0
fi
