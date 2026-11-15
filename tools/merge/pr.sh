#!/bin/sh
# Merges a pull request only after the leak guard's content half and the layers lint pass on the
# exact head that will be merged. A push hook can run without the workspace (structural half only)
# and a merge on GitHub runs no hook at all: this is the gate in between.
#   tools/merge/pr.sh <number> [--squash|--merge]   (default --squash)
# VANILLA_WORKSPACE comes from the environment or the main checkout's .env; without a real workspace
# the merge is refused, never done on the structural half alone.
set -e
n=$1; how=${2:---squash}
[ -n "$n" ] || { echo "usage: tools/merge/pr.sh <number> [--squash|--merge]" >&2; exit 2; }
main=$(dirname "$(cd "$(git rev-parse --git-common-dir)" && pwd)")
if [ -z "$VANILLA_WORKSPACE" ] && [ -f "$main/.env" ]; then
  VANILLA_WORKSPACE=$(sed -n 's/^VANILLA_WORKSPACE=//p' "$main/.env" | head -1); export VANILLA_WORKSPACE
fi
[ -n "$VANILLA_WORKSPACE" ] && [ -d "$VANILLA_WORKSPACE" ] || { echo "merge refused: no workspace for the leak guard's content half (set VANILLA_WORKSPACE)" >&2; exit 1; }
head=$(gh pr view "$n" --json headRefOid --jq .headRefOid)
tmp=$(mktemp -d)
trap 'git -C "$main" worktree remove --force "$tmp/wt" >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT
git -C "$main" fetch -q origin "pull/$n/head"
git -C "$main" worktree add -q --detach "$tmp/wt" "$head"
ln -s "$main/node_modules" "$tmp/wt/node_modules"
(cd "$tmp/wt" && npx tsx src/cli/check-public.ts 2>&1 | tee "$tmp/cp.txt")
grep -q "structural half only" "$tmp/cp.txt" && { echo "merge refused: the leak guard ran its structural half only" >&2; exit 1; }
(cd "$tmp/wt" && node --import tsx --test tests/layers.test.ts >/dev/null) || { echo "merge refused: layers lint failed" >&2; exit 1; }
gh pr merge "$n" "$how" --match-head-commit "$head"
echo "merged #$n at $head after the content check"
