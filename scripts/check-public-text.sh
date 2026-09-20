#!/bin/bash
# Check a draft file (GitHub issue body, PR description, README snippet, etc.)
# for content that must not appear in this PUBLIC repo.
#
# The pre-commit hook covers `git commit → push`. It does NOT cover content
# posted directly via `gh issue create --body-file <draft>`, `gh pr create`,
# or the GitHub web UI — issue/PR bodies never enter the git history. Run this
# before posting any of those.
#
# Usage:
#   scripts/check-public-text.sh path/to/draft.md
#   gh issue create --body-file /tmp/draft.md  # only if check passes
#
# Exit 0 = safe to post. Exit 1 = something to scrub.

set -e

if [ $# -ne 1 ]; then
  echo "Usage: $0 <draft-file>"
  exit 2
fi

FILE="$1"

if [ ! -f "$FILE" ]; then
  echo "❌ File not found: $FILE"
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib/banned-terms.sh"

echo "🔒 Public-text check: $FILE"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

FAILED=0

# 1. Business / instance names
echo "1️⃣  Checking for business / instance names..."
if [ -z "$BANNED_PRIVATE_TERMS" ]; then
  echo "⏭️  SKIP: no private-term list configured"
else
  HITS=$(grep -inE "$BANNED_PRIVATE_TERMS" "$FILE" 2>/dev/null || true)
  if [ -n "$HITS" ]; then
    echo "❌ FAIL: Found private terms:"
    echo "$HITS" | sed 's/^/    /'
    echo "  Banned list: scripts/lib/banned-terms.local.sh (gitignored)"
    FAILED=1
  else
    echo "✅ PASS: No business / instance names"
  fi
fi
echo ""

# 2. Hardcoded user paths (e.g. /Users/<name>/, /home/<name>/, /Work/<name>/)
echo "2️⃣  Checking for hardcoded user paths..."
HITS=$(grep -nE "/(Work|Users|home)/[a-zA-Z]+/" "$FILE" 2>/dev/null || true)
if [ -n "$HITS" ]; then
  echo "❌ FAIL: Found hardcoded user paths:"
  echo "$HITS" | sed 's/^/    /'
  FAILED=1
else
  echo "✅ PASS: No hardcoded user paths"
fi
echo ""

# 3. Phone numbers
echo "3️⃣  Checking for phone numbers..."
HITS=$(grep -nE "\b[0-9]{3}[-. ][0-9]{3}[-. ][0-9]{4}\b|\([0-9]{3}\) ?[0-9]{3}[-. ][0-9]{4}" "$FILE" 2>/dev/null || true)
if [ -n "$HITS" ]; then
  echo "❌ FAIL: Found phone-number patterns:"
  echo "$HITS" | sed 's/^/    /'
  FAILED=1
else
  echo "✅ PASS: No phone-number patterns"
fi
echo ""

# 4. Email addresses (excluding obvious placeholders)
echo "4️⃣  Checking for email addresses..."
HITS=$(grep -inE "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}" "$FILE" 2>/dev/null | \
  grep -ivE "example@|noreply@|test@example\.com|john@acme\.com|found@email\.com" || true)
if [ -n "$HITS" ]; then
  echo "❌ FAIL: Found email addresses:"
  echo "$HITS" | sed 's/^/    /'
  echo "  If this is a public collaborator handle, scrub the email and use @username instead."
  FAILED=1
else
  echo "✅ PASS: No email addresses"
fi
echo ""

# 5. IP addresses (excluding localhost / 0.0.0.0)
echo "5️⃣  Checking for IP addresses..."
HITS=$(grep -nE "\b([0-9]{1,3}\.){3}[0-9]{1,3}\b" "$FILE" 2>/dev/null | \
  grep -vE "127\.0\.0\.1|0\.0\.0\.0|localhost" || true)
if [ -n "$HITS" ]; then
  echo "❌ FAIL: Found IP addresses:"
  echo "$HITS" | sed 's/^/    /'
  FAILED=1
else
  echo "✅ PASS: No IP addresses"
fi
echo ""

# 6. Secret-shaped strings (very loose — flag long high-entropy api/token/secret lines)
echo "6️⃣  Checking for secret-shaped strings..."
HITS=$(grep -inE "api[_-]?key\s*[:=]\s*['\"]?[a-zA-Z0-9_-]{20,}|secret\s*[:=]\s*['\"]?[a-zA-Z0-9_-]{20,}|token\s*[:=]\s*['\"]?[a-zA-Z0-9_-]{20,}|bearer\s+[a-zA-Z0-9_-]{20,}" "$FILE" 2>/dev/null || true)
if [ -n "$HITS" ]; then
  echo "❌ FAIL: Found secret-shaped strings:"
  echo "$HITS" | sed 's/^/    /'
  FAILED=1
else
  echo "✅ PASS: No obvious secret patterns"
fi
echo ""

# Final result
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ $FAILED -eq 1 ]; then
  echo "❌ NOT SAFE TO POST"
  echo "  Scrub the issues above before running gh issue/pr create."
  exit 1
else
  echo "✅ SAFE TO POST"
  exit 0
fi
