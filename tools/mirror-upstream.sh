#!/usr/bin/env bash
# Maintains `upstream-rebranded`: a mirror of genspark-ai/genoffice main with the SelfOffice
# rebrand applied to the whole tree (tools/rebrand-upstream.mjs --tree).
#
#   tools/mirror-upstream.sh [<upstream-ref>]      default upstream/main
#
# Each mirror commit has two parents: the previous mirror commit and the upstream commit it
# was built from. Merging the mirror into main therefore has a real merge base (the previous
# mirror commit, already rebranded), so a rename of `@genoffice/*` to `@selfoffice/*` never
# shows up as a conflict. Only real divergence (features this fork removed or rewrote) does.
#
# The mirror never carries `.github/workflows` (our CI is ours; pushing workflow files needs a
# PAT with the `workflow` scope) nor `ee/` (separate Enterprise License, never pulled in).
#
# Prints the new mirror tip on stdout. Updates refs/heads/upstream-rebranded; pushing is the
# caller's job. The first run (no mirror yet) also builds the rebranded merge base from
# `git merge-base HEAD <upstream-ref>`.
set -euo pipefail
shopt -s inherit_errexit

UP=${1:-upstream/main}
MIRROR=upstream-rebranded
ROOT=$(git rev-parse --show-toplevel)

export GIT_AUTHOR_NAME=${GIT_AUTHOR_NAME:-selfoffice-sync[bot]}
export GIT_AUTHOR_EMAIL=${GIT_AUTHOR_EMAIL:-selfoffice-sync@users.noreply.github.com}
export GIT_COMMITTER_NAME=${GIT_COMMITTER_NAME:-$GIT_AUTHOR_NAME}
export GIT_COMMITTER_EMAIL=${GIT_COMMITTER_EMAIL:-$GIT_AUTHOR_EMAIL}

# build <source-commit> <message> [-p parent]... -> prints the commit whose tree is the
# rebranded <source-commit>
build() {
  local src=$1 msg=$2
  shift 2
  local wt
  wt=$(mktemp -d)
  git worktree add -q --detach "$wt" "$src"
  local tree
  tree=$(
    cd "$wt"
    node "$ROOT/tools/rebrand-upstream.mjs" --tree >&2
    rm -rf .github/workflows ee
    git add -A
    git write-tree
  )
  git worktree remove --force "$wt"
  git commit-tree "$tree" "$@" -m "$msg"
}

prev=$(git rev-parse -q --verify "refs/remotes/origin/$MIRROR" || git rev-parse -q --verify "refs/heads/$MIRROR" || true)

if [ -z "$prev" ]; then
  base=$(git merge-base HEAD "$UP")
  prev=$(build "$base" "mirror: rebranded $(git rev-parse --short "$base") (bootstrap)" -p "$base")
fi

up_sha=$(git rev-parse "$UP")
if [ "$(git rev-parse -q --verify "$prev^2" || true)" = "$up_sha" ]; then
  tip=$prev # nothing new upstream
else
  tip=$(build "$up_sha" "mirror: rebranded upstream $(git rev-parse --short "$up_sha")" -p "$prev" -p "$up_sha")
fi

git update-ref "refs/heads/$MIRROR" "$tip"
echo "$tip"
