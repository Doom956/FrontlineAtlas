#!/usr/bin/env bash
# Run a balance batch on GitHub's runners instead of this machine (.github/workflows/batch.yml).
#
# Usage: scripts/remote-batch.sh <label> [--shards N] [--no-wait] [--human] -- <scripts/batch.ts options>
#   --human runs scripts/humanbench.ts instead (its options after --, without --jobs)
#   e.g. scripts/remote-batch.sh air-sam2 -- --sizes medium --seeds 48 --minutes 50 --decided 0.6 --specialist all
#
# Snapshots the working tree as it is (uncommitted changes included, the current branch untouched) onto branch
# bench/<label>, pushes it, waits for the "Batch results" commit and prints .bench/report.txt. The merged JSON lines
# are saved to /tmp/fa-bal/gh/<label>.jsonl (feed them to batch.ts --from for other cuts). N runners (default 20)
# x 4 workers each; GitHub runs at most ~20 runners at once per repository, so parallel calls queue.
set -euo pipefail
cd "$(dirname "$0")/.."

label=${1:?label}
shift
shards=20
wait=1
script=batch
while [ $# -gt 0 ]; do
  case "$1" in
    --shards) shards=$2; shift 2 ;;
    --no-wait) wait=0; shift ;;
    --human) script=humanbench; shift ;;
    --) shift; break ;;
    *) echo "unknown option $1" >&2; exit 1 ;;
  esac
done
args="$*"
[ -n "$args" ] || { echo "no batch.ts options after --" >&2; exit 1; }
branch="bench/$label"

# Snapshot with a private index so the real index and working tree stay as they are.
idx=$(mktemp)
trap 'rm -f "$idx"' EXIT
export GIT_INDEX_FILE=$idx
git read-tree HEAD
git add -A
git update-index --add --cacheinfo "100644,$(printf '%s\n' "$args" | git hash-object -w --stdin),.bench/args"
git update-index --add --cacheinfo "100644,$(printf '%s\n' "$shards" | git hash-object -w --stdin),.bench/shards"
git update-index --add --cacheinfo "100644,$(printf '%s\n' "$script" | git hash-object -w --stdin),.bench/script"
tree=$(git write-tree)
unset GIT_INDEX_FILE
commit=$(git commit-tree "$tree" -p HEAD -m "Batch: $label")
git push -q -f origin "$commit:refs/heads/$branch" 2>&1 | grep -v -e 'moved' -e 'new location' -e '\.git *$' || true
echo "pushed $branch ($commit): $args"
[ "$wait" = 1 ] || exit 0

mkdir -p /tmp/fa-bal/gh
deadline=$((SECONDS + 3 * 3600))
while [ $SECONDS -lt $deadline ]; do
  sleep 30
  git fetch -q origin "$branch" 2>/dev/null || continue
  head=$(git rev-parse FETCH_HEAD)
  if [ "$head" != "$commit" ] && [ "$(git rev-parse "$head^")" = "$commit" ]; then
    git show "$head:.bench/results.jsonl" > "/tmp/fa-bal/gh/$label.jsonl"
    git show "$head:.bench/report.txt" | tee "/tmp/fa-bal/gh/$label.txt"
    exit 0
  fi
done
echo "timed out waiting for $branch" >&2
exit 1
