#!/usr/bin/env bash
# Pre-push credential guard for fitness-mcp.
#
# Git hooks live in .git/hooks and DO NOT travel with a clone, so reinstall this
# after any fresh clone:  cp scripts/pre-push.sh .git/hooks/pre-push  (or rerun
# scripts/install-hooks.sh).
#
# Two independent checks (mirrors the original build's protection):
#   1. Refuse to push if a known secret FILE is present in the tree being pushed.
#   2. Refuse to push if any live token / signing-secret VALUE appears in a
#      pushed blob. Values are read at push time from the untracked local files
#      (tokens.local.json, signing.local.txt, .dev.vars), so the check stays
#      correct across rotations and never hard-codes a secret into the hook.
# On a hit the push aborts naming the check — never the secret value itself.
set -euo pipefail
root=$(git rev-parse --show-toplevel); cd "$root"
zero=0000000000000000000000000000000000000000
fail(){ echo "pre-push BLOCKED: $*" >&2; echo "  no push performed; remove the credential and retry" >&2; exit 1; }

# --- collect live secret values (each on its OWN line; never printed) --------
secrets=$(mktemp); trap 'rm -f "$secrets"' EXIT
{
  [ -f tokens.local.json ] && grep -oE '"[^"]+"[[:space:]]*:' tokens.local.json | sed -E 's/[[:space:]]*:$//; s/^"//; s/"$//'
  [ -f signing.local.txt ] && { tr -d '\r\n' < signing.local.txt; echo; }
  if [ -f .dev.vars ]; then
    grep -E '^TOKENS_JSON=' .dev.vars | sed -E 's/^TOKENS_JSON=//' | grep -oE '"[^"]+"[[:space:]]*:' | sed -E 's/[[:space:]]*:$//; s/^"//; s/"$//'
    grep -E '^SIGNING_SECRET=' .dev.vars | sed -E 's/^SIGNING_SECRET=//'
  fi
} | awk 'length>=12 && $0!~/-local-token$|^local-development/' | sort -u > "$secrets" || true

name_re='(^|/)(\.dev\.vars(\..*)?$|[^/]+\.local\.(json|txt|md)$)'

while read -r localref localoid remoteref remoteoid; do
  [ "$localoid" = "$zero" ] && continue   # branch deletion
  # .dev.vars.example is the committed template (gitignore un-ignores it) and is
  # safe; every other name_re match is a real secret file.
  offending=$(git ls-tree -r --name-only "$localoid" | grep -E "$name_re" \
    | grep -vE '(^|/)\.dev\.vars\.example$' || true)
  if [ -n "$offending" ]; then
    fail "a secret file is present in the tree being pushed ($localref): $(echo "$offending" | tr '\n' ' ')"
  fi
  if [ -s "$secrets" ]; then
    while read -r oid; do
      if git cat-file blob "$oid" 2>/dev/null | grep -Fqf "$secrets"; then
        fail "a live credential value appears in a pushed blob ($localref)"
      fi
    done < <(git ls-tree -r "$localoid" | awk '{print $3}')
  fi
done
exit 0
