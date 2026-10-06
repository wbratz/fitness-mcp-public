#!/usr/bin/env bash
# Install repo git hooks into .git/hooks (which does not travel with a clone).
set -euo pipefail
root=$(git rev-parse --show-toplevel); cd "$root"
cp scripts/pre-push.sh .git/hooks/pre-push
chmod +x .git/hooks/pre-push
echo "installed .git/hooks/pre-push"
