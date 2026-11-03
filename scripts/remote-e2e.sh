#!/usr/bin/env bash
# Run the multiplayer e2e checks on GitHub's runners (.github/workflows/e2e.yml): one machine per test and map seed.
#
# Usage: scripts/remote-e2e.sh <label> [seed ...]   (no seeds = each test's default map; 0 = a random map)
# Snapshots the working tree as it is (uncommitted changes included, the current branch untouched) onto branch
# e2e/<label> and pushes it. Results: the "Multiplayer e2e" run for that branch (job per test and seed, logs as artifacts).
set -euo pipefail
cd "$(dirname "$0")/.."
label=${1:?label}
shift
seeds="${*:-default}"
idx=$(mktemp)
trap 'rm -f "$idx"' EXIT
export GIT_INDEX_FILE=$idx
git read-tree HEAD
git add -A
git update-index --add --cacheinfo "100644,$(printf '%s\n' "$seeds" | git hash-object -w --stdin),.e2e/seeds"
tree=$(git write-tree)
unset GIT_INDEX_FILE
commit=$(git commit-tree "$tree" -p HEAD -m "E2E: $label")
git push -q -f origin "$commit:refs/heads/e2e/$label" 2>&1 | grep -v -e 'moved' -e 'new location' -e '\.git *$' || true
echo "pushed e2e/$label ($commit): seeds $seeds"
