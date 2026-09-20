#!/bin/bash
# Install git hooks for LocalBase
#
# The pre-commit hook runs two things:
#   1. npm test — code-level security tests (SQL injection, input validation, auth)
#   2. scripts/security-check.sh — repo-level audit (gitleaks, PII, research/
#      allowlist, hardcoded paths, secret patterns, env files, emails, IPs, etc.)
#
# This is critical: localbase.ai is a PUBLIC repo. Anything pushed is world-
# readable on GitHub. The audit prevents accidental leaks of credentials,
# customer/prospect data, contract terms, and instance-specific content.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
HOOKS_DIR="$REPO_ROOT/.git/hooks"

echo "Installing git hooks..."

cat > "$HOOKS_DIR/pre-commit" << 'HOOK'
#!/bin/bash
# Pre-commit hook
#   1. Code security tests (SQL injection, input validation, auth)
#   2. Comprehensive security audit (gitleaks + PII + research/ allowlist + more)
# Server lifecycle is handled by scripts/run-tests.sh — don't start one here.

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}Running security tests...${NC}"

npm test 2>&1
TEST_RESULT=$?

if [ $TEST_RESULT -ne 0 ]; then
    echo -e "${RED}Security tests failed. Commit aborted.${NC}"
    echo -e "${YELLOW}Fix the failing tests before committing.${NC}"
    exit 1
fi

echo -e "${GREEN}Security tests passed.${NC}"

# Comprehensive security audit (gitleaks + business names + PII + research/
# allowlist + 7 more checks). This is the layer that catches accidental leaks
# before they reach this PUBLIC repo.
if [ -x ./scripts/security-check.sh ]; then
    ./scripts/security-check.sh || exit 1
fi

exit 0
HOOK

chmod +x "$HOOKS_DIR/pre-commit"

echo "Pre-commit hook installed."
echo "On each commit: code security tests + comprehensive security audit."
echo "Bypass with --no-verify only if absolutely certain (NOT RECOMMENDED for this PUBLIC repo)."
