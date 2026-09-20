#!/bin/bash
# Shared banned-term lists for public-repo checks.
#
# The real instance/business names live in the GITIGNORED file
#   scripts/lib/banned-terms.local.sh
# which is sourced here if present. If the local file is missing (e.g. a fresh
# public clone), the optional instance-name check is skipped.
#
# To add a name: edit scripts/lib/banned-terms.local.sh (never this file).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/banned-terms.local.sh" ]; then
  . "$SCRIPT_DIR/banned-terms.local.sh"
fi

# Pipe-separated for grep -iE. Case-insensitive. The older
# BANNED_INSTANCE_NAMES variable remains supported for existing ignored files.
export BANNED_PRIVATE_TERMS="${BANNED_PRIVATE_TERMS:-${BANNED_INSTANCE_NAMES:-}}"
export BANNED_INSTANCE_NAMES="${BANNED_INSTANCE_NAMES:-$BANNED_PRIVATE_TERMS}"

# Checker scripts are excluded from their own scan (they reference the variable
# name, not an instance name). banned-terms.sh itself is no longer excluded
# because it no longer holds real names.
export BANNED_TERMS_FILE_EXCLUDE="scripts/security-check\\.sh|scripts/check-public-text\\.sh"
