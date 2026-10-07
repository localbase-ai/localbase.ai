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
BANNED_PRIVATE_TERMS="${BANNED_PRIVATE_TERMS:-${BANNED_INSTANCE_NAMES:-}}"

# An instance repo is EXPECTED to contain its own name — it is named after the
# business it analyses. Scanning for it there flags the repo's own README and
# CLAUDE.md title and so fails every single commit (observed on a real instance
# 2026-09-23). Drop THIS repo's own name from the list and leave every other
# name armed: a sibling client's name turning up in this repo is the leak that
# actually matters, and that check stays live.
#
# Matching is on the repo directory name, exact and case-insensitive. A term
# that merely contains the name (say acme\.com where the repo is acme) is kept.
#
# Keep real instance names out of this file and its comments — it is tracked in
# the public repo and is deliberately NOT excluded from its own scan.
REPO_NAME="$(basename "$(cd "$SCRIPT_DIR/../.." && pwd)")"
if [ -n "$BANNED_PRIVATE_TERMS" ] && [ -n "$REPO_NAME" ]; then
  _self="$(printf '%s' "$REPO_NAME" | tr '[:upper:]' '[:lower:]')"
  _kept=""
  _oldifs="$IFS"
  IFS='|'
  for _term in $BANNED_PRIVATE_TERMS; do
    [ -z "$_term" ] && continue
    [ "$(printf '%s' "$_term" | tr '[:upper:]' '[:lower:]')" = "$_self" ] && continue
    _kept="${_kept:+$_kept|}$_term"
  done
  IFS="$_oldifs"
  BANNED_PRIVATE_TERMS="$_kept"
  unset _self _kept _oldifs _term
fi

export BANNED_PRIVATE_TERMS
export BANNED_INSTANCE_NAMES="${BANNED_INSTANCE_NAMES:-$BANNED_PRIVATE_TERMS}"

# Word-anchored form for the scanners. Unanchored, a short name matches inside
# unrelated words and the hit reads as a real leak — a short name such as "ann"
# turning up in "planning", for instance. Checkers should prefer this.
# Falls back to empty when there is no list, so `[ -z ]` guards still work.
if [ -n "$BANNED_PRIVATE_TERMS" ]; then
  export BANNED_PRIVATE_TERMS_RE="\\b(${BANNED_PRIVATE_TERMS})\\b"
else
  export BANNED_PRIVATE_TERMS_RE=""
fi

# Checker scripts are excluded from their own scan (they reference the variable
# name, not an instance name). banned-terms.sh itself is no longer excluded
# because it no longer holds real names.
#
# A local list may append its own paths via BANNED_TERMS_FILE_EXCLUDE_EXTRA,
# for vendor data a broad term unavoidably matches — e.g. competitor URLs in a
# CRM property dump, where the competitor shares a name with one of your own
# instances. Prefer that over weakening the term.
export BANNED_TERMS_FILE_EXCLUDE="scripts/security-check\\.sh|scripts/check-public-text\\.sh${BANNED_TERMS_FILE_EXCLUDE_EXTRA:+|$BANNED_TERMS_FILE_EXCLUDE_EXTRA}"
